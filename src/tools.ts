// Blyg Atlas — tool definitions shared by the MCP server and the CLI.
// toolDefs + executeTool, so mcp.ts is a thin transport.

import type Database from 'better-sqlite3';
import { openDb, crawl, locateItem, normalizeOrigin, resolveEdges } from './core.js';
import { search, embedMissing, itemUrl, EMBED_MODEL } from './search.js';
import { pulse, renderPulse, markViewed, lastViewed } from './pulse.js';
import * as Q from './query.js';

export interface Tool { name: string; description: string; input_schema: any }

let _db: Database.Database | null = null;
export function db(): Database.Database { return (_db ??= openDb()); }

const shortOrigin = (o: string) => o.replace(/^https?:\/\//, '').replace(/\/$/, '');

export const toolDefs: Tool[] = [
  {
    name: 'blyg_crawl',
    description:
      "Walk the blygger network from the seed list (seeds.json) or the given seeds: resolve each URL to a blyg origin (≤6 fetches, identity = final fetch origin), read its manifest, archive index and every new/changed item document, extract typed edges (transclusion, stub, fork, [[id]] link, blogroll), and follow those edges to new origins up to `hops`. Incremental: every blyg already held is re-checked with a conditional GET on its index, and only items whose version moved are re-fetched. Then embeds anything new locally (nomic-embed-text: through Ollama when it is running, in-process otherwise) unless embed=false. Reader-side only — nothing derived is ever published (spec §16.6d). A first run from the example seeds (November 2026: ~50 origins, ~6,000 items) is about 7 minutes of fetching plus 7 (Ollama) to 20 (in-process) minutes of embedding; later runs fetch only what changed.",
    input_schema: {
      type: 'object',
      properties: {
        seeds: { type: 'array', items: { type: 'string' }, description: 'Override seeds (origin, feed or page URLs). Default: seeds.json' },
        hops: { type: 'number', description: 'Max hops from a seed to follow (default 2). 0 = seeds only.' },
        max_origins: { type: 'number', description: 'Cap on origins visited this run (default 60)' },
        follow: { type: 'array', items: { type: 'string', enum: ['blogroll', 'transclusion', 'stub', 'fork', 'link'] }, description: 'Edge types that enqueue new origins. Default: all' },
        refresh_all: { type: 'boolean', description: 'Ignore validators and re-fetch every item (default false)' },
        revisit: { type: 'boolean', description: 'Also re-check every blyg already held within the hop budget, not only what the seeds lead to this run (default: true with the seed list, false with seeds given here)' },
        wait: { type: 'number', description: 'Seconds of retries (one every 15 s) while no seed answers at all, e.g. a laptop waking before its network (default 0)' },
        embed: { type: 'boolean', description: 'Embed new/changed items after the crawl (default true)' },
      },
    },
  },
  {
    name: 'blyg_search',
    description:
      "Discovery search across every crawled blyg. Local embeddings pick semantic seeds, spreading activation expands along typed citation edges in both directions (transclusion 1.0 · stub 0.9 · fork 0.8 · link 0.5, hop decay 0.6), and a local cross-encoder reranks the pool. Each hit carries `path` — how it was reached (seed cosine, or 'quoted by X', 'stubs Y') — which is the why-surfaced rationale and often more useful than the hit. hops=0 is a plain semantic search. Rerank scores: 0.7+ direct hit, ~0.1–0.3 typical thematic match, <0.07 noise.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        top_k: { type: 'number', description: 'Results to return (default 8)' },
        hops: { type: 'number', description: 'Activation hops (default 2)' },
        seeds: { type: 'number', description: 'Semantic seeds before expansion (default 12)' },
        min_score: { type: 'number', description: 'Rerank floor; unset returns the top_k regardless' },
        origin: { type: 'string', description: 'Restrict to origins containing this string (e.g. "example.org")' },
        after: { type: 'string', description: 'Only items updated on/after this ISO date (hard filter)' },
        half_life_days: { type: 'number', description: 'Soft recency: activation and rerank scores × 2^(-age/half_life). Use for "what is the network saying about X lately" (e.g. 7). Unset = no decay; recency is not in the embedding.' },
        kind: { type: 'string', enum: ['fragment', 'thread'] },
        rerank: { type: 'boolean', description: 'Default true. false = order by activation only (fast, no model load)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'blyg_item',
    description: 'Fetch one crawled item in full: content, changelog, every edge in and out (what it quotes, who quotes it, stubs, forks). Accepts a bare 26-char id, an item/page URL, or {origin,id}.',
    input_schema: { type: 'object', properties: { ref: { type: 'string', description: 'Item id, URL, or "origin id"' }, full_text: { type: 'boolean', description: 'Return the whole content_md (default: first 3000 chars)' } }, required: ['ref'] },
  },
  {
    name: 'blyg_thread',
    description: "Conversation view around an item: walk stub_of upward (what it responds to, recursively) and downward (crawled items that stub it), plus transclusions in/out at each node. This is the locally-computed 'who responded' that the wire deliberately omits — it covers only origins you have crawled.",
    input_schema: { type: 'object', properties: { ref: { type: 'string' }, depth: { type: 'number', description: 'Max depth each direction (default 6)' } }, required: ['ref'] },
  },
  {
    name: 'blyg_lineage',
    description: 'Fork lineage of an item: forked_from chain upward and crawled forks downward.',
    input_schema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  },
  {
    name: 'blyg_stale',
    description: 'Drift view: transclusion/stub/fork references whose pinned version is behind the target item\'s current version (the quote has aged), with the target\'s changelog notes since. Only computable for targets you have crawled.',
    input_schema: { type: 'object', properties: { origin: { type: 'string', description: 'Restrict to quoting origins containing this string' }, limit: { type: 'number', description: 'Default 50' } } },
  },
  {
    name: 'blyg_frontier',
    description: 'What the map knows about but has not crawled: origins referenced by blogrolls, transclusions, stubs or forks that are beyond the hop budget or failed to resolve, with how many crawled items point at each. This is the discovery list — crawl with higher hops or add to seeds.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'blyg_map',
    description: 'Shape of the crawled network: every origin with item count, generator, level, hop, inbound/outbound citation counts by type, blogroll adjacency, embedding coverage, last crawl. Also totals and the last crawl run.',
    input_schema: { type: 'object', properties: { recent_days: { type: 'number', description: 'Also list the most-cited items from the last N days (default 14)' } } },
  },
  {
    name: 'blyg_recent',
    description: 'Latest items across all crawled origins (a reader view), newest first, with title, author, kind, version, and edge counts.',
    input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Default 25' }, origin: { type: 'string' }, since: { type: 'string', description: 'ISO date floor on updated' } } },
  },
  {
    name: 'blyg_pulse',
    description:
      "Activity view: what moved in the reader's neighborhood of the network since they last looked. A diff over author timestamps (new items, revisions with changelog notes, cross-origin quotes/forks/responses), grouped by stub-chain thread and scored by recency × neighborhood affinity (learned from the reader's read history: reads with capped dwell, decayed, spread one citation hop, seed floor) with a boost for items that changed after they read them. Also per-origin tallies (so a bulk import shows as one line, not 140 rows) and blygs new to the map. `mark_viewed` records the watermark that later calls default to. Use at session start for a one-line digest, or when the reader asks what's new from a given author. Local, never published.",
    input_schema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO floor. Default: when the pulse was last marked viewed, else 7 days ago' },
        days: { type: 'number', description: 'Shortcut: since = now − days' },
        limit: { type: 'number', description: 'Threads to return (default 20)' },
        origin: { type: 'string', description: 'Restrict to threads touched by origins containing this string' },
        half_life_days: { type: 'number', description: 'Recency decay (default 3)' },
        neighborhood: { type: 'boolean', description: 'Default true. false = recency only, no read-history weighting' },
        text: { type: 'boolean', description: 'Return the compact text rendering (digest-ready) instead of JSON' },
        mark_viewed: { type: 'boolean', description: 'After reading, set the watermark to now so the next call shows only what is newer' },
      },
    },
  },
  {
    name: 'blyg_reads',
    description: "The reader's read history, recorded by the dashboard (serve): which items they opened, when, and for how long (dwell). Default: the most recent reads, newest first, plus the most-read items. Use before recommending items, or when they refer to 'that thing I read on so-and-so's blyg'. Local data, never published.",
    input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Recent reads to return (default 30)' }, since: { type: 'string', description: 'ISO date floor' }, item: { type: 'string', description: 'Instead: the reads of one item (id or URL)' } } },
  },
  {
    name: 'blyg_queries',
    description:
      "The reader's standing queries — declared-intent feeds over the network. A query is text they typed; a run ranks what moved since they last looked at that query against those words (never against inferred behavior); keeps are items they filed under it. Default action `list` returns the one-line digest per query (unseen count, moved count last run, keeps/runs, top unseen hit) — use at session start or when the reader asks what's new on a topic they're tracking. Results are computed by the daily crawl job; use blyg_query_run to recompute. Other actions: `add` (text, note), `show` (id: hits since last looked, with paths, plus keeps), `seen` (id: advance the watermark — only when the reader says they have looked), `retire`/`revive` (id). Local, never published.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'show', 'seen', 'retire', 'revive'], description: 'Default list' },
        id: { type: 'number', description: 'Query id (show/seen/retire/revive)' },
        text: { type: 'string', description: 'For add: the query, verbatim as the reader declared it — never paraphrase' },
        note: { type: 'string', description: "For add: the reader's own words on why this query exists" },
        include_retired: { type: 'boolean' },
        json: { type: 'boolean', description: 'Return JSON instead of the digest text (list/show)' },
      },
    },
  },
  {
    name: 'blyg_query_run',
    description:
      "Run standing queries now: seed by cosine against items that moved in the window (default: since that query was last marked seen), plus seeds near items kept under the query; expand along citation edges (only moved items enter the pool; the thread a new response hangs off can surface as context); rerank against the query text only; drop below the floor (0.10). Persists hits but never advances the watermark. A quiet window returns few or zero hits and says how many items moved. `text` runs a one-off standing query without saving it.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'One query; omit (or all=true) for every active query' },
        all: { type: 'boolean' },
        text: { type: 'string', description: 'One-off: run this text as a standing query without saving it' },
        since: { type: 'string', description: 'ISO window floor override' },
        hits: { type: 'number', description: 'Hits shown per query in the text rendering (default 5)' },
        json: { type: 'boolean', description: 'Return JSON reports instead of text' },
      },
    },
  },
  {
    name: 'blyg_query_keep',
    description: "File an item under a standing query (the reader's hand-selection — only on their say-so), or undo it, or dismiss a hit. Kept items become extra seeds on later runs of that query; they never change how results are ranked.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Query id' },
        ref: { type: 'string', description: 'Item id, URL, or "origin id"' },
        action: { type: 'string', enum: ['keep', 'unkeep', 'dismiss'], description: 'Default keep' },
        note: { type: 'string' },
      },
      required: ['id', 'ref'],
    },
  },
  {
    name: 'blyg_sql',
    description: 'Read-only SELECT over the atlas database. Tables: origins(origin, kind, title, author_name, blyg_version, level, generator, hop, discovered_via, discovered_from, last_crawled, last_status), items(origin, id, kind, created, updated, version, title, content_md, content_text, content_hash, author_name, page, has_generated), changelog(origin, id, version, at, note, generated), edges(src_origin, src_id, src_version, type, dst_origin, dst_id, dst_version, dst_url, selector_exact, cited_excerpt, cited_author, cited_source), embeddings(origin, id, version, model, dim), crawl_runs(id, started, finished, origins_visited, items_fetched, items_changed, edges_added, errors, notes), queries(id, text, created, updated, active, last_viewed, last_run, min_score, note), query_runs(id, query_id, at, since, until, moved, pooled, hits, new_hits), query_hits(query_id, origin, item_id, version, first_hit, last_hit, score, path, moved, moved_at, context, state, state_at, state_version), query_keeps(query_id, origin, item_id, version, kept_at, note).',
    input_schema: { type: 'object', properties: { sql: { type: 'string' }, limit: { type: 'number', description: 'Row cap (default 100)' } }, required: ['sql'] },
  },
];

