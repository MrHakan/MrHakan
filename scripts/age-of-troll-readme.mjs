// ===================================================================
// age-of-troll-readme.mjs: bot-vs-bot matches of age of troll, drawn for
// the profile README.
//
// 1. Plays bot matches headless with the site's own rule files
//    (games/age-of-troll/age-of-troll-{data,sim}.js from mrhakan.github.io)
//    and keeps --count of them: 6 to 22 minutes, different pairings, plans,
//    lengths and winners.
// 2. Encodes each one as a replay, the same code the site's replay links carry,
//    and checks it plays back the same.
// 3. Plays the replay again and writes down, for every frame of the film, what
//    is on the lane: fast through the quiet parts, slow through the fights,
//    age ups and the end.
// 4. Draws those frames on a transparent canvas in headless Chromium with the
//    game's own sprite sheets (games/age-of-troll/anim) and encodes them as an
//    animated WebP with alpha, so it sits on GitHub's light and dark themes.
// 5. Writes assets/aot/match-NN.webp and assets/aot/matches.json.
//
//   NODE_PATH=../mrhakan.github.io/node_modules:<dir with sharp> \
//     node scripts/age-of-troll-readme.mjs --site ../mrhakan.github.io --out assets/aot --count 30
//
// Other flags: --base <n> (where the seed search starts, default 1),
// --only <n,n> (draw just these matches of the list again), --jobs <n>,
// --seconds <film length before the ending>, --fps <n>, --quality <q,alpha q>,
// --keep-frames <dir>.
//
// The same --count and --base always give the same matches, names and replay
// links; the films come out the same to the eye, not byte for byte.
//
// Needs: Node 20+, playwright (resolved through NODE_PATH) and its Chromium
// (or PW_CHROMIUM), and an encoder: sharp 0.34+ (npm i sharp anywhere and put
// its node_modules on NODE_PATH; it can compress the alpha plane, which keeps
// a film near 1.3 MB) or else ffmpeg with libwebp (FFMPEG env var or on PATH;
// it keeps the alpha lossless and the films come out about twice as big).
// ===================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { compileFunction } from 'vm';

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (name, def) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const SITE = path.resolve(opt('site', process.env.AOT_SITE || '../mrhakan.github.io'));
const OUT = path.resolve(opt('out', 'assets/aot'));
const COUNT = +opt('count', 30);
const BASE = +opt('base', 1);
const ONLY = opt('only', '') ? opt('only', '').split(',').map(Number) : null;
const JOBS = +opt('jobs', 3);
const SECONDS = +opt('seconds', 22);              // the match, compressed, before the ending
const HOLD = 3.2;                                 // the ending: the base falls, the winner's banner
const FPS = +opt('fps', 12);
const W = 800, H = 260;
const KEEP = opt('keep-frames', null);
const MAX_BYTES = 1.5 * 1024 * 1024;              // no film is bigger than this
const AIM_BYTES = 1.35 * 1024 * 1024;             // and the quality steps down until it is this, so 30 stay near 40 MB
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SITE_URL = 'https://mrhakan.github.io/';
const LINK_MAX = 8000;                            // same limit as age-of-troll.js replayUrl()
const log = (...a) => console.log('[aot]', ...a);

if (!fs.existsSync(path.join(SITE, 'games/age-of-troll/age-of-troll-sim.js'))) {
    console.error('no age of troll at ' + SITE + ' (pass --site <path to mrhakan.github.io>)');
    process.exit(2);
}

// ---------- the rules, exactly as the site's own Node checks load them ----------
// (mirrors .github/scripts/game-test-context.mjs: the IIFEs get a scope object
// as their globalThis, plus the web bits the replay encoder uses)
function loadRules() {
    const scope = { console, CompressionStream, DecompressionStream, TextEncoder, TextDecoder, structuredClone };
    for (const f of ['age-of-troll-data.js', 'age-of-troll-sim.js']) {
        const file = path.join(SITE, 'games/age-of-troll', f);
        const bindings = { Math, window: undefined, ...scope, globalThis: scope };
        const names = Object.keys(bindings);
        compileFunction(fs.readFileSync(file, 'utf8'), names, { filename: file })(...names.map(n => bindings[n]));
    }
    if (!scope.AOT || !scope.AOT.replay) throw new Error('the rule files did not define AOT');
    return scope.AOT;
}
const A = loadRules();
const HZ = A.HZ;

// ---------- pick and play matches ----------
// sensible pairings: the same or neighbouring difficulty, so neither side is a punching bag
const DIFFS = ['normal', 'hard', 'troll'];
const PLANS = ['balanced', 'rush', 'greed', 'turtle', 'waves'];
const MIN_MIN = 6, MAX_MIN = 22;                  // minutes of match worth filming

// splitmix32: neighbouring numbers give unrelated streams, so seed 7 and seed 8
// are not the same matchup
function mixer(n) {
    let x = n >>> 0;
    return () => {
        x = (x + 0x9e3779b9) >>> 0;
        let z = x;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
        return ((z ^ (z >>> 16)) >>> 0) / 2 ** 32;
    };
}

function playMatch(k) {
    // everything comes from k: the seed, the matchup and the names
    const r = mixer(k * 7919 + 13);
    const pk = list => list[Math.floor(r() * list.length)];
    const seed = Math.floor(r() * 0x7fffffff) || 1;
    const d0 = Math.floor(r() * DIFFS.length);
    const d1 = Math.max(0, Math.min(DIFFS.length - 1, d0 + pk([-1, 0, 0, 1])));
    const bots = [{ diff: DIFFS[d0], plan: pk(PLANS) }, { diff: DIFFS[d1], plan: pk(PLANS) }];
    const n0 = pk(A.BOT_NAMES);
    let n1 = pk(A.BOT_NAMES);
    while (n1 === n0) n1 = pk(A.BOT_NAMES);
    bots[0].name = n0; bots[1].name = n1;

    const s = A.replay.record(A.newGame(seed), seed);
    const brains = bots.map((b, i) => A.newBrain(b.diff, b.plan, (seed * (i ? 13 : 7) + (i ? 17 : 11)) | 0));
    s.p[0].handicap = A.DIFFICULTIES[bots[0].diff].income;
    s.p[1].handicap = A.DIFFICULTIES[bots[1].diff].income;
    const timeline = [];
    const sample = () => timeline.push({
        units: [s.u[0].length, s.u[1].length],
        kills: [s.p[0].kills, s.p[1].kills],
        dmg: s.p[0].baseDmg + s.p[1].baseDmg,
        age: [s.p[0].age, s.p[1].age]
    });
    const limit = (MAX_MIN + 1) * 60 * HZ;
    sample();
    while (!s.over && s.tick < limit) {
        A.think(s, 0, brains[0]);
        A.think(s, 1, brains[1]);
        A.step(s);
        if (s.tick % HZ === 0) sample();
    }
    return { k, s, bots, timeline, seed, minutes: s.tick / HZ / 60 };
}

