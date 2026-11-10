// Blyg Atlas — field: the thicket as a spatial reader.
//
// The thicket read as an oriented space to find your way through, not a graph: the question this answers is
// "where's the scene around this theme?", a place logic rather than a feed or a PageRank, with a map of what
// moved since you last looked.
// This module is that map, reader-side and local: every embedded item gets a 2D position (UMAP over the
// nomic vectors already in atlas.db), the plane is divided into named regions (two levels of k-means on the
// plane itself, so every region is one contiguous place; named by the terms that set its members apart from
// the field, and a sub-region by what sets it apart from its parent), and three overlays are computed on demand
// from tables that already exist — the reader's reads (a ring on what they opened), the pulse (activity heat
// since they last looked), and a search (a lit region). Nothing derived is ever published (spec §16.6d).
//
// Sidecar: field-sidecar.json beside atlas.db (gitignored). Rebuilt when the embedding set changes.
//
// The algorithms (UMAP layouts, region trees, names, tour frames, the view assembly) live in field-core.ts;
// this file is the atlas's adapter: what the SQL says.

import * as path from 'path';
import type Database from 'better-sqlite3';
import { EMBED_MODEL, fromBlob, itemUrl, search } from './search.js';
import { pulse, affinity } from './pulse.js';
import { CLUSTER, DAY, assembleView, buildSidecarFrom, cachedSidecar, poleTerms, shortOrigin, tokens } from './field-core.js';
import type { BaseEdge, BaseItem, FieldMeta, FieldView, Sidecar, VersionTick } from './field-core.js';

export type { FieldPoint, FieldCluster, FieldCluster4, Sidecar, FieldView, FieldBundle, FieldBundles } from './field-core.js';
export { bundleEdges, fieldJson } from './field-core.js';

export { SIDECAR_PATH } from './config.js';
import { SIDECAR_PATH, FIELD_UI } from './config.js';

// ---------------------------------------------------------------- vectors

function loadVectors(db: Database.Database): { keys: string[]; m: Float32Array; dim: number } {
  const rows = db.prepare(`SELECT e.origin, e.id, e.vector FROM embeddings e JOIN items i ON i.origin=e.origin AND i.id=e.id WHERE e.model=? AND COALESCE(i.kind,'') <> 'withdrawn' ORDER BY e.origin, e.id`).all(EMBED_MODEL) as any[];
  if (!rows.length) return { keys: [], m: new Float32Array(0), dim: 0 };
  const dim = fromBlob(rows[0].vector).length;
  const m = new Float32Array(rows.length * dim);
  rows.forEach((r, i) => {
    const v = fromBlob(r.vector);
    let mag = 0; for (let d = 0; d < dim; d++) mag += v[d] * v[d];
    mag = Math.sqrt(mag) || 1;
    for (let d = 0; d < dim; d++) m[i * dim + d] = v[d] / mag;
  });
  return { keys: rows.map(r => `${r.origin}|${r.id}`), m, dim };
}

/** The embedding set as a fingerprint: count plus the newest embedding row, plus the naming rule's revision (a change
 *  to how regions are named rebuilds the sidecar once). An empty atlas keeps the bare `0|`. */
const NAMING_REV = 'n2';   // n2 (2026-11-09): lines one blyg repeats across its items are left out of the naming words
export function fieldKey(db: Database.Database): string {
  const r = db.prepare(`SELECT COUNT(*) AS n, MAX(created) AS newest FROM embeddings WHERE model=?`).get(EMBED_MODEL) as any;
  return `${r.n}|${r.newest ?? ''}` + (r.n ? `|${NAMING_REV}` : '');
}

// ---------------------------------------------------------------- the words regions are named from

