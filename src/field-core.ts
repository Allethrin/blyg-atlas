// Field core — the source-agnostic half of the field (see field.ts for the blyg atlas adapter).
//
// Everything here works on plain arrays: unit vectors, a creation time and a bag of words per item, and items +
// directed edges for the view. An adapter (field.ts, for the blyg atlas) builds those from its own data and gets the sidecar
// (UMAP to 2D, 4D and 3D + time; region trees named from member text; the tour frames) and the same view payload,
// which public/field.js draws. Split out of field.ts on 2026-10-23 so another source can use the same page; behaviour for
// the atlas is unchanged (the payload and a fresh sidecar hash the same before and after).

import * as fs from 'fs';
import { UMAP } from 'umap-js';

export const SIDECAR_VERSION = '4';   // 2: + the 4D layout, its region tree and the tour frame; 3: + meaning-3D-plus-time; 4: + its era tree
export const ERA_WEIGHT = 1;          // themes + eras: time's spread at the top level, as a share of the widest meaning axis's
export const UMAP_PARAMS = { n_neighbors: 15, min_dist: 0.08, seed: 42 };
export const CLUSTER = { k_top: 12, k_sub: 6, sub_min: 36, iters: 30, restarts: 4, seed: 7, label_terms: 4, text_chars: 1500 };

/** A version after the first: [version, when, the changelog note, 1 when the publishing client wrote the note]. */
export type VersionTick = [number, string, string | null, number];
export interface FieldPoint {
  i: number; origin: string; id: string; kind: string | null; title: string | null; author: string | null;
  created: string | null; updated: string | null; url: string;
  x: number; y: number; cites_in: number; cites_out: number; c: string;   // c = cluster path ('3' or '3.2')
  p4: number[]; c4: string;                                                // the 4D layout and its cluster path, for the tour
  pT: number[]; cT: string;                                                // the 3D meaning layout + time as a fourth axis, and its path
  cE: string;                                                              // its path in the era tree (regions on meaning + some time)
  pA?: number[];                                                           // the arrow space: the raw vector on the four directions the arrows move along most (assembleView with `vec`)
  vt?: VersionTick[];                                                      // the versions after the first that were made by hand (the changelog), when there are any
  vb?: number;                                                             // how many more were bulk revisions (made to many of the blyg's items at once)
  reads: number; last_read: string | null; dwell_ms: number;
}
export interface FieldCluster { path: string; name: string[]; rep: string | null; rep_i: number; size: number; cx: number; cy: number; r: number; children: string[]; origins: [string, number][] }
/** A 4D region: as FieldCluster, but placed by its centroid in the 4D layout (m4) and its rms spread there (r4). */
export interface FieldCluster4 { path: string; name: string[]; rep: string | null; rep_i: number; size: number; m4: number[]; r4: number; children: string[]; origins: [string, number][] }
export interface Sidecar {
  version: string; built: string; key: string; umap: typeof UMAP_PARAMS;
  points: Record<string, [number, number]>; cluster_of: Record<string, string>; clusters: Record<string, { path: string; name: string[]; rep: string; children: string[] }>;
  points4: Record<string, number[]>; cluster_of4: Record<string, string>; clusters4: Sidecar['clusters'];
  frame: { mean: number[]; basis: number[][]; sd: number[] };
  // meaning + time: UMAP to 3D, then each item's rank by `created` as a fourth axis
  pointsT: Record<string, number[]>; cluster_ofT: Record<string, string>; clustersT: Sidecar['clusters'];
  cluster_ofE: Record<string, string>; clustersE: Sidecar['clusters'];   // themes + eras: the top level clustered on meaning and time at ERA_WEIGHT
  frameT: { mean: number[]; basis: number[][]; sd: number[]; time: { scale: number } };
}

export const DAY = 86400_000;
export const shortOrigin = (o: string) => o.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** mulberry32. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- spherical k-means (rows of a unit matrix)

const dot = (m: Float32Array, i: number, c: Float32Array, j: number, dim: number) => {
  let s = 0; const oi = i * dim, oj = j * dim;
  for (let d = 0; d < dim; d++) s += m[oi + d] * c[oj + d];
  return s;
};

function kmeans(m: Float32Array, dim: number, rows: number[], k: number, rand: () => number): { assign: number[]; cent: Float32Array; score: number } {
  const n = rows.length;
  const cent = new Float32Array(k * dim);
  const setCent = (j: number, r: number) => { for (let d = 0; d < dim; d++) cent[j * dim + d] = m[r * dim + d]; };
  // k-means++ seeding on cosine distance
  setCent(0, rows[Math.floor(rand() * n)]);
  const best = new Array<number>(n).fill(-Infinity);
  for (let j = 1; j < k; j++) {
    for (let i = 0; i < n; i++) best[i] = Math.max(best[i], dot(m, rows[i], cent, j - 1, dim));
    const w = best.map(b => Math.max(0, 1 - b) + 1e-9);
    let tot = 0; for (const x of w) tot += x;
    let x = rand() * tot, pick = n - 1;
    for (let i = 0; i < n; i++) { x -= w[i]; if (x <= 0) { pick = i; break; } }
    setCent(j, rows[pick]);
  }
  const assign = new Array<number>(n).fill(0);
  let score = 0;
  for (let it = 0; it < CLUSTER.iters; it++) {
    let moved = 0; score = 0;
    for (let i = 0; i < n; i++) {
      let bj = 0, bs = -Infinity;
      for (let j = 0; j < k; j++) { const s = dot(m, rows[i], cent, j, dim); if (s > bs) { bs = s; bj = j; } }
      if (assign[i] !== bj) { assign[i] = bj; moved++; }
      score += bs;
    }
    cent.fill(0);
    const cnt = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) { const j = assign[i], oi = rows[i] * dim, oj = j * dim; cnt[j]++; for (let d = 0; d < dim; d++) cent[oj + d] += m[oi + d]; }
    for (let j = 0; j < k; j++) {
      if (!cnt[j]) { setCent(j, rows[Math.floor(rand() * n)]); continue; }
      let mag = 0; for (let d = 0; d < dim; d++) mag += cent[j * dim + d] ** 2;
      mag = Math.sqrt(mag) || 1;
      for (let d = 0; d < dim; d++) cent[j * dim + d] /= mag;
    }
    if (!moved) break;
  }
  return { assign, cent, score };
}

