// Blyg Atlas — search: local embeddings (nomic-embed-text, via Ollama or in-process — embed.ts), spreading activation over
// the typed citation graph, local cross-encoder rerank. Nothing leaves the machine.
//
// Retrieval shape:
//   1. semantic seeds   — cosine top-N over every embedded item
//   2. activation       — expand along edges both directions, hop-decayed, type-weighted
//   3. rerank           — cross-encoder orders the pooled candidates against the query
//   4. path             — each hit carries how it was reached (the why-surfaced rationale)

import type Database from 'better-sqlite3';
import * as path from 'path';
import { rerank } from './rerank.js';

export { OLLAMA_URL, EMBED_MODEL, embedQuery } from './embed.js';
import { EMBED_MODEL, embedQuery, embedTexts, embedder } from './embed.js';
// Local by default — same weights as the Jina API model, so scores read on the same scale either way.
export const RERANK_MODEL = process.env.BLYG_RERANK_MODEL || 'jinaai/jina-reranker-v2-base-multilingual';
const EMBED_CHARS = 6000;     // nomic context is 8192 tokens; this keeps well inside it
export const RERANK_CHARS = 1600;    // title + head of body handed to the cross-encoder

// Edge-type weights for activation. Transclusion is costly to make and therefore the strongest attention signal;
// a plain [[id]] link is a silent citation. Blogroll is origin-level and handled separately.
export const EDGE_WEIGHTS: Record<string, number> = { transclusion: 1.0, stub: 0.9, fork: 0.8, link: 0.5 };
export const HOP_DECAY = 0.6;

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

function toBlob(v: number[]): Buffer { return Buffer.from(Float32Array.from(v).buffer); }
export function fromBlob(b: Buffer): Float32Array { return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); }

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface EmbedReport { embedded: number; skipped: number; seconds: number; model: string; backend?: string }

/** What this atlas was embedded with — one model per database. Kept in `meta` so a changed setting is caught, not mixed in. */
export function recordedEmbedder(db: Database.Database): { model: string; dim: number; backend?: string; at?: string } | null {
  const r = db.prepare(`SELECT value FROM meta WHERE key='embedder'`).get() as any;
  if (r) { try { return JSON.parse(r.value); } catch { /* fall through to the rows */ } }
  // a database from before the record existed: read it off the vectors it holds
  const row = db.prepare(`SELECT model, dim FROM embeddings GROUP BY model, dim ORDER BY COUNT(*) DESC LIMIT 1`).get() as any;
  return row ? { model: row.model, dim: row.dim } : null;
}

/** Refuse to embed under a second model: search and the Field read one model's vectors, so a second set would
 *  silently split the atlas. `reembed` is the way to switch. */
function checkEmbedder(db: Database.Database): void {
  const rec = recordedEmbedder(db);
  if (rec && rec.model !== EMBED_MODEL) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM embeddings WHERE model=?`).get(rec.model) as any).n;
    throw new Error(`this atlas holds ${n} vectors from the embedding model "${rec.model}", and the model now set is "${EMBED_MODEL}". ` +
      `Run \`blyg-atlas reembed\` to embed everything again under ${EMBED_MODEL}, or set BLYG_EMBED_MODEL=${rec.model} to keep the one it has.`);
  }
}

