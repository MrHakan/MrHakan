#!/usr/bin/env bash
# ===================================================================
# aot-chain.sh: strings a few random age of troll matches together into one
# animated WebP, played back to back, for the profile README.
#
# An <img> in a README cannot run any script, so "when a match ends, the next
# one starts" has to live inside the image: this joins the films in
# assets/aot frame by frame with libwebp's webpmux, without re-encoding
# anything, and writes
#
#   <out>/current.webp   the chain (loops forever, transparent background)
#   <out>/current.json   which matches are in it, in order
#   <out>/README.md      a short note for the `aot` branch
#
#   scripts/aot-chain.sh [--count 3] [--max-bytes 4500000] [--exclude "4 17"]
#                        [--src assets/aot] [--out dist]
#
# --exclude takes match numbers that must not be in the new chain (the
# workflow passes the chain that is up now). If a pick comes out bigger than
# --max-bytes (GitHub's image proxy refuses big files) another combination is
# tried; after enough misses it falls back to one match fewer.
#
# Needs: bash, jq, and webpmux (libwebp; on Ubuntu `apt-get install webp`, or
# put a libwebp bin folder on PATH / point WEBPMUX at it).
# ===================================================================
set -euo pipefail

COUNT=3
MAX_BYTES=4500000
EXCLUDE=""
SRC=assets/aot
OUT=dist
WEBPMUX=${WEBPMUX:-webpmux}

while [ $# -gt 0 ]; do
    case "$1" in
        --count) COUNT=$2; shift 2 ;;
        --max-bytes) MAX_BYTES=$2; shift 2 ;;
        --exclude) EXCLUDE=$2; shift 2 ;;
        --src) SRC=$2; shift 2 ;;
        --out) OUT=$2; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

LIST="$SRC/matches.json"
command -v "$WEBPMUX" >/dev/null || { echo "no webpmux (install libwebp tools)" >&2; exit 2; }
command -v jq >/dev/null || { echo "no jq" >&2; exit 2; }
[ -f "$LIST" ] || { echo "no $LIST" >&2; exit 2; }

log() { echo "[aot-chain] $*"; }
size_of() { wc -c < "$1" | tr -d ' '; }
# webpmux reports every file it saves; only show that when it fails
quiet() { local out; out=$("$@" 2>&1) || { printf '%s\n' "$out" >&2; return 1; }; }

# every match that may go in, as "n file bytes"
pool=()
while read -r n file; do
    case " $EXCLUDE " in *" $n "*) continue ;; esac
    [ -f "$SRC/$file" ] || { echo "missing $SRC/$file" >&2; exit 1; }
    pool+=("$n $file $(size_of "$SRC/$file")")
done < <(jq -r '.matches[] | "\(.n) \(.file)"' "$LIST")
[ "${#pool[@]}" -ge 1 ] || { echo "nothing left to pick from" >&2; exit 1; }