// A region is named by the words that are commoner in it than in the background. A line that one blyg carries on many
// of its items — an AI-disclosure sentence, a byline, a section heading, a signature — is in nearly every item of any
// region that blyg fills, so its words would outrank the subject (seen 2026-11: four of twelve themes named
// "member · groups · shared" after one blyg added a disclosure line to ~1,800 notes). Such lines are left out of the
// naming words. They stay in the item, in search and in the embedding: this changes names, not places.
const BOILER = { min_items: 8, min_share: 0.05, min_chars: 3, scan_chars: 6000 };
const normLine = (l: string) => l.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');

let boilerCache: { key: string; lines: Map<string, Set<string>> } | null = null;

/** Per blyg, the lines (case, digits and spacing folded) repeated on at least `min_items` and `min_share` of its items. */
function repeatedLines(db: Database.Database): Map<string, Set<string>> {
  const r = db.prepare(`SELECT COUNT(*) AS n, MAX(fetched_at) AS f FROM items`).get() as any, key = `${r.n}|${r.f ?? ''}`;
  if (boilerCache && boilerCache.key === key) return boilerCache.lines;
  const count = new Map<string, Map<string, number>>(), nBy = new Map<string, number>();
  for (const it of db.prepare(`SELECT origin, title, substr(content_text, 1, ?) AS body FROM items WHERE COALESCE(kind,'') <> 'withdrawn'`).iterate(BOILER.scan_chars) as Iterable<any>) {
    nBy.set(it.origin, (nBy.get(it.origin) ?? 0) + 1);
    let m = count.get(it.origin);
    if (!m) count.set(it.origin, m = new Map());
    const seen = new Set<string>();
    for (const l of `${it.title ?? ''}\n${it.body ?? ''}`.split('\n')) { const k = normLine(l); if (k.length >= BOILER.min_chars) seen.add(k); }
    for (const k of seen) m.set(k, (m.get(k) ?? 0) + 1);
  }
  const lines = new Map<string, Set<string>>();
  for (const [origin, m] of count) {
    const need = Math.max(BOILER.min_items, BOILER.min_share * nBy.get(origin)!);
    const set = new Set<string>();
    for (const [k, c] of m) if (c >= need) set.add(k);
    if (set.size) lines.set(origin, set);
  }
  boilerCache = { key, lines };
  return lines;
}

/** The naming words of each item: its title and the opening of its text, without the lines its blyg repeats. */
function namingDocs(db: Database.Database, refs: { origin: string; id: string }[]): Set<string>[] {
  const boiler = repeatedLines(db);
  const textQ = db.prepare(`SELECT title, substr(content_text, 1, ?) AS body FROM items WHERE origin=? AND id=?`);
  return refs.map(({ origin, id }) => {
    const r = textQ.get(BOILER.scan_chars, origin, id) as any, drop = boiler.get(origin);
    const keep = (text: string) => (drop ? text.split('\n').filter(l => !drop.has(normLine(l))).join('\n') : text);
    return tokens(`${keep(String(r?.title ?? ''))} ${keep(String(r?.body ?? '')).slice(0, CLUSTER.text_chars)}`);
  });
}

export function buildSidecar(db: Database.Database, log: (s: string) => void = s => console.log(s)): Sidecar {
  const { keys, m, dim } = loadVectors(db);
  const createdQ = db.prepare(`SELECT COALESCE(created, updated, '') AS t FROM items WHERE origin=? AND id=?`);
  const when = keys.map(k => { const [o, id] = k.split('|'); return String((createdQ.get(o, id) as any)?.t ?? ''); });
  const docs = namingDocs(db, keys.map(k => { const [origin, id] = k.split('|'); return { origin, id }; }));
  return buildSidecarFrom({ keys, m, dim, when, docs, key: fieldKey(db) }, log);
}

export function loadSidecar(db: Database.Database, log?: (s: string) => void): Sidecar {
  return cachedSidecar(SIDECAR_PATH, fieldKey(db), () => buildSidecar(db, log));
}

