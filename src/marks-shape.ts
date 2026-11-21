// Mark shape — the stats block an agent reads about a mark's geometry.
//
// A mark is a set of items the reader picked out on the map (marks.ts). Its shape block is a small set of computed
// facts about that set, handed to any agent that opens the mark next to the member texts. No model writes any of it:
// the agent, under the reader's own prompt, does the reading; the block keeps the reading tied to something true.
//
// Two spaces, never mixed. "On the map" is the layout the reader looks at: the meaning-in-3D + time layout of the tour
// (pT), a flattening. "In meaning" is the full embedding, centred (the direction every item shares removed, since raw
// cosine between random items on this embedder is ~0.77). The measures that have one are reported next to their floor: what a
// random set of the same size scores on this atlas. Under PAIRS_BELOW items there is no shape to measure (the shuffled floor
// is as high as the signal), so the block switches to a table of pairs.
//
// The cut-offs below were read off a probe of one atlas (Nov 2026, 7,992 items, nomic-embed-text) on stand-in marks,
// not tuned on real ones. They are for that atlas and that embedder; re-read them once there are real marks.

import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { field, fieldPoles, fieldDocs, loadVectors } from './field.js';
import type { FieldView } from './field.js';
import { seeded, shortOrigin, symEigen, DAY } from './field-core.js';

export const PAIRS_BELOW = 12;
const SHAPE_REV = 's3';       // bump when the block's computation changes, so stored blocks are recomputed once
const COPY = 0.98;             // similarity at or above this is the same text held twice (a mirror, a stub's copy): skipped as a neighbour
const MEMBER_CAP = 400;        // above this, the pairwise measurements use a sample of the members
const FLOOR_DRAWS = 40;        // random sets drawn for each floor
const SHUFFLES = 20;           // shuffles of the positions along the line, for the grade's floor
const RELATIVES = 8;           // nearest non-members in meaning
const AGREE_SAMPLE = 300, AGREE_K = 10;
const BULK_DATED = { window_ms: 5 * 60_000, min: 25 };   // ≥ this many items of one blyg created within ± window: an import
export const CUT = {
  streak: 0.8,         // share of the on-map spread along one line
  along_time: 0.7,     // |time component| of the long axis
  across: 0.3,
  ordered: 0.5,        // |rank correlation| of position along the line with time
  changes: 0.45,       // grade: meaning changes along the line
  steady: 0.25,        // grade: meaning steady along the line
  pocket: 0.4, slice: 0.15,
};

// ---------------------------------------------------------------- the space: centred vectors in point order, cached

interface Space {
  key: string; v: FieldView; N: number; dim: number;
  G: Float32Array;                 // centred unit vectors, one row per field point (zero row when a point has no vector)
  trank: Float64Array;             // time rank in [0, 1], from the map's time axis
  bulkDated: Uint8Array;           // 1 = created inside a blyg's bulk import
  df: Map<string, number>;         // document frequency of each naming word over the field
  agree?: { map: number; map_time: number; own_blyg: number; sample: number };
}
let spaceCache: Space | null = null;

function space(db: Database.Database): Space {
  const v = field(db);
  if (spaceCache && spaceCache.v === v) return spaceCache;
  if (spaceCache && spaceCache.key === v.key) { spaceCache.v = v; return spaceCache; }   // only the reads moved
  const vec = loadVectors(db), dim = vec.dim, N = v.points.length;
  const row = new Map(vec.keys.map((k, i) => [k, i]));
  const G = new Float32Array(N * dim), mean = new Float64Array(dim);
  let have = 0;
  v.points.forEach((p, i) => {
    const r = row.get(`${p.origin}|${p.id}`);
    if (r === undefined) return;
    G.set(vec.m.subarray(r * dim, (r + 1) * dim), i * dim);
    for (let d = 0; d < dim; d++) mean[d] += G[i * dim + d];
    have++;
  });
  for (let d = 0; d < dim; d++) mean[d] /= have || 1;
  for (let i = 0; i < N; i++) {
    const o = i * dim;
    let mag = 0;
    for (let d = 0; d < dim; d++) mag += G[o + d] * G[o + d];
    if (!mag) continue;
    let m2 = 0;
    for (let d = 0; d < dim; d++) { G[o + d] -= mean[d]; m2 += G[o + d] * G[o + d]; }
    m2 = Math.sqrt(m2) || 1;
    for (let d = 0; d < dim; d++) G[o + d] /= m2;
  }
  const order = v.points.map((_, i) => i).sort((a, b) => v.points[a].pT[3] - v.points[b].pT[3] || a - b);
  const trank = new Float64Array(N);
  order.forEach((i, k) => { trank[i] = N > 1 ? k / (N - 1) : 0.5; });
  // bulk-dated: one night's import of a blyg's archive lands at one moment, and the map's time axis places by order
  const bulkDated = new Uint8Array(N);
  const byOrigin = new Map<string, { i: number; t: number }[]>();
  v.points.forEach((p, i) => { const t = Date.parse(p.created ?? ''); if (!Number.isFinite(t)) return; let a = byOrigin.get(p.origin); if (!a) byOrigin.set(p.origin, a = []); a.push({ i, t }); });
  for (const a of byOrigin.values()) {
    a.sort((x, y) => x.t - y.t);
    let lo = 0, hi = 0;
    for (const x of a) {
      while (hi < a.length && a[hi].t <= x.t + BULK_DATED.window_ms) hi++;
      while (a[lo].t < x.t - BULK_DATED.window_ms) lo++;
      if (hi - lo >= BULK_DATED.min) bulkDated[x.i] = 1;
    }
  }
  const df = new Map<string, number>();
  for (const doc of fieldDocs(db, v)) for (const t of doc) df.set(t, (df.get(t) ?? 0) + 1);
  spaceCache = { key: v.key, v, N, dim, G, trank, bulkDated, df };
  return spaceCache;
}

