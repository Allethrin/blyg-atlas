// Blyg Atlas — standing queries: a declared-intent feed.
//
// Three nouns. A query is text the reader declared; a run is that query against what moved
// since they last looked at it; a keep is an item they filed under the query. Everything else
// is plumbing over the search walk (search.ts) and the diff (pulse.ts moveReader).
//
// The one rule: keeps widen recall, they never change the ranking criterion. Kept items add
// seeds so the graph walk can reach what the words alone would miss; the reranker always
// scores against the query text and nothing else. That is the line between learning from
// declared history and inferring intent from behavior. Keeps are not fed into the pulse's
// affinity and affinity is not fed in here.
//
// Local only. Nothing here publishes anything (spec §16.6d).

import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { rerank } from './rerank.js';
import { locateItem, normalizeOrigin } from './core.js';
import { OWN_ORIGIN } from './config.js';
import { embedQuery, cosine, fromBlob, itemUrl, EMBED_MODEL, EDGE_WEIGHTS, HOP_DECAY, RERANK_MODEL, RERANK_CHARS } from './search.js';
import { moveReader, lastViewed as pulseLastViewed } from './pulse.js';

const DAY = 86400_000;
const DEFAULT_MIN_SCORE = 0.10;
const DEFAULT_SEEDS = 12;
const KEEP_SEED_CAP = 20;     // most recent keeps used as seed sources
const KEEP_SEEDS_EACH = 3;    // moved items seeded per keep
const POOL_CAP = 60;
const DEFAULT_TOP_K = 12;

