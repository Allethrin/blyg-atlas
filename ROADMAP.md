# Roadmap

What is planned, what is being considered, and what has been noticed and not yet fixed. Nothing here is a promise or a schedule. Items move up when someone needs them.

Each item is marked **planned** (the shape is settled), **idea** (worth doing, shape open) or **question** (not sure it should be done).

## v0.1.0: the first public tag

What it contains: the crawl and typed citation graph, embeddings with or without Ollama, search, pulse, standing queries, the read history, the Field in its one default view (meaning + time), the MCP server and the CLI.

Left out on purpose: a publisher, the entity map and flow tab, any hosted version.

## Running it without thinking about processes

Today the dashboard is a process you start and have to remember. After a crawl, a `git pull` or a change to how the map is built, it can be serving something stale with no sign of it, and starting a second one does not tell you a first is already running. The aim is that a stranger runs one command and never has to know what is running in the background.

- **`serve` knows about itself** (planned). Starting it when one is running reports the address, start time and version of the one that is. `blyg-atlas status`, `stop` and `restart`.
- **A status panel in the dashboard** (planned). When this server started and what version it runs; the last crawl, its counts and any failure; how many items are embedded and by what; when the map was laid out. Buttons for crawl now, lay out again, restart. Probably on the map tab, to keep the Field clear.
- **The page notices changes** (planned). A banner when the code on disk is newer than the running server; a reload when the server restarts or the map is rebuilt; a plain message with the command when the server is gone.
- **Lay out again without a restart** (planned). The same thing from the shell as `blyg-atlas layout`.
- **The daily crawl inside the dashboard** (idea). If the dashboard is running anyway it can do the morning crawl itself and catch up when a laptop wakes, which would take launchd and cron out of the setup. It only works while the dashboard is up, so the scheduler examples would stay for people who want the crawl without it.

## The Field

- **Fewer controls** (planned, choices open). The default view still shows more than a first-time reader needs: themes / themes + eras, slab / lens, the second depth slider, save view, ease. Decide which stay visible and which move behind the config. The control panel also takes the top third of a laptop-height window and cuts the map off.
- **A time axis that one import cannot stretch** (idea). Items are spaced by their order, so a blyg that publishes 2,500 items in one night takes that share of the axis. Collapsing a burst from one blyg to a single position would fix it, at the cost of stacking those items on one moment.
- **Marking up the map** (idea). Lasso a group of items and it becomes a mark: your own name and note, an automatic label from its terms, authors and dates, and a written summary on request. Marks are tied to the items, not to coordinates, so they survive a new layout. The summary needs a model, which for a public tool means a local default and the hosted ones by configuration.
- **A map that holds still** (idea). The layout is recomputed whenever the set of items changes, so regions shift and get renamed between crawls. Options: a parametric UMAP that places new items on a fixed map, or aligning each new layout to the last.
- **Numbered headings in region names** (idea). Repeated lines are filtered before naming, but a heading that varies ("Unit 3", "Unit 4") still lets its common word into a name.
- **Faster first layout** (idea). The layout for the four-directions-of-meaning view is still computed when that view is not offered. Skipping it saves about a third of the first build.
- **d3 served locally** (planned). The Field loads d3 from a CDN, so it needs the internet on each page load.
- **Reader polish** (idea). The drawer and the pop-out cards; the loupe in the other views; reply and response chains drawn in the order they happened; arrows that land on the quoted version.
- **A text rendering of the Field for assistants** (idea). There is no MCP or CLI command for the map; it is only for eyes.
- **Other spaces to move through** (question). The citation-fitted space as a rotation of the meaning layout rather than a space of its own; an autoencoder in place of UMAP, which could say what would sit in an empty patch of the map; axes named from tags.
- **How much to keep** (question). The other views (circles arranged by citations, the flat plane, four directions of meaning, the citation-fitted space) are built and hidden. A smaller tool with one good view may be better than one with five.

## Crawl and data

- **Dropping what a removed seed brought in** (idea). A blyg stays in the atlas after its seed is taken out of `seeds.json`. A `prune` that removes what is no longer reachable from the current seeds.
- **The same blyg at two addresses** (question). The spec makes the address the identity, so a mirrored blyg is counted twice. Whether to fold mirrors together for display.
- **Boilerplate in the embedded text** (question). Repeated lines are left out of region names but still embedded. They are a small part of each item; whether they bend the layout has not been measured.
- **Long threads as one point** (idea). An item is embedded whole from its first 6,000 characters. Very long threads may want splitting.
- **Faster in-process embedding** (idea). About 5 items a second on a laptop CPU against 14 through Ollama. The quantized model is faster to download but its vectors drift from Ollama's, and the two GPU paths tried were slower or inexact.
- **Other platforms** (planned). Developed on macOS with Chrome. Linux, Windows and Safari's trackpad gestures have not been tried.

## Search, pulse, queries

- **Pulse neighborhood** (idea). The weighting toward blygs you read is dominated by whoever is in every thread. Weigh the thread's root rather than its best-known participant, and treat time spent on a page as the weak signal it is.
- **A digest** (idea). Pulse and the standing queries written up as a short morning note, by a model, for the reader only.

## Experimental

- **Entity map and the flow tab** (idea). How terms and names move between blygs: who used a word first and who picked it up. Built once and not iterated, so it is not in this release. It brings a second 1 GB model. To promote it: a command that seeds the alias table from your own crawl, and its fill-in procedure tested by someone other than its author.
- **A synthesis layer** (question). Reading the network under a declared intent and saying what changed. Anything it produces stays with the reader unless they choose to publish it themselves.

## What will not change

- Nothing derived from the crawl is published by this tool. The spec grants a reader the walk on that condition.
- No hosted version, for the same reason.
- No account, no telemetry. The dashboard listens on loopback only.