// ---------------------------------------------------------------- small measurements

const dotRows = (S: Space, a: number, b: number) => { let s = 0; const oa = a * S.dim, ob = b * S.dim; for (let d = 0; d < S.dim; d++) s += S.G[oa + d] * S.G[ob + d]; return s; };
const r2 = (x: number) => Number(x.toFixed(2));
const r3 = (x: number) => Number(x.toFixed(3));
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Mean similarity between pairs of members (centred). From the sum vector, since rows are unit: no self-term bias. */
function pairMean(S: Space, set: number[]): number {
  const n = set.length;
  if (n < 2) return 0;
  const sum = new Float64Array(S.dim);
  let self = 0;
  for (const i of set) { const o = i * S.dim; let m = 0; for (let d = 0; d < S.dim; d++) { sum[d] += S.G[o + d]; m += S.G[o + d] ** 2; } self += m; }
  let ss = 0; for (let d = 0; d < S.dim; d++) ss += sum[d] * sum[d];
  return (ss - self) / (n * (n - 1));
}

/** Every item's similarity to the set's centre (centred space). */
function toCentre(S: Space, set: number[]): Float32Array {
  const c = new Float64Array(S.dim);
  for (const i of set) { const o = i * S.dim; for (let d = 0; d < S.dim; d++) c[d] += S.G[o + d]; }
  let m = 0; for (let d = 0; d < S.dim; d++) m += c[d] * c[d];
  m = Math.sqrt(m) || 1;
  const out = new Float32Array(S.N);
  for (let i = 0; i < S.N; i++) { let s = 0; const o = i * S.dim; for (let d = 0; d < S.dim; d++) s += S.G[o + d] * c[d]; out[i] = s / m; }
  return out;
}

/** Of everything at least as close to the centre as the median member, the share that are members. */
function pocketOf(S: Space, set: number[], to: Float32Array): number {
  const r = median(set.map(i => to[i]));
  const mem = new Set(set);
  let inside = 0, members = 0;
  for (let i = 0; i < S.N; i++) if (to[i] >= r) { inside++; if (mem.has(i)) members++; }
  return inside ? members / inside : 0;
}

const ranks = (xs: ArrayLike<number>) => { const idx = Array.from({ length: xs.length }, (_, i) => i).sort((a, b) => xs[a] - xs[b]); const r = new Float64Array(xs.length); idx.forEach((i, k) => { r[i] = k; }); return r; };
function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length; if (n < 2) return 0;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  const d = Math.sqrt(saa * sbb); return d ? sab / d : 0;
}
const spearman = (a: ArrayLike<number>, b: ArrayLike<number>) => pearson(ranks(a), ranks(b));