// ---------------------------------------------------------------- bulk revisions
// A blyg sometimes re-versions most of its items in one go: an import re-run, a byline changed everywhere, a tool
// re-saving its files (the first seen: 2,353 items of one blyg, twice each, inside forty minutes). Those are not
// someone returning to a piece of writing, and drawn as item history they bury the revisions that are. A revision is
// bulk when revisions to at least BULK_ITEMS different items of the same blyg fall within BULK_WINDOW_MS of it.
export const BULK_ITEMS = 8, BULK_WINDOW_MS = 10 * 60_000;

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); const g = m.get(k); if (g) g.push(r); else m.set(k, [r]); }
  return m;
}

/** The bulk revisions among one blyg's changelog rows (versions 2 and up), as `id|version` keys. */
export function bulkRevisions(rows: { id: string; version: number; at: string | null }[]): Set<string> {
  const rs = rows.map(r => ({ r, t: Date.parse(r.at ?? '') })).filter(x => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  const out = new Set<string>(), inWin = new Map<string, number>();
  let lo = 0, hi = 0;   // the window [lo, hi) holds the rows within BULK_WINDOW_MS of the current one
  for (const x of rs) {
    while (hi < rs.length && rs[hi].t <= x.t + BULK_WINDOW_MS) { const id = rs[hi++].r.id; inWin.set(id, (inWin.get(id) ?? 0) + 1); }
    while (rs[lo].t < x.t - BULK_WINDOW_MS) { const id = rs[lo++].r.id, n = inWin.get(id)! - 1; if (n) inWin.set(id, n); else inWin.delete(id); }
    if (inWin.size >= BULK_ITEMS) out.add(`${x.r.id}|${x.r.version}`);
  }
  return out;
}

/** One item's changelog with its bulk revisions marked, for the reader's history. */
export function itemHistory(db: Database.Database, origin: string, id: string) {
  const rows = db.prepare(`SELECT version, at, note, generated FROM changelog WHERE origin=? AND id=? ORDER BY version`).all(origin, id) as any[];
  if (rows.length < 2) return rows;
  const bulk = bulkRevisions(db.prepare(`SELECT id, version, at FROM changelog WHERE origin=? AND version > 1 AND at IS NOT NULL`).all(origin) as any[]);
  return rows.map(r => bulk.has(`${id}|${r.version}`) ? { ...r, bulk: 1 } : r);
}

// ---------------------------------------------------------------- the field view (points + regions + edges + reads)

let cache: { key: string; view: FieldView } | null = null;

export function field(db: Database.Database, log?: (s: string) => void): FieldView {
  const key = fieldKey(db) + '|' + (db.prepare(`SELECT COUNT(*) AS n, MAX(id) AS m FROM reads`).get() as any).m;
  if (cache && cache.key === key) return cache.view;
  const sc = loadSidecar(db, log);
  const rows = db.prepare(`SELECT origin, id, kind, title, author_name, created, updated, page FROM items WHERE COALESCE(kind,'') <> 'withdrawn'`).all() as any[];
  const reads = new Map<string, { n: number; last: string; dwell: number }>();
  for (const r of db.prepare(`SELECT origin, item_id, COUNT(*) AS n, MAX(at) AS last, SUM(COALESCE(dwell_ms,0)) AS dwell FROM reads GROUP BY origin, item_id`).all() as any[]) reads.set(`${r.origin}|${r.item_id}`, { n: r.n, last: r.last, dwell: r.dwell });
  // dv: the version of the cited item a citation quotes (transclusions and stubs pin one); the citing side's recorded
  // version is only the version it was crawled at, so it is not kept
  const rawEdges = db.prepare(`SELECT src_origin, src_id, dst_origin, dst_id, type, MAX(COALESCE(dst_version, 0)) AS dv FROM edges WHERE type IN ('transclusion','stub','fork','link') AND dst_origin IS NOT NULL AND dst_id IS NOT NULL GROUP BY src_origin, src_id, dst_origin, dst_id, type`).all() as any[];

  // version histories: each version after the first that was made by hand — [version, when, note, generated] — and a
  // count of the bulk ones (the diachronic inside an item). The page draws a ring for the first and unfolds the history
  // on demand; bulk revisions are a blyg's event, not the item's, and are only counted.
  const vtimes = new Map<string, VersionTick[]>(), vbulk = new Map<string, number>();
  const clog = db.prepare(`SELECT origin, id, version, at, note, generated FROM changelog WHERE version > 1 AND at IS NOT NULL ORDER BY origin, id, version`).all() as any[];
  const bulk = new Set<string>();
  for (const [origin, rs] of groupBy(clog, r => r.origin as string)) for (const k of bulkRevisions(rs)) bulk.add(`${origin}|${k}`);
  for (const r of clog) {
    const k = `${r.origin}|${r.id}`;
    if (bulk.has(`${k}|${r.version}`)) { vbulk.set(k, (vbulk.get(k) ?? 0) + 1); continue; }
    if (!vtimes.has(k)) vtimes.set(k, []);
    vtimes.get(k)!.push([r.version, r.at, r.note ?? null, r.generated ? 1 : 0]);
  }
  const items: BaseItem[] = rows.map(it => {
    const k = `${it.origin}|${it.id}`, rd = reads.get(k);
    return { key: k, origin: it.origin, id: it.id, kind: it.kind, title: it.title, author: it.author_name, created: it.created, updated: it.updated,
      url: itemUrl(it.origin, it.id, it.page, it.kind), reads: rd?.n ?? 0, last_read: rd?.last ?? null, dwell_ms: rd?.dwell ?? 0, ...(vtimes.has(k) ? { vt: vtimes.get(k) } : {}), ...(vbulk.has(k) ? { vb: vbulk.get(k) } : {}) };
  });
  const edges: BaseEdge[] = rawEdges.map(e => ({ src: `${e.src_origin}|${e.src_id}`, dst: `${e.dst_origin}|${e.dst_id}`, type: e.type, dv: e.dv ?? 0 }));

  const aff = affinity(db);
  const originsOf = (points: FieldView['points']) => {
    const on = new Map<string, { n: number; author: string | null }>();
    for (const p of points) { const c = on.get(p.origin) ?? { n: 0, author: p.author }; c.n++; on.set(p.origin, c); }
    return [...on].map(([origin, c]) => ({ origin, short: shortOrigin(origin), author: c.author, n: c.n, affinity: Number((aff.origins.get(origin) ?? 0).toFixed(3)) })).sort((a, b) => b.n - a.n);
  };
  // what the page calls things, and which presentations it offers (atlas.config.json `field`; default one view)
  const meta: FieldMeta = { source: 'atlas', accent: 'transclusion', type_names: { transclusion: 'transclusions', stub: 'responses', link: 'links' },
    words: { origin: 'blyg', origins: 'blygs', edge: 'citation', edges: 'citations', item: 'item', items: 'items', cited: 'cited' }, ...FIELD_UI };
  const view = assembleView(sc, items, edges, originsOf, meta, loadVectors(db));
  cache = { key, view };
  return view;
}

// ---------------------------------------------------------------- overlays

/** Pulse heat on the plane: per-item event weight in the window, plus the thread roots as scenes. */
export function fieldPulse(db: Database.Database, v: FieldView, opts: { since?: string; days?: number } = {}) {
  const since = opts.since ?? (opts.days ? new Date(Date.now() - opts.days * DAY).toISOString() : undefined);
  const r = pulse(db, { since, limit: 400, events_per_thread: 60 });
  const heat = new Map<number, number>();
  const events: Array<{ i: number; kind: string; at: string; by: number | null; changed: boolean; w: number }> = [];
  const add = (i: number | undefined, w: number) => { if (i === undefined) return; heat.set(i, (heat.get(i) ?? 0) + w); };
  const scenes: Array<{ i: number | null; title: string | null; author: string | null; score: number; events: number; participants: number; read: boolean; changed: number; why: string }> = [];
  for (const t of r.threads) {
    const ri = v.index.get(`${t.root.origin}|${t.root.id}`);
    scenes.push({ i: ri ?? null, title: t.root.title, author: t.root.author, score: t.score, events: t.event_count, participants: t.participants.length, read: t.read, changed: t.changed_since_read, why: t.why });
    for (const e of t.events) {
      const i = v.index.get(`${e.origin}|${e.id}`);
      const by = e.by ? v.index.get(`${e.by.origin}|${e.by.id}`) : undefined;
      add(i, e.weight);
      if (by !== undefined && by !== i) add(by, e.weight * 0.6);
      if (i !== undefined) events.push({ i, kind: e.kind, at: e.at, by: by ?? null, changed: !!e.changed_since_read, w: Number(e.weight.toFixed(4)) });
    }
  }
  return { since: r.since, until: r.until, last_viewed: r.last_viewed, threads_total: r.threads_total, events_total: r.events_total,
    heat: [...heat].map(([i, w]) => [i, Number(w.toFixed(4))] as [number, number]), events, scenes: scenes.slice(0, 40) };
}

/** The naming words of every item, by point index — what the regions were named from, kept for the rim labels. */
const docsCache = new WeakMap<FieldView, Set<string>[]>();
function fieldDocs(db: Database.Database, v: FieldView): Set<string>[] {
  let docs = docsCache.get(v);
  if (docs) return docs;
  docs = namingDocs(db, v.points);
  docsCache.set(v, docs);
  return docs;
}

/** Rim labels: the terms that set each set of items (the edges of the tour's projection) apart from the background. */
export function fieldPoles(db: Database.Database, v: FieldView, sets: number[][], bg?: number[]) {
  return poleTerms(fieldDocs(db, v), sets.slice(0, 8).map(s => s.slice(0, 2000)), bg?.slice(0, 20000));
}

/** Openings of a few items by point index, for the tour's magnifier. `x` is the start of the text after the title;
 *  `own` marks a title that is only the text's own opening cut short — then `x` is the text from its start and the page
 *  shows it alone rather than the same words twice. */
export function fieldExcerpts(db: Database.Database, v: FieldView, idx: number[], chars = 560) {
  const q = db.prepare(`SELECT substr(content_text, 1, ?) AS body FROM items WHERE origin=? AND id=?`);
  const out: Record<number, { x: string; own: boolean }> = {};
  const cut = (t: string) => t.length > chars ? t.slice(0, chars).replace(/\s+\S*$/, '') + '…' : t;
  for (const i of idx.slice(0, 24)) {
    const p = v.points[i];
    if (!p) continue;
    const r = q.get(chars + 400, p.origin, p.id) as any;
    const body = String(r?.body ?? '').replace(/\\([\[\]()_*#`~>-])/g, '$1').replace(/\s+/g, ' ').trim(), title = String(p.title ?? '').trim();
    const stem = title.replace(/(\.\.\.|…)\s*$/, '').trim();
    if (title && body.startsWith(title)) out[i] = { x: cut(body.slice(title.length).trim()), own: false };
    else if (stem.length >= 8 && stem !== title && body.startsWith(stem)) out[i] = { x: cut(body), own: true };
    else out[i] = { x: cut(body), own: false };
  }
  return out;
}

/** A search as a lit region: the atlas search (seeds + spreading activation + rerank), mapped to point indexes. */
export async function fieldSearch(db: Database.Database, v: FieldView, q: string, top_k = 30) {
  const r = await search(db, q, { top_k, hops: 2 });
  return { query: q, pooled: r.pooled, seeds: r.seeds, hits: r.hits.map(h => ({ i: v.index.get(`${h.origin}|${h.id}`) ?? null, score: h.rerank_score ?? h.activation, hops: h.hops, title: h.title, author: h.author })).filter(h => h.i !== null) };
}
