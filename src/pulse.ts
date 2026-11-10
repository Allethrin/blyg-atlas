// Blyg Atlas — pulse: "where is the recent activity in my neighborhood of the network?"
//
// Not a search. A diff over tables that are already timestamped (items.created/updated, one
// changelog row per version, the edges a moved item carries), with three rules that make it a
// feed instead of a list:
//
//   1. neighborhood weight — the read history defines the neighborhood: origins the reader has
//      actually opened (reads, capped dwell, decayed by age), spread one hop along the citation
//      graph, with a floor from seed distance. Not hop count from one seed.
//   2. group by thread — events roll up to the stub-chain root they belong to; a cross-origin
//      quote or fork of a thread's item is an event on that thread too ("one blyg quoted another").
//   3. since-I-last-looked per item — an item changed after the reader last read it outranks one
//      they have never opened; the view's own watermark lives in meta.pulse_last_viewed.
//
// Everything is computed locally from the reader's own crawl and read history. Nothing derived is published (§16.6d).

import type Database from 'better-sqlite3';
import { itemUrl } from './search.js';
import { loadSeeds, normalizeOrigin } from './core.js';

export interface PulseOptions {
  since?: string;            // ISO floor on author timestamps. Default: meta.pulse_last_viewed, else 7 days ago
  until?: string;            // default now
  limit?: number;            // threads returned (default 20)
  neighborhood?: boolean;    // weight by the read history (default true); false = recency only
  half_life_days?: number;   // recency decay (default 3)
  origin?: string;           // restrict to threads with a participant origin containing this string
  events_per_thread?: number; // default 8
}

export interface PulseEvent {
  kind: 'new' | 'revised' | 'quoted' | 'forked' | 'responded';
  at: string;
  origin: string; id: string; title: string | null; author: string | null; url: string; version: number;
  note?: string | null;          // changelog note for revisions
  excerpt?: string;
  by?: { origin: string; id: string; title: string | null; author: string | null; url: string }; // for quoted/forked/responded: the item that did it
  read_at?: string | null;       // the reader's last read of this item
  changed_since_read?: boolean;
  weight: number;                // the event's contribution to the thread score
}

export interface PulseThread {
  root: { origin: string; id: string; title: string | null; author: string | null; url: string; crawled: boolean };
  events: PulseEvent[];
  event_count: number;
  participants: string[];        // origins
  latest: string;
  score: number;
  affinity: number;              // max participant affinity (0–1)
  read: boolean;                 // the reader has read something in this thread
  changed_since_read: number;    // events on items they read that moved after the read
  why: string;                   // one-line rationale
}

export interface PulseReport {
  since: string; until: string; last_viewed: string | null;
  threads: PulseThread[];
  threads_total: number;
  events_total: number;
  by_origin: Array<{ origin: string; new: number; revised: number; quoted: number; affinity: number }>;
  new_origins: Array<{ origin: string; title: string | null; author: string | null; first_seen: string; items: number; via: string | null }>;
  affinity_basis: string;
}