const shuffle = <T>(xs: T[], rand: () => number): T[] => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function sample<T>(xs: T[], k: number, rand: () => number): T[] {
  if (xs.length <= k) return xs;
  const a = [...xs];
  for (let i = 0; i < k; i++) { const j = i + Math.floor(rand() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}
const randomSet = (S: Space, n: number, rand: () => number) => { const out = new Set<number>(); while (out.size < Math.min(n, S.N)) out.add(Math.floor(rand() * S.N)); return [...out]; };

/** Map-wide: how many of an item's 10 nearest on the map are among its 10 nearest in meaning; and how many of its
 *  10 nearest in meaning share its blyg. A standing caveat, computed once per layout and kept in `meta`. */
function agreement(db: Database.Database, S: Space): NonNullable<Space['agree']> {
  if (S.agree) return S.agree;
  const metaKey = 'mark_shape_agreement';
  try {
    const got = db.prepare(`SELECT value FROM meta WHERE key=?`).get(metaKey) as any;
    const j = got ? JSON.parse(got.value) : null;
    if (j && j.key === S.key) return (S.agree = j.agree);
  } catch { /* recompute */ }
  const rand = seeded(17), P = S.v.points;
  const picks = randomSet(S, AGREE_SAMPLE, rand);
  let map = 0, mapT = 0, own = 0;
  const topK = (score: (j: number) => number, i: number, hi: boolean) => {
    const best: [number, number][] = [];
    for (let j = 0; j < S.N; j++) {
      if (j === i) continue;
      const s = hi ? score(j) : -score(j);
      if (best.length < AGREE_K) { best.push([s, j]); best.sort((a, b) => a[0] - b[0]); }
      else if (s > best[0][0]) { best[0] = [s, j]; best.sort((a, b) => a[0] - b[0]); }
    }
    return new Set(best.map(b => b[1]));
  };
  for (const i of picks) {
    const nf = topK(j => dotRows(S, i, j), i, true);
    const p = P[i].pT;
    const n3 = topK(j => { const q = P[j].pT; return (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2; }, i, false);
    const n4 = topK(j => { const q = P[j].pT; return (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 + (q[3] - p[3]) ** 2; }, i, false);
    let a = 0, b = 0, c = 0;
    for (const j of nf) { if (n3.has(j)) a++; if (n4.has(j)) b++; if (P[j].origin === P[i].origin) c++; }
    map += a / AGREE_K; mapT += b / AGREE_K; own += c / AGREE_K;
  }
  const agree = { map: r3(map / picks.length), map_time: r3(mapT / picks.length), own_blyg: r3(own / picks.length), sample: picks.length };
  try { db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(metaKey, JSON.stringify({ key: S.key, agree })); } catch { /* read-only db: keep it in memory */ }
  return (S.agree = agree);
}

// ---------------------------------------------------------------- the block

export interface ShapeInput { members: { origin: string; id: string }[]; view?: any }
export type Shape = Record<string, any>;

/** The key a stored shape is valid under: the layout, plus a hash of the members. */
export function shapeKey(db: Database.Database, members: { origin: string; id: string }[], view?: any): string {
  const h = createHash('sha1').update(members.map(m => `${m.origin}|${m.id}`).sort().join('\n')).update(view?.rg === 'era' ? '|era' : '').digest('hex').slice(0, 16);
  return `${field(db).key}#${h}#${SHAPE_REV}`;
}

/** The words that set a set of items apart from the regions it sits in (the place line's "set apart by"), alone and
 *  fast: what a fresh lasso is named by before anything else is computed. */
export function apartTerms(db: Database.Database, input: ShapeInput, k = 3): string[] {
  const v = field(db), P = v.points;
  const placed = [...new Set(input.members.map(m => v.index.get(`${m.origin}|${m.id}`)).filter((i): i is number => i !== undefined))];
  if (!placed.length) return [];
  const cOf = input.view?.rg === 'era' ? (i: number) => P[i].cE : (i: number) => P[i].cT;
  const tops = new Set(placed.map(i => cOf(i).split('.')[0]));
  const bg = P.map((_, i) => i).filter(i => tops.has(cOf(i).split('.')[0]));
  return (fieldPoles(db, v, [placed], bg)[0] ?? []).slice(0, k);
}

export function computeShape(db: Database.Database, input: ShapeInput): Shape {
  const t0 = Date.now();
  const S = space(db), v = S.v, P = v.points;
  const all = input.members.map(m => v.index.get(`${m.origin}|${m.id}`));
  const placed = [...new Set(all.filter((i): i is number => i !== undefined))];
  const rand = seeded(23);
  const n = placed.length;
  const out: Shape = { n: input.members.length, placed: n, computed: new Date().toISOString(), layout: v.key };
  if (n < input.members.length) out.not_placed = input.members.length - n;
  if (!n) return { ...out, note: 'no member is on the map (no embedding yet)' };
  const era = input.view?.rg === 'era';
  const tree = era ? v.clustersE : v.clustersT, cOf = era ? (i: number) => P[i].cE : (i: number) => P[i].cT;
  const regionOf = new Map(tree.map(c => [c.path, c]));
  const label = (i: number) => P[i].author || shortOrigin(P[i].origin);
  const topName = (i: number) => { const c = regionOf.get(cOf(i).split('.')[0]); return c ? c.name.join(' · ') : '?'; };

  // ---- 1. who and when
  const tokens = (db.prepare(`SELECT COALESCE(SUM(LENGTH(content_text)), 0) AS c FROM items WHERE (origin, id) IN (${input.members.map(() => '(?, ?)').join(',')})`)
    .get(...input.members.flatMap(m => [m.origin, m.id])) as any).c;
  const byBlyg = new Map<string, { blyg: string; author: string | null; n: number }>();
  for (const i of placed) { const p = P[i]; const b = byBlyg.get(p.origin) ?? { blyg: shortOrigin(p.origin), author: p.author, n: 0 }; b.n++; byBlyg.set(p.origin, b); }
  const blygs = [...byBlyg.values()].sort((a, b) => b.n - a.n);
  const times = placed.map(i => Date.parse(P[i].created ?? '')).filter(Number.isFinite).sort((a, b) => a - b);
  const within = (w: number) => { let best = 0, lo = 0; for (let hi = 0; hi < times.length; hi++) { while (times[hi] - times[lo] > w) lo++; best = Math.max(best, hi - lo + 1); } return best; };
  out.who = {
    tokens: Math.round(tokens / 4), blygs: blygs.map(b => ({ ...b, share: r2(b.n / n) })), top_share: r2(blygs[0].n / n),
    first: times.length ? new Date(times[0]).toISOString() : null, last: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    span_days: times.length ? r2((times[times.length - 1] - times[0]) / DAY) : null, dated: times.length,
    within_1d: within(DAY), within_3d: within(3 * DAY), within_7d: within(7 * DAY),
    bulk_dated: placed.filter(i => S.bulkDated[i]).length, bulk_revised: placed.filter(i => (P[i].vb ?? 0) > 0).length,
  };

  // ---- 2. place
  const levels = [1, 2].map(depth => {
    const count = new Map<string, number>();
    for (const i of placed) { const p = cOf(i).split('.').slice(0, depth).join('.'); if (p) count.set(p, (count.get(p) ?? 0) + 1); }
    return [...count].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path, c]) => { const r = regionOf.get(path); return { path, name: r?.name ?? [], members: c, of_mark: r2(c / n), of_region: r ? r2(c / r.size) : null }; });
  });
  const bgPaths = new Set(levels[0].map(r => r.path));
  const bg = P.map((_, i) => i).filter(i => bgPaths.has(cOf(i).split('.')[0]));
  const [apart] = fieldPoles(db, v, [placed], bg);
  out.place = { tree: era ? 'themes + eras' : 'themes', regions: levels[0], sub_regions: levels[1], set_apart_by: apart ?? [] };

  // ---- links (both modes)
  const mem = new Set(placed);
  const inside: Record<string, number> = {}, answers = new Map<string, number>();
  const outBy = { region: new Map<string, number>(), blyg: new Map<string, number>() }, inBy = { region: new Map<string, number>(), blyg: new Map<string, number>() };
  let nOut = 0, nIn = 0, nInside = 0;
  const stubKids = new Map<number, number[]>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const [a, b, type] of v.edges) {   // a cites b
    const ia = mem.has(a), ib = mem.has(b);
    if (ia && ib) {
      nInside++; inside[type] = (inside[type] ?? 0) + 1;
      if (type === 'stub' || type === 'transclusion') bump(answers, `${label(a)} → ${label(b)}`);
      if (type === 'stub') { const k = stubKids.get(b) ?? []; k.push(a); stubKids.set(b, k); }
    } else if (ia) { nOut++; bump(outBy.region, topName(b)); bump(outBy.blyg, label(b)); }
    else if (ib) { nIn++; bump(inBy.region, topName(a)); bump(inBy.blyg, label(a)); }
  }
  const depthMemo = new Map<number, number>();
  const chain = (i: number, seen = new Set<number>()): number => { if (depthMemo.has(i)) return depthMemo.get(i)!; if (seen.has(i)) return 0; seen.add(i); const d = 1 + Math.max(0, ...(stubKids.get(i) ?? []).map(k => chain(k, seen))); depthMemo.set(i, d); return d; };
  const longest = stubKids.size ? Math.max(...placed.map(i => chain(i))) : 0;
  const top3 = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => ({ to: k, n: c }));
  out.links = {
    inside: nInside, inside_by_type: inside, longest_reply_chain: longest >= 2 ? longest : 0,
    answers: [...answers].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c]) => ({ pair: k, n: c })),
    out: nOut, out_by_region: top3(outBy.region), out_by_blyg: top3(outBy.blyg),
    in: nIn, in_by_region: top3(inBy.region), in_by_blyg: top3(inBy.blyg),
    net: nIn - nOut,   // > 0: cited from outside more than it cites out (the arrow space's cited → citing sense)
  };

  if (n < PAIRS_BELOW) {
    out.mode = 'pairs';
    out.pairs = pairsTable(db, S, placed, rand);
    out.ms = Date.now() - t0;
    return out;
  }
  out.mode = 'shape';
  const sm = n > MEMBER_CAP ? sample(placed, MEMBER_CAP, rand) : placed;
  if (sm !== placed) out.sampled = sm.length;

  // ---- 3. on the map (meaning in 3D + time)
  const mean4 = [0, 1, 2, 3].map(d => placed.reduce((s, i) => s + P[i].pT[d], 0) / n);
  const C = [0, 1, 2, 3].map(p => [0, 1, 2, 3].map(q => placed.reduce((s, i) => s + (P[i].pT[p] - mean4[p]) * (P[i].pT[q] - mean4[q]), 0) / n));
  const eig = symEigen(C);
  const total = eig.values.reduce((s, x) => s + Math.max(x, 0), 0) || 1;
  let dir = eig.vectors[0];
  const elong = Math.max(eig.values[0], 0) / total, timeComp = Math.abs(dir[3]);
  let pos = placed.map(i => P[i].pT.reduce((s, x, d) => s + (x - mean4[d]) * dir[d], 0));
  let tAlong = spearman(pos, placed.map(i => S.trank[i]));
  if (tAlong < 0) { dir = dir.map(x => -x); pos = pos.map(x => -x); tAlong = -tAlong; }   // the "other" end is the later one
  const order = placed.map((_, k) => k).sort((a, b) => pos[a] - pos[b]);
  const third = Math.max(1, Math.floor(n / 3));
  const endA = order.slice(0, third).map(k => placed[k]), endB = order.slice(-third).map(k => placed[k]);
  const [termsA, termsB] = fieldPoles(db, v, [endA, endB], placed);
  const endItem = (i: number) => ({ title: P[i].title, blyg: label(i), id: P[i].id, created: P[i].created });
  const endBlygs = (set: number[]) => { const m = new Map<string, number>(); for (const i of set) bump(m, label(i)); return [...m].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k); };
  const radius = Math.max(...placed.map(i => Math.sqrt(P[i].pT.reduce((s, x, d) => s + (x - mean4[d]) ** 2, 0))));
  out.on_map = {
    space: 'meaning (3D) + time', shape: elong >= CUT.streak ? 'streak' : 'blob', along_one_line: r2(elong),
    axis: timeComp >= CUT.along_time ? 'along time' : timeComp <= CUT.across ? 'across meaning' : 'diagonal', time_component: r2(timeComp),
    time_along_line: r2(tAlong), time_ordered: tAlong >= CUT.ordered,
    ends: [{ terms: termsA ?? [], blygs: endBlygs(endA), item: endItem(placed[order[0]]) }, { terms: termsB ?? [], blygs: endBlygs(endB), item: endItem(placed[order[n - 1]]) }],
  };

  // ---- 4. in meaning
  const tight = pairMean(S, placed);
  const randTight = median(Array.from({ length: FLOOR_DRAWS }, () => pairMean(S, randomSet(S, n, rand))));
  const near = P.map((p, i) => [p.pT.reduce((s, x, d) => s + (x - mean4[d]) ** 2, 0), i] as [number, number]).sort((a, b) => a[0] - b[0]).slice(0, n).map(x => x[1]);
  const mapTight = pairMean(S, near);
  const to = toCentre(S, placed);
  const pocket = pocketOf(S, placed, to);
  const randPocket = median(Array.from({ length: Math.min(FLOOR_DRAWS, 20) }, () => { const r = randomSet(S, n, rand); return pocketOf(S, r, toCentre(S, r)); }));
  let wSum = 0, wN = 0, aSum = 0, aN = 0;
  const sims = new Float32Array(sm.length * sm.length);
  for (let x = 0; x < sm.length; x++) for (let y = x + 1; y < sm.length; y++) {
    const s = dotRows(S, sm[x], sm[y]); sims[x * sm.length + y] = sims[y * sm.length + x] = s;
    if (P[sm[x]].origin === P[sm[y]].origin) { wSum += s; wN++; } else { aSum += s; aN++; }
  }
  const outsiders = P.map((_, i) => i).filter(i => !mem.has(i)).sort((a, b) => to[b] - to[a]);
  const copies = outsiders.filter(i => to[i] >= COPY).length;
  const rel = outsiders.filter(i => to[i] < COPY).slice(0, RELATIVES);
  const relatives = rel.map(i => {
    const d = Math.sqrt(P[i].pT.reduce((s, x, k) => s + (x - mean4[k]) ** 2, 0));
    return { title: P[i].title, blyg: label(i), id: P[i].id, similarity: r2(to[i]), region: topName(i), on_map: d <= radius * 1.25 ? 'near the mark' : 'drawn elsewhere' };
  });
  out.in_meaning = {
    tightness: r2(tight), floor_random: r2(randTight), floor_map_neighbourhood: r2(mapTight),
    pocket: r2(pocket), pocket_floor_random: r2(randPocket),
    within_blyg: wN ? r2(wSum / wN) : null, across_blygs: aN ? r2(aSum / aN) : null, within_pairs: wN, across_pairs: aN,
    relatives, relatives_elsewhere: relatives.filter(r => r.on_map === 'drawn elsewhere').length, ...(copies ? { copies_skipped: copies } : {}),
  };

  // ---- 5. does the shape hold
  if (out.on_map.shape === 'streak') {
    const posS = sm.map(i => pos[placed.indexOf(i)]);
    const m = sm.length, sep: number[] = [], dist: number[] = [];
    for (let x = 0; x < m; x++) for (let y = x + 1; y < m; y++) { sep.push(Math.abs(posS[x] - posS[y])); dist.push(1 - sims[x * m + y]); }
    const rd = ranks(dist);
    const grade = pearson(ranks(sep), rd);
    const shuffled: number[] = [];
    for (let s = 0; s < SHUFFLES; s++) {
      const sh = shuffle(posS, rand), sp: number[] = [];
      for (let x = 0; x < m; x++) for (let y = x + 1; y < m; y++) sp.push(Math.abs(sh[x] - sh[y]));
      shuffled.push(Math.abs(pearson(ranks(sp), rd)));
    }
    const floor = shuffled.reduce((s, x) => s + x, 0) / SHUFFLES;
    const changes = grade >= CUT.changes, steady = grade <= CUT.steady, alongTime = out.on_map.axis === 'along time';
    const importDated = out.who.bulk_dated >= n / 2;   // then the time axis is import order and cannot tell a drift from a range
    const statement = changes ? (importDated ? 'a range of meaning (the dates are a bulk import\'s, so time cannot say whether it is a drift)' : out.on_map.time_ordered ? 'a drift: meaning moving over time' : 'a range of meaning at one moment')
      : steady ? (alongTime ? 'one subject persisting' : 'the line is mostly the flattening')
      : 'between: meaning changes somewhat along the line';
    out.holds = { kind: 'streak', grade: r2(grade), grade_floor: r2(floor), meaning_along_line: changes ? 'changes' : steady ? 'steady' : 'somewhat', statement };
  } else {
    const statement = pocket >= CUT.pocket ? 'a whole pocket' : pocket <= CUT.slice ? 'a slice through something larger' : 'part of a pocket';
    out.holds = { kind: 'blob', tightness: r2(tight), floor_random: r2(randTight), pocket: r2(pocket), pocket_floor: r2(randPocket), statement };
  }
  out.ms = Date.now() - t0;
  return out;
}

