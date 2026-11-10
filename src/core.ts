// Blyg Atlas — core: SQLite schema, origin resolution, crawl, edge extraction.
//
// A reader-side map of the blygger network (https://blygger.org/spec/0.3/). The spec
// deliberately keeps forward discovery ("who responded to an item you did not publish")
// off the wire, and grants exactly this to the reader (§16.6d): walk nested transclusion
// layers, stub_of and forked_from chains, and subscriptions' blogrolls, ordering results
// locally "provided nothing derived is published". This module is that walk, persisted.
// Nothing here publishes anything.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

import { ATLAS_DIR, DB_PATH, SEEDS_PATH, CONTACT, REPO_URL, VERSION } from './config.js';
export { ATLAS_DIR, DB_PATH, SEEDS_PATH };
// The software's address says what this is; the contact says who is running this copy, so a site owner can reach that person.
export const UA = `blyg-atlas/${VERSION} (+${REPO_URL}${CONTACT ? `; contact: ${CONTACT}` : ''})`;
const FETCH_TIMEOUT_MS = 20_000;
const CONCURRENCY = 6;
const NET_RETRY_S = 15;   // crawl({ netWait }): seconds between tries while no seed answers
const ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/; // Crockford base32, lowercase

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function openDb(dbPath: string = DB_PATH): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS origins (
      origin TEXT PRIMARY KEY,            -- final fetch origin, trailing slash (the unit of identity)
      kind TEXT NOT NULL DEFAULT 'blyg',  -- blyg | rss | unresolved
      title TEXT, author_name TEXT, author_bio TEXT,
      blyg_version TEXT, level INTEGER, generator TEXT, generator_url TEXT, site TEXT,
      updated TEXT, blogroll TEXT, webmention TEXT,
      hop INTEGER NOT NULL DEFAULT 0,     -- distance from a seed
      discovered_via TEXT,                -- seed | blogroll | transclusion | stub | fork | link
      discovered_from TEXT,               -- origin that led here
      first_seen TEXT NOT NULL, last_crawled TEXT, last_status TEXT, last_error TEXT,
      index_etag TEXT, index_last_modified TEXT,
      raw_manifest TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      origin TEXT NOT NULL, id TEXT NOT NULL,
      kind TEXT, created TEXT, updated TEXT, version INTEGER NOT NULL,
      title TEXT, content_md TEXT, content_text TEXT, content_hash TEXT,
      author_name TEXT, author_url TEXT, page TEXT,
      has_generated INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL, raw_json TEXT,
      PRIMARY KEY (origin, id)
    );
    CREATE INDEX IF NOT EXISTS items_id ON items(id);
    CREATE INDEX IF NOT EXISTS items_updated ON items(updated);
    CREATE TABLE IF NOT EXISTS changelog (
      origin TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
      at TEXT, note TEXT, generated INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (origin, id, version)
    );
    CREATE TABLE IF NOT EXISTS edges (
      src_origin TEXT NOT NULL, src_id TEXT, src_version INTEGER,
      type TEXT NOT NULL,                 -- transclusion | stub | stub_url | fork | link | blogroll
      dst_origin TEXT, dst_id TEXT, dst_version INTEGER, dst_url TEXT,
      selector_exact TEXT, cited_excerpt TEXT, cited_author TEXT, cited_source TEXT,
      seen_at TEXT NOT NULL,
      UNIQUE (src_origin, src_id, type, dst_origin, dst_id, dst_url, selector_exact)
    );
    CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst_origin, dst_id);
    CREATE INDEX IF NOT EXISTS edges_dst_id ON edges(dst_id);
    CREATE INDEX IF NOT EXISTS edges_src ON edges(src_origin, src_id);
    CREATE TABLE IF NOT EXISTS embeddings (
      origin TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
      model TEXT NOT NULL, dim INTEGER NOT NULL, vector BLOB NOT NULL, created TEXT NOT NULL,
      PRIMARY KEY (origin, id, model)
    );
    -- Read history: which items the reader opened, when, and for how long. The pulse learns its
    -- neighborhood from this. Local, never published.
    CREATE TABLE IF NOT EXISTS reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin TEXT NOT NULL, item_id TEXT NOT NULL, version INTEGER,
      at TEXT NOT NULL,
      dwell_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS reads_item ON reads(origin, item_id);
    CREATE TABLE IF NOT EXISTS crawl_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started TEXT NOT NULL, finished TEXT,
      seeds TEXT, max_hops INTEGER, max_origins INTEGER,
      origins_visited INTEGER DEFAULT 0, items_fetched INTEGER DEFAULT 0, items_changed INTEGER DEFAULT 0,
      edges_added INTEGER DEFAULT 0, errors TEXT, notes TEXT
    );
    -- Small key/value state (e.g. when the pulse view was last marked caught-up).
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    -- Standing queries (query.ts): a query is text the reader declared, a run is that
    -- query against what moved since they last looked, a keep is an item they filed under it. Local, never published.
    CREATE TABLE IF NOT EXISTS queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,                 -- the declaration, verbatim; never rewritten by software
      created TEXT NOT NULL, updated TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,  -- 0 = retired (kept for history, not run)
      last_viewed TEXT,                   -- per-query watermark: when the reader last looked at its results
      last_run TEXT,
      min_score REAL,                     -- rerank floor override (default 0.10)
      note TEXT                           -- the reader's own words about why this query exists
    );
    CREATE TABLE IF NOT EXISTS query_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_id INTEGER NOT NULL REFERENCES queries(id),
      at TEXT NOT NULL, since TEXT NOT NULL, until TEXT NOT NULL,
      moved INTEGER NOT NULL,             -- items in the window (the denominator: a quiet network shows here)
      pooled INTEGER NOT NULL, hits INTEGER NOT NULL, new_hits INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS query_runs_q ON query_runs(query_id, at);
    CREATE TABLE IF NOT EXISTS query_hits (
      query_id INTEGER NOT NULL REFERENCES queries(id),
      origin TEXT NOT NULL, item_id TEXT NOT NULL, version INTEGER NOT NULL,
      first_hit TEXT NOT NULL, last_hit TEXT NOT NULL,
      score REAL NOT NULL,                -- latest rerank score
      path TEXT,                          -- latest why-surfaced path (JSON array)
      moved TEXT,                         -- what moved: new | revised | responded | quoted | forked
      moved_at TEXT,                      -- author timestamp of that move
      context INTEGER NOT NULL DEFAULT 0, -- 1 = surfaced as the thread something moved against, not itself changed
      state TEXT NOT NULL DEFAULT 'new',  -- new | seen | kept | dismissed
      state_at TEXT, state_version INTEGER, -- when the state was last set, and the item version at that moment
      PRIMARY KEY (query_id, origin, item_id)
    );
    CREATE TABLE IF NOT EXISTS query_keeps (
      query_id INTEGER NOT NULL REFERENCES queries(id),
      origin TEXT NOT NULL, item_id TEXT NOT NULL, version INTEGER NOT NULL,  -- version the reader kept
      kept_at TEXT NOT NULL, note TEXT,
      PRIMARY KEY (query_id, origin, item_id)
    );
  `);
  // Migrations for databases created before a column existed.
  const itemCols = (db.prepare(`PRAGMA table_info(items)`).all() as any[]).map(c => c.name);
  if (!itemCols.includes('first_seen')) {
    // When the atlas first held the item — survives re-fetches, unlike fetched_at. Backfilled from fetched_at.
    db.exec(`ALTER TABLE items ADD COLUMN first_seen TEXT`);
    db.exec(`UPDATE items SET first_seen = fetched_at WHERE first_seen IS NULL`);
  }
  // Reading trails (paths of steps with their edge types) were simplified to a flat read history on 2026-11-07:
  // an older database keeps its item reads and loses the rest.
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='trail_steps'`).get()) {
    db.exec(`INSERT INTO reads (origin, item_id, version, at, dwell_ms)
               SELECT origin, item_id, version, at, dwell_ms FROM trail_steps
               WHERE kind='item' AND origin IS NOT NULL AND item_id IS NOT NULL ORDER BY id;
             DROP TABLE trail_steps; DROP TABLE IF EXISTS trails;`);
  }
  return db;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface FetchResult {
  ok: boolean; status: number; url: string; text: string;
  etag?: string; lastModified?: string; contentType?: string;
}