/** Embed every item whose latest version has no vector under the current model. */
export async function embedMissing(db: Database.Database, log: (s: string) => void = () => {}, batch = 16): Promise<EmbedReport> {
  const t0 = Date.now();
  checkEmbedder(db);
  const rows = db.prepare(`
    SELECT i.origin, i.id, i.version, i.title, i.content_text
    FROM items i LEFT JOIN embeddings e ON e.origin=i.origin AND e.id=i.id AND e.model=?
    WHERE i.content_text IS NOT NULL AND length(i.content_text) > 0 AND (e.version IS NULL OR e.version <> i.version)
    ORDER BY i.updated DESC`).all(EMBED_MODEL) as any[];
  if (!rows.length) return { embedded: 0, skipped: 0, seconds: 0, model: EMBED_MODEL };
  const { backend, why } = await embedder();
  const rec = recordedEmbedder(db);
  // the in-process model is the slow one; say what a big first run is going to cost before it starts
  const rate = backend === 'ollama' ? 14 : 5;
  if (rows.length >= 200) log(`embedding ${rows.length} items with ${EMBED_MODEL} ${backend === 'ollama' ? 'via Ollama' : `in-process (${why.split(' — ')[0]})`} — roughly ${Math.max(1, Math.round(rows.length / rate / 60))} min`);
  const ins = db.prepare(`INSERT OR REPLACE INTO embeddings (origin, id, version, model, dim, vector, created) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const setMeta = db.prepare(`INSERT INTO meta (key, value) VALUES ('embedder', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  let done = 0, lastLog = Date.now(), dim = 0, rateFrom: { at: number; done: number } | null = null;
  const step = backend === 'ollama' ? batch : 4;   // small steps in-process, so progress and an interrupted run both land often
  for (let i = 0; i < rows.length; i += step) {
    const slice = rows.slice(i, i + step);
    const vecs = await embedTexts(slice.map(r => `search_document: ${(r.title ? r.title + '\n\n' : '') + r.content_text}`.slice(0, EMBED_CHARS)));
    dim = vecs[0].length;
    if (rec && rec.model === EMBED_MODEL && rec.dim && rec.dim !== dim) {
      throw new Error(`${EMBED_MODEL} returned ${dim}-dimensional vectors, and this atlas holds ${rec.dim}-dimensional ones under the same name — a different model is answering to it. Run \`blyg-atlas reembed\` to start over with this one.`);
    }
    const tx = db.transaction(() => {
      slice.forEach((r, k) => ins.run(r.origin, r.id, r.version, EMBED_MODEL, vecs[k].length, toBlob(vecs[k]), new Date().toISOString()));
    });
    tx();
    done += slice.length;
    if (!rateFrom) rateFrom = { at: Date.now(), done };   // the rate starts after the first step, which may include loading or downloading the model
    if (Date.now() - lastLog >= 5000 || done === rows.length) {
      const per = Math.max(0.1, (done - rateFrom.done) / Math.max(0.001, (Date.now() - rateFrom.at) / 1000)) || rate;
      const left = (rows.length - done) / per;
      log(`  embedded ${done}/${rows.length}` + (done < rows.length ? ` · ${per.toFixed(1)}/s · ~${left >= 90 ? Math.round(left / 60) + ' min' : Math.round(left) + ' s'} left` : ''));
      lastLog = Date.now();
    }
  }
  const used = (await embedder()).backend;   // may have moved from Ollama to in-process mid-run
  setMeta.run(JSON.stringify({ model: EMBED_MODEL, dim, backend: used, at: new Date().toISOString() }));
  return { embedded: done, skipped: 0, seconds: Math.round((Date.now() - t0) / 100) / 10, model: EMBED_MODEL, backend: used };
}

/** Drop every vector and embed the whole atlas again under the current model — the way to change embedding models. */
export async function reembed(db: Database.Database, log: (s: string) => void = () => {}): Promise<EmbedReport> {
  await embedder();   // fail on an unusable setting before anything is deleted
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM embeddings`).get() as any).n;
  db.exec(`DELETE FROM embeddings; DELETE FROM meta WHERE key='embedder';`);
  log(`dropped ${n} vectors`);
  return embedMissing(db, log);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  top_k?: number;         // results returned (default 8)
  seeds?: number;         // semantic seeds before expansion (default 12)
  hops?: number;          // activation hops (default 2; 0 = pure semantic)
  rerank?: boolean;       // default true
  min_score?: number;     // rerank floor
  origin?: string;        // restrict results to one origin (prefix match)
  after?: string;         // ISO date floor on item.updated
  half_life_days?: number; // recency decay: activation and rerank scores × 2^(-age/half_life). Unset = no decay.
  kind?: 'fragment' | 'thread';
  pool_cap?: number;      // max candidates handed to the reranker (default 60)
  vector?: Float32Array;  // seed from this vector instead of embedding `query` (used by `similar`)
  exclude?: { origin: string; id: string };
}

export interface Hit {
  origin: string; id: string; version: number; kind: string | null; title: string | null; author: string | null;
  updated: string | null; url: string;
  cosine: number | null; activation: number; hops: number; rerank_score?: number;
  path: string[];          // how it was reached, seed first
  excerpt: string;
}

interface Node { key: string; origin: string; id: string; score: number; hops: number; path: string[]; cosine: number | null }

export function itemUrl(origin: string, id: string, page?: string | null, kind?: string | null): string {
  if (page) return origin + page.replace(/^\//, '');
  return `${origin}${kind === 'thread' ? 't' : 'f'}/${id}/`;
}

export async function search(db: Database.Database, query: string, opts: SearchOptions = {}): Promise<{ hits: Hit[]; pooled: number; seeds: number; embedded_items: number; rerank_model: string | null }> {
  const topK = opts.top_k ?? 8;
  const nSeeds = opts.seeds ?? 12;
  const hops = opts.hops ?? 2;
  const doRerank = opts.rerank ?? true;
  const poolCap = opts.pool_cap ?? 60;

  // 1. Semantic seeds over all vectors (a few thousand at most; in-memory is fine).
  const qv = opts.vector ?? await embedQuery(query);
  const vecs = db.prepare(`SELECT e.origin, e.id, e.vector FROM embeddings e WHERE e.model=?`).all(EMBED_MODEL) as any[];
  const scored = vecs.map(r => ({ origin: r.origin as string, id: r.id as string, cos: cosine(qv, fromBlob(r.vector)) }))
    .sort((a, b) => b.cos - a.cos);
  const seeds = scored.slice(0, nSeeds);

  // 2. Spreading activation over typed edges, both directions.
  const nodes = new Map<string, Node>();
  const key = (o: string, i: string) => `${o}|${i}`;
  for (const s of seeds) {
    nodes.set(key(s.origin, s.id), { key: key(s.origin, s.id), origin: s.origin, id: s.id, score: s.cos, hops: 0, path: [`seed · cosine ${s.cos.toFixed(3)}`], cosine: s.cos });
  }
  const outEdges = db.prepare(`SELECT type, dst_origin, dst_id, dst_version FROM edges WHERE src_origin=? AND src_id=? AND dst_id IS NOT NULL AND dst_origin IS NOT NULL`);
  const inEdges = db.prepare(`SELECT type, src_origin, src_id FROM edges WHERE dst_origin=? AND dst_id=? AND src_id IS NOT NULL`);
  const exists = db.prepare(`SELECT 1 FROM items WHERE origin=? AND id=?`);
  const shortOrigin = (o: string) => o.replace(/^https?:\/\//, '').replace(/\/$/, '');
  let frontier = [...nodes.values()];
  for (let h = 1; h <= hops && frontier.length; h++) {
    const next: Node[] = [];
    for (const n of frontier) {
      const expand = (o: string, i: string, type: string, dir: 'quotes' | 'quoted by') => {
        const w = EDGE_WEIGHTS[type] ?? 0.4;
        const score = n.score * w * HOP_DECAY;
        const k = key(o, i);
        const cur = nodes.get(k);
        if (cur && cur.score >= score) return;
        if (!exists.get(o, i)) return; // referenced but not crawled — surfaces via frontier, not search
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

  // Fill in cosine for activated nodes that have vectors (useful to show, not used for ordering).
  const cosByKey = new Map(scored.map(s => [key(s.origin, s.id), s.cos]));
  for (const n of nodes.values()) if (n.cosine === null) n.cosine = cosByKey.get(n.key) ?? null;

  // 3. Pool → filters → rerank.
  // Recency is not in the embedding: when asked for, it comes in as a half-life
  // decay multiplied into activation (pool membership + activation order) and into the rerank score (final order).
  const decay = (updated: string | null) => opts.half_life_days && updated ? Math.pow(2, -Math.max(0, Date.now() - Date.parse(updated)) / 86400_000 / opts.half_life_days) : 1;
  if (opts.half_life_days) {
    const upd = db.prepare(`SELECT updated FROM items WHERE origin=? AND id=?`);
    for (const n of nodes.values()) { const u = (upd.get(n.origin, n.id) as any)?.updated ?? null; n.score *= decay(u); if (opts.half_life_days) n.path = [...n.path.slice(0, -1), n.path[n.path.length - 1] + ` · decay ${decay(u).toFixed(2)}`]; }
  }
  let pool = [...nodes.values()].sort((a, b) => b.score - a.score);
  const getItem = db.prepare(`SELECT origin, id, version, kind, title, author_name, updated, page, content_text FROM items WHERE origin=? AND id=?`);
  let cands = pool.map(n => ({ n, it: getItem.get(n.origin, n.id) as any })).filter(x => x.it);
  if (opts.exclude) cands = cands.filter(x => !(x.it.origin === opts.exclude!.origin && x.it.id === opts.exclude!.id));
  if (opts.origin) cands = cands.filter(x => x.it.origin.includes(opts.origin!));
  if (opts.after) cands = cands.filter(x => (x.it.updated || '') >= opts.after!);
  if (opts.kind) cands = cands.filter(x => x.it.kind === opts.kind);
  cands = cands.slice(0, poolCap);

  let rerankModel: string | null = null;
  if (doRerank && cands.length) {
    rerankModel = RERANK_MODEL;
    const docs = cands.map(x => `${x.it.title ? x.it.title + '\n' : ''}${(x.it.content_text || '').slice(0, RERANK_CHARS)}`);
    const scores = await rerank(query, docs, RERANK_MODEL);
    cands.forEach((x, i) => { (x as any).rr = scores[i] * decay(x.it.updated); });
    cands.sort((a: any, b: any) => b.rr - a.rr);
    if (opts.min_score !== undefined) cands = cands.filter((x: any) => x.rr >= opts.min_score!);
  }

  const hits: Hit[] = cands.slice(0, topK).map((x: any) => ({
    origin: x.it.origin, id: x.it.id, version: x.it.version, kind: x.it.kind, title: x.it.title, author: x.it.author_name,
    updated: x.it.updated, url: itemUrl(x.it.origin, x.it.id, x.it.page, x.it.kind),
    cosine: x.n.cosine === null ? null : Number(x.n.cosine.toFixed(3)), activation: Number(x.n.score.toFixed(3)), hops: x.n.hops,
    ...(x.rr !== undefined ? { rerank_score: Number(x.rr.toFixed(3)) } : {}),
    path: x.n.path,
    excerpt: (x.it.content_text || '').slice(0, 400),
  }));

  return { hits, pooled: cands.length, seeds: seeds.length, embedded_items: vecs.length, rerank_model: rerankModel };
}

/** "More like this": seed from the item's own vector, rerank against its title + opening. */
export async function similar(db: Database.Database, origin: string, id: string, opts: SearchOptions = {}) {
  const row = db.prepare(`SELECT e.vector, i.title, i.content_text FROM embeddings e JOIN items i ON i.origin=e.origin AND i.id=e.id WHERE e.origin=? AND e.id=? AND e.model=?`).get(origin, id, EMBED_MODEL) as any;
  if (!row) throw new Error('item has no embedding yet (run embed)');
  const q = `${row.title ? row.title + '. ' : ''}${(row.content_text || '').slice(0, 600)}`;
  return search(db, q, { ...opts, vector: fromBlob(row.vector), exclude: { origin, id }, top_k: opts.top_k ?? 8 });
}