/** Under PAIRS_BELOW items: one row per pair, and each member's nearest non-member. */
function pairsTable(db: Database.Database, S: Space, set: number[], rand: () => number) {
  const P = S.v.points, docs = fieldDocs(db, S.v);
  const lbl = (i: number) => P[i].author || shortOrigin(P[i].origin);
  const link = new Map<string, string>();
  for (const [a, b, type] of S.v.edges) link.set(`${a}|${b}`, type);
  const verb = (t: string) => ({ stub: 'responds to', transclusion: 'quotes', link: 'links to', fork: 'forks' } as Record<string, string>)[t] ?? t;
  const rows = [];
  for (let x = 0; x < set.length; x++) for (let y = x + 1; y < set.length; y++) {
    const a = set[x], b = set[y];
    const ta = Date.parse(P[a].created ?? ''), tb = Date.parse(P[b].created ?? '');
    const ab = link.get(`${a}|${b}`), ba = link.get(`${b}|${a}`);
    const shared = [...docs[a]].filter(t => docs[b].has(t)).sort((p, q) => (S.df.get(p) ?? 1) - (S.df.get(q) ?? 1)).slice(0, 4);
    rows.push({ a: P[a].id, b: P[b].id, a_title: P[a].title, b_title: P[b].title, similarity: r2(dotRows(S, a, b)), same_blyg: P[a].origin === P[b].origin,
      days_apart: Number.isFinite(ta) && Number.isFinite(tb) ? r2(Math.abs(ta - tb) / DAY) : null,
      link: ab ? `${lbl(a)} ${verb(ab)} ${lbl(b)}` : ba ? `${lbl(b)} ${verb(ba)} ${lbl(a)}` : null, shared_terms: shared });
  }
  rows.sort((p, q) => q.similarity - p.similarity);
  const mem = new Set(set);
  const nearest = set.map(i => {
    let best = -1, bs = -Infinity;
    for (let j = 0; j < S.N; j++) { if (mem.has(j)) continue; const s = dotRows(S, i, j); if (s < COPY && s > bs) { bs = s; best = j; } }
    return { member: P[i].id, member_title: P[i].title, nearest: best >= 0 ? { title: P[best].title, blyg: lbl(best), id: P[best].id, similarity: r2(bs) } : null };
  });
  // floors: a random pair, and a random pair from one blyg
  const rp: number[] = [], sp: number[] = [];
  const byOrigin = new Map<string, number[]>();
  P.forEach((p, i) => { const a = byOrigin.get(p.origin) ?? []; a.push(i); byOrigin.set(p.origin, a); });
  const big = [...byOrigin.values()].filter(a => a.length >= 2);
  for (let k = 0; k < 400; k++) {
    const a = Math.floor(rand() * S.N), b = Math.floor(rand() * S.N); if (a !== b) rp.push(dotRows(S, a, b));
    const g = big[Math.floor(rand() * big.length)]; const c = g[Math.floor(rand() * g.length)], d = g[Math.floor(rand() * g.length)]; if (c !== d) sp.push(dotRows(S, c, d));
  }
  return { rows, nearest_outsiders: nearest, floor_random_pair: r2(median(rp)), floor_same_blyg_pair: r2(median(sp)) };
}