// a varied list: no matchup twice, winners on both sides, short and long games
function pickMatches(count) {
    const chosen = [], keys = new Set();
    const named = Object.fromEntries(A.BOT_NAMES.map(n => [n, 0]));
    const wins = [0, 0];
    const bucket = m => (m < 11 ? 0 : m < 15 ? 1 : m < 19 ? 2 : 3);
    const buckets = [0, 0, 0, 0];
    const capWins = Math.ceil(count / 2) + 1, capBucket = Math.ceil(count * 0.34);
    for (let k = BASE; chosen.length < count && k < BASE + 4000; k++) {
        const m = playMatch(k);
        if (!m.s.over || (m.s.winner !== 0 && m.s.winner !== 1)) continue;
        if (m.minutes < MIN_MIN || m.minutes > MAX_MIN) continue;
        const key = m.bots.map(b => b.diff + '/' + b.plan).join(' vs ');
        if (keys.has(key)) continue;
        if (wins[m.s.winner] >= capWins || buckets[bucket(m.minutes)] >= capBucket) continue;
        keys.add(key); wins[m.s.winner]++; buckets[bucket(m.minutes)]++;
        // the names are only labels (the rules never see them): spread them round
        const r = mixer(k * 31 + 7);
        const order = A.BOT_NAMES.map(n => [n, r()]).sort((a, b) => named[a[0]] - named[b[0]] || a[1] - b[1]).map(x => x[0]);
        const pair = r() < 0.5 ? [order[0], order[1]] : [order[1], order[0]];
        m.bots[0].name = pair[0]; m.bots[1].name = pair[1];
        named[pair[0]]++; named[pair[1]]++;
        chosen.push(m);
    }
    if (chosen.length < count) throw new Error('only ' + chosen.length + ' filmable matches found');
    return chosen;
}

// ---------- the film's pace: how fast each game second goes by ----------
// quiet stretches race past, fights, age ups, wall hits and the end slow down
function paceOf(TL) {
    const N = TL.length;
    const at = i => TL[Math.max(0, Math.min(N - 1, i))];
    const interest = TL.map((_, t) => {
        const deaths = (at(t + 3).kills[0] + at(t + 3).kills[1]) - (at(t - 3).kills[0] + at(t - 3).kills[1]);
        const dmg = at(t + 3).dmg - at(t - 3).dmg;
        const army = at(t).units[0] + at(t).units[1];
        let ageUp = 0;
        for (let k = -5; k <= 5; k++) {
            const a = at(t + k), b = at(t + k - 1);
            if (a.age[0] !== b.age[0] || a.age[1] !== b.age[1]) ageUp = 1;
        }
        const end = N - 1 - t < 20 ? 1 : 0;
        return 1 + 0.35 * deaths + dmg / 400 + army * 0.05 + 4 * ageUp + 8 * end;
    });
    // smoothed, so the speed never jumps
    const smooth = interest.map((_, t) => {
        let sum = 0, n = 0;
        for (let k = -6; k <= 6; k++) { const v = interest[t + k]; if (v !== undefined) { sum += v; n++; } }
        return sum / n;
    });
    const MIN_RATE = 3, MAX_RATE = 80;
    const ratesFor = K => smooth.map(v => Math.max(MIN_RATE, Math.min(MAX_RATE, K / v)));
    const filmLength = K => ratesFor(K).reduce((t, r) => t + 1 / r, 0);
    let lo = 0.1, hi = 5000;
    for (let i = 0; i < 60; i++) { const mid = Math.sqrt(lo * hi); if (filmLength(mid) > SECONDS) lo = mid; else hi = mid; }
    return ratesFor(hi);
}

// ---------- the frames: what is on the lane at each one ----------
const r1 = v => Math.round(v * 10) / 10;
function filmFrames(rp, rates) {
    const s = A.replay.start(rp);
    s.ev = [];
    const cur = { i: 0 };
    const frames = [];
    let gameT = 0;
    const N = rates.length;
    const snap = (rate, hold) => {
        const ev = s.ev.splice(0);
        // a fast frame can hold a few hundred swings: keep every kind, thin the swings
        const hits = ev.filter(e => e.e === 'hit'), rest = ev.filter(e => e.e !== 'hit');
        const keep = hits.length > 24 ? hits.filter((_, i) => i % Math.ceil(hits.length / 24) === 0) : hits;
        const shots = rest.filter(e => e.e === 'tshot');
        const other = rest.filter(e => e.e !== 'tshot' && e.e !== 'spawn' && e.e !== 'build' && e.e !== 'modem' && e.e !== 'server');
        frames.push({
            i: frames.length, tick: s.tick, over: s.over, winner: s.winner, hold, rate,
            u: s.u.map(list => list.map(u => [u.id, u.t, r1(u.x), Math.round(u.hp / A.UNITS[u.t].hp * 100) / 100, u.stun > 0 ? 1 : 0])),
            p: s.p.map(p => ({ hp: Math.max(0, p.hp) / A.AGES[p.age].hp, hpN: Math.max(0, Math.round(p.hp)), age: p.age, tur: p.tur.map(t => [t.k, t.a]), buff: p.buffT > 0 ? 1 : 0, oc: p.oc })),
            srv: Math.round(s.srv * 100) / 100,
            fire: s.fire.map(f => [f.s, r1(f.x), f.w]),
            ev: [...keep, ...shots.slice(-8), ...other]
        });
    };
    while (!s.over) {
        const rate = rates[Math.max(0, Math.min(N - 1, Math.floor(gameT)))];
        gameT += rate / FPS;
        const target = Math.round(gameT * HZ);
        while (s.tick < target && !s.over) {
            if (!A.replay.tick(s, rp, cur)) throw new Error('the replay went off the rails at tick ' + s.tick);
        }
        snap(Math.round(rate), false);
    }
    for (let i = 0; i < Math.round(HOLD * FPS); i++) snap(0, true);
    return frames;
}

