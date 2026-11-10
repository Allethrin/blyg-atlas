// Blyg Atlas CLI — the same tools as the MCP server, from the shell.
//
//   (blyg-atlas = bin/blyg-atlas, or `npx tsx src/cli.ts`)
//   blyg-atlas serve [--port 5053]     the dashboard → http://127.0.0.1:5053
//   blyg-atlas mcp                     the MCP server on stdio
//   blyg-atlas crawl [--hops 2] [--max-origins 60] [--no-embed] [--refresh-all] [--no-revisit] [--wait 3600] [--json] [seed-url ...]
//                                      --wait N: while no seed answers at all, retry every 15 s for N seconds' worth of tries
//                                      (a scheduled run on a laptop that wakes before its network); --no-revisit: follow only
//                                      what the seeds lead to this run, do not re-check the blygs already held
//   blyg-atlas embed                   embed whatever has no vector yet (Ollama when it is running, in-process otherwise)
//   blyg-atlas reembed                 drop every vector and embed the atlas again — the way to change embedding models
//   blyg-atlas search "query" [--top-k 8] [--hops 2] [--min-score 0.1] [--origin name] [--after ISO] [--half-life 7] [--no-rerank]
//   blyg-atlas item <id|url>
//   blyg-atlas thread <id|url>
//   blyg-atlas lineage <id|url>
//   blyg-atlas stale
//   blyg-atlas frontier
//   blyg-atlas map
//   blyg-atlas recent [--limit 25]
//   blyg-atlas pulse [--days 3 | --since ISO] [--limit 20] [--origin name] [--json] [--no-neighborhood] [--mark]
//   blyg-atlas sql "SELECT ..."
//
// Standing queries:
//   query add "<text>" [--note …] [--min-score 0.1]   declare
//   query list [--all]                                  id · text · unseen · moved last run · keeps/runs · top
//   query run [<id>|--all] [--since ISO] [--hits 5]     run against what moved since you last looked; never advances the watermark
//   query once "<text>" [--since ISO]                    a standing run without saving the query
//   query show <id>                                     hits since last looked, with state and path; keeps
//   query keep <id> <item-ref> [--note …]               file an item under a query
//   query unkeep <id> <item-ref> | query dismiss <id> <item-ref>
//   query seen <id>                                     mark its hits seen: advance the query's watermark to now
//   query retire <id> | query revive <id>               stop running it but keep its history | bring it back
//   query delete <id>                                   remove it with its runs, hits and keeps (not undoable)

import { PORT, CONTACT } from './config.js';