/** The parts that depend on the other marks and on the reader's history: computed when a mark is opened, not stored. */
export function liveParts(db: Database.Database, members: { origin: string; id: string }[], others: { id: number; name: string; state: string; members: { origin: string; id: string }[] }[], opts: { reads?: boolean } = {}) {
  const S = space(db), v = S.v, P = v.points;
  const idx = (ms: { origin: string; id: string }[]) => ms.map(m => v.index.get(`${m.origin}|${m.id}`)).filter((i): i is number => i !== undefined);
  const mine = idx(members), mineSet = new Set(mine);
  const keys = new Set(members.map(m => `${m.origin}|${m.id}`));
  const centre = (set: number[]) => { const c = new Float64Array(S.dim); for (const i of set) for (let d = 0; d < S.dim; d++) c[d] += S.G[i * S.dim + d]; const m = Math.sqrt(c.reduce((s, x) => s + x * x, 0)) || 1; return c.map(x => x / m); };
  const myC = mine.length ? centre(mine) : null;
  const otherMarks = others.map(o => {
    const theirs = idx(o.members), tSet = new Set(theirs);
    const shared = o.members.filter(m => keys.has(`${m.origin}|${m.id}`)).length;
    let links = 0;
    for (const [a, b] of v.edges) if ((mineSet.has(a) && tSet.has(b)) || (tSet.has(a) && mineSet.has(b))) links++;
    const c = theirs.length && myC ? centre(theirs) : null;
    const sim = c && myC ? c.reduce((s, x, d) => s + x * myC[d], 0) : null;
    return { id: o.id, name: o.name, state: o.state, shared, links, similarity: sim === null ? null : r2(sim) };
  }).filter(o => o.shared || o.links || o.similarity !== null).sort((a, b) => (b.shared - a.shared) || (b.links - a.links) || ((b.similarity ?? -1) - (a.similarity ?? -1))).slice(0, 5);
  const agree = agreement(db, S);
  const out: Record<string, any> = { other_marks: otherMarks, map_caveat: agree };
  if (opts.reads) out.reads = { opened: mine.filter(i => P[i].reads > 0).length, of: mine.length };
  return out;
}