const shortOrigin = (o: string) => o.replace(/^https?:\/\//, '').replace(/\/$/, '');
const now = () => new Date().toISOString();

/** The reader's own origin (config `own_origin`), if they publish a blyg — their own items are never part of their feed. */
function ownOrigin(): string | null {
  return OWN_ORIGIN ? normalizeOrigin(OWN_ORIGIN) : null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface Query {
  id: number | null;          // null = a one-off standing run that is not saved
  text: string; created?: string; updated?: string; active?: number;
  last_viewed: string | null; last_run?: string | null; min_score: number | null; note?: string | null;
}

export function getQuery(db: Database.Database, id: number): Query {
  const q = db.prepare(`SELECT * FROM queries WHERE id=?`).get(id) as Query | undefined;
  if (!q) throw new Error(`no standing query #${id}`);
  return q;
}

export function addQuery(db: Database.Database, text: string, note?: string | null, minScore?: number | null): Query {
  const t = String(text || '').trim();
  if (!t) throw new Error('a standing query needs text');
  const at = now();
  const r = db.prepare(`INSERT INTO queries (text, created, updated, note, min_score) VALUES (?, ?, ?, ?, ?)`).run(t, at, at, note ?? null, minScore ?? null);
  return getQuery(db, Number(r.lastInsertRowid));
}

export function setActive(db: Database.Database, id: number, active: boolean): Query {
  getQuery(db, id);
  db.prepare(`UPDATE queries SET active=?, updated=? WHERE id=?`).run(active ? 1 : 0, now(), id);
  return getQuery(db, id);
}

/** Delete a query outright, with its runs, hits and keeps. Retiring keeps the history and can be undone; this is for a
 *  query made by mistake or no longer wanted at all. */
export function deleteQuery(db: Database.Database, id: number): { id: number; text: string; keeps: number; runs: number } {
  const q = getQuery(db, id);
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE query_id=?`).get(id) as any).n as number;
  const keeps = n('query_keeps'), runs = n('query_runs');
  db.transaction(() => {
    for (const t of ['query_hits', 'query_keeps', 'query_runs']) db.prepare(`DELETE FROM ${t} WHERE query_id=?`).run(id);
    db.prepare(`DELETE FROM queries WHERE id=?`).run(id);
  })();
  return { id, text: q.text, keeps, runs };
}

/** The per-query "mark seen": advance the watermark; what was new is now seen. Running never does this. */
export function markSeen(db: Database.Database, id: number, at = now()): string {
  getQuery(db, id);
  db.transaction(() => {
    db.prepare(`UPDATE queries SET last_viewed=? WHERE id=?`).run(at, id);
    db.prepare(`UPDATE query_hits SET state='seen', state_at=?, state_version=version WHERE query_id=? AND state='new'`).run(at, id);
  })();
  return at;
}

// ---------------------------------------------------------------------------
// The moved set
// ---------------------------------------------------------------------------

export type MovedKind = 'new' | 'revised' | 'responded' | 'quoted' | 'forked';
export interface Moved {
  origin: string; id: string; moved: MovedKind; at: string; note: string | null;
  context: boolean;                                   // true = a thread something moved against, not itself changed
  by?: { origin: string; id: string; title: string | null; author: string | null };
}

const TARGET_KIND: Record<string, MovedKind> = { stub: 'responded', transclusion: 'quoted', fork: 'forked' };
const KIND_RANK: Record<MovedKind, number> = { responded: 4, quoted: 3, forked: 2, new: 1, revised: 0 };

/** Items whose own author timestamps fall in (since, until], plus crawled items that received a cross-origin
 *  stub/quote/fork from one of them. The reader's own origin is excluded on both sides. */
export function movedItems(db: Database.Database, since: string, until: string): Map<string, Moved> {
  const mine = ownOrigin();
  const mr = moveReader(db);
  const notesQ = db.prepare(`SELECT note FROM changelog WHERE origin=? AND id=? AND at > ? AND note IS NOT NULL AND note <> '' ORDER BY version DESC LIMIT 1`);
  const crawled = db.prepare(`SELECT 1 FROM items WHERE origin=? AND id=?`);
  const out = new Map<string, Moved>();
  for (const it of mr.rows(since, until)) {
    if (it.updated <= since || it.origin === mine) continue;     // the window is (since, until]
    const k = `${it.origin}|${it.id}`;
    const isNew = !it.created || it.created > since;
    const prev = out.get(k);
    const self: Moved = { origin: it.origin, id: it.id, moved: isNew ? 'new' : 'revised', at: it.updated, note: isNew ? null : ((notesQ.get(it.origin, it.id, since) as any)?.note ?? null), context: false };
    // A revised item that also drew a response keeps the response as what moved, but stays a non-context hit.
    out.set(k, prev && prev.context && self.moved === 'revised' ? { ...prev, context: false, note: self.note } : self);
    for (const e of mr.targets(it)) {
      if (e.dst_origin === mine || !crawled.get(e.dst_origin, e.dst_id)) continue;
      const tk = `${e.dst_origin}|${e.dst_id}`;
      const kind = TARGET_KIND[e.type];
      const cur = out.get(tk);
      const by = { origin: it.origin, id: it.id, title: it.title, author: it.author_name };
      if (!cur) out.set(tk, { origin: e.dst_origin, id: e.dst_id, moved: kind, at: it.updated, note: null, context: true, by });
      else if (cur.context ? KIND_RANK[kind] > KIND_RANK[cur.moved] || (kind === cur.moved && it.updated > cur.at) : cur.moved === 'revised')
        out.set(tk, { ...cur, moved: kind, at: it.updated > cur.at ? it.updated : cur.at, by });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunOptions {
  since?: string; until?: string;
  seeds?: number; hops?: number; top_k?: number; half_life_days?: number;
  persist?: boolean;          // default true for saved queries
}

export type HitState = 'new' | 'seen' | 'kept' | 'dismissed';
export interface QueryHit {
  origin: string; id: string; version: number; kind: string | null; title: string | null; author: string | null;
  updated: string | null; url: string;
  cosine: number | null; activation: number; hops: number; rerank_score: number;
  path: string[]; excerpt: string;
  moved: MovedKind; moved_at: string; note: string | null; context: boolean;
  by?: Moved['by'];
  state: HitState;
}

export interface RunReport {
  query: { id: number | null; text: string };
  since: string; until: string;
  moved: number; seeds: number; kept_seeds: number; pooled: number;
  hits: QueryHit[];
  dismissed_hidden: number;
  rerank_model: string | null;
}

interface Node { key: string; origin: string; id: string; score: number; hops: number; path: string[]; cosine: number | null }

/** Shared across queries in one `run --all`: vectors and moved sets are the same for every query with the same window. */
export interface RunCache { vecs?: Map<string, Float32Array>; moved?: Map<string, Map<string, Moved>> }

function vectors(db: Database.Database, cache?: RunCache): Map<string, Float32Array> {
  if (cache?.vecs) return cache.vecs;
  const m = new Map<string, Float32Array>();
  for (const r of db.prepare(`SELECT origin, id, vector FROM embeddings WHERE model=?`).all(EMBED_MODEL) as any[]) m.set(`${r.origin}|${r.id}`, fromBlob(r.vector));
  if (cache) cache.vecs = m;
  return m;
}

export function windowFor(db: Database.Database, q: Query, opts: RunOptions = {}): { since: string; until: string } {
  const until = opts.until ?? now();
  const since = opts.since ?? q.last_viewed ?? pulseLastViewed(db) ?? new Date(Date.parse(until) - 7 * DAY).toISOString();
  return { since, until };
}

export async function runQuery(db: Database.Database, q: Query, opts: RunOptions = {}, cache?: RunCache): Promise<RunReport> {
  const { since, until } = windowFor(db, q, opts);
  const nSeeds = opts.seeds ?? DEFAULT_SEEDS;
  const hops = opts.hops ?? 2;
  const topK = opts.top_k ?? DEFAULT_TOP_K;
  const minScore = q.min_score ?? DEFAULT_MIN_SCORE;
  const key = (o: string, i: string) => `${o}|${i}`;

  // 1–2. Window and moved set.
  const mkey = `${since}|${until}`;
  let moved = cache?.moved?.get(mkey);
  if (!moved) { moved = movedItems(db, since, until); if (cache) (cache.moved ??= new Map()).set(mkey, moved); }
  const empty: RunReport = { query: { id: q.id, text: q.text }, since, until, moved: moved.size, seeds: 0, kept_seeds: 0, pooled: 0, hits: [], dismissed_hidden: 0, rerank_model: null };
  if (!moved.size) return finish(db, q, empty, opts);

  // 3. Seeds — inside the window. Ranking the whole network and filtering afterwards starves on a quiet day.
  const vecs = vectors(db, cache);
  const movedVecs = [...moved.keys()].filter(k => vecs.has(k)).map(k => ({ k, v: vecs.get(k)! }));
  const nodes = new Map<string, Node>();
  const getTitle = db.prepare(`SELECT title FROM items WHERE origin=? AND id=?`);
  const qv = await embedQuery(q.text);
  const declared = movedVecs.map(m => ({ k: m.k, cos: cosine(qv, m.v) })).sort((a, b) => b.cos - a.cos).slice(0, nSeeds);
  for (const s of declared) {
    const [o, i] = s.k.split('|');
    nodes.set(s.k, { key: s.k, origin: o, id: i, score: s.cos, hops: 0, path: [`seed · cosine ${s.cos.toFixed(3)}`], cosine: s.cos });
  }
  let keptSeeds = 0;
  if (q.id !== null) {
    const keeps = db.prepare(`SELECT origin, item_id FROM query_keeps WHERE query_id=? ORDER BY kept_at DESC LIMIT ?`).all(q.id, KEEP_SEED_CAP) as any[];
    for (const kp of keeps) {
      const kv = vecs.get(key(kp.origin, kp.item_id));
      if (!kv) continue;
      const title = ((getTitle.get(kp.origin, kp.item_id) as any)?.title || kp.item_id).slice(0, 60);
      const near = movedVecs.filter(m => m.k !== key(kp.origin, kp.item_id)).map(m => ({ k: m.k, cos: cosine(kv, m.v) })).sort((a, b) => b.cos - a.cos).slice(0, KEEP_SEEDS_EACH);
      for (const s of near) {
        const label = `near kept: ${title} · cosine ${s.cos.toFixed(3)}`;
        const cur = nodes.get(s.k);
        if (cur) { if (!cur.path[0].includes('near kept')) cur.path[0] += ` · also ${label}`; if (s.cos > cur.score) cur.score = s.cos; continue; }
        const [o, i] = s.k.split('|');
        nodes.set(s.k, { key: s.k, origin: o, id: i, score: s.cos, hops: 0, path: [label], cosine: null });
        keptSeeds++;
      }
    }
  }
  const seedCount = nodes.size;

  // 4. Expansion — the search walk; non-moved neighbors carry paths but never join the pool.
  const outEdges = db.prepare(`SELECT type, dst_origin, dst_id FROM edges WHERE src_origin=? AND src_id=? AND dst_id IS NOT NULL AND dst_origin IS NOT NULL`);
  const inEdges = db.prepare(`SELECT type, src_origin, src_id FROM edges WHERE dst_origin=? AND dst_id=? AND src_id IS NOT NULL`);
  const exists = db.prepare(`SELECT 1 FROM items WHERE origin=? AND id=?`);
  let frontier = [...nodes.values()];
  for (let h = 1; h <= hops && frontier.length; h++) {
    const next: Node[] = [];
    for (const n of frontier) {
      const expand = (o: string, i: string, type: string, dir: 'quotes' | 'quoted by') => {
        const score = n.score * (EDGE_WEIGHTS[type] ?? 0.4) * HOP_DECAY;
        const k = key(o, i);
        const cur = nodes.get(k);
        if (cur && cur.score >= score) return;
        if (!exists.get(o, i)) return;
        const verb = dir === 'quotes' ? `→ ${type} → ` : `← ${type} by `;
        const node: Node = { key: k, origin: o, id: i, score, hops: h, path: [...n.path, `${verb}${shortOrigin(o)}/${i.slice(0, 6)}…`], cosine: cur?.cosine ?? null };
        nodes.set(k, node);
        next.push(node);
      };
      for (const e of outEdges.all(n.origin, n.id) as any[]) expand(e.dst_origin, e.dst_id, e.type, 'quotes');
      for (const e of inEdges.all(n.origin, n.id) as any[]) expand(e.src_origin, e.src_id, e.type, 'quoted by');
    }
    frontier = next;
  }

  // Pool: moved items only. Optional decay, as in search; unset by default because the window bounds recency.
  const decay = (updated: string | null) => opts.half_life_days && updated ? Math.pow(2, -Math.max(0, Date.parse(until) - Date.parse(updated)) / DAY / opts.half_life_days) : 1;
  const getItem = db.prepare(`SELECT origin, id, version, kind, title, author_name, updated, page, content_text FROM items WHERE origin=? AND id=?`);
  const cands = [...nodes.values()].filter(n => moved!.has(n.key)).sort((a, b) => b.score - a.score).slice(0, POOL_CAP)
    .map(n => ({ n, it: getItem.get(n.origin, n.id) as any, m: moved!.get(n.key)! })).filter(x => x.it);
  for (const x of cands) if (x.n.cosine === null && vecs.has(x.n.key)) x.n.cosine = cosine(qv, vecs.get(x.n.key)!);

  // 5. Rank — against the query text only. Never against kept items.
  let ranked: Array<typeof cands[number] & { rr: number }> = [];
  if (cands.length) {
    const docs = cands.map(x => `${x.it.title ? x.it.title + '\n' : ''}${(x.it.content_text || '').slice(0, RERANK_CHARS)}`);
    const scores = await rerank(q.text, docs, RERANK_MODEL);
    ranked = cands.map((x, i) => ({ ...x, rr: scores[i] * decay(x.it.updated) })).filter(x => x.rr >= minScore).sort((a, b) => b.rr - a.rr);
  }

  const hits: QueryHit[] = ranked.map(x => ({
    origin: x.it.origin, id: x.it.id, version: x.it.version, kind: x.it.kind, title: x.it.title, author: x.it.author_name,
    updated: x.it.updated, url: itemUrl(x.it.origin, x.it.id, x.it.page, x.it.kind),
    cosine: x.n.cosine === null ? null : Number(x.n.cosine.toFixed(3)), activation: Number(x.n.score.toFixed(3)), hops: x.n.hops,
    rerank_score: Number(x.rr.toFixed(3)), path: x.n.path, excerpt: (x.it.content_text || '').slice(0, 400),
    moved: x.m.moved, moved_at: x.m.at, note: x.m.note, context: x.m.context, ...(x.m.by ? { by: x.m.by } : {}),
    state: 'new' as HitState,
  }));
  return finish(db, q, { ...empty, seeds: seedCount, kept_seeds: keptSeeds, pooled: cands.length, hits, rerank_model: cands.length ? RERANK_MODEL : null }, { ...opts, top_k: topK });
}

// 6. Persist: hits are keyed on the item, not the run. State survives re-hits: dismissed stays dismissed unless
// the item was revised past the dismissed version *with a changelog note* (someone said what changed); kept stays
// kept; seen goes back to new only when the item moved again after it was seen.
function finish(db: Database.Database, q: Query, r: RunReport, opts: RunOptions): RunReport {
  const persist = q.id !== null && (opts.persist ?? true);
  const at = now();
  const prevQ = db.prepare(`SELECT state, state_at, state_version FROM query_hits WHERE query_id=? AND origin=? AND item_id=?`);
  const keptQ = db.prepare(`SELECT 1 FROM query_keeps WHERE query_id=? AND origin=? AND item_id=?`);
  const upsert = db.prepare(`INSERT INTO query_hits (query_id, origin, item_id, version, first_hit, last_hit, score, path, moved, moved_at, context, state, state_at, state_version)
    VALUES (@query_id, @origin, @item_id, @version, @at, @at, @score, @path, @moved, @moved_at, @context, @state, @state_at, @state_version)
    ON CONFLICT(query_id, origin, item_id) DO UPDATE SET version=excluded.version, last_hit=excluded.last_hit, score=excluded.score, path=excluded.path,
      moved=excluded.moved, moved_at=excluded.moved_at, context=excluded.context, state=excluded.state, state_at=excluded.state_at, state_version=excluded.state_version`);
  let newHits = 0;
  const visible: QueryHit[] = [];
  let hidden = 0;
  const apply = () => {
    for (const h of r.hits) {
      const prev = q.id !== null ? prevQ.get(q.id, h.origin, h.id) as any : null;
      const kept = q.id !== null && !!keptQ.get(q.id, h.origin, h.id);
      let state: HitState = kept ? 'kept' : 'new';
      let stateAt: string | null = at, stateVersion: number | null = h.version;
      if (prev && kept && prev.state === 'kept') { stateAt = prev.state_at; stateVersion = prev.state_version; }
      if (prev && !kept) {
        const resurface =
          prev.state === 'dismissed' ? h.version > (prev.state_version ?? h.version) && h.moved === 'revised' && !!h.note
          : prev.state === 'seen' ? !!prev.state_at && h.moved_at > prev.state_at
          : prev.state === 'kept' ? false
          : true;
        if (prev.state === 'new' || !resurface) { state = prev.state === 'kept' ? 'seen' : prev.state; stateAt = prev.state_at; stateVersion = prev.state_version; }
        // (a hit whose keep was removed elsewhere reads as seen, not new)
      }
      h.state = state;
      if (state === 'new' && (!prev || prev.state !== 'new')) newHits++;
      if (state === 'dismissed') { hidden++; } else visible.push(h);
      if (persist) upsert.run({ query_id: q.id, origin: h.origin, item_id: h.id, version: h.version, at, score: h.rerank_score, path: JSON.stringify(h.path), moved: h.moved, moved_at: h.moved_at, context: h.context ? 1 : 0, state, state_at: stateAt, state_version: stateVersion });
    }
    if (persist) {
      db.prepare(`INSERT INTO query_runs (query_id, at, since, until, moved, pooled, hits, new_hits) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(q.id, at, r.since, r.until, r.moved, r.pooled, r.hits.length, newHits);
      db.prepare(`UPDATE queries SET last_run=? WHERE id=?`).run(at, q.id);
    }
  };
  db.transaction(apply)();
  const order: Record<HitState, number> = { new: 0, kept: 1, seen: 2, dismissed: 3 };
  visible.sort((a, b) => order[a.state] - order[b.state] || b.rerank_score - a.rerank_score);
  return { ...r, hits: visible.slice(0, opts.top_k ?? DEFAULT_TOP_K), dismissed_hidden: hidden };
}