export async function httpGet(url: string, headers: Record<string, string> = {}, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json,application/rss+xml,application/xml,text/xml,text/html,*/*', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = res.status === 304 ? '' : await res.text();
  return {
    ok: res.ok, status: res.status, url: res.url || url, text,
    etag: res.headers.get('etag') ?? undefined,
    lastModified: res.headers.get('last-modified') ?? undefined,
    contentType: res.headers.get('content-type') ?? undefined,
  };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Origin resolution (spec §6: bounded, deterministic; identity = final fetch origin)
// ---------------------------------------------------------------------------

export function dirOf(url: string): string {
  const u = new URL(url);
  u.search = ''; u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/[^/]*$/, '');
  return u.toString();
}

export interface Resolved {
  kind: 'blyg' | 'rss' | 'unresolved';
  origin: string;            // directory URL with trailing slash
  manifest?: any;
  feedUrl?: string;
  error?: string;
}

function looksLikeManifest(j: any): boolean {
  return j && typeof j === 'object' && typeof j.blyg === 'string';
}

const RESOLVE_TIMEOUT_MS = 10_000; // resolution probes hit arbitrary blogs from blogrolls; fail fast

async function tryManifest(manifestUrl: string): Promise<Resolved | null> {
  try {
    const r = await httpGet(manifestUrl, {}, RESOLVE_TIMEOUT_MS);
    if (!r.ok) return null;
    const j = JSON.parse(r.text);
    if (!looksLikeManifest(j)) return null;
    return { kind: 'blyg', origin: dirOf(r.url), manifest: j };
  } catch { return null; }
}

/** Resolve any URL to a blyg origin (≤ 6 fetches), or classify it as plain RSS / unresolved. */
export async function resolveOrigin(input: string): Promise<Resolved> {
  let url: string;
  try { url = new URL(input).toString(); } catch { return { kind: 'unresolved', origin: input, error: 'not a URL' }; }
  const dir = dirOf(url);

  // 1. Probe blyg.json at the normalized directory.
  const direct = await tryManifest(dir + 'blyg.json');
  if (direct) return direct;

  // 2/3. Fetch the URL itself: a feed carries <blyg:manifest>; HTML carries rel="blyg".
  let body: FetchResult | null = null;
  try { body = await httpGet(url, {}, RESOLVE_TIMEOUT_MS); } catch (e: any) { body = null; }
  if (body && body.ok) {
    const isXml = /xml/.test(body.contentType || '') || body.text.trimStart().startsWith('<?xml') || /<rss|<feed/.test(body.text.slice(0, 2000));
    if (isXml) {
      const m = body.text.match(/<blyg:manifest[^>]*>\s*([^<\s]+)\s*<\/blyg:manifest>/);
      if (m) {
        const viaFeed = await tryManifest(new URL(m[1], body.url).toString());
        if (viaFeed) return { ...viaFeed, feedUrl: body.url };
      }
      // Plain RSS/Atom: readable, not a blyg.
      return { kind: 'rss', origin: dirOf(body.url), feedUrl: body.url };
    }
    const link = body.text.match(/<link[^>]+rel=["']blyg["'][^>]*href=["']([^"']+)["']/i)
      || body.text.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']blyg["']/i);
    if (link) {
      const viaRel = await tryManifest(new URL(link[1], body.url).toString());
      if (viaRel) return viaRel;
    }
  }

  // 4. Courtesy fallback: conventional /blyg/ mount on the host.
  const host = new URL(url);
  if (host.pathname !== '/blyg/') {
    const conv = await tryManifest(`${host.protocol}//${host.host}/blyg/blyg.json`);
    if (conv) return conv;
  }

  // 5. Give up: record what we know.
  if (body && body.ok) return { kind: 'rss', origin: dir, feedUrl: undefined, error: 'no manifest; HTML without rel=blyg' };
  return { kind: 'unresolved', origin: dir, error: body ? `HTTP ${body.status}` : 'fetch failed' };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseOpml(xml: string): Array<{ text: string; xmlUrl?: string; htmlUrl?: string }> {
  const out: Array<{ text: string; xmlUrl?: string; htmlUrl?: string }> = [];
  for (const m of xml.matchAll(/<outline\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const get = (k: string) => { const a = attrs.match(new RegExp(`\\b${k}=["']([^"']*)["']`)); return a ? a[1].replace(/&amp;/g, '&') : undefined; };
    const xmlUrl = get('xmlUrl'); const htmlUrl = get('htmlUrl');
    if (!xmlUrl && !htmlUrl) continue;
    out.push({ text: get('text') || get('title') || '', xmlUrl, htmlUrl });
  }
  return out;
}

/** Markdown → plain text for embedding/reranking. Transclusion directives and wiki-links are dropped. */
export function mdToText(md: string): string {
  return md
    .replace(/!\[\[[^\]]+\]\]/g, ' ')
    .replace(/\[\[[^\]]+\]\]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_`~]{1,3}/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Items are titleless on the wire; a leading H1 or the first short line is a usable handle.
 *  Quoted material (blockquotes) and transclusion markers are skipped so a post that opens by
 *  quoting someone else isn't titled with their words (2026-10-11). Falls back to the first line. */
export function deriveTitle(md: string, text: string): string {
  const h1 = md.match(/^\s{0,3}#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim().slice(0, 160);
  const own = md.split('\n').map(s => s.trim())
    .find(s => s.length > 0 && !/^>/.test(s) && !/^!\[\[[^\]]*\]\]$/.test(s) && !/^!\[[^\]]*\]\([^)]*\)$/.test(s));
  const first = (own ? mdToText(own) : '') || text.split('\n').map(s => s.trim()).find(s => s.length > 0) || '';
  return first.length <= 120 ? first : first.slice(0, 117) + '…';
}

function htmlToText(html: string): string {
  return mdToText(html.replace(/<\/(p|div|h[1-6]|li|blockquote|br)>/gi, '\n'));
}

export interface ParsedEdge {
  type: 'transclusion' | 'stub' | 'stub_url' | 'fork' | 'link';
  dst_origin?: string; dst_id?: string; dst_version?: number; dst_url?: string;
  selector_exact?: string; cited_excerpt?: string; cited_author?: string; cited_source?: string;
}

export function extractEdges(doc: any, origin: string): ParsedEdge[] {
  const edges: ParsedEdge[] = [];
  const ref = (r: any) => ({
    dst_origin: typeof r?.origin === 'string' ? normalizeOrigin(r.origin) : undefined,
    dst_id: typeof r?.id === 'string' ? r.id : undefined,
    dst_version: typeof r?.version === 'number' ? r.version : undefined,
    dst_url: typeof r?.url === 'string' ? r.url : (typeof r?.cited?.url === 'string' ? r.cited.url : undefined),
    cited_excerpt: r?.cited?.excerpt, cited_author: r?.cited?.author, cited_source: r?.cited?.source,
  });
  for (const t of Array.isArray(doc.transclusions) ? doc.transclusions : []) {
    if (!t?.id) continue;
    edges.push({ type: 'transclusion', ...ref(t), dst_origin: ref(t).dst_origin ?? origin, selector_exact: t.selector?.exact });
  }
  if (doc.stub_of && typeof doc.stub_of === 'object') {
    const s = doc.stub_of;
    if (s.id) edges.push({ type: 'stub', ...ref(s), dst_origin: ref(s).dst_origin ?? origin });
    else if (s.url) edges.push({ type: 'stub_url', dst_url: s.url, cited_excerpt: s.cited?.excerpt, cited_author: s.cited?.author, cited_source: s.cited?.source });
  }
  if (doc.forked_from && typeof doc.forked_from === 'object' && doc.forked_from.id) {
    edges.push({ type: 'fork', ...ref(doc.forked_from), dst_origin: ref(doc.forked_from).dst_origin ?? origin });
  }
  // Plain [[id]] links: silent citations, no origin on the wire. Resolved by id after the crawl.
  const md: string = typeof doc.content_md === 'string' ? doc.content_md : '';
  const seen = new Set<string>();
  for (const m of md.matchAll(/(^|[^!])\[\[([0-9a-z]{26})(?:@v\d+)?\]\]/g)) {
    const id = m[2];
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const already = edges.some(e => e.dst_id === id && e.type === 'transclusion');
    if (!already) edges.push({ type: 'link', dst_id: id });
  }
  return edges;
}

export function normalizeOrigin(o: string): string {
  try { const u = new URL(o); u.search = ''; u.hash = ''; if (!u.pathname.endsWith('/')) u.pathname += '/'; return u.toString(); }
  catch { return o.endsWith('/') ? o : o + '/'; }
}

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------

export interface CrawlOptions {
  seeds?: string[];
  maxHops?: number;        // distance from seeds to follow (default 2)
  maxOrigins?: number;     // hard cap on origins visited per run (default 60)
  follow?: Array<'blogroll' | 'transclusion' | 'stub' | 'fork' | 'link'>; // which edge types enqueue new origins
  refreshAll?: boolean;    // ignore conditional-GET and re-fetch every item
  revisit?: boolean;       // also re-check every blyg already held, within the hop budget (default: yes when crawling from
                           // seeds.json, no when seeds are given by hand). Without it a blyg found through a citation is
                           // only looked at again when the item citing it changes.
  netWait?: number;        // seconds' worth of retries (one every 15 s) while no seed answers at all — for a scheduled run on
                           // a laptop that wakes before its network does (default 0: fail at once)
  log?: (s: string) => void;
}

export interface CrawlReport {
  run_id: number; origins_visited: number; items_fetched: number; items_changed: number; edges_added: number;
  new_origins: string[]; frontier: number; errors: Array<{ origin: string; error: string }>; notes: string[]; seconds: number;
  kinds: { blyg: number; rss: number; unresolved: number };   // what the origins visited this run turned out to be
  rechecked: number;                                          // blygs already held that this run looked at again
  seeds: number; seeds_unreachable: number;                   // seeds asked for, and how many could not be reached at all
}

export function loadSeeds(): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(SEEDS_PATH, 'utf-8'));
    return Array.isArray(j.seeds) ? j.seeds : [];
  } catch { return []; }
}

export async function crawl(db: Database.Database, opts: CrawlOptions = {}): Promise<CrawlReport> {
  const t0 = Date.now();
  const log = opts.log || ((s: string) => process.stderr.write(s + '\n'));
  const ownSeeds = !(opts.seeds && opts.seeds.length);
  const seeds = (ownSeeds ? loadSeeds() : opts.seeds!).map(s => s.trim()).filter(Boolean);
  if (!seeds.length) {
    throw new Error(fs.existsSync(SEEDS_PATH)
      ? `no seeds: ${SEEDS_PATH} lists none — add the blygs you follow under "seeds", or pass seed URLs to crawl`
      : `no seeds: ${SEEDS_PATH} does not exist — copy seeds.example.json to seeds.json (cp seeds.example.json seeds.json) and edit it, or pass seed URLs to crawl`);
  }
  const maxHops = opts.maxHops ?? 2;
  const maxOrigins = opts.maxOrigins ?? 60;
  const follow = new Set(opts.follow ?? ['blogroll', 'transclusion', 'stub', 'fork', 'link']);
  const now = () => new Date().toISOString();
  const errors: Array<{ origin: string; error: string }> = [];
  const notes: string[] = [];
  const newOrigins: string[] = [];
  let itemsFetched = 0, itemsChanged = 0, edgesAdded = 0, originsVisited = 0, seedsUnreachable = 0;
  const kinds = { blyg: 0, rss: 0, unresolved: 0 };

  const runId = Number(db.prepare(
    `INSERT INTO crawl_runs (started, seeds, max_hops, max_origins) VALUES (?, ?, ?, ?)`
  ).run(now(), JSON.stringify(seeds), maxHops, maxOrigins).lastInsertRowid);

  const upsertOrigin = db.prepare(`
    INSERT INTO origins (origin, kind, title, author_name, author_bio, blyg_version, level, generator, generator_url, site, updated, blogroll, webmention, hop, discovered_via, discovered_from, first_seen, raw_manifest)
    VALUES (@origin, @kind, @title, @author_name, @author_bio, @blyg_version, @level, @generator, @generator_url, @site, @updated, @blogroll, @webmention, @hop, @discovered_via, @discovered_from, @first_seen, @raw_manifest)
    ON CONFLICT(origin) DO UPDATE SET
      kind=excluded.kind, title=excluded.title, author_name=excluded.author_name, author_bio=excluded.author_bio,
      blyg_version=excluded.blyg_version, level=excluded.level, generator=excluded.generator, generator_url=excluded.generator_url,
      site=excluded.site, updated=excluded.updated, blogroll=excluded.blogroll, webmention=excluded.webmention,
      hop=MIN(origins.hop, excluded.hop), raw_manifest=excluded.raw_manifest`);
  const markCrawled = db.prepare(`UPDATE origins SET last_crawled=?, last_status=?, last_error=?, index_etag=COALESCE(?, index_etag), index_last_modified=COALESCE(?, index_last_modified) WHERE origin=?`);
  const getOrigin = db.prepare(`SELECT * FROM origins WHERE origin=?`);
  const getItemVersion = db.prepare(`SELECT version FROM items WHERE origin=? AND id=?`);
  const upsertItem = db.prepare(`
    INSERT INTO items (origin, id, kind, created, updated, version, title, content_md, content_text, content_hash, author_name, author_url, page, has_generated, fetched_at, first_seen, raw_json)
    VALUES (@origin, @id, @kind, @created, @updated, @version, @title, @content_md, @content_text, @content_hash, @author_name, @author_url, @page, @has_generated, @fetched_at, @fetched_at, @raw_json)
    ON CONFLICT(origin, id) DO UPDATE SET
      kind=excluded.kind, created=excluded.created, updated=excluded.updated, version=excluded.version, title=excluded.title,
      content_md=excluded.content_md, content_text=excluded.content_text, content_hash=excluded.content_hash,
      author_name=excluded.author_name, author_url=excluded.author_url, page=excluded.page, has_generated=excluded.has_generated,
      fetched_at=excluded.fetched_at, raw_json=excluded.raw_json`);
  const upsertChangelog = db.prepare(`INSERT OR REPLACE INTO changelog (origin, id, version, at, note, generated) VALUES (?, ?, ?, ?, ?, ?)`);
  const deleteItemEdges = db.prepare(`DELETE FROM edges WHERE src_origin=? AND src_id=? AND type != 'blogroll'`);
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges (src_origin, src_id, src_version, type, dst_origin, dst_id, dst_version, dst_url, selector_exact, cited_excerpt, cited_author, cited_source, seen_at)
    VALUES (@src_origin, @src_id, @src_version, @type, @dst_origin, @dst_id, @dst_version, @dst_url, @selector_exact, @cited_excerpt, @cited_author, @cited_source, @seen_at)`);
  const deleteBlogroll = db.prepare(`DELETE FROM edges WHERE src_origin=? AND type='blogroll'`);

  // Queue of {url, hop, via, from}. Visited keyed by resolved origin; attempted keyed by cleaned input URL
  // (a feed URL stays a feed URL here — resolution decides what directory it belongs to).
  const queue: Array<{ url: string; hop: number; via: string; from?: string }> = seeds.map(s => ({ url: s, hop: 0, via: 'seed' }));
  const attempted = new Set<string>();
  const visited = new Set<string>();

  const cleanUrl = (u: string): string | null => {
    try { const x = new URL(u); x.hash = ''; x.search = ''; return x.toString(); } catch { return null; }
  };

  const enqueue = (url: string | undefined, hop: number, via: string, from: string) => {
    if (!url) return;
    const clean = cleanUrl(url);
    if (!clean) return;
    if (attempted.has(clean) || visited.has(clean) || visited.has(dirOf(clean))) return;
    if (hop > maxHops) {
      // Beyond the hop budget: still record as a known-but-uncrawled origin so the frontier is visible.
      const key = dirOf(clean);
      if (!visited.has(key) && !getOrigin.get(key)) {
        upsertOrigin.run({ origin: key, kind: 'unresolved', title: null, author_name: null, author_bio: null, blyg_version: null, level: null, generator: null, generator_url: null, site: null, updated: null, blogroll: null, webmention: null, hop, discovered_via: via, discovered_from: from, first_seen: now(), raw_manifest: null });
      }
      return;
    }
    queue.push({ url: clean, hop, via, from });
  };

  async function processJob(job: { url: string; hop: number; via: string; from?: string }): Promise<void> {
    if (attempted.has(job.url)) return;
    attempted.add(job.url);
    if (originsVisited >= maxOrigins) return;

    let res: Resolved;
    try { res = await resolveOrigin(job.url); }
    catch (e: any) { res = { kind: 'unresolved', origin: dirOf(job.url), error: e.message }; }
    if (visited.has(res.origin)) return;
    visited.add(res.origin);
    originsVisited++;

    const held: any = getOrigin.get(res.origin);
    const existed = !!held;
    if (!existed) newOrigins.push(res.origin);
    kinds[res.kind]++;
    if (res.kind === 'unresolved' && job.hop === 0) seedsUnreachable++;

    if (res.kind === 'unresolved' && held?.kind === 'blyg') {
      // A blyg this atlas already holds did not answer this time (network down, host down). Keep what is known about
      // it — its manifest fields and its items stand — and record the miss; the next run tries again.
      markCrawled.run(now(), 'unreachable', res.error ?? null, null, null, res.origin);
      errors.push({ origin: res.origin, error: `unreachable: ${res.error ?? 'no answer'}` });
      log(`  unreachable ${res.origin} — ${res.error ?? 'no answer'} (a known blyg; kept as it was)`);
      return;
    }

    if (res.kind !== 'blyg') {
      upsertOrigin.run({
        origin: res.origin, kind: res.kind, title: null, author_name: null, author_bio: null, blyg_version: null, level: null,
        generator: null, generator_url: null, site: null, updated: null, blogroll: null, webmention: null,
        hop: job.hop, discovered_via: job.via, discovered_from: job.from ?? null, first_seen: now(), raw_manifest: null,
      });
      markCrawled.run(now(), res.kind, res.error ?? null, null, null, res.origin);
      log(`  ${res.kind.padEnd(10)} ${res.origin}${res.error ? ' — ' + res.error : ''}`);
      return;
    }

    const m = res.manifest;
    upsertOrigin.run({
      origin: res.origin, kind: 'blyg', title: m.title ?? null, author_name: m.author?.name ?? null, author_bio: m.author?.bio ?? null,
      blyg_version: m.blyg ?? null, level: typeof m.level === 'number' ? m.level : null, generator: m.generator ?? null, generator_url: m.generator_url ?? null,
      site: m.site ?? null, updated: m.updated ?? null, blogroll: m.blogroll ?? null, webmention: m.webmention ?? null,
      hop: job.hop, discovered_via: job.via, discovered_from: job.from ?? null, first_seen: now(), raw_manifest: JSON.stringify(m),
    });
    const prev: any = getOrigin.get(res.origin);
    log(`${job.hop} blyg       ${res.origin}  (${m.generator ?? '?'}, L${m.level ?? '?'})`);

    // Archive index — the lossless surface. Conditional GET when we have validators.
    const indexUrl = new URL(m.items || 'items/index.json', res.origin).toString();
    let idx: any = null; let idxRes: FetchResult | null = null;
    try {
      const cond: Record<string, string> = {};
      if (!opts.refreshAll && prev?.index_etag) cond['If-None-Match'] = prev.index_etag;
      if (!opts.refreshAll && prev?.index_last_modified) cond['If-Modified-Since'] = prev.index_last_modified;
      idxRes = await httpGet(indexUrl, cond);
      if (idxRes.status === 304) {
        markCrawled.run(now(), 'ok (304)', null, null, null, res.origin);
        log(`    index unchanged (304)`);
      } else if (idxRes.ok) {
        idx = JSON.parse(idxRes.text);
      } else {
        throw new Error(`index HTTP ${idxRes.status}`);
      }
    } catch (e: any) {
      errors.push({ origin: res.origin, error: `index: ${e.message}` });
      markCrawled.run(now(), 'error', `index: ${e.message}`, null, null, res.origin);
    }

    if (idx && Array.isArray(idx.items)) {
      // Diff against what we hold; fetch only new or moved items.
      const toFetch: Array<{ id: string; version: number }> = [];
      for (const it of idx.items) {
        if (!it?.id || !ID_RE.test(it.id)) continue;
        const have: any = getItemVersion.get(res.origin, it.id);
        const v = typeof it.version === 'number' ? it.version : 0;
        if (have && have.version > v) notes.push(`watermark regression at ${res.origin}${it.id}: held v${have.version}, index says v${v}`);
        if (opts.refreshAll || !have || have.version < v) toFetch.push({ id: it.id, version: v });
      }
      log(`    ${idx.items.length} items in index, ${toFetch.length} to fetch`);

      // Item documents: conventional items/{id}.json, or the manifest-located template (§16.6e, 0.4 candidate —
      // already live on at least one third-party generator, soapbox-blyg on WordPress).
      const itemUrlFor = (id: string) => typeof m.item === 'string' && m.item.includes('{id}')
        ? new URL(m.item.replace('{id}', id), res.origin).toString()
        : new URL(`items/${id}.json`, res.origin).toString();
      let got = 0;
      const docs = await pool(toFetch, CONCURRENCY, async (it) => {
        const url = itemUrlFor(it.id);
        try {
          const r = await httpGet(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return { it, doc: JSON.parse(r.text) as any };
        } catch (e: any) {
          errors.push({ origin: res.origin, error: `item ${it.id}: ${e.message}` });
          return { it, doc: null };
        } finally {
          // a large archive is minutes of fetching; say where it is
          if (++got % 250 === 0 && got < toFetch.length) log(`    … ${got}/${toFetch.length} from ${res.origin}`);
        }
      });

      const tx = db.transaction(() => {
        for (const { it, doc } of docs) {
          if (!doc) continue;
          itemsFetched++;
          const md: string = typeof doc.content_md === 'string' ? doc.content_md : '';
          const text = md ? mdToText(md) : (typeof doc.content_html === 'string' ? htmlToText(doc.content_html) : '');
          const have: any = getItemVersion.get(res.origin, it.id);
          if (!have || have.version !== (doc.version ?? it.version)) itemsChanged++;
          upsertItem.run({
            origin: res.origin, id: it.id, kind: doc.kind ?? null, created: doc.created ?? null, updated: doc.updated ?? null,
            version: typeof doc.version === 'number' ? doc.version : it.version,
            title: deriveTitle(md, text), content_md: md || null, content_text: text || null, content_hash: doc.content_hash ?? null,
            author_name: doc.author?.name ?? m.author?.name ?? null, author_url: doc.author?.url ?? null, page: doc.page ?? null,
            has_generated: Array.isArray(doc.generated) && doc.generated.length ? 1 : (Array.isArray(doc.changelog) && doc.changelog.some((c: any) => c?.generated) ? 1 : 0),
            fetched_at: now(), raw_json: JSON.stringify(doc),
          });
          for (const c of Array.isArray(doc.changelog) ? doc.changelog : []) {
            if (typeof c?.version === 'number') upsertChangelog.run(res.origin, it.id, c.version, c.at ?? null, c.note ?? null, c.generated ? 1 : 0);
          }
          deleteItemEdges.run(res.origin, it.id);
          for (const e of extractEdges(doc, res.origin)) {
            const r = insertEdge.run({
              src_origin: res.origin, src_id: it.id, src_version: doc.version ?? it.version, type: e.type,
              dst_origin: e.dst_origin ?? null, dst_id: e.dst_id ?? null, dst_version: e.dst_version ?? null, dst_url: e.dst_url ?? null,
              selector_exact: e.selector_exact ?? null, cited_excerpt: e.cited_excerpt ?? null, cited_author: e.cited_author ?? null, cited_source: e.cited_source ?? null,
              seen_at: now(),
            });
            if (r.changes) edgesAdded++;
            if (e.dst_origin && e.dst_origin !== res.origin && follow.has(e.type === 'stub_url' ? 'stub' : e.type as any)) {
              enqueue(e.dst_origin, job.hop + 1, e.type, res.origin);
            }
          }
        }
      });
      tx();
      // Store index validators only when every item fetch succeeded; otherwise a 304 next run would hide the gap.
      const originErrors = errors.filter(e => e.origin === res.origin && e.error.startsWith('item ')).length;
      markCrawled.run(now(), originErrors ? `ok (${originErrors} item errors)` : 'ok', null,
        originErrors ? null : (idxRes?.etag ?? null), originErrors ? null : (idxRes?.lastModified ?? null), res.origin);
    }

    // Blogroll — origin-to-origin curated edges.
    if (m.blogroll) {
      try {
        const r = await httpGet(new URL(m.blogroll, res.origin).toString());
        if (r.ok) {
          const entries = parseOpml(r.text);
          const prevBlogroll = new Set((db.prepare(`SELECT dst_url FROM edges WHERE src_origin=? AND type='blogroll'`).all(res.origin) as any[]).map(x => x.dst_url));
          const tx = db.transaction(() => {
            deleteBlogroll.run(res.origin);
            for (const o of entries) {
              const target = o.htmlUrl || o.xmlUrl!;
              const r = insertEdge.run({
                src_origin: res.origin, src_id: null, src_version: null, type: 'blogroll',
                dst_origin: null, dst_id: null, dst_version: null, dst_url: target,
                selector_exact: null, cited_excerpt: null, cited_author: null, cited_source: o.text || null, seen_at: now(),
              });
              if (r.changes && !prevBlogroll.has(target)) edgesAdded++;
            }
          });
          tx();
          log(`    blogroll: ${entries.length} entries`);
          if (follow.has('blogroll')) for (const o of entries) enqueue(o.htmlUrl || o.xmlUrl, job.hop + 1, 'blogroll', res.origin);
        }
      } catch (e: any) {
        errors.push({ origin: res.origin, error: `blogroll: ${e.message}` });
      }
    }
  }

  // A scheduled run on a laptop can start the moment the machine wakes, before its network is up (or in a background
  // wake that never gets one). When asked to, wait for any seed to answer before spending the run. The budget is counted
  // in tries, not clock time, so hours asleep between tries do not use it up.
  const tries = Math.ceil(Math.max(0, opts.netWait ?? 0) / NET_RETRY_S);
  for (let t = 1; t <= tries; t++) {
    const up = await Promise.all(seeds.slice(0, 3).map(u => httpGet(u, {}, 8000).then(() => true, () => false)));
    if (up.some(Boolean)) break;
    log(`  no seed answered — waiting for the network (${t}/${tries})`);
    await new Promise(r => setTimeout(r, NET_RETRY_S * 1000));
  }

  // The seeds first, on their own. better-sqlite3 is synchronous, so interleaved awaits never split a transaction;
  // the origin cap is checked per job and is therefore approximate by one batch.
  const seedJobs = queue.splice(0);
  for (let i = 0; i < seedJobs.length; i += CONCURRENCY) await Promise.all(seedJobs.slice(i, i + CONCURRENCY).map(processJob));

  let rechecked = 0;
  if (seedsUnreachable === seeds.length) {
    // Nothing answered: most likely no network. Stop here rather than mark every held blyg unreachable too.
    queue.length = 0;
    notes.push('no seed answered, so nothing else was tried this run');
  } else if (opts.revisit ?? ownSeeds) {
    // Every blyg already held, within the hop budget, goes to the front of the queue at the hop it was found at. Without
    // this only blogroll entries and the citations of items fetched in this run are followed, and a blyg discovered through
    // a citation would not be read again until the item citing it changed. A conditional GET makes an unchanged one cheap.
    const held = (db.prepare(`SELECT origin, hop, discovered_via, discovered_from FROM origins WHERE kind='blyg' AND hop <= ? ORDER BY hop, origin`).all(maxHops) as any[])
      .filter(o => !visited.has(o.origin));
    rechecked = held.length;
    if (held.length) log(`re-checking ${held.length} blyg${held.length === 1 ? '' : 's'} already held`);
    queue.unshift(...held.map(o => ({ url: o.origin as string, hop: o.hop as number, via: (o.discovered_via as string) || 'held', from: (o.discovered_from as string) ?? undefined })));
  }

  while (queue.length && originsVisited < maxOrigins) {
    const batch = queue.splice(0, CONCURRENCY);
    await Promise.all(batch.map(processJob));
  }

  // Post-pass: resolve blogroll dst_url → dst_origin, and bare [[id]] links → origin, now that we know more.
  resolveEdges(db);
  const frontier = (db.prepare(`SELECT COUNT(*) AS n FROM origins WHERE kind='unresolved' OR last_crawled IS NULL`).get() as any).n;

  db.prepare(`UPDATE crawl_runs SET finished=?, origins_visited=?, items_fetched=?, items_changed=?, edges_added=?, errors=?, notes=? WHERE id=?`)
    .run(now(), originsVisited, itemsFetched, itemsChanged, edgesAdded, JSON.stringify(errors), JSON.stringify(notes), runId);

  return { run_id: runId, origins_visited: originsVisited, items_fetched: itemsFetched, items_changed: itemsChanged, edges_added: edgesAdded, new_origins: newOrigins, frontier, errors, notes, seconds: Math.round((Date.now() - t0) / 100) / 10,
    kinds, rechecked, seeds: seeds.length, seeds_unreachable: seedsUnreachable };
}

/** Fill in dst_origin for blogroll edges (by URL prefix match against known origins) and for bare [[id]] links (by id). */
export function resolveEdges(db: Database.Database): void {
  const origins = (db.prepare(`SELECT origin FROM origins`).all() as any[]).map(r => r.origin as string);
  const setDst = db.prepare(`UPDATE edges SET dst_origin=? WHERE rowid=?`);
  const blog = db.prepare(`SELECT rowid, dst_url FROM edges WHERE type='blogroll' AND dst_origin IS NULL`).all() as any[];
  for (const e of blog) {
    const url = e.dst_url as string;
    // Longest known origin that is a prefix of the url, or whose host matches a feed URL.
    let best: string | null = null;
    for (const o of origins) {
      if (url.startsWith(o) && (!best || o.length > best.length)) best = o;
    }
    if (!best) {
      try {
        const h = new URL(url).host;
        const sameHost = origins.filter(o => { try { return new URL(o).host === h; } catch { return false; } });
        if (sameHost.length === 1) best = sameHost[0];
      } catch { /* skip */ }
    }
    if (best) setDst.run(best, e.rowid);
  }
  const links = db.prepare(`SELECT rowid, dst_id FROM edges WHERE type='link' AND dst_origin IS NULL`).all() as any[];
  const byId = db.prepare(`SELECT origin FROM items WHERE id=?`);
  for (const e of links) {
    const hits = byId.all(e.dst_id) as any[];
    if (hits.length === 1) setDst.run(hits[0].origin, e.rowid);
  }
}

/** Find an item by (origin,id), by bare id, or by any page/item URL. */
export function locateItem(db: Database.Database, ref: string | { origin?: string; id?: string }): { origin: string; id: string } | null {
  if (typeof ref === 'object') {
    if (ref.origin && ref.id) return { origin: normalizeOrigin(ref.origin), id: ref.id };
    if (ref.id) ref = ref.id; else return null;
  }
  const s = String(ref).trim();
  if (ID_RE.test(s)) {
    const hits = db.prepare(`SELECT origin, id FROM items WHERE id=?`).all(s) as any[];
    if (hits.length) return hits[0];
    const e = db.prepare(`SELECT dst_origin AS origin, dst_id AS id FROM edges WHERE dst_id=? AND dst_origin IS NOT NULL LIMIT 1`).get(s) as any;
    return e ? { origin: e.origin, id: e.id } : null;
  }
  const m = s.match(/([0-9a-hjkmnp-tv-z]{26})/);
  if (m) {
    const hits = db.prepare(`SELECT origin, id FROM items WHERE id=?`).all(m[1]) as any[];
    if (hits.length === 1) return hits[0];
    const o = hits.find(h => s.startsWith(h.origin));
    if (o) return o;
    if (hits.length) return hits[0];
  }
  return null;
}