/** Plain k-means on layout coordinates (k-means++ seeding, several restarts): regions that are places, not directions.
 *  `xy` holds `dim` floats per row — the 2D plane, or the 4D layout the tour slices. */
function kmeansPts(xy: Float32Array, dim: number, rows: number[], k: number, rand: () => number): { assign: number[]; score: number } {
  const n = rows.length;
  const d2 = (i: number, c: number[]) => { let s = 0; for (let d = 0; d < dim; d++) s += (xy[dim * i + d] - c[d]) ** 2; return s; };
  const at = (i: number) => Array.from(xy.subarray(dim * i, dim * i + dim));
  let best: { assign: number[]; score: number } | null = null;
  for (let restart = 0; restart < CLUSTER.restarts; restart++) {
    const cent: number[][] = [];
    cent.push(at(rows[Math.floor(rand() * n)]));
    const near = new Array<number>(n).fill(Infinity);
    for (let j = 1; j < k; j++) {
      for (let i = 0; i < n; i++) near[i] = Math.min(near[i], d2(rows[i], cent[j - 1]));
      let tot = 0; for (const v of near) tot += v;
      let x = rand() * tot, pick = n - 1;
      for (let i = 0; i < n; i++) { x -= near[i]; if (x <= 0) { pick = i; break; } }
      cent.push(at(rows[pick]));
    }
    const assign = new Array<number>(n).fill(0);
    let score = 0;
    for (let it = 0; it < CLUSTER.iters * 2; it++) {
      let moved = 0; score = 0;
      for (let i = 0; i < n; i++) {
        let bj = 0, bd = Infinity;
        for (let j = 0; j < k; j++) { const d = d2(rows[i], cent[j]); if (d < bd) { bd = d; bj = j; } }
        if (assign[i] !== bj) { assign[i] = bj; moved++; }
        score -= bd;
      }
      const sum = Array.from({ length: k }, () => new Array<number>(dim).fill(0)), cnt = new Array<number>(k).fill(0);
      for (let i = 0; i < n; i++) { const j = assign[i]; for (let d = 0; d < dim; d++) sum[j][d] += xy[dim * rows[i] + d]; cnt[j]++; }
      for (let j = 0; j < k; j++) { if (cnt[j]) cent[j] = sum[j].map(v => v / cnt[j]); else cent[j] = at(rows[Math.floor(rand() * n)]); }
      if (!moved) break;
    }
    if (!best || score > best.score) best = { assign, score };
  }
  return best!;
}

function bestKmeans(m: Float32Array, dim: number, rows: number[], k: number, rand: () => number) {
  let best: ReturnType<typeof kmeans> | null = null;
  for (let r = 0; r < CLUSTER.restarts; r++) { const t = kmeans(m, dim, rows, k, rand); if (!best || t.score > best.score) best = t; }
  return best!;
}

// ---------------------------------------------------------------- labels: class-based TF-IDF over member text

const STOP = new Set(('a an the and or but if then else of to in on at by for from with without as is are was were be been being am do does did done have has had having it its this that these those there here where when which who whom whose what why how not no nor so than too very can could would should will shall may might must just also only even still yet again more most much many some any all each every both few several other another such own same new old same out up down over under into onto off about above below between among through during before after around against toward towards because while until unless though although whether either neither one two three first second last next like get got make made say said see seen go went come came take took give gave know knew think thought want way thing things something anything nothing everything someone anyone people person time times year years day days week weeks month months lot lots kind kinds sort sorts bit really pretty actually probably maybe perhaps quite rather sure yes yeah ok okay well right now ago via http https www com org net html blyg blygs blyg stubbing stub stubs transclusion item items post posts thread threads fragment fragments note notes write writing written wrote read reading reads i me my mine myself you your yours yourself he him his she her hers they them their theirs we us our ours ve ll re don didn doesn isn aren wasn weren won couldn shouldn wouldn im ive id youre theyre weve thats whats theres hes shes dont cant going good need use using used world everyone little didnt heres arent doesnt seems better important point real big high stuff line welcome test click page site true feels fun kind lot stuff thing things way ways enough less least often never always ever already since back around long great small large able mean means meant put puts let lets keep keeps kept try trying tried end start started starting part parts whole full half rest else else').split(' '));