// ---------------------------------------------------------------- the text an agent reads

const f2 = (x: number | null | undefined) => x === null || x === undefined ? '—' : x.toFixed(2);
const fmtDay = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '?';
const q = (s: string | null | undefined, k = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return `"${t.length > k ? t.slice(0, k - 1) + '…' : t}"`; };

export function renderShape(name: string, sh: Shape, live?: Record<string, any>): string {
  const L: string[] = [];
  const w = sh.who;
  L.push(`MARK ${q(name || '(unnamed)')} · ${sh.n} items${sh.not_placed ? ` (${sh.not_placed} not on the map)` : ''} · ~${(w?.tokens ?? 0).toLocaleString()} tokens`);
  if (!w) { L.push(sh.note ?? ''); return L.join('\n'); }
  const span = w.first ? (w.span_days < 1 ? fmtDay(w.first) : `${fmtDay(w.first)} – ${fmtDay(w.last)}`) : 'undated';
  const bunch = w.dated > 1 && w.span_days >= 1 && (w.within_1d >= 2 || w.within_7d >= 3) ? ` · ${w.within_1d} within one day, ${w.within_7d} within a week` : '';
  const bulk = [w.bulk_dated ? `${w.bulk_dated} dated by a bulk import` : '', w.bulk_revised ? `${w.bulk_revised} bulk-revised` : ''].filter(Boolean).join(', ');
  L.push(`who/when: ${w.blygs.length} blyg${w.blygs.length === 1 ? '' : 's'} (${w.blygs.slice(0, 4).map((b: any) => `${b.author || b.blyg} ${b.n}`).join(', ')}${w.blygs.length > 4 ? ', …' : ''}) · ${span}${bunch}${bulk ? ` · ${bulk}` : ''}`);
  const r0 = sh.place.regions[0];
  L.push(`place: ${r0.members} of ${sh.placed} in region ${q(r0.name.join(' · '))} (${Math.round(100 * (r0.of_region ?? 0))}% of it)${sh.place.regions.length > 1 ? `, ${sh.place.regions.slice(1).map((r: any) => `${r.members} in ${q(r.name.join(' · '), 40)}`).join(', ')}` : ''}${sh.place.set_apart_by.length ? ` · set apart by: ${sh.place.set_apart_by.join(', ')}` : ''}`);
  if (sh.mode === 'pairs') {
    const p = sh.pairs;
    L.push(`pairs (under ${PAIRS_BELOW} items, so no shape): similarity in meaning, random pair ${f2(p.floor_random_pair)}, random same-blyg pair ${f2(p.floor_same_blyg_pair)}`);
    for (const r of p.rows.slice(0, 12)) L.push(`  ${f2(r.similarity)} ${q(r.a_title, 32)} ~ ${q(r.b_title, 32)} · ${r.same_blyg ? 'same blyg' : 'two blygs'}${r.days_apart !== null ? ` · ${r.days_apart < 1 ? 'same day' : Math.round(r.days_apart) === 1 ? '1 day apart' : Math.round(r.days_apart) + ' days apart'}` : ''}${r.link ? ` · ${r.link}` : ''}${r.shared_terms.length ? ` · shared: ${r.shared_terms.join(', ')}` : ''}`);
    if (p.rows.length > 12) L.push(`  … ${p.rows.length - 12} more pairs in the JSON`);
    L.push(`nearest outsiders: ${p.nearest_outsiders.slice(0, 4).map((x: any) => x.nearest ? `${q(x.member_title, 24)} → ${q(x.nearest.title, 28)} (${x.nearest.blyg}, ${f2(x.nearest.similarity)})` : '').filter(Boolean).join('; ')}`);
  } else {
    const m = sh.on_map, im = sh.in_meaning, h = sh.holds;
    const importDated = w.bulk_dated >= sh.placed / 2;
    L.push(`on the map (${m.space}): ${m.shape} (${f2(m.along_one_line)} along one line), ${m.axis}, time ${m.time_ordered ? 'ordered' : 'not ordered'} along it (${f2(m.time_along_line)})${importDated ? ' — most dates are a bulk import\'s, so time here is import order' : ''}`);
    const end = (e: any) => `${e.terms.slice(0, 3).join(', ') || '—'} (${e.blygs.join(', ')})`;
    L.push(`  one end${m.time_ordered ? ' (earlier)' : ''}: ${end(m.ends[0])}   other end${m.time_ordered ? ' (later)' : ''}: ${end(m.ends[1])}`);
    L.push(`in meaning: tightness ${f2(im.tightness)} (random ${f2(im.floor_random)}, map neighbourhood ${f2(im.floor_map_neighbourhood)}) · pocket ${f2(im.pocket)} (random ${f2(im.pocket_floor_random)})`);
    if (im.within_blyg !== null || im.across_blygs !== null) L.push(`  within one blyg ${f2(im.within_blyg)}, across blygs ${im.across_pairs ? f2(im.across_blygs) : '— (one blyg)'}`);
    L.push(`  relatives: ${im.relatives_elsewhere} of the ${im.relatives.length} nearest outsiders are drawn elsewhere on the map${im.copies_skipped ? ` (${im.copies_skipped} identical copies skipped)` : ''}${im.relatives[0] ? `; nearest ${q(im.relatives[0].title, 36)} (${im.relatives[0].blyg}, ${im.relatives[0].on_map})` : ''}`);
    L.push(h.kind === 'streak'
      ? `holds? meaning ${h.meaning_along_line === 'changes' ? 'changes steadily' : h.meaning_along_line === 'steady' ? 'stays steady' : 'changes somewhat'} along the line (grade ${f2(h.grade)}; floor ${f2(h.grade_floor)}) → ${h.statement}`
      : `holds? pocket ${f2(h.pocket)} against ${f2(h.pocket_floor)} for a random set → ${h.statement}`);
  }
  const k = sh.links;
  const types = Object.entries(k.inside_by_type).map(([t, c]) => `${c} ${t}`).join(', ');
  L.push(`links: ${k.inside} inside${types ? ` (${types})` : ''}${k.longest_reply_chain ? ` · reply chain of ${k.longest_reply_chain}` : ''}${k.answers.length ? ` · who answers or quotes whom: ${k.answers.slice(0, 2).map((a: any) => `${a.pair} ${a.n}`).join(', ')}` : ''} · out ${k.out}${k.out_by_region[0] ? ` (most to ${q(k.out_by_region[0].to, 36)})` : ''} · in ${k.in}${k.in_by_region[0] ? ` (most from ${q(k.in_by_region[0].to, 36)})` : ''}`);
  if (live?.other_marks?.length) L.push(`other marks: ${live.other_marks.slice(0, 3).map((o: any) => `#${o.id} ${q(o.name, 30)}${o.shared ? ` shares ${o.shared}` : ''}${o.links ? `, ${o.links} links` : ''}${o.similarity !== null ? `, similarity ${f2(o.similarity)}` : ''}`).join('; ')}`);
  if (live?.reads) L.push(`read: the reader has opened ${live.reads.opened} of ${live.reads.of}`);
  if (live?.map_caveat) L.push(`map-wide: ${Math.round(live.map_caveat.map * 10)} in 10 of an item's nearest on the map are among its nearest in meaning; ${Math.round(live.map_caveat.own_blyg * 100)}% of an item's nearest in meaning share its blyg`);
  return L.join('\n');
}