// ---------- the page that draws them ----------
// Runs in Chromium. Everything it needs comes in D; the sheets come from the
// site's anim folder through a route, no server.
function pageMain(D) {
    const W = D.W, H = D.H, FPS = D.FPS;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    document.body.appendChild(cv);
    const c = cv.getContext('2d');
    // a clean downscale of the 96px cells: the default one shimmers, and noise
    // that changes every frame is what an animated WebP pays for
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    const GY = 222;                                 // where the feet are
    const X = x => 28 + x * (744 / D.LANE);
    const SC = 0.44;                                // sprite size against the site's
    const SIDE = ['#0ea5e9', '#f97316'], SIDE_DK = ['#0b3d91', '#9a3412'], SIDE_LT = ['#7dd3fc', '#fdba74'];
    const GREY = '#8b949e', INK = '#0d1117';
    // outlines in a middle grey: a dark one disappears on GitHub's dark theme
    const RIM = 'rgba(139,148,158,.85)';
    const FONT = '"DejaVu Sans Mono", Menlo, Consolas, monospace';
    const FRAME = 0.08;
    const ANIM_FPS = FPS / 2;
    const SHEETS = {};
    let M, V;

    window.loadSheets = names => Promise.all(names.map(n => new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => { SHEETS[n] = im; res(); };
        im.onerror = () => rej(new Error('no sheet ' + n));
        im.src = 'http://aot.local/anim/' + n + '.webp';
    })));
    window.reset = meta => {
        M = meta;
        let rs = (meta.seed >>> 0) || 1;
        const rand = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; };
        V = { vis: new Map(), rand, corpses: [], shots: [], sparks: [], rings: [], banners: [], fx: [], flash: [-9, -9], pulse: [-9, -9], kick: [[], []], endAt: null, prevT: 0 };
    };

    const units = D.UNITS;
    const animSize = t => t.size * (t.id === D.BOSS ? 1.5 : 1.6) * SC;
    const animFlip = (file, left) => (D.LOOKS_LEFT[file] ? left : !left);
    function sheet(c2, file, cell, frame, x, bottom, size, flip, alpha, glow) {
        const im = SHEETS[file];
        if (!im) return false;
        const f = Math.max(0, Math.min(15, Math.floor(frame)));
        c2.save();
        if (alpha !== undefined) c2.globalAlpha = alpha;
        c2.translate(x, bottom);
        if (flip) c2.scale(-1, 1);
        // a thin grey halo: emoji line art is black, and black on #0d1117 is nothing
        if (glow) { c2.shadowColor = 'rgba(160,170,182,.95)'; c2.shadowBlur = 2; }
        c2.drawImage(im, (f % 4) * cell, (f >> 2) * cell, cell, cell, -size / 2, -size, size, size);
        c2.restore();
        return true;
    }
    function rr(x, y, w, h, r) {
        c.beginPath();
        c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
    }
    // text that reads on white and on #0d1117: a dark rim under a light face
    function label(text, x, y, color, size, align, weight) {
        c.font = (weight || 600) + ' ' + size + 'px ' + FONT;
        c.textAlign = align || 'left'; c.textBaseline = 'middle';
        c.lineJoin = 'round'; c.lineWidth = 3; c.strokeStyle = 'rgba(13,17,23,.85)';
        c.strokeText(text, x, y);
        c.fillStyle = color; c.fillText(text, x, y);
    }
    // plain text in a colour that reads on both backgrounds, no rim
    function text(t, x, y, color, size, align, weight) {
        c.font = (weight || 600) + ' ' + size + 'px ' + FONT;
        c.textAlign = align || 'left'; c.textBaseline = 'middle';
        c.fillStyle = color; c.fillText(t, x, y);
    }
    function pill(t, cx, cy, fill, size, alpha) {
        c.save();
        c.globalAlpha = alpha;
        c.font = '700 ' + size + 'px ' + FONT;
        const w = c.measureText(t).width + size * 1.4, h = size + 10;
        rr(cx - w / 2, cy - h / 2, w, h, h / 2);
        c.fillStyle = fill; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = RIM; c.stroke();
        c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(t, cx, cy + 0.5);
        c.restore();
    }
    const clock = sec => { sec = Math.floor(sec); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
    const baseH = age => 58 + age * 11;

    // ---------- the events of a frame become sparks, shots, banners ----------
    function events(f, T) {
        const lane = GY - 16;
        let sparks = 0;
        for (const e of f.ev) {
            if (e.e === 'hit') {
                const v = V.vis.get(e.id);
                if (v && T - v.atk >= v.atkDur) { v.atk = T; v.atkDur = 0.5; }
                if (e.base !== undefined) {
                    V.flash[e.base] = T;
                    if (sparks++ < 4) V.sparks.push({ x: X(D.FRONT[e.base]) + (e.base ? 4 : -4), y: GY - 12 - V.rand() * (baseH(f.p[e.base].age) - 20), at: T, c: '#facc15' });
                } else if (e.role === 1 && e.tx !== undefined) {
                    const ty = v && units[v.t];
                    const anim = ty && D.ANIM[ty.anim] && D.ANIM[ty.anim].shot ? ty.anim : null;
                    if (V.shots.length < 14) V.shots.push({ x0: X(e.x), x1: X(e.tx), y0: lane - 8, y1: lane - 6, at: T, d: 0.3, anim, s: e.s });
                } else if (e.tx !== undefined && sparks++ < 5) {
                    V.sparks.push({ x: X(e.tx) + (V.rand() - 0.5) * 8, y: GY - 14 - V.rand() * 18, at: T, c: e.role === 2 || e.role === 3 ? '#fde047' : '#ffffff' });
                }
            } else if (e.e === 'tshot') {
                const side = e.s;
                if (e.i >= 0) V.kick[side][e.i] = T;
                const o = turretSpot(side, e.i, f.p[side].age);
                if (V.shots.length < 18) V.shots.push({ x0: o.x, x1: X(e.x), y0: o.y, y1: lane, at: T, d: e.k === 1 ? 0.4 : 0.16, tracer: e.k !== 1, shell: e.k === 1, s: side });
                if (e.k === 1) V.rings.push({ x: X(e.x), at: T + 0.4, max: 64 * 0.465 });
            } else if (e.e === 'die') {
                if (V.corpses.length > 6) V.corpses.shift();
                V.corpses.push({ t: e.t, x: X(e.x), side: e.s, depth: (e.id * 7) % 3, at: T });
                V.vis.delete(e.id);
            } else if (e.e === 'age') {
                V.pulse[e.s] = T;
                banner(M.names[e.s] + ' reached age ' + (e.a + 1) + ': ' + D.AGES[e.a], e.s, T);
            } else if (e.e === 'overclock') {
                banner(M.names[e.s] + ' overclocked +' + e.a * 10 + '%', e.s, T);
            } else if (e.e === 'special') {
                banner(M.names[e.s] + ': ' + D.SPECIALS[e.k], e.s, T);
                V.fx.push({ k: e.k, s: e.s, x: X(e.x), at: T, seed: V.rand() });
            }
        }
    }
    function banner(t, s, T) {
        V.banners.push({ t, s, at: T });
        while (V.banners.length > 2) V.banners.shift();
    }
    function turretSpot(side, i, age) {
        const top = GY + 8 - baseH(age);
        const wall = X(D.FRONT[0]);
        let x = i < 0 ? wall : wall - 12 - i * 17;
        if (side === 1) x = W - x;
        return { x, y: i < 0 ? top + 6 : top - 6 };
    }

    // ---------- the scenery ----------
    function lane(f) {
        c.strokeStyle = GREY; c.lineWidth = 2;
        c.beginPath(); c.moveTo(8, GY + 11); c.lineTo(W - 8, GY + 11); c.stroke();
        c.globalAlpha = 0.6; c.lineWidth = 1;
        for (let x = X(D.FRONT[0]) + 40; x < X(D.FRONT[1]) - 20; x += 40) { c.beginPath(); c.moveTo(x, GY + 10); c.lineTo(x, GY + 14); c.stroke(); }
        c.globalAlpha = 1;
        // the server in the middle: whoever stands on it gets paid more
        const sx = X(D.MID), owner = f.srv >= 1 ? 0 : f.srv <= -1 ? 1 : -1;
        const col = owner < 0 ? GREY : SIDE[owner];
        rr(sx - 8, GY - 12, 16, 22, 2); c.fillStyle = owner < 0 ? 'rgba(139,148,158,.35)' : col; c.fill();
        c.lineWidth = 1.2; c.strokeStyle = owner < 0 ? GREY : SIDE_DK[owner]; c.stroke();
        for (let k = 0; k < 3; k++) {
            c.fillStyle = 'rgba(13,17,23,.45)'; c.fillRect(sx - 6, GY - 9 + k * 6, 12, 3);
            c.fillStyle = (k + 1) % 3 ? '#86efac' : '#facc15'; c.fillRect(sx + 3, GY - 9 + k * 6, 2, 2);
        }
        // the capture bar
        c.fillStyle = 'rgba(139,148,158,.35)'; c.fillRect(sx - 18, GY + 13, 36, 3);
        if (f.srv) { c.fillStyle = SIDE[f.srv > 0 ? 0 : 1]; c.fillRect(f.srv > 0 ? sx - 18 : sx + 18 - 18 * -f.srv, GY + 13, 18 * Math.abs(f.srv), 3); }
    }

    // one base, drawn for the left side; the right one is the mirror image
    function base(side, f, T) {
        const p = f.p[side];
        const h = baseH(p.age);
        const x0 = 10, x1 = X(D.FRONT[0]) + 1, w = x1 - x0;
        let sink = 0, shake = 0;
        if (f.over && f.winner !== side && V.endAt !== null) {
            const k = Math.min(1, (T - V.endAt) / 1.6);
            sink = h * 0.8 * k * k;
            shake = k < 1 ? Math.sin(T * 60) * 2 * (1 - k) : 0;
        }
        c.save();
        if (side === 1) { c.translate(W, 0); c.scale(-1, 1); }
        c.translate(shake, 0);
        c.beginPath(); c.rect(0, 0, W / 2, GY + 10); c.clip();
        const top = GY + 10 - h + sink;
        // the body: a castle that is also a beige-box PC, coloured for its side
        const g = c.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, SIDE_DK[side]); g.addColorStop(1, SIDE[side]);
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(x0, GY + 10); c.lineTo(x0, top);
        const n = 5, mw = w / (n * 2 - 1);
        for (let i = 0; i < n; i++) {
            const a = x0 + i * 2 * mw;
            c.lineTo(a, top - 7); c.lineTo(a + mw, top - 7); c.lineTo(a + mw, top);
            if (i < n - 1) c.lineTo(a + 2 * mw, top);
        }
        c.lineTo(x1, top); c.lineTo(x1, GY + 10); c.closePath();
        c.fill();
        c.lineWidth = 1.5; c.strokeStyle = RIM; c.stroke();
        // a lighter band: the drive bays
        c.fillStyle = 'rgba(255,255,255,.18)';
        c.fillRect(x0 + 6, top + 8, w - 12, 5);
        c.fillRect(x0 + 6, top + 16, w - 12, 5);
        // windows, more of them every age
        const rows = 1 + Math.min(3, Math.floor(p.age / 1.4));
        for (let r = 0; r < rows; r++) {
            for (let k = 0; k < 3; k++) {
                const lit = (k + r + side) % 3 !== 0;
                c.fillStyle = lit ? '#fde68a' : 'rgba(13,17,23,.5)';
                c.fillRect(x0 + 10 + k * 18, top + 28 + r * 13, 7, 7);
            }
        }
        // the door, facing the lane
        c.fillStyle = 'rgba(13,17,23,.7)';
        c.beginPath(); c.moveTo(x1 - 22, GY + 10); c.lineTo(x1 - 22, GY - 6); c.arc(x1 - 14, GY - 6, 8, Math.PI, 0); c.lineTo(x1 - 6, GY + 10); c.fill();
        // the flag
        c.strokeStyle = GREY; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(x0 + 8, top - 7); c.lineTo(x0 + 8, top - 26); c.stroke();
        c.fillStyle = SIDE_LT[side];
        c.beginPath(); c.moveTo(x0 + 8, top - 26); c.lineTo(x0 + 22, top - 22); c.lineTo(x0 + 8, top - 18); c.fill();
        c.stroke();
        // damage: cracks as the wall goes down, smoke when it is nearly gone
        if (p.hp < 0.6) {
            c.strokeStyle = 'rgba(13,17,23,.65)'; c.lineWidth = 1.3;
            c.beginPath(); c.moveTo(x0 + 20, top + 2); c.lineTo(x0 + 26, top + 14); c.lineTo(x0 + 22, top + 22); c.lineTo(x0 + 30, top + 34); c.stroke();
            if (p.hp < 0.3) { c.beginPath(); c.moveTo(x1 - 8, top + 4); c.lineTo(x1 - 16, top + 18); c.lineTo(x1 - 10, top + 28); c.stroke(); }
        }
        // turrets on the roof
        p.tur.forEach((t, i) => {
            const tx = x1 - 12 - i * 17, ty = top - 6;
            const kick = Math.max(0, 1 - (T - (V.kick[side][i] || -9)) / 0.15) * 3;
            c.fillStyle = '#94a3b8'; c.strokeStyle = '#475569'; c.lineWidth = 1.2;
            rr(tx - 6, ty - 1, 12, 8, 2); c.fill(); c.stroke();
            c.strokeStyle = '#475569'; c.lineWidth = t[0] === 1 ? 4 : 2.2;
            c.beginPath();
            if (t[0] === 1) { c.moveTo(tx, ty + 2); c.lineTo(tx + 8 - kick, ty - 5); }
            else { c.moveTo(tx + 2, ty + 2); c.lineTo(tx + 13 - kick, ty + 2); }
            c.stroke();
        });
        // hit flash and the age-up glow
        const fl = Math.max(0, 1 - (T - V.flash[side]) / 0.12);
        const pu = Math.max(0, 1 - (T - V.pulse[side]) / 0.8);
        // a hit lights the wall face only: a whole base flashing on every hit
        // would make each frame of a siege a big new picture
        if (fl > 0) { c.fillStyle = '#fde047'; c.fillRect(x1 - 3, top, 3, h - 10); }
        if (pu > 0) {
            c.globalAlpha = pu * 0.5; c.fillStyle = '#fef08a';
            c.fillRect(x0, top - 7, w, h + 7);
            c.globalAlpha = 1;
        }
        c.restore();
        // dust where a base comes down
        if (sink > 0) {
            const k = Math.min(1, (T - V.endAt) / 2.4);
            for (let i = 0; i < 9; i++) {
                const px = (side ? W - x1 : x0) + (i / 8) * w + Math.sin(i * 3.1) * 6;
                const py = GY + 4 - k * (20 + (i % 3) * 12);
                c.fillStyle = 'rgba(139,148,158,' + (0.55 * (1 - k)).toFixed(3) + ')';
                c.beginPath(); c.arc(px, py, 6 + k * 10 + (i % 2) * 3, 0, Math.PI * 2); c.fill();
            }
        }
    }

    function info(side, f) {
        const p = f.p[side], b = M.bots[side];
        const right = side === 1;
        const x = right ? W - 12 : 12, al = right ? 'right' : 'left';
        text(b.name, x, 41, SIDE[side], 13, al, 700);
        c.font = '700 13px ' + FONT;
        const nw = c.measureText(b.name).width;
        text(b.diff + ' · ' + b.plan, right ? x - nw - 8 : x + nw + 8, 41.5, GREY, 11, al, 500);
        // the wall's health
        const bw = 170, bx = right ? x - bw : x, by = 51;
        rr(bx, by, bw, 8, 3); c.fillStyle = 'rgba(139,148,158,.28)'; c.fill();
        c.lineWidth = 1; c.strokeStyle = 'rgba(139,148,158,.9)'; c.stroke();
        const fw = Math.max(0, bw * p.hp);
        if (fw > 0.5) {
            c.save(); rr(bx, by, bw, 8, 3); c.clip();
            c.fillStyle = p.hp > 0.3 ? SIDE[side] : '#ef4444';
            c.fillRect(right ? bx + bw - fw : bx, by, fw, 8);
            c.restore();
        }
        text(p.hpN.toLocaleString('en-US'), right ? bx - 6 : bx + bw + 6, by + 4.5, GREY, 10, right ? 'right' : 'left', 600);
        // the age it is in
        const age = 'age ' + (p.age + 1) + ' · ' + D.AGES[p.age] + (p.oc ? ' +' + p.oc * 10 + '%' : '');
        text(age, x, 70, GREY, 11, al, 600);
    }

    function header(f) {
        const g = c.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, '#0b3d91'); g.addColorStop(1, '#0ea5e9');
        rr(0, 0, W, 26, 7); c.fillStyle = g; c.fill();
        text('age of troll · ' + M.bots[0].name + ' vs ' + M.bots[1].name + ' · ' + M.minutes + ' min', 11, 13.5, '#ffffff', 13, 'left', 600);
        // the strip stays still while the match runs: an animated WebP stores the
        // box round everything that changed, and a ticking clock up here would
        // make that box the whole picture on every frame
        text(f.over ? M.bots[f.winner].name + ' wins' : 'bot vs bot', W - 11, 13.5, '#ffffff', 13, 'right', 700);
    }
    // the clock and the film's speed, under the lane where things move anyway
    function clockLine(f) {
        if (f.over) return;
        // twice a second is plenty for a clock running at 20x
        if (f.i % (FPS / 2) === 0 || !V.clock) V.clock = { tick: f.tick, rate: f.rate };
        f = Object.assign({}, f, V.clock);
        const t = clock(f.tick / D.HZ) + ' / ' + clock(M.ticks / D.HZ) + '  ' + (f.rate >= 20 ? '»»' : f.rate >= 8 ? '»' : '▸') + ' ' + f.rate + 'x';
        text(t, W / 2, GY + 27, GREY, 10, 'center', 600);
    }

    // ---------- the trolls ----------
    function trolls(f, T) {
        const list = [];
        f.u.forEach((us, side) => us.forEach(u => list.push({ side, id: u[0], t: u[1], x: u[2], hp: u[3], stun: u[4] })));
        list.sort((a, b) => ((a.id * 7) % 3) - ((b.id * 7) % 3) || a.x - b.x);
        // the side with CAPS LOCK on glows
        f.p.forEach((p, side) => {
            if (!p.buff) return;
            c.fillStyle = SIDE[side]; c.globalAlpha = 0.22 + 0.1 * Math.sin(T * 12);
            for (const u of f.u[side]) { c.beginPath(); c.ellipse(X(u[2]), GY + 2, 16, 6, 0, 0, Math.PI * 2); c.fill(); }
            c.globalAlpha = 1;
        });
        for (const u of list) {
            const type = units[u.t], meta = D.ANIM[type.anim];
            let v = V.vis.get(u.id);
            if (!v) { v = { x: u.x, t: u.t, phase: (u.id * 0.37) % 1.28, atk: -9, atkDur: 0.5, walking: false }; V.vis.set(u.id, v); }
            v.walking = Math.abs(u.x - v.x) > 0.05;
            v.x = u.x; v.seen = T;
            const left = u.side === 0;
            const depth = (u.id * 7) % 3;
            // at 6x and up a troll moves on every other frame: it jumps at that
            // speed anyway, and the frames between cost half as much
            if (v.sx === undefined || f.rate < 6 || f.i % 2 === 0) v.sx = Math.round(X(u.x));
            const sx = v.sx, feet = GY + depth * 3;
            c.fillStyle = 'rgba(0,0,0,.22)';
            c.beginPath(); c.ellipse(sx, feet + 1, type.r * 0.75, 2.5, 0, 0, Math.PI * 2); c.fill();
            c.fillStyle = SIDE[u.side];
            c.fillRect(sx - type.r * 0.6, feet, type.r * 1.2, 2.5);
            const size = animSize(type);
            const swinging = T - v.atk < v.atkDur;
            const move = swinging ? 'attack' : 'walk';
            // the sheets step at half the film's rate: a troll standing in a
            // fight then changes every other frame, which halves what it costs
            const Tq = Math.floor(T * ANIM_FPS) / ANIM_FPS;
            const frame = swinging ? Math.max(0, Tq - v.atk) / v.atkDur * 16 : v.walking && !u.stun ? ((Tq + v.phase) / FRAME) % 16 : 0;
            const file = type.anim + '-' + move;
            sheet(c, file, meta.cell, frame, sx, feet - 1, size, animFlip(file, left), undefined, true);
            const top = feet - size * meta.h;
            if (u.stun) label('zZ', sx, top - 4, '#facc15', 9, 'center', 700);
            if (u.hp < 1) {
                const bw = Math.max(12, type.r * 1.1);
                c.fillStyle = 'rgba(139,148,158,.55)'; c.fillRect(sx - bw / 2 - 1, top - 3, bw + 2, 4);
                c.fillStyle = u.hp > 0.4 ? SIDE[u.side] : '#ef4444';
                c.fillRect(sx - bw / 2, top - 2, Math.max(1, bw * u.hp), 2);
            }
        }
        for (const [id, v] of V.vis) if (T - v.seen > 0.5) V.vis.delete(id);
    }

    function corpses(T) {
        const DIE = 0.06, life = 16 * DIE + 0.1, fade = 0.25;
        for (let i = V.corpses.length - 1; i >= 0; i--) {
            const k = V.corpses[i], age = T - k.at;
            if (age > life + fade) { V.corpses.splice(i, 1); continue; }
            const type = units[k.t], meta = D.ANIM[type.anim], file = type.anim + '-death';
            const alpha = age > life ? Math.max(0, 1 - (age - life) / fade) : 1;
            sheet(c, file, meta.cell, Math.floor(age * ANIM_FPS) / ANIM_FPS / DIE, Math.round(k.x), GY + k.depth * 3 - 1, animSize(type), animFlip(file, k.side === 0), alpha, true);
        }
    }

    function effects(f, T) {
        // the lane on fire
        for (const fr of f.fire) {
            const x = X(fr[1]), w = fr[2] * 0.465;
            c.fillStyle = 'rgba(249,115,22,.22)'; c.fillRect(x - w / 2, GY - 6, w, 14);
            for (let i = 0; i < 14; i++) {
                const fx = x - w / 2 + (i + 0.5) * w / 14;
                const fh = 8 + Math.abs(Math.sin(T * 9 + i * 2.1)) * 16;
                c.fillStyle = i % 2 ? '#f97316' : '#facc15';
                c.beginPath(); c.moveTo(fx - 5, GY + 8); c.quadraticCurveTo(fx - 4, GY + 8 - fh * 0.6, fx, GY + 8 - fh); c.quadraticCurveTo(fx + 4, GY + 8 - fh * 0.6, fx + 5, GY + 8); c.fill();
            }
        }
        // the specials
        for (let i = V.fx.length - 1; i >= 0; i--) {
            const e = V.fx[i], k = (T - e.at);
            if (k > 1.1) { V.fx.splice(i, 1); continue; }
            if (e.k === 'popups') {
                for (let n = 0; n < 6; n++) {
                    const px = e.x + (((e.seed * 997 + n * 37) % 1) - 0.5) * 80, d = Math.min(1, Math.max(0, (k - n * 0.06) / 0.35));
                    const py = 90 + d * (GY - 110);
                    c.globalAlpha = k > 0.8 ? (1.1 - k) / 0.3 : 1;
                    c.fillStyle = '#e5e7eb'; c.fillRect(px - 11, py - 7, 22, 15);
                    c.fillStyle = '#1d4ed8'; c.fillRect(px - 11, py - 7, 22, 4);
                    c.strokeStyle = INK; c.lineWidth = 1; c.strokeRect(px - 11, py - 7, 22, 15);
                    c.fillStyle = '#ef4444'; c.fillRect(px - 3, py, 6, 4);
                    c.globalAlpha = 1;
                }
            } else if (e.k === 'ban') {
                const d = Math.min(1, k / 0.25);
                const hy = 70 + d * (GY - 90);
                c.globalAlpha = k > 0.8 ? (1.1 - k) / 0.3 : 1;
                c.fillStyle = '#78350f'; c.fillRect(e.x - 2, hy - 30, 4, 30);
                c.fillStyle = '#94a3b8'; c.strokeStyle = INK; c.lineWidth = 1.2;
                c.fillRect(e.x - 14, hy - 4, 28, 14); c.strokeRect(e.x - 14, hy - 4, 28, 14);
                c.globalAlpha = 1;
                if (d >= 1) { c.strokeStyle = '#facc15'; c.lineWidth = 2; c.globalAlpha = Math.max(0, 1 - (k - 0.25) / 0.6); c.beginPath(); c.ellipse(e.x, GY + 4, 10 + (k - 0.25) * 70, 4 + (k - 0.25) * 12, 0, 0, Math.PI * 2); c.stroke(); c.globalAlpha = 1; }
            } else if (e.k === 'bsod') {
                const foe = 1 - e.s;
                const xs = f.u[foe].map(u => X(u[2]));
                if (xs.length) {
                    const a = Math.min(...xs) - 20, b = Math.max(...xs) + 20;
                    c.globalAlpha = 0.55 * Math.max(0, 1 - k / 1.1);
                    c.fillStyle = '#1d4ed8'; c.fillRect(a, GY - 70, b - a, 82);
                    c.globalAlpha = Math.max(0, 1 - k / 1.1);
                    label(':(', (a + b) / 2, GY - 54, '#ffffff', 16, 'center', 700);
                    c.globalAlpha = 1;
                }
            } else if (e.k === 'caps') {
                c.globalAlpha = Math.max(0, 1 - k / 1.1);
                label('CAPS LOCK', e.s ? X(D.FRONT[1]) - 60 : X(D.FRONT[0]) + 60, GY - 70 - k * 10, '#facc15', 12, 'center', 800);
                c.globalAlpha = 1;
            }
        }
    }

    function shots(T) {
        for (let i = V.shots.length - 1; i >= 0; i--) {
            const s = V.shots[i], k = (T - s.at) / s.d;
            if (k >= 1) { V.shots.splice(i, 1); continue; }
            if (k < 0) continue;
            const x = s.x0 + (s.x1 - s.x0) * k;
            const y = s.y0 + (s.y1 - s.y0) * k - (s.shell ? Math.sin(k * Math.PI) * 40 : 0);
            const shot = s.anim && D.ANIM[s.anim].shot;
            if (shot) {
                sheet(c, s.anim + '-projectile', shot.cell, ((T - s.at) / FRAME) % 16, x, y + 8, 18, s.x1 < s.x0);
            } else if (s.tracer) {
                const k0 = Math.max(0, k - 0.35);
                c.strokeStyle = s.s ? '#fb923c' : '#38bdf8'; c.lineWidth = 2;
                c.beginPath(); c.moveTo(s.x0 + (s.x1 - s.x0) * k0, s.y0 + (s.y1 - s.y0) * k0); c.lineTo(x, y); c.stroke();
            } else {
                c.fillStyle = s.s ? '#fdba74' : '#7dd3fc'; c.strokeStyle = INK; c.lineWidth = 1;
                c.beginPath(); c.arc(x, y, s.shell ? 3.5 : 2.5, 0, Math.PI * 2); c.fill(); c.stroke();
            }
        }
        for (let i = V.rings.length - 1; i >= 0; i--) {
            const r = V.rings[i], k = (T - r.at) / 0.3;
            if (k >= 1) { V.rings.splice(i, 1); continue; }
            if (k < 0) continue;
            c.strokeStyle = '#fb923c'; c.lineWidth = 2; c.globalAlpha = 1 - k;
            c.beginPath(); c.ellipse(r.x, GY + 4, 4 + r.max * k, 2 + r.max * 0.25 * k, 0, 0, Math.PI * 2); c.stroke();
            c.globalAlpha = 1;
        }
        for (let i = V.sparks.length - 1; i >= 0; i--) {
            const s = V.sparks[i], k = (T - s.at) / 0.22;
            if (k >= 1) { V.sparks.splice(i, 1); continue; }
            const r = 2 + k * 6;
            c.strokeStyle = s.c; c.lineWidth = 2; c.globalAlpha = 1 - k;
            c.beginPath();
            for (let a = 0; a < 4; a++) {
                const ang = a * Math.PI / 2 + 0.6;
                c.moveTo(s.x + Math.cos(ang) * r * 0.4, s.y + Math.sin(ang) * r * 0.4);
                c.lineTo(s.x + Math.cos(ang) * r, s.y + Math.sin(ang) * r);
            }
            c.stroke();
            c.strokeStyle = 'rgba(13,17,23,.5)'; c.lineWidth = 0.8; c.stroke();
            c.globalAlpha = 1;
        }
    }

    function banners(T) {
        let row = 0;
        for (let i = V.banners.length - 1; i >= 0; i--) {
            const b = V.banners[i], k = T - b.at;
            if (k > 1.9) { V.banners.splice(i, 1); continue; }
            const a = Math.min(1, k / 0.15, (1.9 - k) / 0.3);
            pill(b.t, W / 2, 96 + row * 24, b.s ? '#c2410c' : '#0369a1', 12, a);
            row++;
        }
    }

    function ending(f, T) {
        if (!f.over) return;
        if (V.endAt === null) V.endAt = T;
        const k = T - V.endAt - 0.35;
        if (k < 0) return;
        const a = Math.min(1, k / 0.3);
        const s = 1 + 0.15 * Math.max(0, 1 - k / 0.3);
        const w = f.winner, b = M.bots[w];
        c.save();
        c.translate(W / 2, 128); c.scale(s, s);
        c.globalAlpha = a;
        c.font = '800 24px ' + FONT;
        const t = b.name + ' wins';
        const tw = c.measureText(t).width + 54;
        const g = c.createLinearGradient(-tw / 2, 0, tw / 2, 0);
        g.addColorStop(0, w ? '#9a3412' : '#0b3d91'); g.addColorStop(1, SIDE[w]);
        rr(-tw / 2, -24, tw, 48, 12); c.fillStyle = g; c.fill();
        c.lineWidth = 2; c.strokeStyle = RIM; c.stroke();
        // a little crown
        c.fillStyle = '#facc15'; c.strokeStyle = INK; c.lineWidth = 1;
        c.beginPath(); c.moveTo(-tw / 2 + 14, 6); c.lineTo(-tw / 2 + 14, -6); c.lineTo(-tw / 2 + 19, -1); c.lineTo(-tw / 2 + 23, -9); c.lineTo(-tw / 2 + 27, -1); c.lineTo(-tw / 2 + 32, -6); c.lineTo(-tw / 2 + 32, 6); c.closePath(); c.fill(); c.stroke();
        c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(t, 12, -3);
        c.font = '600 11px ' + FONT;
        c.fillStyle = 'rgba(255,255,255,.9)';
        c.fillText(b.diff + ' ' + b.plan + ' bot · ' + M.minutes + ' min · age ' + (f.p[w].age + 1) + ' vs ' + (f.p[1 - w].age + 1), 12, 15);
        c.restore();
    }

    function draw(f) {
        const T = f.i / FPS;
        V.T = T;
        c.clearRect(0, 0, W, H);
        events(f, T);
        if (f.over && V.endAt === null) V.endAt = T;
        lane(f);
        base(0, f, T); base(1, f, T);
        effects(f, T);
        corpses(T);
        trolls(f, T);
        shots(T);
        info(0, f); info(1, f);
        banners(T);
        clockLine(f);
        header(f);
        ending(f, T);
    }
    window.drawFrames = frames => frames.map(f => { draw(f); return cv.toDataURL('image/png'); });
}