// ---------------------------------------------------------------------------

function itemRow(d: Database.Database, origin: string, id: string): any {
  return d.prepare(`SELECT origin, id, kind, created, updated, version, title, author_name, page, has_generated, content_md, content_text, content_hash FROM items WHERE origin=? AND id=?`).get(origin, id);
}

function brief(it: any, extra: Record<string, any> = {}) {
  return {
    ref: `${shortOrigin(it.origin)} ${it.id}`, title: it.title, author: it.author_name, kind: it.kind, version: it.version, updated: it.updated,
    url: itemUrl(it.origin, it.id, it.page, it.kind), ...extra,
  };
}

function edgesOf(d: Database.Database, origin: string, id: string) {
  const out = d.prepare(`SELECT type, dst_origin, dst_id, dst_version, dst_url, selector_exact, cited_excerpt, cited_author, cited_source FROM edges WHERE src_origin=? AND src_id=?`).all(origin, id) as any[];
  // Partial transclusions from one source are separate edge rows (one per selector); collapse them to one inbound link.
  const inn = d.prepare(`SELECT e.type, e.src_origin, e.src_id, MAX(e.src_version) AS src_version, MIN(e.selector_exact) AS selector_exact, COUNT(*) AS n, i.title, i.author_name, i.kind, i.page FROM edges e LEFT JOIN items i ON i.origin=e.src_origin AND i.id=e.src_id WHERE e.dst_origin=? AND e.dst_id=? GROUP BY e.type, e.src_origin, e.src_id ORDER BY e.type`).all(origin, id) as any[];
  const cur = d.prepare(`SELECT version, title, kind, page FROM items WHERE origin=? AND id=?`);
  return {
    out: out.map(e => {
      const t = e.dst_id ? cur.get(e.dst_origin, e.dst_id) as any : null;
      return {
        type: e.type, target: e.dst_id ? `${shortOrigin(e.dst_origin || '?')} ${e.dst_id}` : e.dst_url, pinned_version: e.dst_version ?? undefined,
        target_current_version: t?.version, stale: t && e.dst_version != null ? t.version > e.dst_version : undefined,
        target_title: t?.title ?? e.cited_excerpt ?? undefined, cited_author: e.cited_author ?? undefined,
        selector: e.selector_exact ?? undefined, crawled: !!t, url: e.dst_id && e.dst_origin ? itemUrl(e.dst_origin, e.dst_id, t?.page, t?.kind) : e.dst_url,
      };
    }),
    in: inn.map(e => ({ type: e.type, source: `${shortOrigin(e.src_origin)} ${e.src_id}`, source_title: e.title, author: e.author_name, selector: e.selector_exact ?? undefined, passages: e.n > 1 ? e.n : undefined, url: itemUrl(e.src_origin, e.src_id, e.page, e.kind) })),
  };
}