export function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().replace(/[’']/g, '').split(/[^a-z]+/)) {
    if (w.length < 3 || w.length > 24 || STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

const dfOver = (docs: Set<string>[], rows: number[]) => { const df = new Map<string, number>(); for (const i of rows) for (const t of docs[i]) df.set(t, (df.get(t) ?? 0) + 1); return df; };

/** The terms that set `rows` apart from a background: p_c · log(p_c / p_global), the term's share of the KL divergence
 *  between the set and the background, so a word that is merely common everywhere ("going", "need") loses to one
 *  concentrated here ("zarathustra"). `df` is the background's document frequencies (pass it when reusing one). */
function klTerms(docs: Set<string>[], rows: number[], bgRows: number[], df: Map<string, number>, k: number): string[] {
  const N = bgRows.length;
  const cf = new Map<string, number>();
  for (const i of rows) for (const t of docs[i]) cf.set(t, (cf.get(t) ?? 0) + 1);
  return [...cf].filter(([t, c]) => c >= 2 && (df.get(t) ?? 0) >= 3)
    .map(([t, c]) => { const pc = c / rows.length, pg = (df.get(t) ?? 1) / N; return [t, pc * Math.log(pc / pg)] as [string, number]; })
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k).map(([t]) => t);
}

/** Name each cluster by the terms that set its members apart from the background: the whole field for a region,
 *  the parent region for a sub-region (so a sub-region is named by what makes it different inside its parent). */
function labelClusters(docs: Set<string>[], groups: Map<string, number[]>): Map<string, string[]> {
  const all = docs.map((_, i) => i);
  const dfAll = dfOver(docs, all);
  const dfCache = new Map<string, Map<string, number>>();
  const names = new Map<string, string[]>();
  for (const [p, rows] of groups) {
    const parent = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : null;   // the immediate parent (a sub-sub-region against its sub-region)
    const bgRows = parent ? groups.get(parent)! : all;
    if (parent && !dfCache.has(parent)) dfCache.set(parent, dfOver(docs, bgRows));
    names.set(p, klTerms(docs, rows, bgRows, parent ? dfCache.get(parent)! : dfAll, CLUSTER.label_terms));
  }
  return names;
}

/** Rim labels for the tour (Ben, Oct 24 2026: UMAP's directions "don't correspond to meaning" — do they happen to be
 *  nameable?): each set is the items at one edge of the current projection, named against the background the level is
 *  showing (the whole field at the top, a region's members inside it) by the same KL share the regions are named by.
 *  Cheap enough to answer live: one pass over the background's words plus one per set. */
export function poleTerms(docs: Set<string>[], sets: number[][], bg?: number[], k = CLUSTER.label_terms): string[][] {
  const ok = (i: number) => Number.isInteger(i) && i >= 0 && i < docs.length;
  const bgRows = (bg && bg.length ? bg : docs.map((_, i) => i)).filter(ok);
  const df = dfOver(docs, bgRows);
  return sets.map(rows => klTerms(docs, rows.filter(ok), bgRows, df, k));
}

// ---------------------------------------------------------------- build

/** Two-level k-means over layout coordinates: a region is a place in the layout, a sub-region a neighborhood inside it.
 *  Paths are '3' and '3.2'; a region under `sub_min` items, or one whose split degenerates, keeps no sub-regions. */
function regionTree(xy: Float32Array, dim: number, n: number, rand: () => number, sub?: { xy: Float32Array; dim: number }) {
  const all = Array.from({ length: n }, (_, i) => i);
  const subXy = sub ? sub.xy : xy, subDim = sub ? sub.dim : dim;   // the sub level can cluster in other coordinates
  const kTop = Math.min(CLUSTER.k_top, Math.max(2, Math.floor(n / 25)));
  const top = kmeansPts(xy, dim, all, kTop, rand);
  const groups = new Map<string, number[]>();
  const clusterOfRow = new Array<string>(n);
  for (let j = 0; j < kTop; j++) groups.set(String(j + 1), []);
  all.forEach((r, i) => { groups.get(String(top.assign[i] + 1))!.push(r); });
  const children = new Map<string, string[]>();
  for (const [p, rows] of [...groups]) {
    children.set(p, []);
    if (rows.length < CLUSTER.sub_min) { for (const r of rows) clusterOfRow[r] = p; continue; }
    const kSub = Math.min(CLUSTER.k_sub, Math.max(2, Math.floor(rows.length / 18)));
    const sub = kmeansPts(subXy, subDim, rows, kSub, rand);
    for (let j = 0; j < kSub; j++) { const sp = `${p}.${j + 1}`; groups.set(sp, []); children.get(p)!.push(sp); }
    rows.forEach((r, i) => { const sp = `${p}.${sub.assign[i] + 1}`; groups.get(sp)!.push(r); clusterOfRow[r] = sp; });
    // drop empty sub-clusters (a degenerate split) so the tree never shows a hollow region
    for (const sp of [...children.get(p)!]) if (!groups.get(sp)!.length) { groups.delete(sp); children.set(p, children.get(p)!.filter(x => x !== sp)); }
    if (children.get(p)!.length < 2) { for (const sp of children.get(p)!) groups.delete(sp); children.set(p, []); for (const r of rows) clusterOfRow[r] = p; }
  }
  return { kTop, groups, children, clusterOfRow };
}

/** The optional third level (Ben 2026-10-23: finer distinctions come from more levels, not more UMAP
 *  dimensions). Every sub-region of at least `min` items splits into
 *  clamp(floor(n / per), 2, max) neighborhoods, in the sub level's coordinates, with its own random stream so the two
 *  levels above come out exactly as they would without it. Paths gain a third part: '3.2.1'. */
export interface LeafLevel { min: number; per: number; max: number }
function deepenTree(tree: ReturnType<typeof regionTree>, xy: Float32Array, dim: number, leaf: LeafLevel, rand: () => number) {
  for (const p of [...tree.groups.keys()].filter(p => p.split('.').length === 2)) {
    const rows = tree.groups.get(p)!;
    if (rows.length < leaf.min) continue;
    const k = Math.max(2, Math.min(leaf.max, Math.floor(rows.length / leaf.per)));
    const sub = kmeansPts(xy, dim, rows, k, rand);
    const kids: string[] = [];
    for (let j = 0; j < k; j++) { const sp = `${p}.${j + 1}`; if (sub.assign.some(a => a === j)) { tree.groups.set(sp, []); kids.push(sp); } }
    if (kids.length < 2) { for (const sp of kids) tree.groups.delete(sp); continue; }
    rows.forEach((r, i) => { const sp = `${p}.${sub.assign[i] + 1}`; tree.groups.get(sp)!.push(r); tree.clusterOfRow[r] = sp; });
    tree.children.set(p, kids);
    for (const sp of kids) tree.children.set(sp, []);
  }
  return tree;
}

/** Name every cluster of a tree from member text, and pick its representative (the member nearest the mean vector). */
function describeTree(tree: ReturnType<typeof regionTree>, docs: Set<string>[], keys: string[], m: Float32Array, dim: number): Sidecar['clusters'] {
  const names = labelClusters(docs, tree.groups);
  const clusters: Sidecar['clusters'] = {};
  for (const [p, rows] of tree.groups) {
    const cent = new Float32Array(dim);
    for (const r of rows) for (let d = 0; d < dim; d++) cent[d] += m[r * dim + d];
    let bi = rows[0], bs = -Infinity;
    for (const r of rows) { let s = 0; for (let d = 0; d < dim; d++) s += m[r * dim + d] * cent[d]; if (s > bs) { bs = s; bi = r; } }
    clusters[p] = { path: p, name: names.get(p) ?? [], rep: keys[bi], children: tree.children.get(p) ?? [] };
  }
  return clusters;
}

/** Eigen-decomposition of a small symmetric matrix (cyclic Jacobi): eigenvalues descending, eigenvectors as rows. */
function symEigen(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length, a = A.map(r => [...r]), V: number[][] = A.map((_, i) => A.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const order = a.map((_, i) => i).sort((i, j) => a[j][j] - a[i][i]);
  return { values: order.map(i => a[i][i]), vectors: order.map(i => V.map(r => r[i])) };
}

/** The tour's frame: the 4D layout's mean and principal axes (most spread first) — the default plane is the first two. */
function tourFrame(xy: Float32Array, n: number): Sidecar['frame'] {
  const D = 4, mean = new Array<number>(D).fill(0);
  for (let i = 0; i < n; i++) for (let d = 0; d < D; d++) mean[d] += xy[D * i + d] / n;
  const C = Array.from({ length: D }, () => new Array<number>(D).fill(0));
  for (let i = 0; i < n; i++) for (let p = 0; p < D; p++) for (let q = 0; q < D; q++) C[p][q] += (xy[D * i + p] - mean[p]) * (xy[D * i + q] - mean[q]) / n;
  const { values, vectors } = symEigen(C);
  // a stable sign per axis (largest component positive), so a saved view means the same thing after a rebuild with the same layout
  const basis = vectors.map(v => { const big = v.reduce((b, x, i) => Math.abs(x) > Math.abs(v[b]) ? i : b, 0); return v.map(x => Number((x * Math.sign(v[big])).toFixed(6))); });
  return { mean: mean.map(x => Number(x.toFixed(4))), basis, sd: values.map(v => Number(Math.sqrt(Math.max(v, 0)).toFixed(4))) };
}

/** The meaning + time frame: the 3D layout's principal axes as the first three, time as the fourth, untouched by the
 *  PCA (so tilting toward the fourth axis turns time into the screen, and the slab along it is a slice in time). */
function timeFrame(xyz: Float32Array, n: number, tScale: number, tMean: number): Sidecar['frameT'] {
  const D = 3, mean = new Array<number>(D).fill(0);
  for (let i = 0; i < n; i++) for (let d = 0; d < D; d++) mean[d] += xyz[D * i + d] / n;
  const C = Array.from({ length: D }, () => new Array<number>(D).fill(0));
  for (let i = 0; i < n; i++) for (let p = 0; p < D; p++) for (let q = 0; q < D; q++) C[p][q] += (xyz[D * i + p] - mean[p]) * (xyz[D * i + q] - mean[q]) / n;
  const { values, vectors } = symEigen(C);
  const basis3 = vectors.map(v => { const big = v.reduce((b, x, i) => Math.abs(x) > Math.abs(v[b]) ? i : b, 0); return v.map(x => Number((x * Math.sign(v[big])).toFixed(6))); });
  return { mean: [...mean.map(x => Number(x.toFixed(4))), Number(tMean.toFixed(4))], basis: [...basis3.map(v => [...v, 0]), [0, 0, 0, 1]],
    sd: [...values.map(v => Number(Math.sqrt(Math.max(v, 0)).toFixed(4))), Number((tScale / Math.sqrt(12)).toFixed(4))], time: { scale: Number(tScale.toFixed(4)) } };
}

// ---------------------------------------------------------------- build

/** What a source hands the sidecar build: one row per item, in a fixed order. `m` holds unit vectors (`dim` floats per
 *  row), `when` the creation time used for the time axis (ISO strings sort correctly; '' sorts first), `docs` the
 *  words the regions are named from (`tokens` over the item's text), `key` the fingerprint the cache is checked by. */
export interface SidecarInput { keys: string[]; m: Float32Array; dim: number; when: string[]; docs: Set<string>[]; key: string;
  leaf?: LeafLevel;   // a third level in the tour's trees (4D, themes, themes + eras); the plane's tree stays at two
}

export function buildSidecarFrom(input: SidecarInput, log: (s: string) => void = s => console.log(s)): Sidecar {
  const t0 = Date.now();
  const { keys, m, dim, when, docs } = input;
  const n = keys.length;
  const I4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  if (!n) return { version: SIDECAR_VERSION, built: new Date().toISOString(), key: input.key, umap: UMAP_PARAMS, points: {}, cluster_of: {}, clusters: {}, points4: {}, cluster_of4: {}, clusters4: {}, frame: { mean: [0, 0, 0, 0], basis: I4, sd: [1, 1, 1, 1] },
    pointsT: {}, cluster_ofT: {}, clustersT: {}, cluster_ofE: {}, clustersE: {}, frameT: { mean: [0, 0, 0, 0], basis: I4, sd: [1, 1, 1, 1], time: { scale: 1 } } };

  // UMAP on unit vectors under euclidean = cosine ordering of neighbors
  const data: number[][] = [];
  for (let i = 0; i < n; i++) data.push(Array.from(m.subarray(i * dim, (i + 1) * dim)));
  const umapTo = (nComponents: number) => new UMAP({ nComponents, nNeighbors: Math.min(UMAP_PARAMS.n_neighbors, n - 1), minDist: UMAP_PARAMS.min_dist, random: seeded(UMAP_PARAMS.seed) }).fit(data);
  const coords = umapTo(2);
  const points: Record<string, [number, number]> = {};
  keys.forEach((k, i) => { points[k] = [Number(coords[i][0].toFixed(4)), Number(coords[i][1].toFixed(4))]; });
  log(`[field] umap 2D: ${n} points in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  // the same neighbor graph laid out in four dimensions, for the tour
  const t4 = Date.now();
  const coords4 = umapTo(4);
  const points4: Record<string, number[]> = {};
  keys.forEach((k, i) => { points4[k] = coords4[i].map(v => Number(v.toFixed(4))); });
  log(`[field] umap 4D: ${n} points in ${((Date.now() - t4) / 1000).toFixed(1)}s`);
  // meaning in three dimensions, and time as the fourth: each item's rank by `when` (dates can be too lumpy for a
  // calendar axis — the atlas has 2002 archives and a network mostly since August 2026), stretched to the spread of
  // the widest meaning axis
  const t3 = Date.now();
  const coords3 = umapTo(3);
  const xyz = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) xyz[3 * i + d] = coords3[i][d];
  const byTime = keys.map((_, i) => i).sort((a, b) => when[a] < when[b] ? -1 : when[a] > when[b] ? 1 : a - b);
  const rank = new Float64Array(n);
  byTime.forEach((i, k) => { rank[i] = n > 1 ? k / (n - 1) : 0.5; });
  const sd3 = timeFrame(xyz, n, 1, 0).sd[0];
  const tScale = sd3 * Math.sqrt(12);   // rank is uniform on [0, 1] (sd 1/√12): this gives time the PC1 spread
  const xyzt = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { for (let d = 0; d < 3; d++) xyzt[4 * i + d] = coords3[i][d]; xyzt[4 * i + 3] = (rank[i] - 0.5) * tScale; }
  const pointsT: Record<string, number[]> = {};
  keys.forEach((k, i) => { pointsT[k] = Array.from(xyzt.subarray(4 * i, 4 * i + 4)).map(v => Number(v.toFixed(4))); });
  log(`[field] umap 3D + time: ${n} points in ${((Date.now() - t3) / 1000).toFixed(1)}s`);

  // Region trees: on the plane (blobs + plane modes) and in the 4D layout (the tour), each named from member text
  const t1 = Date.now();
  const xy = new Float32Array(n * 2), xy4 = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { xy[2 * i] = coords[i][0]; xy[2 * i + 1] = coords[i][1]; for (let d = 0; d < 4; d++) xy4[4 * i + d] = coords4[i][d]; }
  const tree = regionTree(xy, 2, n, seeded(CLUSTER.seed));
  const tree4 = regionTree(xy4, 4, n, seeded(CLUSTER.seed + 1));
  // meaning + time: regions are themes (clustered on meaning alone), sub-regions are scenes (meaning and time together)
  const treeT = regionTree(xyz, 3, n, seeded(CLUSTER.seed + 2), { xy: xyzt, dim: 4 });
  // themes + eras: the top level also feels time (at ERA_WEIGHT of its spread), the scenes inside as before
  const xyze = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { for (let d = 0; d < 3; d++) xyze[4 * i + d] = xyzt[4 * i + d]; xyze[4 * i + 3] = xyzt[4 * i + 3] * ERA_WEIGHT; }
  const treeE = regionTree(xyze, 4, n, seeded(CLUSTER.seed + 3), { xy: xyzt, dim: 4 });
  if (input.leaf) {
    deepenTree(tree4, xy4, 4, input.leaf, seeded(CLUSTER.seed + 11));
    deepenTree(treeT, xyzt, 4, input.leaf, seeded(CLUSTER.seed + 12));
    deepenTree(treeE, xyzt, 4, input.leaf, seeded(CLUSTER.seed + 13));
  }
  const clusters = describeTree(tree, docs, keys, m, dim), clusters4 = describeTree(tree4, docs, keys, m, dim), clustersT = describeTree(treeT, docs, keys, m, dim), clustersE = describeTree(treeE, docs, keys, m, dim);
  const cluster_of: Record<string, string> = {}, cluster_of4: Record<string, string> = {}, cluster_ofT: Record<string, string> = {}, cluster_ofE: Record<string, string> = {};
  keys.forEach((k, i) => { cluster_of[k] = tree.clusterOfRow[i]; cluster_of4[k] = tree4.clusterOfRow[i]; cluster_ofT[k] = treeT.clusterOfRow[i]; cluster_ofE[k] = treeE.clusterOfRow[i]; });
  log(`[field] clusters: ${tree.kTop} regions, ${Object.keys(clusters).length - tree.kTop} sub-regions on the plane; ${tree4.kTop} + ${Object.keys(clusters4).length - tree4.kTop} in 4D, in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  return { version: SIDECAR_VERSION, built: new Date().toISOString(), key: input.key, umap: UMAP_PARAMS, points, cluster_of, clusters, points4, cluster_of4, clusters4, frame: tourFrame(xy4, n),
    pointsT, cluster_ofT, clustersT, cluster_ofE, clustersE, frameT: timeFrame(xyz, n, tScale, 0) };
}

/** The sidecar at `file` if its version and key still match, else a fresh build written there (atomically). */
export function cachedSidecar(file: string, key: string, build: () => Sidecar): Sidecar {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Sidecar;
    if (s.version === SIDECAR_VERSION && s.key === key) return s;
  } catch { /* missing or unreadable: rebuild */ }
  const s = build();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
  return s;
}

// ---------------------------------------------------------------- the field view (points + regions + edges + reads)

/** How a source names its things in the page, and which edge type the page draws in the accent colour. The atlas
 *  leaves it out (the page's defaults are the atlas's words: blyg / citation / transclusion). */
export interface FieldMeta {
  source: string;
  accent: string;                          // the edge type drawn in the accent colour
  type_names: Record<string, string>;      // edge type → plural label
  words: { origin: string; origins: string; edge: string; edges: string; item: string; items: string; cited: string };
  overlays?: boolean;                      // false: no reads or pulse (the page hides their controls)
  item_href?: string;                      // template for an item's page, '{id}' replaced; default: the atlas's own item page
  modes?: string[];                        // presentations offered (blobs | tour | plane), the first the default; absent = all
  spaces?: string[];                       // tour spaces offered (m4 | mt | ar), the first the default; absent = all that were built
  time_fixed?: boolean;                    // meaning + time: time runs left to right and no control turns it (the ∠₁ slider is gone)
}

export interface FieldView {
  built: string; key: string; n: number;
  points: FieldPoint[];
  clusters: FieldCluster[];
  clusters4: FieldCluster4[];
  frame: Sidecar['frame'];
  clustersT: FieldCluster4[];
  clustersE: FieldCluster4[];
  frameT: Sidecar['frameT'];
  clustersA?: FieldCluster4[];   // the 4D meaning regions placed in the arrow space
  frameA?: ArrowFrame;
  edges: [number, number, string, number][];   // [citing, cited, type, the cited version quoted (0 = unknown)]
  bundles: FieldBundles;
  origins: Array<{ origin: string; short: string; author: string | null; n: number; affinity: number }>;
  meta?: FieldMeta;
  index: Map<string, number>;
}

/** The citation lines aggregated by region, for drawing at the scale you are looking at: one connector per region
 *  pair at rest, one per sub-region pair zoomed in. `top` pairs are between top-level regions; `sub` pairs between
 *  the deepest clusters (a sub-region, or a region with none), within one region or across two; `within` counts
 *  the lines that stay inside a cluster, at both levels. Pairs are unordered (a < b by path), counted by type. */
export interface FieldBundle { a: string; b: string; n: number; by: Record<string, number> }
export interface FieldBundles { top: FieldBundle[]; sub: FieldBundle[]; within: Record<string, number> }

export function bundleEdges(points: Pick<FieldPoint, 'c'>[], edges: [number, number, string, ...number[]][]): FieldBundles {
  const parentOf = (c: string) => c.includes('.') ? c.slice(0, c.indexOf('.')) : c;
  const top = new Map<string, FieldBundle>(), sub = new Map<string, FieldBundle>();
  const within: Record<string, number> = {};
  const add = (m: Map<string, FieldBundle>, x: string, y: string, type: string) => {
    const [a, b] = x.localeCompare(y, undefined, { numeric: true }) < 0 ? [x, y] : [y, x];
    const k = a + '|' + b;
    let e = m.get(k);
    if (!e) m.set(k, e = { a, b, n: 0, by: {} });
    e.n++; e.by[type] = (e.by[type] ?? 0) + 1;
  };
  for (const [i, j, type] of edges) {
    const ca = points[i].c, cb = points[j].c;
    if (!ca || !cb) continue;
    const ta = parentOf(ca), tb = parentOf(cb);
    if (ta !== tb) add(top, ta, tb, type); else within[ta] = (within[ta] ?? 0) + 1;
    if (ca !== cb) add(sub, ca, cb, type); else if (ca !== ta) within[ca] = (within[ca] ?? 0) + 1;
  }
  const byN = (a: FieldBundle, b: FieldBundle) => b.n - a.n || a.a.localeCompare(b.a, undefined, { numeric: true }) || a.b.localeCompare(b.b, undefined, { numeric: true });
  return { top: [...top.values()].sort(byN), sub: [...sub.values()].sort(byN), within };
}

/** An item as a source describes it, before the sidecar places it. `key` is the sidecar's key for it. */
export interface BaseItem {
  key: string; origin: string; id: string; kind: string | null; title: string | null; author: string | null;
  created: string | null; updated: string | null; url: string;
  reads: number; last_read: string | null; dwell_ms: number; vt?: VersionTick[]; vb?: number;
}
/** A directed edge by item key: `src` cites `dst`. */
export interface BaseEdge { src: string; dst: string; type: string; dv: number }

/** Place the items with the sidecar, index the edges, and measure every region in both spaces. Items the sidecar has
 *  no position for are left out; an edge counts toward cites_in / cites_out even when its other end is missing. */
/** The arrow space (Ben, Oct 24 2026: tilt "in different parts of semantic space and
 *  because of just how the arrows work it makes … a sensible impressionistic conceptual map"). Every arrow is a
 *  displacement in the embedding space, cited → citing (the way ideas travel). The four directions along which those
 *  displacements carry the most energy — the top eigenvectors of Σ d·dᵀ, uncentred, so a drift every arrow shares
 *  counts as a direction — become the axes, each turned so the arrows' mean displacement along it is positive (citing
 *  tends to the + side). Items are the raw vectors, mean-centred, on those axes: a linear projection, so the clusters
 *  blur where UMAP would pull them apart, but a direction now means what the arrows made it mean. `share` is each
 *  axis's share of the arrows' displacement energy. */
export interface ArrowFrame { mean: number[]; basis: number[][]; sd: number[]; share: number[]; edges: number }
export function arrowSpace(m: Float32Array, dim: number, rows: number, edges: [number, number][], rand = seeded(11)): { pA: number[][]; frame: ArrowFrame } | null {
  const E = edges.filter(([a, b]) => a !== b && a >= 0 && b >= 0 && a < rows && b < rows);
  if (E.length < 8 || rows < 8) return null;
  // S = Σ d dᵀ over the arrows (upper triangle, mirrored), d = citing − cited
  const S = new Float64Array(dim * dim), d = new Float64Array(dim);
  let trace = 0;
  for (const [a, b] of E) {
    const oa = a * dim, ob = b * dim;
    for (let i = 0; i < dim; i++) { d[i] = m[oa + i] - m[ob + i]; trace += d[i] * d[i]; }
    for (let i = 0; i < dim; i++) { const di = d[i]; if (!di) continue; const row = i * dim; for (let j = i; j < dim; j++) S[row + j] += di * d[j]; }
  }
  for (let i = 0; i < dim; i++) for (let j = i + 1; j < dim; j++) S[j * dim + i] = S[i * dim + j];
  // the top four eigenvectors by orthogonal iteration
  const K = 4;
  let V = Array.from({ length: K }, () => Float64Array.from({ length: dim }, () => rand() - 0.5));
  const mul = (v: Float64Array) => { const out = new Float64Array(dim); for (let i = 0; i < dim; i++) { let s = 0; const row = i * dim; for (let j = 0; j < dim; j++) s += S[row + j] * v[j]; out[i] = s; } return out; };
  const orth = (vs: Float64Array[]) => { for (let k = 0; k < vs.length; k++) { const v = vs[k]; for (let p = 0; p < k; p++) { const u = vs[p]; let dot = 0; for (let i = 0; i < dim; i++) dot += v[i] * u[i]; for (let i = 0; i < dim; i++) v[i] -= dot * u[i]; } let n = 0; for (let i = 0; i < dim; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; for (let i = 0; i < dim; i++) v[i] /= n; } };
  orth(V);
  let lam = new Array<number>(K).fill(0);
  for (let it = 0; it < 300; it++) {
    const W = V.map(mul);
    const nl = W.map((w, k) => { let s = 0; for (let i = 0; i < dim; i++) s += w[i] * V[k][i]; return s; });
    orth(W); V = W;
    const change = Math.max(...nl.map((l, k) => Math.abs(l - lam[k]) / (Math.abs(l) || 1)));
    lam = nl;
    if (change < 1e-7 && it > 10) break;
  }
  const order = [0, 1, 2, 3].sort((a, b) => lam[b] - lam[a]);
  V = order.map(k => V[k]); lam = order.map(k => lam[k]);
  // orient: the arrows' mean displacement along each axis is positive
  for (const v of V) { let s = 0; for (const [a, b] of E) { const oa = a * dim, ob = b * dim; for (let i = 0; i < dim; i++) s += (m[oa + i] - m[ob + i]) * v[i]; } if (s < 0) for (let i = 0; i < dim; i++) v[i] = -v[i]; }
  const mu = new Float64Array(dim);
  for (let r = 0; r < rows; r++) for (let i = 0; i < dim; i++) mu[i] += m[r * dim + i] / rows;
  const pA: number[][] = [], sd = new Array<number>(K).fill(0);
  for (let r = 0; r < rows; r++) {
    const o = r * dim, q = V.map(v => { let s = 0; for (let i = 0; i < dim; i++) s += (m[o + i] - mu[i]) * v[i]; return s; });
    q.forEach((x, k) => { sd[k] += x * x / rows; });
    pA.push(q.map(x => Number(x.toFixed(4))));
  }
  const I4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  return { pA, frame: { mean: [0, 0, 0, 0], basis: I4, sd: sd.map(v => Number(Math.sqrt(v).toFixed(4))), share: lam.map(l => Number((l / (trace || 1)).toFixed(4))), edges: E.length } };
}

export function assembleView(sc: Sidecar, items: BaseItem[], rawEdges: BaseEdge[],
  originsOf: (points: FieldPoint[]) => FieldView['origins'], meta?: FieldMeta, vec?: { keys: string[]; m: Float32Array; dim: number }): FieldView {
  const points: FieldPoint[] = [];
  const index = new Map<string, number>();
  for (const it of items) {
    const k = it.key;
    const p = sc.points[k];
    if (!p) continue;
    index.set(k, points.length);
    points.push({ i: points.length, origin: it.origin, id: it.id, kind: it.kind, title: it.title, author: it.author, created: it.created, updated: it.updated,
      url: it.url, x: p[0], y: p[1], cites_in: 0, cites_out: 0, c: sc.cluster_of[k] ?? '', p4: sc.points4[k] ?? [0, 0, 0, 0], c4: sc.cluster_of4[k] ?? '', pT: sc.pointsT[k] ?? [0, 0, 0, 0], cT: sc.cluster_ofT[k] ?? '', cE: sc.cluster_ofE[k] ?? '',
      reads: it.reads, last_read: it.last_read, dwell_ms: it.dwell_ms, ...(it.vt ? { vt: it.vt } : {}), ...(it.vb ? { vb: it.vb } : {}) });
  }
  const citesIn = new Map<string, number>(), citesOut = new Map<string, number>();
  const edges: [number, number, string, number][] = [];
  const seenE = new Set<string>();
  for (const e of rawEdges) {
    const a = index.get(e.src), b = index.get(e.dst);
    citesOut.set(e.src, (citesOut.get(e.src) ?? 0) + 1);
    citesIn.set(e.dst, (citesIn.get(e.dst) ?? 0) + 1);
    if (a === undefined || b === undefined || a === b) continue;
    const ek = `${a}|${b}`;
    if (seenE.has(ek)) continue;   // several partial transclusions of one target are one line
    seenE.add(ek);
    edges.push([a, b, e.type, e.dv ?? 0]);
  }
  items.forEach(it => { const i = index.get(it.key); if (i === undefined) return; points[i].cites_in = citesIn.get(it.key) ?? 0; points[i].cites_out = citesOut.get(it.key) ?? 0; });

  // Regions: centroid and spread in plane coordinates, per-origin mix
  const byCluster = new Map<string, FieldPoint[]>();
  for (const p of points) { if (!byCluster.has(p.c)) byCluster.set(p.c, []); byCluster.get(p.c)!.push(p); }
  const under = (c: string, path: string) => c === path || c.startsWith(path + '.');   // at or below `path`, at any depth
  const clusters: FieldCluster[] = [];
  for (const [path, c] of Object.entries(sc.clusters)) {
    const members = c.children.length ? points.filter(p => under(p.c, path)) : (byCluster.get(path) ?? []);
    if (!members.length) continue;
    const cx = members.reduce((s, p) => s + p.x, 0) / members.length, cy = members.reduce((s, p) => s + p.y, 0) / members.length;
    const r = Math.sqrt(members.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / members.length);
    const om = new Map<string, number>();
    for (const p of members) om.set(p.origin, (om.get(p.origin) ?? 0) + 1);
    const repI = index.get(c.rep) ?? -1;
    clusters.push({ path, name: c.name, rep: repI >= 0 ? points[repI].title : null, rep_i: repI, size: members.length, cx: Number(cx.toFixed(3)), cy: Number(cy.toFixed(3)), r: Number(r.toFixed(3)), children: c.children,
      origins: [...om].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([o, n]) => [shortOrigin(o), n]) });
  }
  clusters.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  // 4D regions (the tour's two spaces): placed by their centroid in that space (m4) and their rms spread there (r4)
  const regions4 = (tree: Sidecar['clusters'], pos: (p: FieldPoint) => number[], cOf: (p: FieldPoint) => string) => {
    const out: FieldCluster4[] = [];
    for (const [path, c] of Object.entries(tree)) {
      const members = points.filter(p => under(cOf(p), path));
      if (!members.length) continue;
      const m4 = [0, 1, 2, 3].map(d => members.reduce((s, p) => s + pos(p)[d], 0) / members.length);
      const r4 = Math.sqrt(members.reduce((s, p) => s + pos(p).reduce((t, v, d) => t + (v - m4[d]) ** 2, 0), 0) / members.length);
      const om = new Map<string, number>();
      for (const p of members) om.set(p.origin, (om.get(p.origin) ?? 0) + 1);
      const repI = index.get(c.rep) ?? -1;
      out.push({ path, name: c.name, rep: repI >= 0 ? points[repI].title : null, rep_i: repI, size: members.length, m4: m4.map(v => Number(v.toFixed(4))), r4: Number(r4.toFixed(4)), children: c.children,
        origins: [...om].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([o, n]) => [shortOrigin(o), n]) });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  };
  const clusters4 = regions4(sc.clusters4, p => p.p4, p => p.c4);
  const clustersT = regions4(sc.clustersT, p => p.pT, p => p.cT);
  const clustersE = regions4(sc.clustersE, p => p.pT, p => p.cE);

  // the arrow space: the raw vectors (in point order) on the directions the arrows move along most
  let frameA: ArrowFrame | undefined, clustersA: FieldCluster4[] | undefined;
  if (vec && vec.dim && edges.length) {
    const row = new Map(vec.keys.map((k, i) => [k, i]));
    const keyOf = new Array<string>(points.length);
    for (const [k, i] of index) keyOf[i] = k;
    const mm = new Float32Array(points.length * vec.dim);
    let ok = 0;
    points.forEach((p, i) => { const r = row.get(keyOf[i]); if (r === undefined) return; ok++; mm.set(vec.m.subarray(r * vec.dim, (r + 1) * vec.dim), i * vec.dim); });
    const t0 = Date.now();
    const ar = ok === points.length ? arrowSpace(mm, vec.dim, points.length, edges.map(e => [e[0], e[1]] as [number, number])) : null;
    if (ar) {
      points.forEach((p, i) => { p.pA = ar.pA[i]; });
      frameA = ar.frame;
      clustersA = regions4(sc.clusters4, p => p.pA!, p => p.c4);
      console.log(`[field] arrow space: ${ar.frame.edges} arrows, energy share ${ar.frame.share.map(x => (100 * x).toFixed(0) + '%').join(' / ')}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }


  const view: FieldView = { built: sc.built, key: sc.key, n: points.length, points, clusters, clusters4, frame: sc.frame, clustersT, clustersE, frameT: sc.frameT, ...(frameA && clustersA ? { frameA, clustersA } : {}), edges, bundles: bundleEdges(points, edges), origins: originsOf(points), ...(meta ? { meta } : {}), index };
  return view;
}

/** JSON shape for the page (the Map is not serializable). */
export function fieldJson(v: FieldView) {
  const { index, ...rest } = v;
  return rest;
}