export async function runAll(db: Database.Database, opts: RunOptions = {}, log: (s: string) => void = () => {}): Promise<RunReport[]> {
  const cache: RunCache = {};
  const out: RunReport[] = [];
  for (const q of db.prepare(`SELECT * FROM queries WHERE active=1 ORDER BY id`).all() as Query[]) {
    try { out.push(await runQuery(db, q, opts, cache)); }
    catch (e: any) { log(`query #${q.id} failed: ${e.message}`); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keeps and dismissals
// ---------------------------------------------------------------------------

/** File an item under a query. */
export function keep(db: Database.Database, queryId: number, ref: string | { origin?: string; id?: string }, opts: { note?: string | null } = {}) {
  getQuery(db, queryId);
  const loc = locateItem(db, ref);
  const it = loc ? db.prepare(`SELECT origin, id, version, title FROM items WHERE origin=? AND id=?`).get(loc.origin, loc.id) as any : null;
  if (!it) throw new Error(`no crawled item matches ${typeof ref === 'string' ? `"${ref}"` : JSON.stringify(ref)}`);
  const at = now();
  db.transaction(() => {
    db.prepare(`INSERT INTO query_keeps (query_id, origin, item_id, version, kept_at, note) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(query_id, origin, item_id) DO UPDATE SET version=excluded.version, kept_at=excluded.kept_at, note=COALESCE(excluded.note, query_keeps.note)`)
      .run(queryId, it.origin, it.id, it.version, at, opts.note ?? null);
    db.prepare(`UPDATE query_hits SET state='kept', state_at=?, state_version=? WHERE query_id=? AND origin=? AND item_id=?`).run(at, it.version, queryId, it.origin, it.id);
  })();
  return { query_id: queryId, origin: it.origin, id: it.id, version: it.version, title: it.title, kept_at: at };
}

export function unkeep(db: Database.Database, queryId: number, ref: string | { origin?: string; id?: string }) {
  const loc = locateItem(db, ref);
  if (!loc) throw new Error('no such item');
  const r = db.prepare(`DELETE FROM query_keeps WHERE query_id=? AND origin=? AND item_id=?`).run(queryId, loc.origin, loc.id);
  db.prepare(`UPDATE query_hits SET state='seen', state_at=? WHERE query_id=? AND origin=? AND item_id=? AND state='kept'`).run(now(), queryId, loc.origin, loc.id);
  return { removed: r.changes };
}

export function dismiss(db: Database.Database, queryId: number, ref: string | { origin?: string; id?: string }) {
  const loc = locateItem(db, ref);
  if (!loc) throw new Error('no such item');
  const r = db.prepare(`UPDATE query_hits SET state='dismissed', state_at=?, state_version=version WHERE query_id=? AND origin=? AND item_id=? AND state <> 'kept'`).run(now(), queryId, loc.origin, loc.id);
  if (!r.changes) throw new Error('not a (non-kept) hit of this query');
  return { dismissed: true };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface QuerySummary {
  id: number; text: string; note: string | null; active: boolean; created: string;
  last_run: string | null; last_viewed: string | null;
  unseen: number; keeps: number; runs: number; moved_last_run: number | null;
  top: { origin: string; id: string; title: string | null; author: string | null; score: number } | null;
}

export function listQueries(db: Database.Database, includeRetired = false): QuerySummary[] {
  const rows = db.prepare(`SELECT q.*,
      (SELECT COUNT(*) FROM query_hits h WHERE h.query_id=q.id AND h.state='new') AS unseen,
      (SELECT COUNT(*) FROM query_keeps k WHERE k.query_id=q.id) AS keeps,
      (SELECT COUNT(*) FROM query_runs r WHERE r.query_id=q.id) AS runs,
      (SELECT moved FROM query_runs r WHERE r.query_id=q.id ORDER BY r.id DESC LIMIT 1) AS moved_last_run
    FROM queries q ${includeRetired ? '' : 'WHERE q.active=1'} ORDER BY q.active DESC, q.id`).all() as any[];
  const topQ = db.prepare(`SELECT h.origin, h.item_id AS id, h.score, i.title, i.author_name AS author FROM query_hits h LEFT JOIN items i ON i.origin=h.origin AND i.id=h.item_id WHERE h.query_id=? AND h.state='new' ORDER BY h.score DESC LIMIT 1`);
  return rows.map(r => ({
    id: r.id, text: r.text, note: r.note, active: !!r.active, created: r.created, last_run: r.last_run, last_viewed: r.last_viewed,
    unseen: r.unseen, keeps: r.keeps, runs: r.runs, moved_last_run: r.moved_last_run ?? null, top: (topQ.get(r.id) as any) ?? null,
  }));
}

/** Hits since the query's watermark (plus anything still unseen), with state and path; kept items separately. */
export function showQuery(db: Database.Database, id: number, opts: { include_dismissed?: boolean } = {}) {
  const q = getQuery(db, id);
  const { since } = windowFor(db, q);
  const rows = db.prepare(`SELECT h.*, i.title, i.author_name, i.kind, i.page, i.updated, i.version AS current_version, substr(i.content_text, 1, 400) AS excerpt
    FROM query_hits h LEFT JOIN items i ON i.origin=h.origin AND i.id=h.item_id
    WHERE h.query_id=? AND (h.state='new' OR h.moved_at > ? OR h.state='kept' AND h.last_hit > ?) ${opts.include_dismissed ? '' : "AND h.state <> 'dismissed'"}
    ORDER BY CASE h.state WHEN 'new' THEN 0 WHEN 'kept' THEN 1 WHEN 'seen' THEN 2 ELSE 3 END, h.score DESC`).all(id, since, since) as any[];
  const keeps = db.prepare(`SELECT k.*, i.title, i.author_name, i.kind, i.page, i.version AS current_version FROM query_keeps k LEFT JOIN items i ON i.origin=k.origin AND i.id=k.item_id WHERE k.query_id=? ORDER BY k.kept_at DESC`).all(id) as any[];
  const lastRun = db.prepare(`SELECT * FROM query_runs WHERE query_id=? ORDER BY id DESC LIMIT 1`).get(id) as any;
  const runs = (db.prepare(`SELECT COUNT(*) AS n FROM query_runs WHERE query_id=?`).get(id) as any).n;
  return {
    query: q, since, last_run: lastRun ?? null, runs,
    hits: rows.map(h => ({
      origin: h.origin, id: h.item_id, version: h.version, title: h.title, author: h.author_name, kind: h.kind, updated: h.updated,
      url: itemUrl(h.origin, h.item_id, h.page, h.kind), rerank_score: h.score, path: JSON.parse(h.path || '[]'),
      moved: h.moved, moved_at: h.moved_at, context: !!h.context, state: h.state, first_hit: h.first_hit, last_hit: h.last_hit, excerpt: h.excerpt ?? '',
    })),
    keeps: keeps.map(k => ({ origin: k.origin, id: k.item_id, version: k.version, current_version: k.current_version, title: k.title, author: k.author_name, kept_at: k.kept_at, note: k.note, url: itemUrl(k.origin, k.item_id, k.page, k.kind) })),
  };
}

/** Which active queries an item is already kept under (for the item page). */
export function keptUnder(db: Database.Database, origin: string, id: string): number[] {
  return (db.prepare(`SELECT query_id FROM query_keeps WHERE origin=? AND item_id=?`).all(origin, id) as any[]).map(r => r.query_id);
}

// ---------------------------------------------------------------------------
// Text rendering — CLI, MCP, and a one-line digest
// ---------------------------------------------------------------------------

const fmt = (s: string | null) => s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;

/** One line per query: "<text>" · n new since <date> · top: <title> (<author>, <score>). */
export function renderQueries(qs: QuerySummary[]): string {
  if (!qs.length) return 'no standing queries — `query add "<text>"`, or save one from a search in the dashboard';
  return qs.map(q => {
    const bits = [
      `#${q.id} "${clip(q.text, 70)}"`,
      `${q.unseen} new since ${fmt(q.last_viewed)}`,
      q.moved_last_run !== null ? `${q.moved_last_run} moved last run` : 'not run yet',
      `keeps ${q.keeps}/${q.runs} runs`,
      q.top ? `top: ${clip(q.top.title || q.top.id, 60)} (${q.top.author || shortOrigin(q.top.origin)}, ${q.top.score.toFixed(2)})` : null,
      q.active ? null : 'retired',
    ].filter(Boolean);
    return bits.join(' · ');
  }).join('\n');
}

export function renderRun(r: RunReport, opts: { hits?: number } = {}): string {
  const n = opts.hits ?? r.hits.length;
  const lines = [`"${r.query.text}"${r.query.id !== null ? ` (#${r.query.id})` : ' (one-off)'} · since ${fmt(r.since)} · ${r.moved} items moved · ${r.seeds} seeds${r.kept_seeds ? ` (${r.kept_seeds} from keeps)` : ''} · ${r.pooled} pooled · ${r.hits.length} hit${r.hits.length === 1 ? '' : 's'}${r.dismissed_hidden ? ` · ${r.dismissed_hidden} dismissed hidden` : ''}`];
  if (!r.hits.length) lines.push(!r.moved ? '   nothing moved in the window' : r.dismissed_hidden ? '   only dismissed items cleared the floor' : '   nothing in the window clears the floor — the network moved, just not here');
  for (const h of r.hits.slice(0, n)) {
    const verb = h.context && h.by ? `${h.moved} by ${h.by.author || shortOrigin(h.by.origin)}` : h.moved;
    lines.push(`   [${h.rerank_score.toFixed(2)}] ${h.state === 'new' ? '•' : ' '} ${clip(h.title || h.id, 80)} — ${h.author || shortOrigin(h.origin)} · ${verb} ${fmt(h.moved_at)}${h.state !== 'new' ? ` · ${h.state}` : ''}${h.note ? ` — ${clip(h.note, 80)}` : ''}`);
    lines.push(`         ${h.path.join(' ')}   ${shortOrigin(h.origin)} ${h.id}`);
  }
  return lines.join('\n');
}
