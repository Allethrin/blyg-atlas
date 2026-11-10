# Notes for an AI agent setting up blyg-atlas

You have been asked to get blyg-atlas running for someone. `README.md` is the full description. This file is the short path, and the places where an agent tends to go wrong. It was revised after a fresh agent followed it on a clean clone.

Run every command from the root of the clone.

## Ask before you start

- **Which blygs do they follow?** That list is `seeds.json`, and it decides what their map shows. The two in `seeds.example.json` are a fine default if they have no preference (about 30 blygs and 6,000 items).
- **How far to walk.** By default a crawl follows citations and blogrolls two steps out from the seeds. If they want only their own list, that is `--hops 0`, and it has to be given on every crawl: the crawl button in the dashboard and the scheduled examples use the default.
- **A contact for the crawler's User-Agent**, so a site it reads can reach them. Optional, but worth asking for: with it, a site owner with a question reaches the person running the crawl. Left unset, the User-Agent names only this software and this repository.

## Steps

1. Node 20 or later, then `npm install` (about 500 MB of dependencies).
2. `cp seeds.example.json seeds.json`, then replace the two example addresses with theirs.
3. Embeddings. Run `ollama list`.
   - It answers and lists `nomic-embed-text`: nothing to do.
   - It answers without that model: `ollama pull nomic-embed-text` is a download of a few hundred MB outside this folder, so ask first.
   - No Ollama: nothing to do. The same model runs inside Node after a one-time 550 MB download, at about a third of the speed.

   The last lines of a crawl say which one did the embedding.
4. Crawl, **in the background, with a log**. A first crawl from the example seeds takes about 14 minutes with Ollama and nearer 30 without, which is longer than most command timeouts. One small blyg at `--hops 0` takes seconds.

   ```bash
   npx blyg-atlas crawl > crawl.log 2>&1 &
   ```

   Read `crawl.log` to follow it. Exit 0 means done. Exit 1 means no seed answered or the embedding failed, and the last lines say which.
5. Serve. This one never exits. Start it however your environment keeps a process alive after the command returns (its background option, or `nohup`); a bare `&` can die with the shell.

   ```bash
   nohup npx blyg-atlas serve > serve.log 2>&1 &
   ```

   Then **read `serve.log`**. A line `[blyg-atlas] http://127.0.0.1:PORT` means it is up. If the port was taken, the log says so and the process has already exited: find a free port, start again with `--port N`, and write `{ "port": N }` to `atlas.config.json` so later runs agree. Do not stop whatever holds the port without asking.
6. Check it, **on the port from `serve.log`**. Another program, or another blyg-atlas, may be answering on 5053.
   - `curl -s http://127.0.0.1:PORT/api/status` shows `items` above 0, `embedded` close to `embeddable`, and `last_crawl.finished` set.
   - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:PORT/api/field` gives 200. The first call computes the layout: about 20 seconds for a full network.
7. Tell them the address. Their browser needs to be online, because the page loads d3 from a CDN. Their first search takes about 40 seconds, for a one-time 280 MB reranker download. With one small blyg the Field has only a couple of regions; that is expected.

To stop the dashboard later: `lsof -ti tcp:PORT | xargs kill`.

## `atlas.config.json`

Write only the keys you are setting, for example `{ "port": 5056, "contact": "…" }`. Do not copy `atlas.config.example.json` as it stands: its values are descriptions of each field, not settings.

## Then offer, don't assume

- **A daily crawl.** `examples/` has a cron line and a launchd plist. Keep `crawl --wait 3600` there, so a job that fires before the network is up waits instead of failing, and add `--hops` if they chose one.
- **The atlas as tools for you.** `npx tsx src/mcp.ts` is an MCP server on stdio with the same fifteen tools as the CLI (`README.md`, "From an AI assistant"). Registering it changes their assistant's configuration, so ask first.
- **Standing queries.** `npx blyg-atlas query add "…"` in their own words; `query run --all` after each crawl.
- **Paying the first search now.** `npx blyg-atlas search "anything"` once downloads the reranker, so their first search in the browser is quick.

## Rules

- **Their data stays on their machine.** `atlas.db`, `seeds.json` and `atlas.config.json` are gitignored. Do not commit, copy or upload them. `atlas.db` also holds their reading history, so do not delete it to start clean without asking.
- **The dashboard listens on 127.0.0.1 only.** Leave it that way.
- **A crawl reads other people's small sites.** One crawl is enough. Do not loop it, and do not reach for `--refresh-all` to debug; later crawls fetch only what changed.
- **When something fails, pass on the message.** The errors are written to say what is wrong and what to do.