const USAGE = `blyg-atlas — a reader-side atlas of the blygger network

  first run:   cp seeds.example.json seeds.json     your subscription list
               blyg-atlas crawl                     walk the network from your seeds, embed what it finds
               blyg-atlas serve                     the dashboard and the Field → http://127.0.0.1:5053

  crawl [--hops 2] [--max-origins 60] [--no-embed] [--refresh-all] [--no-revisit] [--wait 3600] [--json] [seed-url ...]
  embed | reembed                     embed what is missing | drop every vector and embed again
  serve [--port 5053]                 the dashboard
  mcp                                 the same tools as an MCP server on stdio
  search "query" [--top-k 8] [--hops 2] [--origin name] [--after ISO] [--no-rerank]
  pulse [--days 3] · recent · map · frontier · stale
  item | thread | lineage <id|url>
  query add|list|run|once|show|keep|unkeep|dismiss|seen|retire|revive|delete
  sql "SELECT ..."

Every flag is in the comment at the top of src/cli.ts. (blyg-atlas = bin/blyg-atlas, or npx tsx src/cli.ts)
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { process.stdout.write(USAGE); return; }
  const { executeTool, db } = await import('./tools.js');
  const { embedMissing, reembed } = await import('./search.js');
  if (cmd === 'serve') { await import('./serve.js'); return; }   // serve.ts reads --port from argv itself
  if (cmd === 'mcp') { await import('./mcp.js'); return; }
  const flags: Record<string, any> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k.startsWith('no-')) flags[k.slice(3)] = false;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { const v = argv[++i]; flags[k] = isNaN(Number(v)) ? v : Number(v); }
      else flags[k] = true;
    } else pos.push(a);
  }
  const out = (s: string) => process.stdout.write(s + '\n');
  const err = (s: string) => process.stderr.write(s + '\n');

  switch (cmd) {
    case 'crawl': {
      // progress goes to stderr as it happens; the result is a short summary, or the full report with --json
      const text = await executeTool('blyg_crawl', { seeds: pos.length ? pos : undefined, hops: flags.hops, max_origins: flags['max-origins'], refresh_all: flags['refresh-all'], revisit: flags.revisit, wait: flags.wait, embed: flags.embed }, err);
      const r = JSON.parse(text);
      out(flags.json ? text : crawlSummary(r));
      for (const w of r.warnings ?? []) err(`warning: ${w}`);
      // a run that reached no seed, or stored items it could not embed, did not do its job — let a scheduler see that
      if (r.seeds_unreachable === r.seeds || r.embed?.error) process.exitCode = 1;
      break;
    }
    case 'embed':
    case 'reembed': {
      const r = await (cmd === 'reembed' ? reembed : embedMissing)(db(), err);
      out(r.embedded ? `embedded ${r.embedded} items with ${r.model}${r.backend ? ` (${r.backend === 'ollama' ? 'Ollama' : 'in-process'})` : ''} in ${fmtSecs(r.seconds)}` : 'nothing to embed — every item has a vector');
      break;
    }
    case 'search':
      out(await executeTool('blyg_search', { query: pos.join(' '), top_k: flags['top-k'], hops: flags.hops, seeds: flags.seeds, min_score: flags['min-score'], origin: flags.origin, after: flags.after, half_life_days: flags['half-life'], kind: flags.kind, rerank: flags.rerank }));
      break;
    case 'item': out(await executeTool('blyg_item', { ref: pos[0], full_text: flags.full })); break;
    case 'thread': out(await executeTool('blyg_thread', { ref: pos[0], depth: flags.depth })); break;
    case 'lineage': out(await executeTool('blyg_lineage', { ref: pos[0] })); break;
    case 'stale': out(await executeTool('blyg_stale', { origin: flags.origin, limit: flags.limit })); break;
    case 'frontier': out(await executeTool('blyg_frontier', {})); break;
    case 'map': out(await executeTool('blyg_map', { recent_days: flags.days })); break;
    case 'recent': out(await executeTool('blyg_recent', { limit: flags.limit, origin: flags.origin, since: flags.since })); break;
    case 'pulse': out(await executeTool('blyg_pulse', { days: flags.days, since: flags.since, limit: flags.limit, origin: flags.origin, half_life_days: flags['half-life'], neighborhood: flags.neighborhood, text: !flags.json, mark_viewed: !!flags.mark })); break;
    case 'sql': out(await executeTool('blyg_sql', { sql: pos.join(' '), limit: flags.limit })); break;
    case 'query': await queryCmd(db(), pos, flags, out); break;
    default:
      process.stderr.write(`unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(1);
  }
}

const fmtSecs = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

/** The crawl report as a reader would want it: what was found, what it cost, what to run next. */
function crawlSummary(r: any): string {
  const n = (k: number, one: string, many = one + 's') => `${k.toLocaleString()} ${k === 1 ? one : many}`;
  const k = r.kinds ?? { blyg: 0, rss: 0, unresolved: 0 };
  const lines = [
    `crawled ${n(r.origins_visited, 'origin')} in ${fmtSecs(r.seconds)}: ${n(k.blyg, 'blyg')}` +
      (k.rss ? `, ${n(k.rss, 'plain feed or page', 'plain feeds or pages')} (not blygs; noted, not read)` : '') + (k.unresolved ? `, ${k.unresolved} unreachable` : ''),
    `  ${n(r.items_fetched, 'item')} fetched (${r.items_changed.toLocaleString()} new or changed), ${n(r.edges_added, 'citation')} added`,
  ];
  if (r.embed && !r.embed.error) lines.push(r.embed.embedded
    ? `  ${n(r.embed.embedded, 'item')} embedded with ${r.embed.model}${r.embed.backend ? ` (${r.embed.backend === 'ollama' ? 'Ollama' : 'in-process'})` : ''} in ${fmtSecs(r.embed.seconds)}`
    : `  nothing new to embed`);
  if (r.frontier) lines.push(`  ${n(r.frontier, 'origin')} known but not crawled — beyond --hops, or unreachable (blyg-atlas frontier)`);
  const itemErrs = (r.errors ?? []).length;
  if (itemErrs) lines.push(`  ${n(itemErrs, 'error')} — first: ${r.errors[0].origin} ${r.errors[0].error}  (--json for all)`);
  for (const note of (r.notes ?? []).slice(0, 3)) lines.push(`  note: ${note}`);
  if (r.new_origins?.length && r.items_fetched) lines.push(`next: blyg-atlas serve   → the Field at http://127.0.0.1:${PORT}`);
  if (r.new_origins?.length && r.items_fetched && !CONTACT) lines.push(`note: no "contact" is set, so the sites this crawl reads see the software's name and no way to reach you. Put one in atlas.config.json, e.g. { "contact": "you@example.com" }, or set BLYG_CONTACT.`);
  return lines.join('\n');
}

