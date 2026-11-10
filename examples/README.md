# Running it on a schedule, and from Claude Code

**Daily crawl (cron, Linux/macOS)** — crawl at 06:45, then run the standing queries:

```
45 6 * * * cd /PATH/TO/blyg-atlas && (npx tsx src/cli.ts crawl --wait 3600 && npx tsx src/cli.ts query run --all) >> crawl.log 2>&1
```

`--wait 3600` is for machines that are not always online at that hour: while no seed answers at all, the crawl retries every 15 seconds (240 tries, not counting time asleep) instead of failing at once. A run that still reaches no seed, or cannot embed what it fetched, exits non-zero, so the queries after `&&` do not run on stale data.

**Daily crawl (macOS launchd)** — `com.example.blygcrawl.plist` in this folder; edit the two paths, copy it to `~/Library/LaunchAgents/`, `launchctl load` it.

**MCP server (Claude Code)** — the same tools the CLI exposes, as an MCP server on stdio (`src/mcp.ts`, tool list in `src/tools.ts`):

```
claude mcp add blyg --scope user -- npx tsx /PATH/TO/blyg-atlas/src/mcp.ts
```

If `npx` is not on the PATH Claude Code launches with, give the absolute path to it. Any MCP client that speaks stdio works the same way.
