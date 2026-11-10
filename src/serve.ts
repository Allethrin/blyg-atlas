// Blyg Atlas dashboard — a minimal local reader over the atlas: search bar, item pages with the
// citation graph as links, and a read history recorded in the database (which items were opened, when,
// for how long). Loopback only. Nothing here publishes anything.
//
//   blyg-atlas serve [--port 5053]      → http://127.0.0.1:5053

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';

import { ATLAS_DIR, PUBLISHER, PORT as DEFAULT_PORT } from './config.js';

const PORT = Number(process.argv.find((a, i, arr) => arr[i - 1] === '--port') ?? DEFAULT_PORT);

async function main() {
  const { db, executeTool, itemRow, edgesOf, readsView, pulse, markViewed, lastViewed } = await import('./tools.js');
  const { search, similar, embedMissing, itemUrl } = await import('./search.js');
  const { crawl, locateItem } = await import('./core.js');
  const Q = await import('./query.js');
  const d = db();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const wrap = (fn: (req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
    try { const out = await fn(req, res); if (out !== undefined) res.json(out); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  const now = () => new Date().toISOString();

  // Read markers: last time each (origin,id) was opened, for annotating lists.
  const lastRead = d.prepare(`SELECT MAX(at) AS at, COUNT(*) AS n FROM reads WHERE origin=? AND item_id=?`);
  const annotate = <T extends { origin: string; id: string }>(rows: T[]) => rows.map(r => { const lr = lastRead.get(r.origin, r.id) as any; return { ...r, read_at: lr?.at ?? null, reads: lr?.n ?? 0 }; });

  // --- Reading ---------------------------------------------------------------
  app.get('/api/search', wrap(async (req) => {
    const q = String(req.query.q || '').trim();
    if (!q) return { hits: [] };
    const r = await search(d, q, { top_k: Number(req.query.top_k || 12), hops: req.query.hops !== undefined ? Number(req.query.hops) : 2, min_score: req.query.min_score ? Number(req.query.min_score) : undefined, origin: req.query.origin ? String(req.query.origin) : undefined });
    return { ...r, hits: annotate(r.hits) };
  }));

  app.get('/api/similar', wrap(async (req) => {
    const r = await similar(d, String(req.query.origin), String(req.query.id), { top_k: Number(req.query.top_k || 8) });
    return { ...r, hits: annotate(r.hits) };
  }));

  app.get('/api/item', wrap(async (req) => {
    const loc = req.query.ref ? locateItem(d, String(req.query.ref)) : { origin: String(req.query.origin), id: String(req.query.id) };
    if (!loc) throw new Error('not found');
    const it = itemRow(d, loc.origin, loc.id);
    if (!it) throw new Error('item not crawled');
    const raw = JSON.parse((d.prepare(`SELECT raw_json FROM items WHERE origin=? AND id=?`).get(loc.origin, loc.id) as any).raw_json || '{}');
    const changelog = F.itemHistory(d, loc.origin, loc.id);   // bulk revisions marked, for the reader's history
    const origin = d.prepare(`SELECT title, author_name, generator FROM origins WHERE origin=?`).get(loc.origin);
    const reads = d.prepare(`SELECT at, dwell_ms FROM reads WHERE origin=? AND item_id=? ORDER BY at DESC LIMIT 20`).all(loc.origin, loc.id);
    const edges = edgesOf(d, loc.origin, loc.id);
    return {
      origin: it.origin, id: it.id, kind: it.kind, version: it.version, created: it.created, updated: it.updated, title: it.title,
      author: it.author_name, origin_title: (origin as any)?.title, generator: (origin as any)?.generator, url: itemUrl(it.origin, it.id, it.page, it.kind),
      content_html: raw.content_html ?? null, content_text: it.content_text, has_generated: !!it.has_generated, changelog, edges, reads,
      kept_under: Q.keptUnder(d, loc.origin, loc.id),
    };
  }));

  app.get('/api/recent', wrap(async (req) => {
    const origin = req.query.origin ? `%${String(req.query.origin)}%` : null;
    const since = req.query.since ? String(req.query.since) : null;
    const rows = d.prepare(`SELECT origin, id, kind, version, updated, title, author_name AS author, page, substr(content_text, 1, 260) AS excerpt
      FROM items WHERE 1=1 ${origin ? 'AND origin LIKE ?' : ''} ${since ? 'AND updated >= ?' : ''} ORDER BY updated DESC LIMIT ?`)
      .all(...(origin ? [origin] : []), ...(since ? [since] : []), Number(req.query.limit || 40)) as any[];
    return annotate(rows.map(r => ({ ...r, url: itemUrl(r.origin, r.id, r.page, r.kind) })));
  }));
  app.get('/api/thread', wrap(async (req) => JSON.parse(await executeTool('blyg_thread', { ref: String(req.query.ref) }))));
  // Pulse: what moved in the neighborhood. `since` ISO or `days`; default = last time "caught up" was pressed.
  app.get('/api/pulse', wrap(async (req) => {
    const since = req.query.since ? String(req.query.since) : req.query.days ? new Date(Date.now() - Number(req.query.days) * 86400_000).toISOString() : undefined;
    const r = pulse(d, { since, limit: Number(req.query.limit || 30), origin: req.query.origin ? String(req.query.origin) : undefined, neighborhood: req.query.neighborhood !== '0' });
    return { ...r, threads: r.threads.map(t => ({ ...t, events: annotate(t.events) })) };
  }));
  app.post('/api/pulse/viewed', wrap(async () => ({ viewed: markViewed(d) })));
  app.get('/api/pulse/viewed', wrap(async () => ({ viewed: lastViewed(d) })));
  app.get('/api/map', wrap(async () => JSON.parse(await executeTool('blyg_map', {}))));
  app.get('/api/frontier', wrap(async () => JSON.parse(await executeTool('blyg_frontier', {}))));
  app.get('/api/stale', wrap(async () => JSON.parse(await executeTool('blyg_stale', { limit: 40 }))));
  app.post('/api/crawl', wrap(async () => {
    const rep = await crawl(d, {});
    const emb = await embedMissing(d);
    return { ...rep, embed: emb };
  }));

  // --- Standing queries ------------------------------------
  const qid = (req: express.Request) => { const n = Number(req.params.id); if (!Number.isInteger(n)) throw new Error('bad query id'); return n; };
  const itemRef = (req: express.Request) => ({ origin: String(req.body?.origin || ''), id: String(req.body?.id || '') });
  app.get('/api/queries', wrap(async (req) => Q.listQueries(d, req.query.all === '1')));
  app.post('/api/queries', wrap(async (req) => {
    const q = Q.addQuery(d, String(req.body?.text || ''), req.body?.note ?? null);
    // A query declared from a search should show results straight away, not tomorrow morning.
    const run = await Q.runQuery(d, q);
    return { query: q, run };
  }));
  app.get('/api/query/:id', wrap(async (req) => {
    const s = Q.showQuery(d, qid(req));
    return { ...s, hits: annotate(s.hits), keeps: annotate(s.keeps) };
  }));
  app.post('/api/query/:id/run', wrap(async (req) => Q.runQuery(d, Q.getQuery(d, qid(req)))));
  app.post('/api/query/:id/seen', wrap(async (req) => ({ last_viewed: Q.markSeen(d, qid(req)) })));
  app.post('/api/query/:id/active', wrap(async (req) => Q.setActive(d, qid(req), !!req.body?.active)));
  app.post('/api/query/:id/delete', wrap(async (req) => Q.deleteQuery(d, qid(req))));
  app.post('/api/query/:id/keep', wrap(async (req) => Q.keep(d, qid(req), itemRef(req), { note: req.body?.note ?? null })));
  app.post('/api/query/:id/unkeep', wrap(async (req) => Q.unkeep(d, qid(req), itemRef(req))));
  app.post('/api/query/:id/dismiss', wrap(async (req) => Q.dismiss(d, qid(req), itemRef(req))));

  // --- Casual replies: shell out to the reader's own publisher (config `publisher`), which owns rendering, the
  // §10.2 checks and the wire. Not part of this repo: the atlas is reader-side; whoever has a blyg brings their own
  // publisher. preview = `reply --dry-run` (nothing written); publish = `reply --yes --no-mention` after the reader
  // has looked at the preview (the button is the review prompt), then the mention waits for the page in a detached
  // process. Without a publisher configured the routes answer 400 and the dashboard shows no reply button.
  const PUBLISH = PUBLISHER;
  const PUBLISH_CWD = PUBLISH ? path.dirname(PUBLISH) : ATLAS_DIR;
  const MENTION_LOG = path.join(PUBLISH_CWD, 'mention-runs.log');
  const publisher = (args: string[]) => new Promise<{ ok: boolean; output: string }>((resolve) => {
    if (!PUBLISH) return resolve({ ok: false, output: 'no publisher configured (atlas.config.json → publisher)' });
    execFile('npx', ['tsx', PUBLISH, ...args], { cwd: PUBLISH_CWD, timeout: 180_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: (stdout + (stderr ? '\n' + stderr : '')).trim() }));
  });
  const replyArgs = (req: express.Request) => {
    const ref = String(req.body?.ref || '').trim(), text = String(req.body?.text || '').trim(), quote = String(req.body?.quote || '').trim();
    if (!ref || !text) throw new Error('reply needs a target and some text');
    return ['reply', ref, text, ...(quote ? ['--quote', quote] : [])];
  };
  app.post('/api/reply/preview', wrap(async (req) => publisher([...replyArgs(req), '--dry-run'])));
  app.post('/api/reply', wrap(async (req) => {
    const r = await publisher([...replyArgs(req), '--yes', '--no-mention']);
    const m = r.output.match(/published ([0-9a-hjkmnp-tv-z]{26}) v(\d+) → (\S+)/);
    if (!r.ok || !m) return { ...r, ok: false };
    const log = fs.openSync(MENTION_LOG, 'a');
    fs.writeSync(log, `\n=== ${now()} mention ${m[1]}\n`);
    spawn('npx', ['tsx', PUBLISH!, 'mention', m[1], '--wait'], { cwd: PUBLISH_CWD, detached: true, stdio: ['ignore', log, log] }).unref();
    return { ...r, id: m[1], version: Number(m[2]), url: m[3], mention: `sending once the page is live — log: ${MENTION_LOG}` };
  }));

  // --- Read history ------------------------------------------------------------
  // The page records an item open; a dwell beacon tops it up when the reader moves on. Local, never published.
  app.post('/api/read', wrap(async (req) => {
    const b = req.body || {};
    if (!b.origin || !b.id) throw new Error('origin and id required');
    // a reload of the same item within a minute is the same read
    const prev = d.prepare(`SELECT id, at FROM reads WHERE origin=? AND item_id=? ORDER BY id DESC LIMIT 1`).get(b.origin, b.id) as any;
    if (prev && Date.now() - Date.parse(prev.at) < 60_000) return { read_id: prev.id, repeated: true };
    const r = d.prepare(`INSERT INTO reads (origin, item_id, version, at) VALUES (?, ?, ?, ?)`).run(b.origin, b.id, b.version ?? null, now());
    return { read_id: Number(r.lastInsertRowid) };
  }));
  app.post('/api/read/:id/dwell', wrap(async (req) => {
    d.prepare(`UPDATE reads SET dwell_ms=COALESCE(dwell_ms,0)+? WHERE id=?`).run(Math.max(0, Math.min(Number(req.body?.dwell_ms || 0), 6 * 3600_000)), Number(req.params.id));
    return { ok: true };
  }));
  app.get('/api/reads', wrap(async (req) => readsView(d, Number(req.query.limit || 40), req.query.since ? String(req.query.since) : undefined)));

  // --- Field: the thicket as a plane (UMAP over the item embeddings), regions, and the overlays ----------
  const F = await import('./field.js');
  const fieldLog = (s: string) => console.log(s);
  app.get('/api/field', wrap(async () => F.fieldJson(F.field(d, fieldLog))));
  app.get('/api/field/pulse', wrap(async (req) => F.fieldPulse(d, F.field(d, fieldLog), { since: req.query.since ? String(req.query.since) : undefined, days: req.query.days ? Number(req.query.days) : undefined })));
  app.get('/api/field/excerpts', wrap(async (req) => F.fieldExcerpts(d, F.field(d, fieldLog), String(req.query.i || '').split(',').map(Number).filter(Number.isInteger))));
  // rim labels for the tour: POST { sets: number[][], bg?: number[] } (point indexes) → string[][] of terms per set
  app.post('/api/field/terms', wrap(async (req) => F.fieldPoles(d, F.field(d, fieldLog), Array.isArray(req.body?.sets) ? req.body.sets : [], Array.isArray(req.body?.bg) ? req.body.bg : undefined)));
  app.get('/api/field/search', wrap(async (req) => {
    const q = String(req.query.q || '').trim();
    if (!q) return { query: q, hits: [] };
    return F.fieldSearch(d, F.field(d, fieldLog), q, Number(req.query.top_k || 30));
  }));

  // Optional parts the page asks about (casual replies need a publisher in atlas.config.json), and the running version.
  app.get('/api/features', wrap(async () => ({ publisher: !!PUBLISH, version: (await import('./config.js')).VERSION })));
  // What the atlas holds — the page reads this to explain an empty Field (nothing crawled yet / crawled but not embedded).
  app.get('/api/status', wrap(async () => {
    const { EMBED_MODEL } = await import('./embed.js');
    const { SEEDS_PATH } = await import('./config.js');
    const n = (sql: string, ...a: any[]) => (d.prepare(sql).get(...a) as any).n as number;
    const last = d.prepare(`SELECT started, finished, origins_visited, items_fetched FROM crawl_runs ORDER BY id DESC LIMIT 1`).get() as any;
    return {
      blygs: n(`SELECT COUNT(*) AS n FROM origins WHERE kind='blyg'`), items: n(`SELECT COUNT(*) AS n FROM items`),
      embeddable: n(`SELECT COUNT(*) AS n FROM items WHERE content_text IS NOT NULL AND length(content_text) > 0`),
      embedded: n(`SELECT COUNT(*) AS n FROM embeddings WHERE model=?`, EMBED_MODEL), embed_model: EMBED_MODEL,
      seeds_file: fs.existsSync(SEEDS_PATH), last_crawl: last ?? null,
    };
  }));
  app.use(express.static(path.join(ATLAS_DIR, 'public')));
  // Express 5 hands a failed listen to this callback too, so without the check a taken port printed the address and served nothing.
  app.listen(PORT, '127.0.0.1', (err?: Error) => {
    if (err) {
      const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      console.error(inUse
        ? `[blyg-atlas] port ${PORT} is already in use, so the dashboard did not start. Another blyg-atlas may be running; stop it, or pick another port: blyg-atlas serve --port ${PORT + 1} (or "port" in atlas.config.json, or BLYG_PORT).`
        : `[blyg-atlas] the dashboard could not start on port ${PORT}: ${err.message}`);
      process.exit(1);
    }
    console.log(`[blyg-atlas] http://127.0.0.1:${PORT}`);
  });
}

main();