const shortOrigin = (o: string) => o.replace(/^https?:\/\//, '').replace(/\/$/, '');
const DAY = 86400_000;
const days = (from: string, to: string) => Math.max(0, (Date.parse(to) - Date.parse(from)) / DAY);

// ---------------------------------------------------------------------------
// Neighborhood: per-origin affinity learned from the read history
// ---------------------------------------------------------------------------

export interface Affinity {
  origins: Map<string, number>;                        // 0–1
  reads: Map<string, { last_read: string; reads: number }>; // key origin|id
  basis: string;
}

const DWELL_CAP_MS = 10 * 60_000;      // a tab left open is not ten hours of attention
const READ_HALF_LIFE_DAYS = 30;        // interest fades; a read a month ago counts half
const SPREAD = 0.5;                    // share of affinity passed to an origin one citation hop away
const SEED_FLOOR = 0.4;                // origins in seeds.json start here even if never opened

export function affinity(db: Database.Database, now = new Date().toISOString()): Affinity {
  const steps = db.prepare(`SELECT origin, item_id, at, dwell_ms FROM reads`).all() as any[];
  const raw = new Map<string, number>();
  const reads = new Map<string, { last_read: string; reads: number }>();
  for (const s of steps) {
    const o = normalizeOrigin(s.origin);
    const age = days(s.at, now);
    const w = (1 + Math.min(s.dwell_ms || 0, DWELL_CAP_MS) / (5 * 60_000)) * Math.pow(2, -age / READ_HALF_LIFE_DAYS);
    raw.set(o, (raw.get(o) || 0) + w);
    const k = `${o}|${s.item_id}`;
    const r = reads.get(k);
    if (!r) reads.set(k, { last_read: s.at, reads: 1 });
    else { r.reads++; if (s.at > r.last_read) r.last_read = s.at; }
  }
  const max = Math.max(1e-9, ...raw.values());
  const direct = new Map<string, number>();
  for (const [o, v] of raw) direct.set(o, v / max);

  // Spread one hop along cross-origin citation edges (either direction), scaled by how many edges connect them.
  const links = db.prepare(`SELECT src_origin AS a, dst_origin AS b, COUNT(*) AS n FROM edges WHERE type IN ('transclusion','stub','fork','link') AND dst_origin IS NOT NULL AND src_origin <> dst_origin GROUP BY src_origin, dst_origin`).all() as any[];
  const out = new Map<string, number>(direct);
  for (const l of links) {
    const n = Math.min(1, Math.log1p(l.n) / Math.log(6));
    for (const [from, to] of [[l.a, l.b], [l.b, l.a]] as const) {
      const d = direct.get(from);
      if (!d) continue;
      const v = SPREAD * d * n;
      if ((out.get(to) || 0) < v) out.set(to, v);
    }
  }
  // Floors: seeds, then hop distance.
  for (const s of loadSeeds()) { const o = normalizeOrigin(s); if ((out.get(o) || 0) < SEED_FLOOR) out.set(o, SEED_FLOOR); }
  for (const r of db.prepare(`SELECT origin, hop FROM origins WHERE kind='blyg'`).all() as any[]) {
    const floor = 0.2 / (1 + (r.hop ?? 2));
    if ((out.get(r.origin) || 0) < floor) out.set(r.origin, floor);
  }
  return { origins: out, reads, basis: `${steps.length} reads over ${raw.size} origins, dwell capped ${DWELL_CAP_MS / 60000}m, read half-life ${READ_HALF_LIFE_DAYS}d, spread ${SPREAD} one citation hop, seed floor ${SEED_FLOOR}` };
}

// ---------------------------------------------------------------------------
// Pulse
// ---------------------------------------------------------------------------

const KIND_WEIGHT: Record<PulseEvent['kind'], number> = { responded: 1.0, quoted: 1.0, forked: 0.8, new: 0.6, revised: 0.5 };

export function lastViewed(db: Database.Database): string | null {
  const r = db.prepare(`SELECT value FROM meta WHERE key='pulse_last_viewed'`).get() as any;
  return r?.value ?? null;
}
export function markViewed(db: Database.Database, at = new Date().toISOString()): string {
  db.prepare(`INSERT INTO meta (key, value) VALUES ('pulse_last_viewed', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(at);
  return at;
}

/** The diff itself, shared by the pulse and standing queries (query.ts): items whose own author timestamps fall
 *  in the window, and the cross-origin stub/fork/transclusion targets each one carries (one row per (type, target),
 *  stub before fork before transclusion). */
export function moveReader(db: Database.Database) {
  const movedQ = db.prepare(`SELECT origin, id, kind, created, updated, version, title, author_name, page, substr(content_text,1,220) AS excerpt
    FROM items WHERE updated >= ? AND updated <= ? AND (? IS NULL OR origin LIKE ?) ORDER BY updated DESC`);
  // One row per (type, target): partial transclusions are several edge rows (one per selector) but one quote.
  const outEdges = db.prepare(`SELECT type, dst_origin, dst_id FROM edges WHERE src_origin=? AND src_id=? AND type IN ('stub','transclusion','fork') AND dst_id IS NOT NULL AND dst_origin IS NOT NULL GROUP BY type, dst_origin, dst_id ORDER BY CASE type WHEN 'stub' THEN 0 WHEN 'fork' THEN 1 ELSE 2 END`);
  return {
    rows: (since: string, until: string, origin?: string): any[] => movedQ.all(since, until, origin ?? null, origin ? `%${origin}%` : null) as any[],
    targets: (it: { origin: string; id: string }): Array<{ type: string; dst_origin: string; dst_id: string }> =>
      (outEdges.all(it.origin, it.id) as any[]).filter(e => e.dst_origin !== it.origin),
  };
}

export function pulse(db: Database.Database, opts: PulseOptions = {}): PulseReport {
  const until = opts.until ?? new Date().toISOString();
  const viewed = lastViewed(db);
  const since = opts.since ?? viewed ?? new Date(Date.parse(until) - 7 * DAY).toISOString();
  const limit = opts.limit ?? 20;
  const perThread = opts.events_per_thread ?? 8;
  const halfLife = opts.half_life_days ?? 3;
  const useNeighborhood = opts.neighborhood ?? true;
  const aff = affinity(db, until);
  const affOf = (o: string) => useNeighborhood ? (aff.origins.get(o) ?? 0.05) : 0.5;
  const recency = (at: string) => Math.pow(2, -days(at, until) / halfLife);

  const getItem = db.prepare(`SELECT origin, id, kind, created, updated, version, title, author_name, page, substr(content_text,1,220) AS excerpt FROM items WHERE origin=? AND id=?`);
  const brief = (it: any) => ({ origin: it.origin, id: it.id, title: it.title, author: it.author_name, url: itemUrl(it.origin, it.id, it.page, it.kind) });

  // Thread root: follow stub_of upward through crawled items (cycle-guarded). Uncrawled targets still key the thread.
  const stubUp = db.prepare(`SELECT dst_origin, dst_id FROM edges WHERE src_origin=? AND src_id=? AND type='stub' AND dst_id IS NOT NULL AND dst_origin IS NOT NULL LIMIT 1`);
  const rootCache = new Map<string, string>();
  const rootOf = (origin: string, id: string): string => {
    const start = `${origin}|${id}`;
    if (rootCache.has(start)) return rootCache.get(start)!;
    const seen = new Set<string>([start]);
    let cur = { origin, id };
    for (let i = 0; i < 12; i++) {
      const s = stubUp.get(cur.origin, cur.id) as any;
      if (!s) break;
      const k = `${s.dst_origin}|${s.dst_id}`;
      if (seen.has(k)) break;
      seen.add(k);
      cur = { origin: s.dst_origin, id: s.dst_id };
    }
    const root = `${cur.origin}|${cur.id}`;
    for (const k of seen) rootCache.set(k, root);
    return root;
  };

  const readOf = (origin: string, id: string) => aff.reads.get(`${origin}|${id}`);
  const threads = new Map<string, { events: PulseEvent[]; participants: Set<string> }>();
  const push = (rootKey: string, ev: PulseEvent) => {
    let t = threads.get(rootKey);
    if (!t) { t = { events: [], participants: new Set() }; threads.set(rootKey, t); }
    t.events.push(ev);
    t.participants.add(ev.origin);
    if (ev.by) t.participants.add(ev.by.origin);
  };
  const byOrigin = new Map<string, { new: number; revised: number; quoted: number }>();
  const tally = (o: string, k: 'new' | 'revised' | 'quoted') => { const c = byOrigin.get(o) || { new: 0, revised: 0, quoted: 0 }; c[k]++; byOrigin.set(o, c); };

  // Items that moved in the window (author timestamps — the wire's own clock).
  const mr = moveReader(db);
  const moved = mr.rows(since, until, opts.origin);
  const notesQ = db.prepare(`SELECT version, at, note FROM changelog WHERE origin=? AND id=? AND at >= ? ORDER BY version DESC`);
  let eventsTotal = 0;

  for (const it of moved) {
    const isNew = !it.created || it.created >= since;
    const read = readOf(it.origin, it.id);
    const changedSinceRead = !!read && it.updated > read.last_read;
    const root = rootOf(it.origin, it.id);
    const hasStub = !!(stubUp.get(it.origin, it.id));
    const base = { origin: it.origin, id: it.id, title: it.title, author: it.author_name, url: itemUrl(it.origin, it.id, it.page, it.kind), version: it.version, excerpt: it.excerpt, read_at: read?.last_read ?? null, changed_since_read: changedSinceRead };
    if (isNew) {
      // A new item that stubs something is a response in that thread; otherwise it opens its own.
      const kind: PulseEvent['kind'] = hasStub && root !== `${it.origin}|${it.id}` ? 'responded' : 'new';
      const w = KIND_WEIGHT[kind] * recency(it.updated) * (0.1 + 0.9 * affOf(it.origin));
      push(root, { kind, at: it.updated, ...base, weight: w });
      tally(it.origin, 'new');
    } else {
      const notes = notesQ.all(it.origin, it.id, since) as any[];
      const note = notes.find(n => n.note)?.note ?? null;
      const w = KIND_WEIGHT.revised * (note ? 1 : 0.5) * recency(it.updated) * (0.1 + 0.9 * affOf(it.origin)) * (changedSinceRead ? 1.5 : 1);
      push(root, { kind: 'revised', at: it.updated, ...base, note, weight: w });
      tally(it.origin, 'revised');
    }
    eventsTotal++;
    // Cross-origin quotes/forks carried by the moved item land on the target's thread too — one event per
    // target thread (stub beats fork beats transclusion), and never on the item's own thread, where the
    // new/responded event already says it.
    const touched = new Set<string>([root]);
    for (const e of mr.targets(it)) {
      const target = getItem.get(e.dst_origin, e.dst_id) as any;
      const tRoot = target ? rootOf(e.dst_origin, e.dst_id) : `${e.dst_origin}|${e.dst_id}`;
      if (touched.has(tRoot)) continue;
      touched.add(tRoot);
      const kind: PulseEvent['kind'] = e.type === 'fork' ? 'forked' : e.type === 'stub' ? 'responded' : 'quoted';
      const tRead = target ? readOf(e.dst_origin, e.dst_id) : undefined;
      const sinceRead = !!tRead && it.updated > tRead.last_read;
      const w = KIND_WEIGHT[kind] * recency(it.updated) * (0.1 + 0.9 * Math.max(affOf(it.origin), affOf(e.dst_origin))) * (sinceRead ? 1.5 : 1);
      push(tRoot, {
        kind, at: it.updated,
        origin: e.dst_origin, id: e.dst_id, title: target?.title ?? null, author: target?.author_name ?? null, url: target ? itemUrl(target.origin, target.id, target.page, target.kind) : itemUrl(e.dst_origin, e.dst_id), version: target?.version ?? 0,
        by: brief(it), read_at: tRead?.last_read ?? null, changed_since_read: sinceRead, weight: w,
      });
      tally(e.dst_origin, 'quoted');
      eventsTotal++;
    }
  }

  // Score and shape threads.
  const shaped: PulseThread[] = [];
  for (const [key, t] of threads) {
    const [ro, rid] = key.split('|');
    const rootItem = getItem.get(ro, rid) as any;
    const participants = [...t.participants];
    const maxAff = Math.max(...participants.map(affOf));
    const readAny = t.events.some(e => e.read_at) || !!readOf(ro, rid);
    const changed = t.events.filter(e => e.changed_since_read).length;
    const events = t.events.sort((a, b) => b.at.localeCompare(a.at));
    const score = events.reduce((s, e) => s + e.weight, 0) * (1 + 0.5 * (readAny ? 1 : 0)) * (participants.length > 1 ? 1.2 : 1);
    const whyBits = [
      participants.length > 1 ? `${participants.length} blygs in the thread` : null,
      changed ? `${changed} item${changed > 1 ? 's' : ''} changed since you read` : readAny ? 'you have read this thread' : null,
      useNeighborhood ? `affinity ${maxAff.toFixed(2)} (${shortOrigin(participants.sort((a, b) => affOf(b) - affOf(a))[0])})` : null,
    ].filter(Boolean);
    shaped.push({
      root: { origin: ro, id: rid, title: rootItem?.title ?? null, author: rootItem?.author_name ?? null, url: rootItem ? itemUrl(ro, rid, rootItem.page, rootItem.kind) : itemUrl(ro, rid), crawled: !!rootItem },
      events: events.slice(0, perThread), event_count: events.length, participants, latest: events[0].at,
      score: Number(score.toFixed(4)), affinity: Number(maxAff.toFixed(3)), read: readAny, changed_since_read: changed, why: whyBits.join(' · '),
    });
  }
  shaped.sort((a, b) => b.score - a.score);

  // Blygs new to the map — but not the ones the very first crawl brought in (that is the map being born, not news).
  const bootstrap = (db.prepare(`SELECT finished FROM crawl_runs ORDER BY id ASC LIMIT 1`).get() as any)?.finished ?? '';
  const newOrigins = db.prepare(`SELECT o.origin, o.title, o.author_name, o.first_seen, o.discovered_via, (SELECT COUNT(*) FROM items i WHERE i.origin=o.origin) AS items FROM origins o WHERE o.kind='blyg' AND o.first_seen >= ? AND o.first_seen <= ? AND o.first_seen > ? ORDER BY o.first_seen DESC`).all(since, until, bootstrap) as any[];

  return {
    since, until, last_viewed: viewed,
    threads: shaped.slice(0, limit), threads_total: shaped.length, events_total: eventsTotal,
    by_origin: [...byOrigin].map(([origin, c]) => ({ origin, ...c, affinity: Number(affOf(origin).toFixed(3)) })).sort((a, b) => (b.new + b.revised + b.quoted) - (a.new + a.revised + a.quoted)),
    new_origins: newOrigins.map(o => ({ origin: o.origin, title: o.title, author: o.author_name, first_seen: o.first_seen, items: o.items, via: o.discovered_via })),
    affinity_basis: aff.basis,
  };
}

// ---------------------------------------------------------------------------
// Text rendering — for the CLI and for a model writing a digest
// ---------------------------------------------------------------------------

export function renderPulse(r: PulseReport, opts: { threads?: number; events?: number } = {}): string {
  const fmt = (s: string) => new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const lines: string[] = [];
  const nThreads = opts.threads ?? r.threads.length;
  const nEvents = opts.events ?? 4;
  lines.push(`pulse · since ${fmt(r.since)}${r.last_viewed ? ` (last looked ${fmt(r.last_viewed)})` : ''} · ${r.threads_total} threads moved · ${r.events_total} events`);
  const quiet = r.by_origin.slice(0, 6).map(o => `${shortOrigin(o.origin)} ${o.new}n/${o.revised}r${o.quoted ? '/' + o.quoted + 'q' : ''}`).join(', ');
  if (quiet) lines.push(`by origin: ${quiet}${r.by_origin.length > 6 ? ', …' : ''}`);
  for (const o of r.new_origins) lines.push(`new blyg on the map: ${shortOrigin(o.origin)} (${o.author || o.title || '?'}, ${o.items} items, via ${o.via || '?'})`);
  r.threads.slice(0, nThreads).forEach((t, i) => {
    lines.push('');
    lines.push(`${i + 1}. [${t.score.toFixed(2)}] ${t.root.title || '(untitled)'} — ${t.root.author || shortOrigin(t.root.origin)}${t.root.crawled ? '' : ' (root not crawled)'} · ${t.event_count} event${t.event_count === 1 ? '' : 's'} · ${t.why}`);
    for (const e of t.events.slice(0, nEvents)) {
      const who = e.by ? `${e.by.author || shortOrigin(e.by.origin)}` : (e.author || shortOrigin(e.origin));
      const verb = e.kind === 'new' ? 'posted' : e.kind === 'revised' ? `revised v${e.version}` : e.kind === 'responded' ? 'responded' : e.kind === 'quoted' ? 'quoted' : 'forked';
      const what = e.by ? ` "${(e.title || e.id).slice(0, 70)}" in "${(e.by.title || e.by.id).slice(0, 70)}"` : ` "${(e.title || e.id).slice(0, 90)}"`;
      lines.push(`   · ${fmt(e.at)} ${who} ${verb}${what}${e.note ? ` — ${e.note.slice(0, 110)}` : ''}${e.changed_since_read ? ' ⟲ since your read' : e.read_at ? ' (read)' : ''}`);
    }
    if (t.event_count > nEvents) lines.push(`   · … ${t.event_count - nEvents} more`);
  });
  return lines.join('\n');
}