// ---------- making the films ----------
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, out, err) => e ? rej(new Error(err || e.message)) : res(out)));

// sharp (libvips) when it can be found, because it can lose a little of the alpha
// plane, which is most of the bytes of a transparent film; ffmpeg otherwise
const require = createRequire(import.meta.url);
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* ffmpeg it is */ }
const LADDER = opt('quality', null) ? [opt('quality').split(',').map(Number)] : [[38, 35], [34, 30], [30, 25], [27, 20], [24, 16], [22, 12], [20, 8]];   // [quality, alpha quality]

async function encode(dir, file) {
    const frames = fs.readdirSync(dir).filter(f => /^f\d{4}\.png$/.test(f)).sort().map(f => path.join(dir, f));
    let bytes = 0, q;
    for (const [lq, aq] of LADDER) {
        q = lq;
        if (sharp) {
            await sharp(frames, { join: { animated: true }, limitInputPixels: false })
                .webp({ quality: q, alphaQuality: aq, effort: 6, loop: 0, delay: frames.map(() => Math.round(1000 / FPS)) })
                .toFile(file);
        } else {
            await run(FFMPEG, ['-y', '-v', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%04d.png'),
                '-c:v', 'libwebp_anim', '-pix_fmt', 'yuva420p', '-lossless', '0', '-quality', String(q),
                '-compression_level', '6', '-loop', '0', file]);
        }
        bytes = fs.statSync(file).size;
        if (bytes <= AIM_BYTES) break;
    }
    return { bytes, q };
}