# a random pick of $1 matches from the pool whose films fit together under the cap
pick() {
    local want=$1 tries=0 i j t total
    local deck
    while [ $tries -lt 200 ]; do
        tries=$((tries + 1))
        deck=("${pool[@]}")
        # Fisher-Yates, first $want places only
        for ((i = 0; i < want; i++)); do
            j=$((i + (RANDOM * 32768 + RANDOM) % (${#deck[@]} - i)))
            t=${deck[i]}; deck[i]=${deck[j]}; deck[j]=$t
        done
        total=0
        for ((i = 0; i < want; i++)); do total=$((total + ${deck[i]##* })); done
        # the container adds a few bytes per frame; leave room for it
        if [ $((total + 40000)) -le "$MAX_BYTES" ]; then
            CHAIN=("${deck[@]:0:want}")
            return 0
        fi
    done
    return 1
}

[ "$COUNT" -le "${#pool[@]}" ] || COUNT=${#pool[@]}
CHAIN=()
while ! pick "$COUNT"; do
    COUNT=$((COUNT - 1))
    [ "$COUNT" -ge 1 ] || { echo "no match fits under $MAX_BYTES bytes" >&2; exit 1; }
    log "no combination fits, trying $COUNT"
done

work=$(mktemp -d "${TMPDIR:-/tmp}/aot-chain.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$OUT"

# One -frame argument per frame of every film, with the film's own duration,
# offset, dispose and blend. The last frame of each film gets dispose to
# background, so nothing of one match is left on the transparent canvas when
# the next one starts (each film opens with a frame that covers the play area
# and does not blend).
args=()
canvas=""
frames_total=0
ms_total=0
numbers=()
for entry in "${CHAIN[@]}"; do
    n=${entry%% *}; rest=${entry#* }; file=${rest%% *}
    numbers+=("$n")
    info=$("$WEBPMUX" -info "$SRC/$file")
    c=$(printf '%s\n' "$info" | sed -n 's/^Canvas size: *//p')
    if [ -z "$canvas" ]; then canvas=$c
    elif [ "$c" != "$canvas" ]; then echo "$file is $c, the chain is $canvas" >&2; exit 1; fi
    rows=$(printf '%s\n' "$info" | awk '$1 ~ /^[0-9]+:$/ { print $5, $6, $7, $8, $9 }')
    count=$(printf '%s\n' "$rows" | wc -l | tr -d ' ')
    k=0
    while read -r x y dur dispose blend; do
        k=$((k + 1))
        frame="$work/m$n-$k.webp"
        quiet "$WEBPMUX" -get frame "$k" "$SRC/$file" -o "$frame"
        d=0; [ "$dispose" = background ] && d=1
        [ "$k" -eq "$count" ] && d=1
        b=-b; [ "$blend" = yes ] && b=+b
        args+=(-frame "$frame" "+$dur+$x+$y+$d$b")
        ms_total=$((ms_total + dur))
    done <<< "$rows"
    frames_total=$((frames_total + count))
    log "match $n ($file): $count frames"
done

quiet "$WEBPMUX" "${args[@]}" -loop 0 -bgcolor 0,0,0,0 -o "$OUT/current.webp"

# webpmux sizes the canvas to the frames it is given, and no frame of a film
# paints its bottom few transparent rows, so it comes out a little short. Put
# the films' own canvas size back into the VP8X header (bytes 24-29: width - 1
# and height - 1, 24-bit little endian). Only the header changes; every frame
# still fits, which -info below checks.
cw=${canvas%% x *}; ch=${canvas##* x }
le24() { printf "\\$(printf %03o $(($1 & 255)))\\$(printf %03o $((($1 >> 8) & 255)))\\$(printf %03o $((($1 >> 16) & 255)))"; }
[ "$(dd if="$OUT/current.webp" bs=1 skip=12 count=4 2>/dev/null)" = VP8X ] || { echo "no VP8X chunk in the output" >&2; exit 1; }
{ le24 $((cw - 1)); le24 $((ch - 1)); } | dd of="$OUT/current.webp" bs=1 seek=24 count=6 conv=notrunc 2>/dev/null

# check what came out: one animation, every frame, every millisecond
info=$("$WEBPMUX" -info "$OUT/current.webp")
got_canvas=$(printf '%s\n' "$info" | sed -n 's/^Canvas size: *//p')
got_frames=$(printf '%s\n' "$info" | sed -n 's/^Number of frames: *//p')
got_ms=$(printf '%s\n' "$info" | awk '$1 ~ /^[0-9]+:$/ { s += $7 } END { print s }')
bytes=$(size_of "$OUT/current.webp")
[ "$got_canvas" = "$canvas" ] || { echo "canvas $got_canvas, expected $canvas" >&2; exit 1; }
[ "$got_frames" = "$frames_total" ] || { echo "$got_frames frames, expected $frames_total" >&2; exit 1; }
[ "$got_ms" = "$ms_total" ] || { echo "${got_ms} ms, expected ${ms_total} ms" >&2; exit 1; }
[ "$bytes" -le "$MAX_BYTES" ] || { echo "$bytes bytes, over $MAX_BYTES" >&2; exit 1; }
log "chain ${numbers[*]}: $frames_total frames, ${ms_total} ms, $bytes bytes, canvas $canvas"

nums=$(printf '%s\n' "${numbers[@]}" | jq -s -c .)
jq --argjson order "$nums" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   --argjson frames "$frames_total" --argjson ms "$ms_total" --argjson bytes "$bytes" '
    (.matches | map({ key: (.n | tostring), value: . }) | from_entries) as $by
    | { published: $at,
        play: .play,
        film: { frames: $frames, milliseconds: $ms, bytes: $bytes },
        chain: [ $order[] | $by[tostring] | {
            n, file, minutes, link,
            left: { name: .left.name, difficulty: .left.difficulty, plan: .left.plan },
            right: { name: .right.name, difficulty: .right.difficulty, plan: .right.plan },
            winner: .winner } ] }' "$LIST" > "$OUT/current.json"

{
    echo "# age of troll: the matches on the profile now"
    echo
    echo "Played back to back, then the loop starts again:"
    echo
    jq -r '.chain | to_entries[] | .key as $i | .value |
        "\($i + 1). Match \(.n) of 30: **\(.left.name)** (\(.left.difficulty), \(.left.plan)) vs **\(.right.name)** (\(.right.difficulty), \(.right.plan)), \(.minutes | floor) min, **\(.winner.name)** wins. [Watch it on the site](\(.link))"' "$OUT/current.json"
    echo
    echo "![the matches](current.webp)"
    echo
    echo "Built by \`scripts/aot-chain.sh\` from \`.github/workflows/aot-rotate.yml\` on $(jq -r .published "$OUT/current.json"). This branch is rewritten every run."
} > "$OUT/README.md"