function need(d: Database.Database, ref: string) {
  const loc = locateItem(d, ref);
  if (!loc) throw new Error(`no crawled item matches "${ref}" — run blyg_crawl or check blyg_frontier`);
  const it = itemRow(d, loc.origin, loc.id);
  if (!it) throw new Error(`item ${loc.id} at ${loc.origin} is referenced but not crawled (see blyg_frontier)`);
  return it;
}

/** `onLog`, when given, receives progress lines as they happen (the CLI prints them); the returned text is the same either way. */
export async function executeTool(name: string, args: any, onLog?: (s: string) => void): Promise<string> {
  const d = db();
  const J = (x: any) => JSON.stringify(x, null, 1);
  switch (name) {
    case 'blyg_crawl': {
      const lines: string[] = [];
      const rep = await crawl(d, { seeds: args.seeds, maxHops: args.hops, maxOrigins: args.max_origins, follow: args.follow, refreshAll: args.refresh_all, revisit: args.revisit, netWait: args.wait, log: (s) => { lines.push(s); onLog?.(s); } });
      let embed: any = null;
      if (args.embed !== false) {
        try { embed = await embedMissing(d, onLog); } catch (e: any) { embed = { error: e.message }; }
      }
      const warnings: string[] = [];
      if (rep.seeds_unreachable === rep.seeds) warnings.push(`${rep.seeds === 1 ? 'the seed' : `none of the ${rep.seeds} seeds`} could not be reached — nothing was crawled (network down, or a wrong URL in seeds.json?)`);
      else if (rep.seeds_unreachable) warnings.push(`${rep.seeds_unreachable} of ${rep.seeds} seeds could not be reached`);
      if (embed?.error) warnings.push(`embedding failed: ${embed.error} — the new items are stored but not searchable or on the Field until \`embed\` succeeds`);
      return J({ ...rep, embed, ...(warnings.length ? { warnings } : {}), log: lines.slice(-40) });
    }
    case 'blyg_search': {
      const r = await search(d, args.query, { top_k: args.top_k, hops: args.hops, seeds: args.seeds, min_score: args.min_score, origin: args.origin, after: args.after, half_life_days: args.half_life_days, kind: args.kind, rerank: args.rerank });
      if (!r.embedded_items) return J({ ...r, note: 'no embeddings yet — run blyg_crawl (embed=true) first' });
      return J(r);
    }
    case 'blyg_item': {
      const it = need(d, args.ref);
      const changelog = d.prepare(`SELECT version, at, note, generated FROM changelog WHERE origin=? AND id=? ORDER BY version`).all(it.origin, it.id);
      const md: string = it.content_md || it.content_text || '';
      return J({ ...brief(it), origin: it.origin, id: it.id, content_hash: it.content_hash, has_generated: !!it.has_generated, changelog, edges: edgesOf(d, it.origin, it.id), content_md: args.full_text ? md : md.slice(0, 3000) + (md.length > 3000 ? `\n…[${md.length} chars; full_text=true for all]` : '') });
    }
    case 'blyg_thread': {
      const root = need(d, args.ref);
      const depth = args.depth ?? 6;
      const seen = new Set<string>();
      const up: any[] = [];
      // Upward: what does this respond to?
      let cur: any = root;
      for (let i = 0; i < depth && cur; i++) {
        const s = d.prepare(`SELECT dst_origin, dst_id, dst_version, dst_url, cited_excerpt, cited_author FROM edges WHERE src_origin=? AND src_id=? AND type IN ('stub','stub_url') LIMIT 1`).get(cur.origin, cur.id) as any;
        if (!s) break;
        if (!s.dst_id) { up.push({ responds_to: { url: s.dst_url, excerpt: s.cited_excerpt, author: s.cited_author, crawled: false, note: 'plain-web target (stub_of url)' } }); break; }
        const t = s.dst_origin ? itemRow(d, s.dst_origin, s.dst_id) : null;
        if (!t) { up.push({ responds_to: { ref: `${shortOrigin(s.dst_origin || '?')} ${s.dst_id}`, pinned_version: s.dst_version, excerpt: s.cited_excerpt, author: s.cited_author, crawled: false } }); break; }
        up.push({ responds_to: brief(t, { pinned_version: s.dst_version, stale: t.version > (s.dst_version ?? t.version) }) });
        cur = t;
      }
      // Downward: crawled items that stub this one (recursively), plus transclusions in.
      const down = (origin: string, id: string, lvl: number): any[] => {
        if (lvl >= depth) return [];
        const kids = d.prepare(`SELECT e.type, e.src_origin, e.src_id, e.dst_version FROM edges e WHERE e.dst_origin=? AND e.dst_id=? AND e.type IN ('stub','transclusion') ORDER BY e.type`).all(origin, id) as any[];
        const out: any[] = [];
        for (const k of kids) {
          const key = `${k.src_origin}|${k.src_id}`;
          if (seen.has(key)) continue; seen.add(key);
          const it = itemRow(d, k.src_origin, k.src_id);
          if (!it) continue;
          out.push({ via: k.type, ...brief(it), excerpt: (it.content_text || '').slice(0, 240), responses: down(k.src_origin, k.src_id, lvl + 1) });
        }
        return out;
      };
      seen.add(`${root.origin}|${root.id}`);
      return J({ root: brief(root, { excerpt: (root.content_text || '').slice(0, 300) }), responds_to_chain: up, responses: down(root.origin, root.id, 0), note: 'responses cover crawled origins only' });
    }
    case 'blyg_lineage': {
      const root = need(d, args.ref);
      const up: any[] = []; let cur: any = root;
      for (let i = 0; i < 12 && cur; i++) {
        const f = d.prepare(`SELECT dst_origin, dst_id, dst_version FROM edges WHERE src_origin=? AND src_id=? AND type='fork' LIMIT 1`).get(cur.origin, cur.id) as any;
        if (!f) break;
        const t = f.dst_origin ? itemRow(d, f.dst_origin, f.dst_id) : null;
        up.push(t ? brief(t, { forked_at_version: f.dst_version }) : { ref: `${shortOrigin(f.dst_origin || '?')} ${f.dst_id}`, forked_at_version: f.dst_version, crawled: false });
        cur = t;
      }
      const down = (origin: string, id: string, lvl: number): any[] => lvl > 8 ? [] : (d.prepare(`SELECT src_origin, src_id, dst_version FROM edges WHERE dst_origin=? AND dst_id=? AND type='fork'`).all(origin, id) as any[])
        .map(k => { const it = itemRow(d, k.src_origin, k.src_id); return it ? brief(it, { forked_at_version: k.dst_version, forks: down(k.src_origin, k.src_id, lvl + 1) }) : null; }).filter(Boolean);
      return J({ root: brief(root), forked_from_chain: up, forks: down(root.origin, root.id, 0) });
    }
    case 'blyg_stale': {
      const rows = d.prepare(`
        SELECT e.type, e.src_origin, e.src_id, e.dst_origin, e.dst_id, e.dst_version, t.version AS current_version, t.title AS target_title, s.title AS source_title, s.author_name AS source_author, t.page AS tpage, t.kind AS tkind
        FROM edges e JOIN items t ON t.origin=e.dst_origin AND t.id=e.dst_id LEFT JOIN items s ON s.origin=e.src_origin AND s.id=e.src_id
        WHERE e.type IN ('transclusion','stub','fork') AND e.dst_version IS NOT NULL AND t.version > e.dst_version ${args.origin ? 'AND e.src_origin LIKE ?' : ''}
        ORDER BY (t.version - e.dst_version) DESC LIMIT ?`).all(...(args.origin ? [`%${args.origin}%`] : []), args.limit ?? 50) as any[];
      const notes = d.prepare(`SELECT version, at, note FROM changelog WHERE origin=? AND id=? AND version > ? ORDER BY version`);
      return J({ count: rows.length, stale: rows.map(r => ({
        type: r.type, source: `${shortOrigin(r.src_origin)} ${r.src_id}`, source_title: r.source_title, source_author: r.source_author,
        target: `${shortOrigin(r.dst_origin)} ${r.dst_id}`, target_title: r.target_title, target_url: itemUrl(r.dst_origin, r.dst_id, r.tpage, r.tkind),
        pinned_version: r.dst_version, current_version: r.current_version, changes_since: notes.all(r.dst_origin, r.dst_id, r.dst_version),
      })) });
    }
    case 'blyg_frontier': {
      const rows = d.prepare(`
        SELECT o.origin, o.kind, o.hop, o.discovered_via, o.discovered_from, o.last_status, o.last_error,
          (SELECT COUNT(*) FROM edges e WHERE e.dst_origin=o.origin AND e.type IN ('transclusion','stub','fork','link')) AS cited_by_items,
          (SELECT COUNT(*) FROM edges e WHERE e.dst_origin=o.origin AND e.type='blogroll') AS in_blogrolls
        FROM origins o WHERE o.kind <> 'blyg' OR o.last_crawled IS NULL
        ORDER BY cited_by_items DESC, in_blogrolls DESC`).all() as any[];
      const unresolvedUrls = d.prepare(`SELECT dst_url, COUNT(*) AS n FROM edges WHERE type='blogroll' AND dst_origin IS NULL GROUP BY dst_url ORDER BY n DESC`).all();
      const danglingRefs = d.prepare(`SELECT e.dst_origin, COUNT(*) AS n FROM edges e LEFT JOIN items i ON i.origin=e.dst_origin AND i.id=e.dst_id WHERE e.dst_id IS NOT NULL AND e.dst_origin IS NOT NULL AND i.id IS NULL GROUP BY e.dst_origin ORDER BY n DESC`).all();
      return J({ uncrawled_origins: rows, blogroll_urls_without_origin: unresolvedUrls, referenced_items_not_held_by_origin: danglingRefs, hint: 'blyg_crawl with higher hops, or add an origin to seeds.json' });
    }
    case 'blyg_map': {
      const origins = d.prepare(`
        SELECT o.origin, o.kind, o.title, o.author_name, o.blyg_version, o.level, o.generator, o.hop, o.discovered_via, o.last_crawled, o.last_status,
          (SELECT COUNT(*) FROM items i WHERE i.origin=o.origin) AS items,
          (SELECT COUNT(*) FROM embeddings e WHERE e.origin=o.origin AND e.model=?) AS embedded,
          (SELECT COUNT(*) FROM edges e WHERE e.src_origin=o.origin AND e.type='transclusion' AND e.dst_origin<>o.origin) AS quotes_out,
          (SELECT COUNT(*) FROM edges e WHERE e.dst_origin=o.origin AND e.type='transclusion' AND e.src_origin<>o.origin) AS quoted_in,
          (SELECT COUNT(*) FROM edges e WHERE e.src_origin=o.origin AND e.type='stub') AS stubs_out,
          (SELECT COUNT(*) FROM edges e WHERE e.dst_origin=o.origin AND e.type='stub' AND e.src_origin<>o.origin) AS stubbed_in,
          (SELECT COUNT(*) FROM edges e WHERE e.src_origin=o.origin AND e.type='blogroll') AS blogroll_out,
          (SELECT COUNT(*) FROM edges e WHERE e.dst_origin=o.origin AND e.type='blogroll') AS blogroll_in,
          (SELECT MAX(updated) FROM items i WHERE i.origin=o.origin) AS latest_item
        FROM origins o ORDER BY o.kind='blyg' DESC, items DESC`).all(EMBED_MODEL) as any[];
      const adjacency = d.prepare(`SELECT src_origin, dst_origin, dst_url, cited_source FROM edges WHERE type='blogroll' ORDER BY src_origin`).all() as any[];
      const adj: Record<string, string[]> = {};
      for (const a of adjacency) (adj[shortOrigin(a.src_origin)] ??= []).push(a.dst_origin ? shortOrigin(a.dst_origin) : `(uncrawled) ${a.cited_source || a.dst_url}`);
      const totals = d.prepare(`SELECT (SELECT COUNT(*) FROM origins WHERE kind='blyg') AS blygs, (SELECT COUNT(*) FROM origins) AS origins, (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM embeddings WHERE model=?) AS embedded, (SELECT COUNT(*) FROM edges) AS edges`).get(EMBED_MODEL);
      const byType = d.prepare(`SELECT type, COUNT(*) AS n FROM edges GROUP BY type ORDER BY n DESC`).all();
      const days = args.recent_days ?? 14;
      const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
      const mostCited = d.prepare(`
        SELECT e.dst_origin, e.dst_id, COUNT(*) AS cites, COUNT(DISTINCT e.src_origin) AS citing_origins, i.title, i.author_name, i.page, i.kind
        FROM edges e JOIN items i ON i.origin=e.dst_origin AND i.id=e.dst_id
        WHERE e.type IN ('transclusion','stub') AND e.seen_at >= ? GROUP BY e.dst_origin, e.dst_id ORDER BY citing_origins DESC, cites DESC LIMIT 12`).all(since) as any[];
      const lastRun = d.prepare(`SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 1`).get();
      return J({ totals, edges_by_type: byType, origins: origins.map(o => ({ ...o, origin: shortOrigin(o.origin) })), blogroll_adjacency: adj,
        most_cited_recent: mostCited.map(m => ({ ref: `${shortOrigin(m.dst_origin)} ${m.dst_id}`, title: m.title, author: m.author_name, cites: m.cites, citing_origins: m.citing_origins, url: itemUrl(m.dst_origin, m.dst_id, m.page, m.kind) })),
        last_crawl: lastRun, note: 'Counts are local analytics over your own crawl, never published (spec §16.8 excludes metrics from the wire, not from your reader).' });
    }
    case 'blyg_recent': {
      const rows = d.prepare(`
        SELECT i.*, (SELECT COUNT(*) FROM edges e WHERE e.src_origin=i.origin AND e.src_id=i.id AND e.type<>'blogroll') AS edges_out,
          (SELECT COUNT(*) FROM edges e WHERE e.dst_origin=i.origin AND e.dst_id=i.id) AS edges_in
        FROM items i WHERE 1=1 ${args.origin ? 'AND i.origin LIKE ?' : ''} ${args.since ? 'AND i.updated >= ?' : ''}
        ORDER BY i.updated DESC LIMIT ?`).all(...(args.origin ? [`%${args.origin}%`] : []), ...(args.since ? [args.since] : []), args.limit ?? 25) as any[];
      return J(rows.map(r => brief(r, { edges_out: r.edges_out, edges_in: r.edges_in, excerpt: (r.content_text || '').slice(0, 200) })));
    }
    case 'blyg_pulse': {
      const since = args.since ?? (args.days ? new Date(Date.now() - args.days * 86400_000).toISOString() : undefined);
      const r = pulse(d, { since, limit: args.limit, origin: args.origin, half_life_days: args.half_life_days, neighborhood: args.neighborhood });
      const marked = args.mark_viewed ? markViewed(d) : null;
      if (args.text) return renderPulse(r) + (marked ? `\n\n(marked viewed ${marked})` : '');
      return J({ ...r, marked_viewed: marked });
    }
    case 'blyg_reads': {
      if (args.item) {
        const it = need(d, args.item);
        const reads = d.prepare(`SELECT at, dwell_ms FROM reads WHERE origin=? AND item_id=? ORDER BY at DESC`).all(it.origin, it.id);
        return J({ item: brief(it), reads });
      }
      return J(readsView(d, args.limit ?? 30, args.since));
    }
    case 'blyg_queries': {
      const action = args.action ?? 'list';
      if (action === 'add') { const q = Q.addQuery(d, args.text, args.note ?? null); return `declared #${q.id} "${q.text}" — first results after the next run (blyg_query_run id=${q.id})`; }
      if (action === 'show') { const s = Q.showQuery(d, Number(args.id)); return args.json ? J(s) : J({ ...s, hits: s.hits.map(h => ({ ...h, excerpt: h.excerpt.slice(0, 200) })) }); }
      if (action === 'seen') return `#${args.id} marked seen at ${Q.markSeen(d, Number(args.id))}`;
      if (action === 'retire' || action === 'revive') { const q = Q.setActive(d, Number(args.id), action === 'revive'); return `#${q.id} ${q.active ? 'active' : 'retired'}`; }
      const qs = Q.listQueries(d, !!args.include_retired);
      return args.json ? J(qs) : Q.renderQueries(qs);
    }
    case 'blyg_query_run': {
      const opts = { since: args.since };
      if (args.text) { const r = await Q.runQuery(d, { id: null, text: args.text, last_viewed: null, min_score: null }, opts); return args.json ? J(r) : Q.renderRun(r, { hits: args.hits }); }
      const reps = args.id && !args.all ? [await Q.runQuery(d, Q.getQuery(d, Number(args.id)), opts)] : await Q.runAll(d, opts);
      return args.json ? J(reps) : reps.map(r => Q.renderRun(r, { hits: args.hits ?? 5 })).join('\n\n');
    }
    case 'blyg_query_keep': {
      const action = args.action ?? 'keep';
      if (action === 'unkeep') return J(Q.unkeep(d, Number(args.id), args.ref));
      if (action === 'dismiss') return J(Q.dismiss(d, Number(args.id), args.ref));
      const r = Q.keep(d, Number(args.id), args.ref, { note: args.note ?? null });
      return `kept "${r.title || r.id}" v${r.version} under #${r.query_id}`;
    }
    case 'blyg_sql': {
      const sql = String(args.sql || '').trim();
      if (!/^\s*(select|with)\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error('read-only: a single SELECT/WITH statement');
      const rows = d.prepare(sql).all();
      const lim = args.limit ?? 100;
      return J({ rows: rows.slice(0, lim), total: rows.length, truncated: rows.length > lim });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** The read history: recent reads, newest first, and the most-read items. Shared by the MCP tool and the dashboard. */
export function readsView(d: Database.Database, limit = 30, since?: string) {
  const row = (r: any) => ({ ref: `${shortOrigin(r.origin)} ${r.item_id}`, origin: r.origin, item_id: r.item_id, title: r.title, author: r.author_name, url: itemUrl(r.origin, r.item_id, r.page, r.item_kind) });
  const recent = d.prepare(`SELECT r.at, r.dwell_ms, r.origin, r.item_id, i.title, i.author_name, i.kind AS item_kind, i.page FROM reads r LEFT JOIN items i ON i.origin=r.origin AND i.id=r.item_id ${since ? 'WHERE r.at >= ?' : ''} ORDER BY r.at DESC LIMIT ?`).all(...(since ? [since] : []), limit) as any[];
  const most = d.prepare(`SELECT r.origin, r.item_id, COUNT(*) AS reads, MAX(r.at) AS last_read, SUM(COALESCE(r.dwell_ms,0)) AS dwell_ms, i.title, i.author_name, i.kind AS item_kind, i.page FROM reads r LEFT JOIN items i ON i.origin=r.origin AND i.id=r.item_id GROUP BY r.origin, r.item_id ORDER BY reads DESC, dwell_ms DESC LIMIT 15`).all() as any[];
  return {
    recent: recent.map(r => ({ at: r.at, dwell_ms: r.dwell_ms ?? 0, ...row(r) })),
    most_read: most.map(r => ({ ...row(r), reads: r.reads, last_read: r.last_read, dwell_ms: r.dwell_ms })),
  };
}

export { normalizeOrigin, resolveEdges, itemRow, edgesOf, brief, shortOrigin, pulse, renderPulse, markViewed, lastViewed };