async function main() {
    const t0 = Date.now();
    log(`looking for ${COUNT} matches from seed index ${BASE}`);
    const all = pickMatches(COUNT);
    log(`found them in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const todo = ONLY ? ONLY.map(n => [n, all[n - 1]]) : all.map((m, i) => [i + 1, m]);
    fs.mkdirSync(OUT, { recursive: true });
    log('encoder: ' + (sharp ? 'sharp ' + sharp.versions.sharp + ' (libwebp ' + sharp.versions.webp + ')' : FFMPEG));

    const { chromium } = require('playwright');
    const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
    const animDir = path.join(SITE, 'games/age-of-troll/anim');
    const sheets = fs.readdirSync(animDir).filter(f => f.endsWith('.webp')).map(f => f.replace(/\.webp$/, ''));
    const D = {
        W, H, FPS, HZ, LANE: A.LANE, FRONT: A.BASE_FRONT, MID: A.MID, BOSS: A.BOSS,
        UNITS: A.UNITS.map(u => ({ id: u.id, anim: u.anim, size: u.size, r: u.r, role: u.role })),
        ANIM: A.ANIM, LOOKS_LEFT: A.ANIM_LOOKS_LEFT || {},
        AGES: A.AGES.map(a => a.name),
        SPECIALS: Object.fromEntries(A.SPECIALS.map(s => [s.key, s.name]))
    };
    const results = [];
    const queue = todo.slice();
    async function worker() {
        const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
        await ctx.route('http://aot.local/**', route => {
            const u = new URL(route.request().url());
            if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">' });
            const m = u.pathname.match(/^\/anim\/([\w-]+\.webp)$/);
            if (m && fs.existsSync(path.join(animDir, m[1]))) return route.fulfill({ contentType: 'image/webp', body: fs.readFileSync(path.join(animDir, m[1])) });
            return route.fulfill({ status: 404, body: '' });
        });
        await ctx.route(/^(?!http:\/\/aot\.local\/).*/, route => route.abort());
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('http://aot.local/');
        await page.addScriptTag({ content: '(' + pageMain.toString() + ')(' + JSON.stringify(D) + ');' });
        await page.evaluate(n => window.loadSheets(n), sheets);
        while (queue.length) {
            const [n, m] = queue.shift();
            const name = 'match-' + String(n).padStart(2, '0');
            const { s: S, bots: BOTS, seed: SEED } = m;
            const rp = A.replay.replayOf(S, { names: [BOTS[0].name, BOTS[1].name], label: 'readme' });
            const code = await A.replay.encode(rp);
            const back = await A.replay.decode(code);
            const v = back.rp && A.replay.verify(back.rp);
            if (!v || !v.ok) throw new Error(name + ': the replay does not play back the way it was recorded');
            const base = SITE_URL + '?app=ageoftroll';
            const link = base + (base.length + 8 + code.length <= LINK_MAX ? '&replay=' : '#replay=') + code;
            const frames = filmFrames(back.rp, paceOf(m.timeline));
            const minutes = Math.round(m.minutes);
            await page.evaluate(meta => window.reset(meta), { bots: BOTS, names: BOTS.map(b => b.name), minutes, ticks: S.tick, seed: SEED });
            const dir = KEEP ? path.join(path.resolve(KEEP), name) : fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aot-' + name + '-'));
            fs.mkdirSync(dir, { recursive: true });
            for (let i = 0; i < frames.length; i += 24) {
                const urls = await page.evaluate(b => window.drawFrames(b), frames.slice(i, i + 24));
                urls.forEach((u, j) => fs.writeFileSync(path.join(dir, 'f' + String(i + j).padStart(4, '0') + '.png'), Buffer.from(u.slice(u.indexOf(',') + 1), 'base64')));
            }
            if (errors.length) throw new Error(name + ': page errors: ' + errors.join('; '));
            const file = path.join(OUT, name + '.webp');
            const { bytes, q } = await encode(dir, file);
            if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
            const winner = BOTS[S.winner];
            log(`${name}: seed ${SEED}, ${BOTS[0].name} (${BOTS[0].diff}/${BOTS[0].plan}) vs ${BOTS[1].name} (${BOTS[1].diff}/${BOTS[1].plan}), ` +
                `${m.minutes.toFixed(1)} min, ${winner.name} wins; ${frames.length} frames, ${(bytes / 1024).toFixed(0)} KB at q${q}`);
            results.push({
                n, file: name + '.webp', seed: SEED,
                left: { name: BOTS[0].name, difficulty: BOTS[0].diff, plan: BOTS[0].plan, age: S.p[0].age + 1, kills: S.p[0].kills },
                right: { name: BOTS[1].name, difficulty: BOTS[1].diff, plan: BOTS[1].plan, age: S.p[1].age + 1, kills: S.p[1].kills },
                minutes: +m.minutes.toFixed(2),
                winner: { side: S.winner === 0 ? 'left' : 'right', name: winner.name },
                film: { bytes, seconds: +(frames.length / FPS).toFixed(1), fps: FPS, width: W, height: H },
                link
            });
        }
        await ctx.close();
    }
    try {
        await Promise.all(Array.from({ length: Math.max(1, Math.min(JOBS, todo.length)) }, worker));
    } finally {
        await browser.close();
    }
    // matches.json: the list, merged with what is already there when only some were redrawn
    const jsonFile = path.join(OUT, 'matches.json');
    let list = [];
    if (ONLY && fs.existsSync(jsonFile)) list = JSON.parse(fs.readFileSync(jsonFile, 'utf8')).matches || [];
    for (const r of results) { list = list.filter(x => x.n !== r.n); list.push(r); }
    list.sort((a, b) => a.n - b.n);
    fs.writeFileSync(jsonFile, JSON.stringify({
        generated: new Date().toISOString(),
        about: 'age of troll bot matches for the profile README, made by scripts/age-of-troll-readme.mjs',
        rules: A.replay.RULES_REV,
        play: SITE_URL + '?app=ageoftroll',
        matches: list
    }, null, 2) + '\n');
    const total = list.reduce((t, m) => t + m.film.bytes, 0);
    log(`wrote ${results.length} films and matches.json to ${OUT}: ${list.length} matches, ${(total / 1024 / 1024).toFixed(1)} MB, ` +
        `${((Date.now() - t0) / 1000).toFixed(0)} s`);
    const big = list.filter(m => m.film.bytes > MAX_BYTES);
    if (big.length) { console.error('over 1.5 MB: ' + big.map(m => m.file).join(', ')); process.exitCode = 1; }
}

main().catch(e => { console.error(e); process.exit(1); });