async function queryCmd(d: any, pos: string[], flags: Record<string, any>, out: (s: string) => void) {
  const Q = await import('./query.js');
  const sub = pos.shift();
  const id = () => { const n = Number(pos[0]); if (!Number.isInteger(n)) throw new Error(`query ${sub}: expected a query id`); return n; };
  switch (sub) {
    case 'add': { const q = Q.addQuery(d, pos.join(' '), flags.note ?? null, flags['min-score'] ?? null); out(`declared #${q.id} "${q.text}"`); break; }
    case 'list': out(Q.renderQueries(Q.listQueries(d, !!flags.all))); break;
    case 'run': {
      const opts = { since: flags.since };
      if (flags.all || !pos.length) {
        const reps = await Q.runAll(d, opts, (s) => process.stderr.write(s + '\n'));
        for (const r of reps) out(Q.renderRun(r, { hits: flags.hits ?? 5 }) + '\n');
        out(Q.renderQueries(Q.listQueries(d)));
      } else out(Q.renderRun(await Q.runQuery(d, Q.getQuery(d, id()), opts), { hits: flags.hits }));
      break;
    }
    case 'once': out(Q.renderRun(await Q.runQuery(d, { id: null, text: pos.join(' '), last_viewed: null, min_score: flags['min-score'] ?? null }, { since: flags.since }), { hits: flags.hits })); break;
    case 'show': {
      const s = Q.showQuery(d, id());
      out(`#${s.query.id} "${s.query.text}"${s.query.active ? '' : ' (retired)'} · since ${s.since} · ${s.runs} runs · last run ${s.last_run ? `${s.last_run.at} (${s.last_run.moved} moved, ${s.last_run.hits} hits)` : 'never'}`);
      for (const h of s.hits) out(`  [${h.rerank_score.toFixed(2)}] ${h.state.padEnd(7)} ${h.title || h.id} — ${h.author || ''} · ${h.moved}${h.context ? ' (context)' : ''} ${h.moved_at?.slice(0, 10)}\n           ${h.path.join(' ')}   ${h.id}`);
      if (!s.hits.length) out('  (no hits since last looked)');
      if (s.keeps.length) { out('  kept:'); for (const k of s.keeps) out(`    ${k.kept_at.slice(0, 10)} ${k.title || k.id} — ${k.author || ''}${k.note ? ` — ${k.note}` : ''}   ${k.id}`); }
      break;
    }
    case 'keep': { const r = Q.keep(d, id(), pos[1], { note: flags.note ?? null }); out(`kept "${r.title || r.id}" v${r.version} under #${r.query_id}`); break; }
    case 'unkeep': out(JSON.stringify(Q.unkeep(d, id(), pos[1]))); break;
    case 'dismiss': out(JSON.stringify(Q.dismiss(d, id(), pos[1]))); break;
    case 'seen': out(`#${id()} marked seen at ${Q.markSeen(d, id())}`); break;
    case 'retire': Q.setActive(d, id(), false); out(`#${id()} retired`); break;
    case 'revive': Q.setActive(d, id(), true); out(`#${id()} active`); break;
    case 'delete': { const r = Q.deleteQuery(d, id()); out(`#${r.id} "${r.text}" deleted, with ${r.keeps} keeps and ${r.runs} runs`); break; }
    default: throw new Error('query add|list|run|once|show|keep|unkeep|dismiss|seen|retire|revive|delete  (see header comment)');
  }
}

main().catch((e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(1); });
