// Field — the thicket as a place. Loaded by index.html after the main script; uses its helpers
// (api, markRead, itemHash, esc, short, fmtDate, fmtWhen, ms, viewGen/stale, main, route).
//
// Two presentations of the same payload, toggled in the bar and remembered in fieldState.mode:
//
// BLOBS (the default; Ben, Oct 21: "circular blobs floating around that as you click into you drill deeper … the
// width of the connector is the strength … at each level of view you have way fewer discrete things to connect").
// The region tree read as nested circles. At the top one circle per
// region (area ∝ visible items) drifting under a gentle force layout — collide, a weak pull to the centre, and link
// forces weighted by the citations between each pair, so regions that cite each other settle side by side — with
// one ribbon per region pair drawn between the circle edges (width ∝ log count, accent when mostly transclusions).
// Inside each circle a faint miniature of the next level: that level's own settled layout, scaled in, so the zoom
// lands exactly on it. Click → zoom into the circle, its sub-regions become the field, connectors re-aggregated
// over the pairs inside it, citations leaving it a quiet stub per sub-region. Inside a sub-region (the bottom) the
// items themselves, as dots at their UMAP positions scaled into the circle, with the individual citation lines,
// pulse glows and read rings. The level is the hash
// (#/field?c=3.2); background click, Escape or the breadcrumb backs out. Every number is recomputed from the
// visible items when blygs are hidden. Pulse is a glow on each circle (relative to its siblings); a search lights
// each circle by its share of the hits.
//
// PLANE (the first two passes). Two layers under one d3 zoom. A canvas draws what is many — the region territories,
// the citations, the pulse heat and every item as a point — and an SVG on top keeps what is few and interactive:
// region labels, the flash when a scene is picked. The zoom handler only stores the transform;
// one requestAnimationFrame per frame redraws the canvas and re-scales the labels, so dragging never touches
// thousands of DOM nodes. Hover and click find the point under the cursor with a d3.quadtree.
// Citations are drawn at the scale you are looking at, not all at once: at rest one tapered connector per pair of
// regions (width by log count, from the server's `bundles`), zoomed into a region one per pair of sub-regions, and
// only deep in (k ≳ 4) the individual lines — each routed through its endpoints' cluster centroids (hierarchical
// edge bundling, d3.curveBundle's construction, precomputed) so lines that travel together are drawn together.
// The levels crossfade on k like the labels do. Hovering a point lights its own lines at any level.
//
// In both, clicking an item opens it in the reader drawer and records a read. The scenes / regions / blygs side
// panel, the tooltip and the pulse and search loaders are shared; each presentation answers the same few hooks
// (restyle, pulse, hits, scene, region).

let FIELD = null;                 // /api/field, cached for the page's life
let fieldState = { mode: 'blobs', layers: { regions: true, cites: true, pulse: true }, color: 'origin', days: 3, hidden: new Set(), q: '', focus: '', tour: null };
try { Object.assign(fieldState, JSON.parse(localStorage.fieldState || '{}'), { hidden: new Set(JSON.parse(localStorage.fieldHidden || '[]')) }); } catch {}
// Nov 6: meaning became a color mode and the default; a saved choice from before is switched over once
try { if (!localStorage.fieldColorV2) { fieldState.color = 'meaning'; localStorage.fieldColorV2 = '1'; } } catch {}
const saveFieldState = () => { try { localStorage.fieldState = JSON.stringify({ mode: fieldState.mode, layers: fieldState.layers, color: fieldState.color, days: fieldState.days, tour: fieldState.tour, holds: fieldState.holds }); localStorage.fieldHidden = JSON.stringify([...fieldState.hidden]); } catch {} };
// Set by a live blobs view: route() offers it #/field?c= changes first, so moving between levels animates in place
// instead of re-rendering the page. Returns false when it can't (another mode, a different query, gone stale).
var fieldHashNav = null;
let fieldUnwide = null;
var fieldSearch = null;   // set while the field is up: the page's one search box lights up the map through it
let fieldReaderChanged = null;   // set by the items level: an item opened or closed in the reader (its history unfolds while it is open)
// ---------------------------------------------------------------- the reader drawer
// Ben, Nov 6: going from the loupe — "sorta visual and meditative" — to a whole other page when you click one "could
// use some work … a better way to just open em while mostly just looking over the map … opening it in a side panel".
// An item opens in a drawer over the right edge of the field; the map stays live and clickable behind it, so the next
// click just replaces what's in the drawer. It is still a read (with its dwell), the open item gets
// a ring on the map, and links inside it (quotes, responses, in-body links to crawled items) open in the drawer too,
// with ← back. "full page" leaves for the item page; Esc or × closes.
const READER = { open: null, it: null, stack: [], el: null, gen: 0 };
const CARDS = [];   // popped-out readers
function readerEl() {
  if (READER.el && READER.el.isConnected) return READER.el;
  const el = document.createElement('aside');
  el.className = 'freader'; el.hidden = true;
  el.innerHTML = `<div class="frhead"><a href="#" class="frback" title="back (the item you came from)" hidden>←</a><span class="frwhere muted small"></span><a href="#" class="frpop" title="pop it out into a card you can drag, resize and fold away — the drawer is free for the next one">⧉ pop out</a><a href="#" class="frfull" title="the item's own page">full page</a><a href="#" class="frx" title="close (Esc)">×</a></div><div class="frscroll"><div class="frbody"></div></div>`;
  document.body.appendChild(el);
  el.querySelector('.frx').onclick = ev => { ev.preventDefault(); readerClose(); };
  el.querySelector('.frback').onclick = ev => { ev.preventDefault(); const prev = READER.stack.pop(); if (prev) readerOpen(prev.origin, prev.id, 'trail', true); };
  el.querySelector('.frpop').onclick = ev => { ev.preventDefault(); readerPop(); };
  el.querySelector('.frfull').onclick = ev => { ev.preventDefault(); const o = READER.open; if (!o) return; readerClose(true); location.hash = itemHash(o.origin, o.id); };
  // links to crawled items stay in the drawer; everything else behaves as on the page
  el.addEventListener('click', ev => {
    const a = ev.target.closest('a[href^="#/item/"]');
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    const m = a.getAttribute('href').match(/^#\/item\/([^/]+)\/(.+)$/);
    if (!m) return;
    ev.preventDefault(); ev.stopPropagation();
    readerOpen(decodeURIComponent(m[1]), m[2], 'link');
  }, true);
  READER.el = el;
  return el;
}
const readerKeys = () => { const ks = new Set(CARDS.map(c => c.open.origin + ' ' + c.open.id)); if (READER.open) ks.add(READER.open.origin + ' ' + READER.open.id); return ks; };
function readerMark() {
  const ks = readerKeys();
  if (typeof d3 !== 'undefined') d3.selectAll('#fsvg .bdot').classed('fopen', d => !!(d && d.p && ks.has(d.p.origin + ' ' + d.p.id)));
  if (fieldReaderChanged) fieldReaderChanged();
}
const readerIsOpen = p => { if (READER.open && READER.open.origin === p.origin && READER.open.id === p.id) return true; return CARDS.some(c => c.open.origin === p.origin && c.open.id === p.id); };
async function readerOpen(origin, id, via = 'field', isBack = false) {
  // already popped out: bring its card up (unfolded) rather than opening a second copy in the drawer
  const have = via === 'field' && !isBack && CARDS.find(c => c.open.origin === origin && c.open.id === id);
  if (have) { have.el.classList.remove('min'); have.el.style.zIndex = ++cardZ; return; }
  const el = readerEl(), g = ++READER.gen;
  if (READER.open && !isBack && !(READER.open.origin === origin && READER.open.id === id)) READER.stack.push(READER.open);
  if (!isBack && via === 'field') READER.stack = [];   // a click on the map starts over; links followed inside keep the stack
  READER.open = { origin, id };
  el.hidden = false; document.body.classList.add('freading');
  const bodyEl = el.querySelector('.frbody');
  el.querySelector('.frback').hidden = !READER.stack.length;
  bodyEl.innerHTML = '<p class="spinner">loading…</p>';
  readerMark();
  let it;
  try { it = await api(`/item?origin=${encodeURIComponent(origin)}&id=${id}`); } catch (e) { if (g === READER.gen) bodyEl.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (g !== READER.gen) return;
  markRead(it);
  READER.it = it;
  el.querySelector('.frwhere').textContent = short(it.origin);
  readerRender(bodyEl, it);
  el.querySelector('.frscroll').scrollTop = 0;
}
// an item's text, meta and edges into a reader body (the drawer's or a card's)
function readerRender(bodyEl, it) {
  const edgeLink = (e, dir) => {
    if (dir === 'out') return e.crawled ? `<a href="${itemHash(originOf(e.url), e.target.split(' ')[1])}">${esc(e.target_title || e.target)}</a>` : `<a href="${esc(e.url || '#')}" target="_blank" rel="noopener">${esc(e.target_title || e.target || e.url)}</a> <span class="pill">not crawled</span>`;
    return `<a href="${itemHash(originFromShort(e.source.split(' ')[0]), e.source.split(' ')[1])}">${esc(e.source_title || e.source)}</a> <span class="muted small">${esc(e.author || '')}</span>`;
  };
  const outs = collapseOut(it.edges.out), ins = it.edges.in;
  bodyEl.innerHTML = `<h2 class="frtitle">${esc(it.title || '(untitled)')}</h2>
    <div class="meta small">${esc(it.author || '')} · ${esc(it.kind || '')} · ${fmtDate(it.created)}${it.updated !== it.created ? ' → ' + fmtDate(it.updated) : ''} · <a href="${esc(it.url)}" target="_blank" rel="noopener">live ↗</a>${it.reads.length ? ` · <span class="read">read ${it.reads.length}×</span>` : ''}</div>
    ${readerHistory(it)}
    <div class="body frtext"></div>
    ${outs.length || ins.length ? `<div class="fredges small">${outs.length ? `<div><b>quotes / responds to</b>${outs.map(e => `<div>${edgeLink(e, 'out')}</div>`).join('')}</div>` : ''}${ins.length ? `<div><b>quoted by / responses</b>${ins.map(e => `<div>${edgeLink(e, 'in')}</div>`).join('')}</div>` : ''}</div>` : ''}`;
  fillItemBody(bodyEl.querySelector('.frtext'), it);
}
// An item's history, folded under its meta line: the latest version is the text below, and a blyg serves no earlier
// text, so the history is each version's date and note, newest first. Revisions the blyg made to many items at once
// (`bulk`, marked by the server) fold into one row per run.
function readerHistory(it) {
  const cl = it.changelog || [];
  if (cl.length < 2) return '';
  const day = s => s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const rows = [];
  for (const c of [...cl].reverse()) { const last = rows[rows.length - 1]; if (c.bulk && last && last.run) last.run.unshift(c); else rows.push(c.bulk ? { run: [c] } : c); }
  const nb = cl.filter(c => c.bulk).length, nh = cl.length - 1 - nb;
  const row = r => {
    if (r.run) {
      const a = r.run[0], b = r.run[r.run.length - 1], notes = [...new Set(r.run.map(c => c.note).filter(Boolean))];
      return `<div class="frh bulk"><span class="frhv">v${a.version}${b !== a ? '–' + b.version : ''}</span><span class="frhd">${day(b.at)}</span><span class="frhn"><span class="pill" title="made within minutes of revisions to many other items of this blyg">bulk</span> ${notes.map(esc).join(' · ')}</span></div>`;
    }
    return `<div class="frh"><span class="frhv">v${r.version}</span><span class="frhd">${day(r.at)}</span><span class="frhn">${r.version === 1 ? '<span class="muted">first published</span>' : r.note ? esc(r.note) : '<span class="muted">no note</span>'}${r.note && r.generated ? ' <span class="muted" title="the publishing client wrote this note">· generated</span>' : ''}</span></div>`;
  };
  return `<details class="frhist small"><summary>history · ${cl.length} versions${nh ? ` · revised ${nh}×` : ''}${nb ? ` · ${nb} bulk` : ''}</summary>${rows.map(row).join('')}<div class="muted frhfoot">Only the latest text is published; earlier versions leave a date and a note.</div></details>`;
}
function readerClose(keepStep) {
  if (!READER.el) return;
  READER.gen++;
  if (!keepStep) flushDwell();
  READER.el.hidden = true; READER.open = null; READER.stack = [];
  document.body.classList.remove('freading');
  readerMark();
}
// ---------------------------------------------------------------- cards: readers popped out of the drawer
// Ben, Nov 6: "pop off the open ones into little tabs i can drag around … kinda small or resizable so i can move em
// out of the way and see the clusters too". A card is a small floating reader: drag it by its bar, resize it from the
// corner, fold it to a tab (– or double-click the bar), close it (×). Links inside open in the card itself, with ←
// back. Its item keeps its ring on the map, and hovering the card lights its dot. Cards stay up while you move around
// the field (they live outside the page that re-renders) and hide while you're on another page.
let cardZ = 30;
function cardsHost() {
  let h = document.getElementById('fcards');
  if (!h) { h = document.createElement('div'); h.id = 'fcards'; document.body.appendChild(h); }
  h.hidden = !location.hash.startsWith('#/field');
  return h;
}
function readerPop() {
  const o = READER.open, it = READER.it;
  if (!o || !it || it.origin !== o.origin || it.id !== o.id) return;
  const stack = READER.stack.slice(), dr = READER.el.getBoundingClientRect();
  readerClose(true);
  // land where the drawer was, stepped so a run of pop-outs fans out instead of stacking exactly
  const n = CARDS.length % 8;
  cardMake(it, stack, Math.max(8, dr.left + 30 - 26 * n), 70 + 30 * n);
}
function cardMake(it, stack, x, y) {
  const el = document.createElement('div');
  el.className = 'fcard';
  el.innerHTML = `<div class="fchead"><a href="#" class="fcback" title="back" hidden>←</a><span class="fctitle"></span><a href="#" class="fcmin" title="fold to a tab (or double-click the bar)">–</a><a href="#" class="fcfull" title="the item's own page">↗</a><a href="#" class="fcx" title="close">×</a></div><div class="frscroll"><div class="frbody"></div></div>`;
  const W0 = Math.min(380, innerWidth - 16), H0 = Math.min(440, innerHeight - 16);
  el.style.width = W0 + 'px'; el.style.height = H0 + 'px';
  el.style.left = Math.max(4, Math.min(innerWidth - W0 - 4, x)) + 'px'; el.style.top = Math.max(4, Math.min(innerHeight - 60, y)) + 'px';
  el.style.zIndex = ++cardZ;
  cardsHost().appendChild(el);
  const card = { el, open: { origin: it.origin, id: it.id }, stack, gen: 0 };
  CARDS.push(card);
  const show = it2 => {
    card.open = { origin: it2.origin, id: it2.id };
    el.querySelector('.fctitle').textContent = it2.title || '(untitled)';
    el.querySelector('.fctitle').title = `${it2.title || ''} — ${it2.author || short(it2.origin)}`;
    el.querySelector('.fcback').hidden = !card.stack.length;
    readerRender(el.querySelector('.frbody'), it2);
    el.querySelector('.frscroll').scrollTop = 0;
    readerMark();
  };
  card.go = async (origin, id, via, isBack) => {
    const g = ++card.gen;
    if (!isBack) card.stack.push(card.open);
    let it2;
    try { it2 = await api(`/item?origin=${encodeURIComponent(origin)}&id=${id}`); } catch (e) { return; }
    if (g !== card.gen) return;
    markRead(it2);
    show(it2);
  };
  show(it);
  cardChrome(el);
  el.querySelector('.fcx').onclick = ev => { ev.preventDefault(); cardClose(card); };
  el.querySelector('.fcfull').onclick = ev => { ev.preventDefault(); const o = card.open; location.hash = itemHash(o.origin, o.id); };
  el.querySelector('.fcback').onclick = ev => { ev.preventDefault(); const prev = card.stack.pop(); if (prev) card.go(prev.origin, prev.id, 'trail', true); };
  el.addEventListener('click', ev => {
    const a = ev.target.closest('.frbody a[href^="#/item/"]');
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    const m = a.getAttribute('href').match(/^#\/item\/([^/]+)\/(.+)$/);
    if (!m) return;
    ev.preventDefault(); ev.stopPropagation();
    card.go(decodeURIComponent(m[1]), m[2], a.dataset.via || 'link');
  }, true);
  // hovering a card lights its dot on the map
  const hov = on => { if (typeof d3 !== 'undefined') d3.selectAll('#fsvg .bdot').classed('fhov', d => on && !!(d && d.p && d.p.origin === card.open.origin && d.p.id === card.open.id)); };
  el.addEventListener('mouseenter', () => hov(true));
  el.addEventListener('mouseleave', () => hov(false));
  return card;
}
// what every floating card shares: a press brings it to the front, its bar drags it (not the bar's buttons) and keeps
// at least the bar on screen, double-click or – folds it to a tab
function cardChrome(el) {
  el.addEventListener('pointerdown', () => { el.style.zIndex = ++cardZ; });
  const head = el.querySelector('.fchead');
  head.addEventListener('pointerdown', ev => {
    if (ev.target.closest('a, input, button') || ev.button !== 0) return;
    ev.preventDefault(); head.setPointerCapture(ev.pointerId);
    const r = el.getBoundingClientRect(), ox = ev.clientX - r.left, oy = ev.clientY - r.top;
    const move = e => {
      el.style.left = Math.max(40 - r.width, Math.min(innerWidth - 40, e.clientX - ox)) + 'px';
      el.style.top = Math.max(0, Math.min(innerHeight - 28, e.clientY - oy)) + 'px';
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); el.classList.remove('dragging'); };
    el.classList.add('dragging');
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });
  const fold = () => el.classList.toggle('min');
  head.addEventListener('dblclick', ev => { if (!ev.target.closest('a')) fold(); });
  el.querySelector('.fcmin').onclick = ev => { ev.preventDefault(); fold(); };
}
function cardClose(card) {
  const k = CARDS.indexOf(card);
  if (k >= 0) CARDS.splice(k, 1);
  card.gen++; card.el.remove();
  readerMark();
}

// ---------------------------------------------------------------- marks (Nov 19)
// A mark is a set of items the reader picked out on the map, with their own name and note; the server keeps it and
// computes its shape block (the facts an agent reads about its geometry) when it is saved. The lasso, the outlines and
// the side-panel list live in viewField; the cards are here, because like the reader cards they outlive a re-render.
// Agent proposals (state 'proposed') are drawn dashed until the reader keeps or discards them.
let MARKS = null;   // /api/marks, reloaded whenever the field is drawn and after every change
const MARK = { on: false, hl: null, hov: null, lab: false, geomHover: false, lift: new Set(), pending: null, pendingView: null, refresh: () => {}, go: null };
const MCARDS = new Map();   // mark id → its open card
async function marksLoad() { try { MARKS = (await api('/marks')).marks || []; } catch { MARKS = []; } return MARKS; }
const markName = m => String((m && m.name) || '').trim() || 'untitled mark';
// Collapsing a mark (the tour's bottom level; display only — see collapseOf): per mark, whether it is collapsed and by
// how much, kept in this browser. MARK_COLLAPSE is the amount a mark collapses by unless its card's slider says otherwise
// (0 = its own shape, 1 = a full circle); MARK_R sizes the circle, per √member, in the level's own px.
const MARK_COLLAPSE = 0.75, MARK_R = 11;
const MCOL = (() => { try { const j = JSON.parse(localStorage.markCollapse || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; } })();
const markColAmt = id => { const e = MCOL[id]; return e && e[1] > 0 ? e[1] : MARK_COLLAPSE; };
const markCol = id => { const e = MCOL[id]; return e && e[0] ? markColAmt(id) : 0; };   // the amount it is collapsed by now (0: open)
function markColSet(id, on, amt) {
  MCOL[id] = [on ? 1 : 0, +(amt ?? markColAmt(id)).toFixed(2)];
  try { localStorage.markCollapse = JSON.stringify(MCOL); } catch { /* private window: this page only */ }
  MARK.refresh();
}
const marksChanged = () => marksLoad().then(() => MARK.refresh());
// the card that names a fresh lasso: `items` are field points, `gesture` and `view` go to the server as they are
function markSaveCard(items, gesture, view, x, y, onDone) {
  if (MARK.pending) MARK.pending.close();
  const el = document.createElement('div');
  el.className = 'fcard fmcard fmsave';
  const n = items.length;
  el.innerHTML = `<div class="fchead"><span class="fctitle">new mark · ${n} item${n === 1 ? '' : 's'}</span><a href="#" class="fcmin" title="fold to a tab">–</a><a href="#" class="fcx" title="cancel (Esc)">×</a></div>
    <div class="frscroll"><input class="fmname" type="text" maxlength="160" placeholder="name">
      <textarea class="fmnote" rows="3" placeholder="a note: what ties these together (optional)"></textarea>
      <div class="fmlist small muted">${items.slice(0, 6).map(p => esc((p.title || '(untitled)').slice(0, 56))).join(' · ')}${n > 6 ? ` · +${n - 6} more` : ''}</div>
      <div class="fmact"><button class="fmok">save</button><button class="fmno">cancel</button><span class="fmmsg small muted"></span></div>
      <div class="fmhint small muted"></div></div>`;
  const W0 = Math.min(330, innerWidth - 16);
  el.style.width = W0 + 'px';
  el.style.left = Math.max(4, Math.min(innerWidth - W0 - 4, x)) + 'px'; el.style.top = Math.max(4, Math.min(innerHeight - 260, y)) + 'px';
  el.style.zIndex = ++cardZ;
  cardsHost().appendChild(el);
  cardChrome(el);
  const close = () => { if (MARK.pending === me) MARK.pending = null; el.remove(); onDone && onDone(); };
  const me = { el, close };
  MARK.pending = me;
  const $name = el.querySelector('.fmname'), $note = el.querySelector('.fmnote'), $msg = el.querySelector('.fmmsg'), $ok = el.querySelector('.fmok');
  el.querySelector('.fcx').onclick = ev => { ev.preventDefault(); close(); };
  el.querySelector('.fmno').onclick = close;
  const save = async () => {
    $ok.disabled = true; $msg.textContent = 'saving… (the shape block is computed now)';
    try {
      const r = await post('/marks', { name: $name.value.trim(), note: $note.value.trim(), members: items.map(p => ({ origin: p.origin, id: p.id })), view, gesture });
      const box = el.getBoundingClientRect();
      close();
      await marksChanged();
      if (r && r.mark && r.mark.id != null) markOpen(r.mark.id, box.left, box.top);
    } catch (e) { $ok.disabled = false; $msg.textContent = e.message; }
  };
  $ok.onclick = save;
  // Suggestions, grey in the empty field; Tab takes one. First the words that set the set apart (no model, at once), then,
  // when the reader has set a local model and written a prompt (atlas.config.json `marks`), what that model offers.
  const sug = { name: '', note: '' }, from = { name: '', note: '' }, $hint = el.querySelector('.fmhint');
  let opts = [], at = 0;   // several names offered (the model's, then the words that set it apart): ↓/↑ in the empty field steps through them
  let asking = '', why = '';   // asking: what is on its way ('qwen… for a note'); why: the model tier's reason for giving none
  const hint = () => {
    if (MARK.pending !== me) return;
    const has = sug.name && sug.note ? 'name or note' : sug.name ? 'name' : sug.note ? 'note' : '';
    $hint.textContent = [has && `Tab takes the suggested ${has} · ${from.note || from.name || 'the words that set it apart'}`, opts.length > 1 && `↓↑ for other names (${at + 1}/${opts.length})`, asking && `asking ${asking}…`, why].filter(Boolean).join(' · ');
  };
  const offer = (what, r) => {
    if (MARK.pending !== me || !r || !r.text) return;
    if (what === 'name' && r.options && r.options.length > 1) { opts = [...r.options, ...(sug.name && !from.name && !r.options.includes(sug.name) ? [sug.name] : [])]; at = 0; }
    sug[what] = r.text; from[what] = r.model || '';
    (what === 'name' ? $name : $note).placeholder = r.text;
    // a long note suggestion would be cut off in three rows: the empty field grows to show it (up to eight)
    if (what === 'note' && !$note.value) $note.rows = Math.max(3, Math.min(8, Math.ceil(r.text.length / 40)));
    hint();
  };
  const take = ($f, what) => ev => { if (ev.key === 'Tab' && !ev.shiftKey && !$f.value && sug[what]) { ev.preventDefault(); $f.value = sug[what]; } };
  $name.addEventListener('keydown', take($name, 'name'));
  $name.addEventListener('keydown', ev => {
    if ((ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') || $name.value || opts.length < 2) return;
    ev.preventDefault();
    at = (at + (ev.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length;
    sug.name = $name.placeholder = opts[at];
    hint();
  });
  $note.addEventListener('keydown', take($note, 'note'));
  (async () => {
    const members = items.map(p => ({ origin: p.origin, id: p.id }));
    try { offer('name', await post('/marks/suggest', { members, view, tier: 'terms' })); } catch { /* no suggestion */ }
    let feat = null;
    try { feat = await api('/features'); } catch { /* none */ }
    if (!feat || !feat.mark_model) return;
    for (const what of ['name', 'note']) {
      if (MARK.pending !== me) return;   // closed or saved: ask nothing more
      asking = `${feat.mark_model} for a ${what}`; hint();
      let r = null;
      try { r = await post('/marks/suggest', { members, view, tier: 'model', what }); } catch { /* keep what there is */ }
      asking = '';
      if (r && r.text) offer(what, r);
      else if (r && r.reason && what === 'name' && !/^no (model|name prompt|note prompt)/.test(r.reason)) why = `${feat.mark_model} offers nothing: ${r.reason}`;   // an unwritten prompt is not news; a failure is   // the note's reason is the same story, said once
      hint();
    }
  })();
  $name.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
  el.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } });
  setTimeout(() => $name.focus(), 0);
}
// a mark's card: name and note (editable), the shape block, the members (click one to read it), the notes, and for an
// agent's proposal keep / discard. Hovering the card brings its outline up on the map.
function markOpen(id, x, y) {
  const have = MCARDS.get(String(id));
  if (have) { have.el.classList.remove('min'); have.el.style.zIndex = ++cardZ; have.load(); return; }
  const el = document.createElement('div');
  el.className = 'fcard fmcard';
  el.innerHTML = `<div class="fchead"><span class="fctitle">mark</span><a href="#" class="fcmin" title="fold to a tab (or double-click the bar)">–</a><a href="#" class="fcx" title="close">×</a></div><div class="frscroll"><div class="frbody"><p class="spinner">loading…</p></div></div>`;
  const W0 = Math.min(400, innerWidth - 16), H0 = Math.min(560, innerHeight - 16), k = MCARDS.size % 6;
  el.style.width = W0 + 'px'; el.style.height = H0 + 'px';
  const x0 = x ?? innerWidth - W0 - 300 - 24 * k, y0 = y ?? 80 + 28 * k;
  el.style.left = Math.max(4, Math.min(innerWidth - W0 - 4, x0)) + 'px'; el.style.top = Math.max(4, Math.min(innerHeight - 60, y0)) + 'px';
  el.style.zIndex = ++cardZ;
  cardsHost().appendChild(el);
  cardChrome(el);
  let gen = 0;
  const card = { el, load };
  MCARDS.set(String(id), card);
  const close = () => { gen++; MCARDS.delete(String(id)); el.remove(); if (MARK.hl === id) { MARK.hl = null; MARK.refresh(); } };
  el.querySelector('.fcx').onclick = ev => { ev.preventDefault(); close(); };
  el.addEventListener('mouseenter', () => { if (MARK.hl !== id) { MARK.hl = id; MARK.refresh(); } });
  el.addEventListener('mouseleave', () => { if (MARK.hl === id) { MARK.hl = null; MARK.refresh(); } });
  const body = el.querySelector('.frbody');
  async function load() {
    const my = ++gen;
    let r;
    try { r = await api('/mark/' + encodeURIComponent(id)); } catch (e) { if (my === gen) body.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (my !== gen) return;
    render(r);
  }
  function render(r) {
    const m = r.mark || {}, members = r.members || [], notes = r.notes || [], prop = m.state === 'proposed';
    let view = m.view ?? null;
    if (typeof view === 'string') { try { view = JSON.parse(view); } catch { view = null; } }
    el.querySelector('.fctitle').textContent = markName(m);
    el.classList.toggle('prop', prop);
    const CAP = 300;
    body.innerHTML = `<div class="fmmeta small muted">${members.length} item${members.length === 1 ? '' : 's'} · ${m.made_by === 'agent' ? 'made by an agent' : 'yours'}${prop ? ' · <b>proposal</b>' : ''}${m.created ? ' · ' + fmtDate(m.created) : ''}</div>
      ${prop ? `<div class="fmprop small">An agent proposed this mark. <button data-keep>keep</button><button data-discard>discard</button></div>` : ''}
      <input class="fmname" type="text" maxlength="160" placeholder="name" value="${esc(m.name || '')}">
      <textarea class="fmnote" rows="3" placeholder="note">${esc(m.note || '')}</textarea>
      <div class="fmact"><button data-save disabled>save</button><button data-go title="${view ? 'back to the view it was made in (mode, level, plane, hidden blygs)' : 'fit the map to its members'}">go there</button><button data-del class="fmdel">delete</button><span class="fmmsg small muted"></span></div>
      <div class="fmcolrow small"><button data-col title="draw it as one region on the map's bottom level, the space round it stretched to match (display only; also: click its name on the map)">${markCol(id) ? 'open it out' : 'collapse'}</button><input type="range" min="0.2" max="1" step="0.05" value="${markColAmt(id)}" data-colamt title="how far toward a circle: 1 is a full circle"><span class="muted" data-colv>${markColAmt(id).toFixed(2)}</span></div>
      <details class="fmshape" open><summary>shape</summary><pre>${esc(r.shape_text || '(no shape block)')}</pre></details>
      <details class="fmmembers" open><summary>members · ${members.length}</summary>${members.slice(0, CAP).map((x, j) => `<div class="fmm"><a href="#" data-j="${j}">${esc(x.title || '(untitled)')}</a> <span class="muted small">${esc(x.author || short(x.origin))}${x.created ? ' · ' + fmtDate(x.created) : ''}</span></div>`).join('')}${members.length > CAP ? `<div class="muted small">+${members.length - CAP} more</div>` : ''}</details>
      <details class="fmnotes" open><summary>notes · ${notes.length}</summary>${notes.map(n => `<div class="fmn ${n.author === 'agent' ? 'agent' : ''}"><div class="small muted">${n.author === 'agent' ? 'agent' : 'you'}${n.at ? ' · ' + fmtWhen(n.at) : ''}</div><div class="fmnt">${esc(n.text || '')}</div></div>`).join('')}
        <textarea class="fmadd" rows="2" placeholder="add a note"></textarea><button data-addnote>add note</button></details>`;
    const $ = s => body.querySelector(s), $msg = $('.fmmsg'), $save = $('[data-save]');
    const dirty = () => { $save.disabled = $('.fmname').value.trim() === (m.name || '').trim() && $('.fmnote').value.trim() === (m.note || '').trim(); };
    $('.fmname').oninput = dirty; $('.fmnote').oninput = dirty;
    const act = async (fn, msg) => { $msg.textContent = msg || ''; try { await fn(); } catch (e) { $msg.textContent = e.message; } };
    $save.onclick = () => act(async () => { await post('/mark/' + encodeURIComponent(id), { name: $('.fmname').value.trim(), note: $('.fmnote').value.trim() }); await marksChanged(); await load(); });
    $('[data-go]').onclick = () => {
      if (!MARK.go) return;
      MARK.go(view, members);
      MARK.hl = id; MARK.refresh();
      setTimeout(() => { if (MARK.hl === id && !el.matches(':hover')) { MARK.hl = null; MARK.refresh(); } }, 3000);
    };
    const del = () => act(async () => { await post('/mark/' + encodeURIComponent(id) + '/delete', {}); close(); await marksChanged(); });
    $('[data-del]').onclick = () => { if (confirm(`Delete the mark "${markName(m)}"? Its notes go with it.`)) del(); };
    if (prop) {
      $('[data-keep]').onclick = () => act(async () => { await post('/mark/' + encodeURIComponent(id), { state: 'kept' }); await marksChanged(); await load(); });
      $('[data-discard]').onclick = del;
    }
    body.querySelectorAll('.fmm a[data-j]').forEach(a => a.onclick = ev => { ev.preventDefault(); const x = members[Number(a.dataset.j)]; if (x) readerOpen(x.origin, x.id, 'mark'); });
    // collapse: the button toggles it; the slider sets how far (and collapses it, so the change shows)
    const $col = $('[data-col]'), $amt = $('[data-colamt]');
    $col.onclick = () => { markColSet(id, !markCol(id)); $col.textContent = markCol(id) ? 'open it out' : 'collapse'; };
    $amt.oninput = () => { const v = Number($amt.value); $('[data-colv]').textContent = v.toFixed(2); markColSet(id, true, v); $col.textContent = 'open it out'; };
    $('[data-addnote]').onclick = () => { const t = $('.fmadd').value.trim(); if (t) act(async () => { await post('/mark/' + encodeURIComponent(id) + '/note', { text: t }); await load(); }); };
  }
  load();
}
addEventListener('hashchange', () => { const h = document.getElementById('fcards'); if (h) h.hidden = !location.hash.startsWith('#/field'); });
addEventListener('keydown', ev => { if (ev.key === 'Escape' && READER.open && !(ev.target instanceof HTMLInputElement && ev.target.type !== 'range')) { ev.stopImmediatePropagation(); readerClose(); } }, true);
addEventListener('hashchange', () => { if (READER.open && !location.hash.startsWith('#/field')) readerClose(true); });

// leaving the tour (another page, another mode) leaves its full screen too
function fieldUnfull() { document.body.classList.remove('ffull', 'fbare'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
const ORIGIN_COLORS = ['#c0392b', '#2471a3', '#1e8449', '#b7950b', '#7d3c98', '#d35400', '#148f77', '#a04000', '#5b2c6f', '#1a5276', '#7b7d7d', '#196f3d', '#9a7d0a', '#6c3483', '#b03a2e', '#2e86c1', '#45b39d', '#ca6f1e', '#884ea0', '#239b56'];

// Zoom levels for the citations: [fade-in start, full] / [fade-out start, gone], in zoom scale k.
const FIELD_LEVELS = { region: [1.5, 2.4], sub: [1.5, 2.4, 3.8, 5.2], line: [3.6, 5.2] };
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const TAU = Math.PI * 2;

/** Sample a hierarchical-bundling route: the control points are straightened toward the chord by (1 - beta), then
 *  read as a uniform cubic B-spline with the ends tripled so it starts and ends on them (d3.curveBundle's maths). */
function fieldBundlePath(ctrl, beta, per = 7) {
  const c0 = [];
  for (const p of ctrl) { const q = c0[c0.length - 1]; if (!q || Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) > 1e-6) c0.push(p); }
  const n = c0.length - 1;
  if (n < 1) return [ctrl[0], ctrl[ctrl.length - 1]];
  const [x0, y0] = c0[0], [xn, yn] = c0[n];
  if (n === 1) { const out = []; for (let j = 0; j <= per * 2; j++) { const u = j / (per * 2); out.push([x0 + (xn - x0) * u, y0 + (yn - y0) * u]); } return out; }
  const q = c0.map(([x, y], i) => [beta * x + (1 - beta) * (x0 + (xn - x0) * i / n), beta * y + (1 - beta) * (y0 + (yn - y0) * i / n)]);
  const c = [q[0], q[0], ...q, q[n], q[n]];
  const out = [];
  for (let s = 0; s + 3 < c.length; s++) {
    for (let j = s ? 1 : 0; j <= per; j++) {
      const u = j / per, u2 = u * u, u3 = u2 * u;
      const b0 = (1 - u) ** 3 / 6, b1 = (3 * u3 - 6 * u2 + 4) / 6, b2 = (-3 * u3 + 3 * u2 + 3 * u + 1) / 6, b3 = u3 / 6;
      out.push([b0 * c[s][0] + b1 * c[s + 1][0] + b2 * c[s + 2][0] + b3 * c[s + 3][0], b0 * c[s][1] + b1 * c[s + 1][1] + b2 * c[s + 2][1] + b3 * c[s + 3][1]]);
    }
  }
  return out;
}

/** A sampled path with what a tapered ribbon needs: arc-length position, unit normals, bounding box. */
function fieldGeom(pts) {
  const n = pts.length, t = new Float32Array(n), nx = new Float32Array(n), ny = new Float32Array(n);
  let len = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    t[i] = len;
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1;
    nx[i] = -dy / m; ny[i] = dx / m;
    x0 = Math.min(x0, pts[i][0]); y0 = Math.min(y0, pts[i][1]); x1 = Math.max(x1, pts[i][0]); y1 = Math.max(y1, pts[i][1]);
  }
  for (let i = 0; i < n; i++) t[i] /= len || 1;
  return { pts, t, nx, ny, bb: [x0, y0, x1, y1] };
}

/** Client-side mirror of field.ts bundleEdges, for when some blygs are hidden (the server's counts include them). */
function fieldAggregate(points, edges) {
  const parentOf = c => c.includes('.') ? c.slice(0, c.indexOf('.')) : c;
  const top = new Map(), sub = new Map(), within = {};
  const add = (m, x, y, type) => {
    const [a, b] = x.localeCompare(y, undefined, { numeric: true }) < 0 ? [x, y] : [y, x];
    let e = m.get(a + '|' + b);
    if (!e) m.set(a + '|' + b, e = { a, b, n: 0, by: {} });
    e.n++; e.by[type] = (e.by[type] || 0) + 1;
  };
  for (const [i, j, type] of edges) {
    const ca = points[i].c, cb = points[j].c;
    if (!ca || !cb) continue;
    const ta = parentOf(ca), tb = parentOf(cb);
    if (ta !== tb) add(top, ta, tb, type); else within[ta] = (within[ta] || 0) + 1;
    if (ca !== cb) add(sub, ca, cb, type); else if (ca !== ta) within[ca] = (within[ca] || 0) + 1;
  }
  const byN = (a, b) => b.n - a.n;
  return { top: [...top.values()].sort(byN), sub: [...sub.values()].sort(byN), within };
}


/** The Field with nothing on it: which of the two first-run steps is missing, and the command for it. */
function fieldEmpty(st) {
  const cmd = c => `<pre class="fempty-cmd">${esc(c)}</pre>`;
  let h, body;
  if (!st) { h = 'Nothing to lay out yet'; body = '<p>No embedded items were found.</p>'; }
  else if (!st.items) {
    h = 'Nothing crawled yet';
    body = `<p>The Field is drawn from the blygs this atlas has crawled, and it has not crawled any. In a terminal, in the blyg-atlas folder:</p>` +
      (st.seeds_file ? '' : cmd('cp seeds.example.json seeds.json     # your subscription list — edit it to taste')) +
      cmd('npx blyg-atlas crawl') +
      `<p class="muted">A first crawl from the example seeds reads about 6,000 items from about 30 blygs: roughly 7 minutes of fetching, then 7 to 20 minutes of embedding (faster with <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> running, which is optional). It prints its progress. Reload this page when it finishes.</p>`;
  } else {
    h = `${st.items.toLocaleString()} items crawled, none embedded yet`;
    body = `<p>The Field places each item by its embedding, and this atlas has no embeddings${st.embedded ? '' : ` under ${esc(st.embed_model)}`} — the crawl stored the items but the embedding step did not run or did not finish. In a terminal, in the blyg-atlas folder:</p>` +
      cmd('npx blyg-atlas embed') +
      `<p class="muted">It uses Ollama's nomic-embed-text when Ollama is running and runs the same model in-process otherwise (a one-time ~550 MB download), and it picks up where it stopped if interrupted. Reload this page when it finishes. Search needs the embeddings too; <a href="#/recent">recent</a> and <a href="#/map">map</a> work without them.</p>`;
  }
  return `<div class="fempty"><h2>${h}</h2>${body}</div>`;
}

async function viewField(p) {
  main.classList.add('wide');
  if (fieldUnwide) removeEventListener('hashchange', fieldUnwide);
  fieldUnwide = () => { if (!location.hash.startsWith('#/field')) { main.classList.remove('wide'); fieldUnfull(); removeEventListener('hashchange', fieldUnwide); fieldUnwide = null; } };
  addEventListener('hashchange', fieldUnwide);
  fieldHashNav = null;
  const g = viewGen;
  if (typeof d3 === 'undefined') { main.innerHTML = '<p class="err">d3 failed to load (CDN) — the field needs it</p>'; return; }
  main.innerHTML = `<p class="spinner">laying out the thicket…</p>`;
  if (!FIELD) FIELD = await api('/field');
  if (stale(g)) return;
  if (!FIELD.n) {
    // nothing to lay out: say why and what to run, rather than draw an empty frame. Not cached, so a reload after
    // the crawl or the embed picks the field up.
    FIELD = null;
    let st = null;
    try { st = await api('/status'); } catch { /* a source without a status route gets the plain line */ }
    if (stale(g)) return;
    main.innerHTML = fieldEmpty(st);
    return;
  }
  const F = FIELD;
  // what the source calls its things (FieldMeta, field-core.ts); the atlas sends none, and these defaults are its words
  const FM = Object.assign({ source: 'atlas', accent: 'transclusion', type_names: { transclusion: 'transclusions', stub: 'responses', link: 'links' } }, F.meta || {});
  FM.words = Object.assign({ origin: 'blyg', origins: 'blygs', edge: 'citation', edges: 'citations', item: 'item', items: 'items', cited: 'cited' }, FM.words || {});
  const ACC = FM.accent, FW = FM.words;
  const OVERLAYS = FM.overlays !== false;   // the atlas's reads and pulse; a source without them hides their controls
  // an item opens in the atlas's reader drawer (a read), or on the source's own page in a new tab
  const openItem = d => { if (FM.item_href) window.open(FM.item_href.replace('{id}', encodeURIComponent(d.id)), '_blank'); else readerOpen(d.origin, d.id, 'field'); };
  if (p.has('q')) fieldState.q = p.get('q');
  if (p.has('c')) fieldState.focus = p.get('c');
  document.title = 'field — ' + FM.source;
  // what this source offers (FieldMeta.modes / .spaces): with one of each there is no switch to draw, just the view
  const MODES = (Array.isArray(FM.modes) && FM.modes.length ? FM.modes : ['blobs', 'tour', 'plane']).filter(m => ['blobs', 'tour', 'plane'].includes(m));
  const SPACES = (Array.isArray(FM.spaces) && FM.spaces.length ? FM.spaces : ['m4', 'mt', 'ar']).filter(s => s === 'm4' ? !!F.clusters4 : s === 'mt' ? !!F.clustersT : s === 'ar' ? !!F.clustersA : false);
  const TIME_FIXED = FM.time_fixed === true;   // meaning + time: time runs left to right and is not a control
  let mode = MODES.includes(fieldState.mode) ? fieldState.mode : MODES[0];
  if (mode === 'tour' && !SPACES.length) mode = MODES.includes('blobs') ? 'blobs' : 'plane';   // no tour layout built yet
  if (fieldState.mode !== mode) { fieldState.mode = mode; saveFieldState(); }
  if (mode !== 'tour') fieldUnfull();   // full screen is the tour's

  // ---------------------------------------------------------------- frame
  // The tour moves through the 4D layout, so its regions are the ones clustered there (c4); the others use the plane's.
  // the tour has two spaces: meaning in 4D (m4), or meaning in 3D with time as the fourth axis (mt)
  const spWanted = mode === 'tour' ? (p.get('sp') || (p.has('t') ? '' : fieldState.tour && fieldState.tour.sp) || '') : '';
  const tourSpace = mode === 'tour' ? (SPACES.includes(spWanted) ? spWanted : SPACES[0]) : 'm4';
  // and in meaning + time, two region trees: themes (the top level on meaning alone) or themes + eras (time weighed in too)
  const tourEras = tourSpace === 'mt' && F.clustersE && (p.get('rg') || (p.has('t') ? '' : fieldState.tour && fieldState.tour.rg) || '') === 'era';
  const CL = mode === 'tour' ? (tourSpace === 'mt' ? (tourEras ? F.clustersE : F.clustersT) : tourSpace === 'ar' ? F.clustersA : F.clusters4) : F.clusters;
  const cOf = mode === 'tour' ? (tourSpace === 'mt' ? (tourEras ? d => d.cE : d => d.cT) : d => d.c4) : d => d.c;
  const topLevel = CL.filter(c => !c.path.includes('.'));
  const byPath = new Map(CL.map(c => [c.path, c]));
  const parentOf = c => c.includes('.') ? c.slice(0, c.indexOf('.')) : c;
  const originRank = new Map(F.origins.map((o, i) => [o.origin, i]));
  const originColor = o => { const r = originRank.get(o); return r === undefined || r >= ORIGIN_COLORS.length ? '#9a938a' : ORIGIN_COLORS[r]; };
  const L = fieldState.layers;
  if (!('marks' in L)) L.marks = true;   // layers added Nov 19: on unless turned off
  if (!('notes' in L)) L.notes = true;   // the marks' notes, as glosses under their names
  MARK.on = false; MARK.geomHover = false; MARK.lab = false; MARK.hov = null;
  const layerNames = (mode === 'plane' ? ['regions', 'cites', 'pulse', 'marks', 'notes'] : ['cites', 'pulse', 'marks', 'notes']).filter(k => OVERLAYS || k !== 'pulse');
  main.innerHTML = `<div class="field">
    <span class="fqchip fqfloat" data-qchip hidden></span>
    <div class="ffind" hidden><input type="search" placeholder="light up a theme on the map" autocomplete="off" aria-label="search the map"></div>
    <div class="fbar">
      ${MODES.length > 1 ? `<span class="fctl fmode">${MODES.map(m => `<a href="#" data-mode="${m}" class="${mode === m ? 'on' : ''}" title="${{ blobs: 'regions as circles you drill into', tour: 'the blobs in a slice of the 4D layout — move and tilt the plane through it', plane: 'every item on the UMAP plane' }[m]}">${m}</a>`).join('')}</span>` : ''}
      <span class="fqchip" data-qchip hidden></span>
      <span class="fctl">${layerNames.map(k => `<label><input type="checkbox" data-layer="${k}" ${L[k] ? 'checked' : ''}> ${k === 'cites' ? FW.edges : k}</label>`).join('')}</span>
      <span class="fctl"><a href="#" data-lasso title="lasso: drag around some dots to mark them (key l; Esc cancels)">mark</a></span>
      <span class="fctl" ${OVERLAYS ? '' : 'hidden'}>pulse: ${[0, 1, 3, 7, 14].map(d => `<a href="#" data-days="${d}" class="${fieldState.days === d ? 'on' : ''}">${d ? d + 'd' : 'unseen'}</a>`).join('')}</span>
      <span class="fctl">color: ${['meaning', 'origin', 'age', 'read'].filter(c => OVERLAYS || c !== 'read').map(c => `<a href="#" data-color="${c}" class="${fieldState.color === c ? 'on' : ''}">${c}</a>`).join('')}</span>
      <span class="fstat muted">${F.n.toLocaleString()} ${FW.items} · ${topLevel.length} regions · ${F.edges.length} ${FW.edge} lines · laid out ${fmtWhen(F.built)}</span>
    </div>
    ${mode === 'tour' ? '<div class="ftour" id="ftour"></div><div class="ffab" id="ffab"><button data-fab="find" title="search: light up a theme on the map (/)"><kbd>/</kbd> search</button><button data-fab="mark" title="lasso: drag around some dots to mark them (l)"><kbd>l</kbd> mark</button><button data-fab="drift" title="let the plane wander on its own">drift</button><button data-fab="bare" title="hide or show the controls (h)">controls</button><button data-fab="exit" title="leave full screen (f, or Esc)">exit</button></div>' : ''}
    ${mode !== 'plane' ? '<div class="bcrumb" id="fcrumb"></div>' : ''}
    <div class="fwrap">
      <div class="fsvgwrap"><canvas id="fcanvas" ${mode === 'plane' ? '' : 'hidden'}></canvas><svg id="fsvg"></svg><div id="ftip" class="ftip" hidden></div></div>
      <aside class="fside">
        <div id="fmarks"></div>
        <div id="fscenes"></div>
        <div id="fregions"></div>
        <div id="forigins"></div>
      </aside>
    </div>
    <div class="flegend muted small" id="flegend"></div>
  </div>`;
  const legend = () => { main.querySelector('#flegend').innerHTML = mode === 'plane'
    ? `scroll to zoom, drag to pan · click a point to read it · click a region name to go there · double-click the background to reset · ${FW.edges} gather by region at rest and come apart as you zoom in`
    : mode === 'tour'
    ? `regions clustered in a 4D layout, seen through a plane you move and tilt · circle area = items inside the slab (or the lens) · ribbon = ${FW.edges} between ${FW.items} inside it · <b>depth</b> slides the slab along the two hidden directions, <b>tilt</b> turns the plane toward them, <b>thickness</b> → ∞ is the plain projection · click a circle to go in, <b>shift-click</b> a circle or dot to put the lens there · Esc backs out`
    : `circle area = ${FW.items} in the region · ribbon width = ${FW.edges} between two regions (<span class="accent">accent</span> = mostly ${FM.type_names[ACC] || ACC}) · glow = pulse · rim = ` + (fieldState.color === 'origin' ? `${FW.origins} there` : fieldState.color === 'age' ? 'median age' : 'share you have read') + ' · click a circle to go in, the background (or Esc) to back out · at the bottom, click a dot to read it'; };
  legend();
  const wrap = main.querySelector('.fsvgwrap');

  // ---------------------------------------------------------------- colors (the page's palette, read from CSS so dark mode follows)
  const C = {};
  let heatSprite = null;
  const clear = c => { const x = d3.color(c); if (!x) return 'rgba(0,0,0,0)'; x.opacity = 0; return x.formatRgb(); };   // the same hue, transparent (fading to transparent black greys a gradient)
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    for (const v of ['bg', 'fg', 'mute', 'line', 'accent', 'soft', 'read', 'mark']) C[v] = cs.getPropertyValue('--' + v).trim() || '#888';
    C.pulse = cs.getPropertyValue('--pulse').trim() || C.accent;   // the pulse glow has its own color; a page without the token keeps the accent
    // one soft disc in the pulse color, scaled per heat point (a blur filter per frame would be the slow part)
    const s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s;
    const c2 = cv.getContext('2d'), gr = c2.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, C.pulse); gr.addColorStop(0.3, C.pulse); gr.addColorStop(1, clear(C.pulse));
    c2.fillStyle = gr; c2.globalAlpha = 1; c2.fillRect(0, 0, s, s);
    heatSprite = cv;
  };
  readColors();
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onTheme = () => { if (stale(g)) { mq.removeEventListener('change', onTheme); return; } readColors(); pres.theme(); };
  mq.addEventListener('change', onTheme);

  const now = Date.now();
  const ageT = d => { const t = Date.parse(d.updated || d.created || 0); return Math.max(0, Math.min(1, 1 - Math.log1p((now - t) / 864e5) / Math.log1p(3650))); };  // 1 = today, 0 = ten years
  const ageRamp = t => d3.interpolateRgb('#cfc8bc', '#8a4b2a')(t);
  // ---------------------------------------------------------------- meaning as color (Nov 6)
  // Ben: "its mostly all brown. What if we used color as another dimension … is hue like 2d or something kinda?" Hue
  // alone is a circle (one dimension); hue with chroma is a disk (two) — OKLab's a/b plane, where equal steps look
  // equal. Each item's place on the 2D meaning map (the plane's UMAP, x/y) is read in polar form around the middle:
  // its angle sets the hue, its distance out the chroma, both rank-equalized so every hue gets used and the dense
  // middle stays distinguishable; lightness is fixed, so color never fights the text. The 2D map is a different
  // flattening from the tour's 4D one, so in the tour the color is a second, independent look at meaning: neighbours
  // on screen in different colors are near in this slice but apart on the map. A region's tint is the mean of its
  // members' a/b, so a mixed region comes out greyer — mixedness is visible.
  // The disk is spread over whatever level is in view (Nov 6, first look: inside one leaf every dot came out the same
  // pink, its members being neighbours on the map): the scope's own items are re-ranked, so color shows the structure at
  // the zoom you're at. The same item can change color between levels; at the top it is the global map.
  const abFor = idx => {
    const P = F.points, n = idx.length, ab = new Map();
    if (!n) return ab;
    const mx = d3.median(idx, i => P[i].x), my = d3.median(idx, i => P[i].y);
    const rankOf = f => { const o = idx.slice().sort((a, b) => f(a) - f(b)), r = new Map(); o.forEach((k, j) => r.set(k, (j + 0.5) / n)); return r; };
    const ra = rankOf(i => Math.atan2(P[i].y - my, P[i].x - mx)), rr = rankOf(i => Math.hypot(P[i].x - mx, P[i].y - my));
    for (const i of idx) { const h = TAU * ra.get(i) + 0.5, c = 0.055 + 0.105 * rr.get(i); ab.set(i, [c * Math.cos(h), c * Math.sin(h)]); }
    return ab;
  };
  const MAB_ALL = abFor(F.points.map(p => p.i));
  let MAB = MAB_ALL, MCOL = new Map(), MDARK = null, MKEY = '';
  const setMeaningScope = idx => {
    const key = idx ? idx.length + ':' + idx[0] + ':' + idx[idx.length - 1] : '';
    if (key === MKEY) return;
    MKEY = key; MAB = idx && idx.length > 1 ? abFor(idx) : MAB_ALL; MCOL = new Map();
  };
  const oklabHex = (L, a, b) => {
    for (let t = 0; t < 12; t++) {
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.2914855480 * b;
      const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3;
      const rgb = [4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3, -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3, -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3];
      if (rgb.every(v => v >= -0.0005 && v <= 1.0005) || t === 11)
        return '#' + rgb.map(v => { v = Math.max(0, Math.min(1, v)); v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return Math.round(v * 255).toString(16).padStart(2, '0'); }).join('');
      a *= 0.88; b *= 0.88;   // out of gamut: pull the chroma in, keep the hue
    }
  };
  const meaningCol = i => {
    const dark = (d3.lab(C.bg).l || 100) < 50;
    if (MDARK !== dark) { MDARK = dark; MCOL = new Map(); }
    let c = MCOL.get(i);
    if (!c) { const ab = MAB.get(i) || MAB_ALL.get(i) || [0, 0]; c = oklabHex(dark ? 0.76 : 0.62, ab[0], ab[1]); MCOL.set(i, c); }
    return c;
  };
  // the mean a/b of a set of items (indexes), weighted; `body` → the pale fill for a circle, else the rim's stronger ring
  const meaningTint = (idx, wt, body) => {
    let a = 0, b = 0, w = 0;
    for (const i of idx) { const wi = wt ? wt(i) : 1; if (!wi) continue; const ab = MAB.get(i) || MAB_ALL.get(i); if (!ab) continue; a += wi * ab[0]; b += wi * ab[1]; w += wi; }
    if (!w) return null;
    a /= w; b /= w;
    const dark = (d3.lab(C.bg).l || 100) < 50;
    return body ? oklabHex(dark ? 0.29 : 0.94, a * 0.7, b * 0.7) : oklabHex(dark ? 0.72 : 0.6, a * 1.25, b * 1.25);
  };
  const fillOf = d => fieldState.color === 'meaning' ? meaningCol(d.i) : fieldState.color === 'origin' ? originColor(d.origin) : fieldState.color === 'age' ? ageRamp(Math.round(ageT(d) * 32) / 32) : (d.reads ? '#3f7a4a' : '#bdb6ab');
  const visible = d => !fieldState.hidden.has(d.origin);
  // a region too small or too mixed for distinguishing terms is named by its most central item instead
  const nameOf = (c, n) => c.name.length ? c.name.slice(0, n).join(' · ') : (c.rep || '').split(/\s+/).slice(0, 4).join(' ');
  const regionNames = d => { const parts = cOf(d).split('.'); return parts.map((_, k) => byPath.get(parts.slice(0, k + 1).join('.'))).filter(Boolean).map(c => nameOf(c, 3)).join(' › '); };   // every level, top first
  const pointTip = d => `<b>${esc(d.title || '(untitled)')}</b><div class="small">${esc(d.author || short(d.origin))} · ${esc(short(d.origin))} · ${esc(d.kind || '')} · ${fmtDate(d.updated)}${d.cites_in ? ` · ${FW.cited} ${d.cites_in}×` : ''}</div>
    ${d.vt || d.vb ? `<div class="small muted">${[d.vt ? `revised ${d.vt.length}× · last ${fmtDate(d.vt[d.vt.length - 1][1])}` : '', d.vb ? `${d.vb} bulk revision${d.vb === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</div>` : ''}
    ${d.reads ? `<div class="small read">you read this ${d.reads}× · last ${fmtWhen(d.last_read)}${d.dwell_ms > 20000 ? ' · ' + ms(d.dwell_ms) : ''}</div>` : ''}
    ${HEAT.has(d.i) ? `<div class="small accent">pulse ${HEAT.get(d.i).toFixed(2)}</div>` : ''}
    <div class="small muted">${esc(regionNames(d))}</div>`;
  const typeNames = FM.type_names;
  const byTypes = by => Object.entries(by).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${typeNames[t] || t}`).join(' · ');

  // ---------------------------------------------------------------- overlays (fetched lazily) + the citation aggregate for the current blyg filter
  let HEAT = new Map(), PULSE = null, HITS = null;
  let BUND = F.bundles;
  const rebund = () => { BUND = fieldState.hidden.size ? fieldAggregate(F.points, F.edges.filter(e => visible(F.points[e[0]]) && visible(F.points[e[1]]))) : F.bundles; };
  rebund();

  // ---------------------------------------------------------------- marks: what the presentations share
  // Each presentation answers drawn() (the item dots on screen now, in #fsvg's coordinates; null where the level draws
  // none), view() (what brings the scene back), fit(idx) and marks() (redraw the outlines). A mark's members are matched
  // to points by origin|id, not by the server's index, so a page holding an older field still finds them.
  const KEYI = new Map(F.points.map(p => [p.origin + '|' + p.id, p.i]));
  const markIdx = m => { if (!m._idx || m._of !== F) { m._idx = (m.members || []).map(x => KEYI.get(x.origin + '|' + x.id)).filter(i => i !== undefined); m._of = F; } return m._idx; };
  const marksShown = () => L.marks !== false && MARKS && MARKS.length ? MARKS : [];
  // A mark is drawn as a bubble (Ben, Nov 19: "little bubbles that kinda contain the ones they include"): the smooth
  // contour of the field Σ rᵢ²/dᵢ² over its members — each place [x, y, r] alone is a disc of radius r, and near ones
  // melt together as metaballs do — sampled on a coarse grid (~3k cells) and its rings smoothed. Members far apart give
  // islands: that is where they are. The largest island carries the label.
  const blobLine = d3.line().curve(d3.curveBasisClosed), colLine = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5));
  // Display only, a distortion on purpose: at the tour's bottom level a mark's dots are drawn squeezed toward its middle
  // (see pullOffsets), so the set reads as one region. Item positions, the layout, the lasso and every number about the
  // mark are untouched; a dot in two marks takes the average of the two. MARK_GLOM is how far out the squeeze levels off,
  // as a share of the members' median distance from the middle: smaller pulls them in harder.
  const MARK_GLOM = 0.8;
  function markBlob(pl) {
    if (!pl.length) return null;
    if (pl.length > 400) { const st = Math.ceil(pl.length / 400); pl = pl.filter((_, j) => j % st === 0); }   // a huge mark: a sample shapes it
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, rmax = 0;
    for (const [x, y, r] of pl) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); rmax = Math.max(rmax, r); }
    const cell0 = Math.sqrt(((x1 - x0) + 4 * rmax) * ((y1 - y0) + 4 * rmax) / 3000);
    // a disc much smaller than a cell would fall between the samples: on a wide, sparse mark the discs grow to the grid
    const P = pl.map(([x, y, r]) => [x, y, Math.max(r, cell0 * 1.3)]);
    const rm = d3.max(P, q => q[2]), pad = rm * 1.7;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const cell = Math.max(cell0, d3.min(P, q => q[2]) / 3);
    const nx = Math.ceil((x1 - x0) / cell) + 2, ny = Math.ceil((y1 - y0) / cell) + 2;
    if (nx * ny > 40000) return null;
    const v = new Float32Array(nx * ny);
    for (const [x, y, r] of P) {
      const r2 = r * r, R = 5 * r;
      const i0 = Math.max(0, Math.floor((x - R - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((x + R - x0) / cell));
      const j0 = Math.max(0, Math.floor((y - R - y0) / cell)), j1 = Math.min(ny - 1, Math.ceil((y + R - y0) / cell));
      for (let j = j0; j <= j1; j++) { const dy = y0 + j * cell - y, o = j * nx; for (let i = i0; i <= i1; i++) { const dx = x0 + i * cell - x; v[o + i] += r2 / (dx * dx + dy * dy + 1e-6 * r2); } }
    }
    const mp = d3.contours().size([nx, ny]).thresholds([1])(v)[0];
    if (!mp || !mp.coordinates.length) return null;
    const rings = [];
    // d3.contours reads value i as the pixel [i, i+1]: a sample at x0 + i·cell sits at contour x i + ½
    for (const poly of mp.coordinates) { const ring = poly[0].slice(0, -1).map(([gx, gy]) => [x0 + (gx - 0.5) * cell, y0 + (gy - 0.5) * cell]); if (ring.length >= 3) rings.push(ring); }
    if (!rings.length) return null;
    let main = rings[0], ma = -1;
    for (const r of rings) { const a = Math.abs(d3.polygonArea(r)); if (a > ma) { ma = a; main = r; } }
    const b = { x0: d3.min(main, q => q[0]), y0: d3.min(main, q => q[1]), x1: d3.max(main, q => q[0]), y1: d3.max(main, q => q[1]), cx: d3.mean(main, q => q[0]), cy: d3.mean(main, q => q[1]), area: ma };
    return { d: rings.map(r => blobLine(r)).join(''), b };
  }
  // At the tour's bottom level a mark is one simple region (Ben, Nov 20: "a smooth/clear and probably thicker boundary,
  // more like the other regions … simple and smoothed out a lot. abstracted"): along each ray from the members' middle,
  // how far out their discs reach, R(θ); that outline kept to its first few harmonics, so it is one smooth lobe-y shape
  // with no islands and no dents round single dots; then lifted until it covers nearly all of R. A mark split across
  // the level is one shape over the gap (the glom, below, has pulled its members in first).
  const HULL_NB = 96, HULL_K = 3;
  function markHull(pl) {
    if (!pl.length) return null;
    if (pl.length > 400) { const st = Math.ceil(pl.length / 400); pl = pl.filter((_, j) => j % st === 0); }
    const cx = d3.mean(pl, q => q[0]), cy = d3.mean(pl, q => q[1]), NB = HULL_NB, TA = 2 * Math.PI;
    const R = new Float64Array(NB).fill(NaN);
    for (const [x, y, r] of pl) {
      const dx = x - cx, dy = y - cy;
      for (let k = 0; k < NB; k++) {
        const c0 = Math.cos(k * TA / NB), s0 = Math.sin(k * TA / NB), t = dx * c0 + dy * s0, e = -dx * s0 + dy * c0;
        if (Math.abs(e) >= r) continue;
        const ex = t + Math.sqrt(r * r - e * e);
        if (ex > 0 && !(R[k] >= ex)) R[k] = ex;
      }
    }
    if (![...R].some(v => v === v)) return null;
    for (let k = 0; k < NB; k++) if (R[k] !== R[k]) {   // a ray through a gap: from its neighbours round the circle
      let a = k, b = k, da = 0, db = 0;
      while (R[a] !== R[a]) { a = (a + NB - 1) % NB; da++; }
      while (R[b] !== R[b]) { b = (b + 1) % NB; db++; }
      R[k] = (R[a] * db + R[b] * da) / (da + db);
    }
    // the low harmonics only
    const L = new Float64Array(NB).fill(0);
    for (let h = 0; h <= HULL_K; h++) {
      let a = 0, b = 0;
      for (let k = 0; k < NB; k++) { a += R[k] * Math.cos(h * k * TA / NB); b += R[k] * Math.sin(h * k * TA / NB); }
      a *= (h ? 2 : 1) / NB; b *= (h ? 2 : 1) / NB;
      for (let k = 0; k < NB; k++) L[k] += a * Math.cos(h * k * TA / NB) + b * Math.sin(h * k * TA / NB);
    }
    // lifted to cover the reach of nearly every ray; never thinner than the biggest disc
    const short = [...R].map((v, k) => v - L[k]).sort((p, q) => p - q), lift = Math.max(0, short[Math.floor(0.9 * (NB - 1))]);
    const rmin = d3.max(pl, q => q[2]);
    const pts = Array.from(L, (v, k) => { const rr = Math.max(rmin, v + lift); return [cx + rr * Math.cos(k * TA / NB), cy + rr * Math.sin(k * TA / NB)]; });
    const b = { x0: d3.min(pts, q => q[0]), y0: d3.min(pts, q => q[1]), x1: d3.max(pts, q => q[0]), y1: d3.max(pts, q => q[1]), cx, cy, area: Math.abs(d3.polygonArea(pts)) };
    return { d: colLine(pts), b };
  }
  // The words (Ben: "the text could look nicer, and kinda laid on/in the mark … I want to be able to scan all the notes
  // just looking at it"): the name in spaced capitals, the note under it as a short italic gloss (two lines; all of it
  // while the label is hovered). Laid inside the bubble's upper part when the bubble holds them, over it when it does
  // not; then nudged apart, the biggest marks keeping their places. Sizes in screen px; positions in the drawing's own
  // units, under a zoom zk.
  // a name's width as it is set: spaced capitals, 10.5 px at .16em; in a collapsed mark 11 px at .1em (measured, so the
  // circle can be sized to hold it)
  const markTextW = (() => {
    const cx = document.createElement('canvas').getContext('2d'), memo = new Map();
    return (t, col) => {
      const k = (col ? 'c' : 'o') + t;
      if (!memo.has(k)) { const fs = col ? 11 : 10.5; cx.font = `600 ${fs}px Georgia, "Iowan Old Style", serif`; memo.set(k, cx.measureText(t).width + t.length * fs * (col ? 0.1 : 0.16)); }
      return memo.get(k);
    };
  })();
  const MARK_TYPE = { name: 10.5, nameW: 8.3, nameH: 15, note: 11.5, noteW: 5.7, noteH: 14.5, gloss: 46, glossLines: 2, full: 54, fullLines: 14 };
  function wrapLines(s, n, max) {
    const out = [];
    let line = '';
    for (const w of s.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + w).length > n) { out.push(line); line = w; } else line = line ? line + ' ' + w : w;
      if (out.length === max) break;
    }
    if (out.length < max && line) out.push(line);
    const all = s.split(/\s+/).filter(Boolean).join(' ').length, shown = out.join(' ').length;
    if (shown < all && out.length) { let last = out[out.length - 1]; if (last.length > n - 1) last = last.slice(0, n - 1).replace(/\s+\S*$/, ''); out[out.length - 1] = last.replace(/[,.;:—–-]*$/, '') + '…'; }
    return out;
  }
  const markOn = m => MARK.hl === m.id || MARK.hov === m.id;   // hovered, or its card or row is
  // top: the view's upper edge, in screen px of the drawing (a label flips under its mark there); keep: boxes to stay off
  // ({ x: centre, y: top, w, h }, screen px of the drawing): the circles' own names
  function markLabels(rows, zk, top, keep = [], hint) {
    const T = MARK_TYPE, placed = [...keep], out = [];
    for (const r of [...rows].sort((a, b) => (b.lb || b.blob.b).area - (a.lb || a.blob.b).area)) {
      const b = r.lb || r.blob.b, m = r.m, open = MARK.hov === m.id;
      if (r.minor && !markOn(m)) continue;
      const name = markName(m).toUpperCase();
      const note = L.notes !== false && m.note ? String(m.note).trim() : '';
      const hn = open && hint ? hint(m) : '';
      // the lines of one way of setting the label: with its note (as a gloss, or all of it while hovered), or bare
      // nameMax: inside a mark, a name wider than this is set on two or three lines, a word or two each, as a map stacks one
      const nameLines = nameMax => {
        if (!nameMax || markTextW(name, !!r.col) <= nameMax) return [name];
        const out = [];
        for (const wd of name.split(/\s+/)) { const last = out[out.length - 1]; if (last && markTextW(last + ' ' + wd) <= nameMax) out[out.length - 1] = last + ' ' + wd; else out.push(wd); }
        return out.length <= 3 ? out : [name];
      };
      const setLines = (withNote, wn = T.gloss, wl = T.glossLines, nameMax = 0) => {
        const lines = nameLines(nameMax).map(t => ({ t, c: 'mn', h: T.nameH - 1 }));
        lines[lines.length - 1].h = T.nameH;
        if (r.col) lines.push({ t: `∙ ${r.col.n} ∙`, c: 'mc', h: 13 });   // collapsed: its count, as a region's circle has
        // collapsed: the name and count sit in the middle of the circle, and the note hangs just under its lower edge
        const gap = r.col && note && withNote ? Math.max(0, (b.y1 - b.cy) * zk - (T.nameH + 13) / 2 + 6) : 0;
        if (gap) lines.push({ t: '', c: 'gap', h: gap });
        // round a whole circle (above the bottom level) the circle's own name is inside it: the mark's words go outside, one line of gloss
        if (note && withNote) for (const t of wrapLines(note, open ? T.full : wn, open ? T.fullLines : r.ring ? 1 : wl)) lines.push({ t, c: 'mt', h: T.noteH });
        if (hn) lines.push({ t: hn, c: 'mh', h: 14 });
        const w = Math.max(...lines.map(q => q.c === 'mn' ? markTextW(q.t, !!r.col) : q.t.length * T.noteW)), h = d3.sum(lines, q => q.h);
        return { lines, w, h, gap };
      };
      const ws = (b.x1 - b.x0) * zk, hs = (b.y1 - b.y0) * zk;
      const clashAt = (x, y, w, h) => (top !== undefined && y < top + 2) || placed.some(p => Math.abs(p.x - x) < (p.w + w) / 2 + 8 && y < p.y + p.h + 4 && y + h > p.y - 4);
      let S, ax, ay, inside, dy = 0;
      if (r.hull && !r.col) {
        // the bottom level's regions: the label stays on its own mark — inside it (the note wrapped to the mark's own
        // width, three short lines, a little above its middle), else just above it, else just under it; with its note
        // if one of those is free, else bare (the note is on hover and in the card); only then nudged. A hovered label
        // takes its first spot regardless, over the others.
        const innerN = Math.max(20, Math.min(T.gloss, Math.floor((ws - 16) / T.noteW)));   // a name may run up to ~20 px past the rim each side
        const tries = [];
        for (const withNote of open || !note ? [true] : [true, false]) {
          const Si = setLines(withNote, innerN, 3, ws + 20), So = setLines(withNote);
          if (hs >= Si.h + 18 && ws + 44 >= Si.w) tries.push([Si, b.cx * zk, b.y0 * zk + Math.max(10, 0.3 * (hs - Si.h)), true]);
          tries.push([So, b.cx * zk, b.y0 * zk - So.h - 3, false], [So, b.cx * zk, b.y1 * zk + 4, false]);
        }
        for (const [S1, x, y, inn] of tries) if (open || !clashAt(x, y, S1.w, S1.h)) { S = S1; ax = x; ay = y; inside = inn; break; }
        if (!S) {
          S = setLines(false); ax = b.cx * zk; ay = b.y0 * zk - S.h - 3; inside = false;
          let best = null;
          for (const cx of [0, -1, 1]) for (let k = -6; k <= 6; k++) {
            const ox = cx * (S.w / 2 + 24), oy = k * 13, cost = Math.abs(ox) * 0.7 + Math.abs(oy);
            if ((!best || cost < best[2]) && !clashAt(ax + ox, ay + oy, S.w, S.h)) best = [ox, oy, cost];
          }
          if (best) { ax += best[0]; dy = best[1]; }
        }
      } else {
        S = setLines(true);
        const { w, h } = S;
        const hc = r.col ? T.nameH + 13 : h;   // the part centred in a collapsed mark
        inside = !!r.col || (!r.ring && hs >= Math.min(h, T.nameH + 2 * T.noteH) + 26 && ws >= Math.min(w, 150) + 18);
        ax = b.cx * zk; ay = r.col ? b.cy * zk - hc / 2 + 2 : inside ? b.y0 * zk + 14 : b.y0 * zk - h - 3;   // collapsed: centred in it, as a region's name
        if (!inside && top !== undefined && ay < top + 4) ay = b.y1 * zk + 4;   // no room above (the top of the view): under it
        // the nearest free spot: up and down in 13 px steps, then sideways
        if (!r.col && clashAt(ax, ay, w, h)) {   // a collapsed mark's name stays in its circle; the others move round it
          let best = null;
          for (const cx of [0, -1, 1, -2, 2]) for (let k = -8; k <= 8; k++) {
            const ox = cx * (w / 2 + 30), oy = k * 13, cost = Math.abs(ox) * 0.7 + Math.abs(oy);
            if ((!best || cost < best[2]) && !clashAt(ax + ox, ay + oy, w, h)) best = [ox, oy, cost];
          }
          if (best) { ax += best[0]; dy = best[1]; }
        }
      }
      const { lines, w, h, gap } = S, hc = r.col ? T.nameH + 13 : h;
      placed.push({ x: ax, y: ay + dy, w, h });
      let y = 0;
      for (const q of lines) { y += q.h; q.y = y - 4; }
      out.push({ r, x: ax / zk, y: (ay + dy) / zk, lines, inside, w, h, open, py: gap ? hc + gap - 4 : 0, nw: markTextW(name, !!r.col) });   // py: where the plate starts (under a collapsed mark's circle)
    }
    return out;
  }
  // the gradient every bubble is filled with (bounding-box units, so one serves all)
  function markDefs(defs) {
    const gr = defs.append('radialGradient').attr('id', 'fmarkfill').attr('cx', '50%').attr('cy', '45%').attr('r', '62%');
    gr.selectAll('stop').data([[0, 0.2], [0.65, 0.12], [1, 0.07]]).join('stop').attr('offset', s => s[0]).style('stop-color', 'var(--mark)').style('stop-opacity', s => s[1]);
    // a collapsed mark, a region of its own: a little stronger, still soft enough that two overlapping do not wash out
    const gc = defs.append('radialGradient').attr('id', 'fmarkfillc').attr('cx', '50%').attr('cy', '42%').attr('r', '58%');
    gc.selectAll('stop').data([[0, 0.3], [0.7, 0.2], [1, 0.13]]).join('stop').attr('offset', s => s[0]).style('stop-color', 'var(--mark)').style('stop-opacity', s => s[1]);
  }
  // The SVG drawing (tour and blobs): the bubbles into gB (under the dots at the bottom level), the labels into gL, each
  // keyed by mark and updated in place. `places(m)` in the group's units; `redraw` asks the presentation for a frame.
  // opts.click(m, ev): what a click on a label does (default: open the mark's card); opts.hint: a line shown on hover
  function drawMarkSvg(gB, gL, places, zk, redraw, top = 0, keep = [], opts = {}) {
    const rows = [];
    for (const m of marksShown()) {
      const pl = places(m);
      if (pl.shape) {   // collapsed: its outline is given, and its label sits in its middle
        const u = pl.ushape, b = { x0: d3.min(u, q => q[0]), y0: d3.min(u, q => q[1]), x1: d3.max(u, q => q[0]), y1: d3.max(u, q => q[1]), cx: d3.mean(u, q => q[0]), cy: d3.mean(u, q => q[1]) };
        b.area = (b.x1 - b.x0) * (b.y1 - b.y0);
        rows.push({ m, blob: { d: colLine(pl.shape), b }, lb: b, col: pl.col, hd: colLine(pl.ushape) });
        continue;
      }
      const shape = opts.bubble ? markHull : markBlob;   // the bottom level: one smooth region per mark
      const blob = shape(pl);
      if (!blob) continue;
      // under the loupe the dots (and so the bubble) move; the label is laid on the bubble as it is without the loupe
      const moved = pl.some(q => q.length > 3 && (q[3] !== q[0] || q[4] !== q[1] || (q.length > 5 && q[5] !== q[2])));
      const still = moved ? shape(pl.map(q => [q[3], q[4], q[5] ?? q[2]])) : null;
      // a stray few of a mark that lives mostly elsewhere: drawn faint, named only while hovered
      const minor = !!opts.bubble && pl.length < 4 && pl.length < 0.5 * markIdx(m).length;
      rows.push({ m, blob, lb: still ? still.b : blob.b, ring: !!pl.ring, minor, hull: !!opts.bubble, hd: still ? still.d : blob.d });
    }
    const key = r => String(r.m.id);
    const state = (sel, r) => sel.classed('prop', d => r(d).m.state === 'proposed').classed('on', d => markOn(r(d).m)).classed('lift', d => MARK.lift.has(r(d).m.id));
    // largest first, so a smaller mark lies over a larger one; each is a casing (a band of the background, so where two
    // rims cross one passes cleanly over the other) and then its fill and rim
    const order = rows.slice().sort((a, b) => (b.lb.area || 0) - (a.lb.area || 0));
    gB.selectAll('path.fmb').filter(function () { return !this.parentNode.classList.contains('fmg'); }).remove();   // drawn before the casing
    const mg = gB.selectAll('g.fmg').data(order, key).join(e => { const g2 = e.append('g').attr('class', 'fmg'); g2.append('path').attr('class', 'fmk'); g2.append('path').attr('class', 'fmb'); return g2; }).order();
    mg.select('path.fmk').attr('d', r => r.blob.d).classed('ring', r => r.ring).classed('minor', r => r.minor);
    state(mg.select('path.fmb').attr('d', r => r.blob.d), r => r).classed('ring', r => r.ring).classed('col', r => !!r.col).classed('minor', r => r.minor).classed('hull', !!opts.bubble);
    // opts.bubble (the bottom level): the inside of a bubble is a target too — an invisible copy of it under the dots (so a
    // dot keeps the pointer), drawn as the bubble is without the loupe: the loupe leaves the point under the cursor where
    // it is, so the cursor is tested against the sheet as it lies there. The smaller of two overlapping is on top.
    if (opts.bubble) {
      gB.selectAll('path.fmbhit').data(rows.slice().sort((a, b) => (b.lb.area || 0) - (a.lb.area || 0)), key)
        .join(e => e.append('path').attr('class', 'fmbhit').on('click', (ev, r) => { ev.stopPropagation(); (opts.click || (m => markOpen(m.id)))(r.m, ev); }))
        .attr('d', r => r.hd).order();
    } else gB.selectAll('path.fmbhit').remove();
    const labs = markLabels(rows, zk, top, keep, opts.hint);
    const lg = gL.selectAll('g.fml').data(labs, l => key(l.r)).join(e => {
      const g2 = e.append('g').attr('class', 'fml');
      g2.append('rect').attr('class', 'fmplate');
      g2.append('text');
      g2.append('g').attr('class', 'fmhits');   // what takes the pointer: a box round each line as the browser drew it (below)
      g2.on('click', (ev, l) => { ev.stopPropagation(); (opts.click || (m => markOpen(m.id)))(l.r.m, ev); })
        .on('mouseenter', (ev, l) => { if (MARK.geomHover) return; MARK.hov = l.r.m.id; MARK.lab = true; redraw(true); })   // (the tour's bottom level decides hover itself)
        .on('mouseleave', (ev, l) => { if (MARK.geomHover) return; MARK.lab = false; if (MARK.hov === l.r.m.id) { MARK.hov = null; redraw(true); } });
      return g2;
    });
    state(lg, l => l.r).classed('in', l => l.inside).classed('col', l => !!l.r.col).attr('transform', l => `translate(${l.x.toFixed(1)},${l.y.toFixed(1)}) scale(${(1 / zk).toFixed(4)})`);
    lg.select('rect.fmplate').attr('x', l => -l.w / 2 - 10).attr('y', l => l.py - 4).attr('width', l => l.w + 20).attr('height', l => l.h - l.py + 11).attr('rx', 7);
    lg.select('text').each(function (l) {
      d3.select(this).selectAll('tspan').data(l.lines).join('tspan').attr('class', q => q.c).attr('x', 0).attr('y', q => q.y).text(q => q.t);
    });
    // The pointer's targets, measured from what was drawn (Safari sets the same text wider and lower than Chromium, so a
    // box worked out from font sizes misses the letters there): per line with words, the span from its first glyph to its
    // last (getExtentOfChar), padded so the lines of one label touch. The blank line between a collapsed mark's name and
    // its note gets none, so the dots inside the circle stay reachable.
    lg.each(function (l) {
      const text = this.querySelector('text'), boxes = [];
      let at = 0;
      for (const q of l.lines) {
        const n = q.t.length;
        if (n && q.c !== 'gap') {
          try {
            const a = text.getExtentOfChar(at), b = text.getExtentOfChar(at + n - 1);
            const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x + a.width, b.x + b.width), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y + a.height, b.y + b.height);
            if (x1 > x0 && y1 > y0) boxes.push([x0 - 6, y0 - 3, x1 - x0 + 12, y1 - y0 + 6]);
          } catch { /* not laid out yet (hidden): the next draw measures it */ }
        }
        at += n;
      }
      d3.select(this).select('g.fmhits').selectAll('rect').data(boxes).join('rect').attr('class', 'fmhit')
        .attr('x', q => q[0]).attr('y', q => q[1]).attr('width', q => q[2]).attr('height', q => q[3]);
    });
  }
  // the marks a dot belongs to, lifted while it is hovered
  function markLift(i, redraw) {
    const ids = i === null ? [] : marksShown().filter(m => markIdx(m).includes(i)).map(m => m.id);
    if (ids.length === MARK.lift.size && ids.every(id => MARK.lift.has(id))) return;
    MARK.lift = new Set(ids); redraw();
  }

  // ================================================================ PLANE
  function fieldPlane() {
    const W = Math.max(600, wrap.clientWidth), H = Math.max(520, Math.min(900, innerHeight - wrap.getBoundingClientRect().top - 56));
    const svg = d3.select('#fsvg').attr('width', W).attr('height', H).attr('viewBox', [0, 0, W, H]);
    const canvas = main.querySelector('#fcanvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    const pad = 24;
    const x = d3.scaleLinear().domain(d3.extent(F.points, d => d.x)).range([pad, W - pad]);
    const y = d3.scaleLinear().domain(d3.extent(F.points, d => d.y)).range([H - pad, pad]);
    for (const d of F.points) { d.px = x(d.x); d.py = y(d.y); }
    for (const c of F.clusters) { c.px = x(c.cx); c.py = y(c.cy); c.pr = Math.abs(x(c.cx + c.r) - c.px); }

    svg.append('rect').attr('class', 'fbg').attr('width', W).attr('height', H).attr('fill', 'transparent');
    const view = svg.append('g').attr('class', 'fview');
    const gLabels = view.append('g').attr('class', 'flabels');
    const gFx = view.append('g').attr('class', 'ffx');
    let t = d3.zoomIdentity, k = 1;   // current zoom transform and scale

    // ---------------------------------------------------------------- regions + labels
    // A region's territory: the convex hull of its dense core (members within 2× the median distance of the centroid,
    // so a few members UMAP scattered elsewhere don't stretch the shape across the whole plane), rounded.
    const hullOf = c => {
      const members = F.points.filter(p => p.c === c.path || parentOf(p.c) === c.path);
      const dist = members.map(p => Math.hypot(p.px - c.px, p.py - c.py));
      const cut = (d3.median(dist) || 0) * 2;
      const core = members.filter((p, i) => dist[i] <= cut);
      if (core.length < 3) return null;
      const hull = d3.polygonHull(core.map(p => [p.px, p.py]));
      return hull ? d3.line().curve(d3.curveCatmullRomClosed.alpha(0.7))(hull) : null;
    };
    const hulls = topLevel.map(hullOf).filter(Boolean).map(d => new Path2D(d));
    const label = gLabels.selectAll('g').data(F.clusters).join('g')
      .attr('class', c => 'flabel ' + (c.path.includes('.') ? 'sub' : 'top'))
      .attr('tabindex', 0).attr('role', 'button')
      .on('click', (ev, c) => { ev.stopPropagation(); zoomToCluster(c); })
      .on('keydown', (ev, c) => { if (ev.key === 'Enter') zoomToCluster(c); });
    // Top-level labels: a greedy vertical nudge so the ones that share the dense middle don't stack on each other at rest.
    const placed = [];
    for (const c of [...topLevel].sort((a, b) => b.size - a.size)) {
      const w = Math.max(120, (c.name.slice(0, 4).join(' · ').length) * 8.5), h = 34;
      let dy = 0, tries = 0;
      const clash = () => placed.some(o => Math.abs(o.px - c.px) < (o.w + w) / 2 && Math.abs(o.py - (c.py + dy)) < h);
      while (clash() && tries < 12) { tries++; dy = (tries % 2 ? 1 : -1) * Math.ceil(tries / 2) * h * 0.8; }
      c.dy = dy; placed.push({ px: c.px, py: c.py + dy, w });
    }
    label.append('text').attr('class', 'fname').attr('text-anchor', 'middle').text(c => nameOf(c, c.path.includes('.') ? 3 : 4));
    label.append('text').attr('class', 'frep').attr('text-anchor', 'middle').attr('dy', '1.25em').text(c => c.name.length ? (c.rep || '').slice(0, 54) + ((c.rep || '').length > 54 ? '…' : '') : '');

    // ---------------------------------------------------------------- citations: geometry, precomputed once
    // The bundling tree is the region hierarchy: field centre → region → sub-region → item. A connector between two
    // regions bends toward the centre; one between two sub-regions runs through their regions' centroids; a single
    // line runs through its endpoints' cluster centroids. Beta < 1 straightens each route toward its chord.
    const cen = { px: d3.mean(F.points, d => d.px), py: d3.mean(F.points, d => d.py) };
    const at = c => [c.px, c.py];
    const routeCache = new Map();
    const routeOf = (a, b, level) => {
      const key = level + ':' + a + '|' + b;
      if (routeCache.has(key)) return routeCache.get(key);
      const A = byPath.get(a), B = byPath.get(b), PA = byPath.get(parentOf(a)), PB = byPath.get(parentOf(b));
      const [ctrl, beta] = level === 'top' ? [[at(A), at(cen), at(B)], 0.24]
        : PA === PB ? [[at(A), at(PA), at(B)], 0.55]
        : [[at(A), at(PA), at(PB), at(B)], 0.85];
      const geo = fieldGeom(fieldBundlePath(ctrl, beta, 8));
      routeCache.set(key, geo);
      return geo;
    };
    const edgeGeo = F.edges.map(([i, j]) => {
      const a = F.points[i], b = F.points[j], ca = byPath.get(a.c), cb = byPath.get(b.c);
      if (!ca || !cb) return fieldGeom([[a.px, a.py], [b.px, b.py]]);
      const ctrl = ca === cb ? [[a.px, a.py], at(ca), [b.px, b.py]] : [[a.px, a.py], at(ca), at(cb), [b.px, b.py]];
      return fieldGeom(fieldBundlePath(ctrl, ca === cb ? 0.3 : 0.5, 6));
    });
    const edgesOf = new Map();   // point index → its edges, for the hover highlight
    F.edges.forEach((e, j) => { for (const i of [e[0], e[1]]) { if (!edgesOf.has(i)) edgesOf.set(i, []); edgesOf.get(i).push(j); } });

    // Connector sets for the current blyg filter (the server's counts when nothing is hidden).
    let conTop = [], conSub = [], edgeVis = [];
    const buildConnectors = () => {
      const live = F.edges.map((e, j) => j).filter(j => visible(F.points[F.edges[j][0]]) && visible(F.points[F.edges[j][1]]));
      edgeVis = live;
      const B = fieldState.hidden.size ? fieldAggregate(F.points, live.map(j => F.edges[j])) : F.bundles;
      const mk = (list, level, wBase, wLog) => {
        const max = d3.max(list, b => b.n) || 1;
        return list.map(b => {
          const tr = (b.by[ACC] || 0) / b.n > 0.5;
          return { ...b, A: byPath.get(b.a), B: byPath.get(b.b), geo: routeOf(b.a, b.b, level), w: wBase + wLog * Math.log1p(b.n), alpha: (tr ? 0.13 : 0.11) + 0.22 * Math.log1p(b.n) / Math.log1p(max), tr };
        }).sort((p, q) => q.n - p.n);   // heaviest first, so the thin ones stay visible on top
      };
      conTop = mk(B.top || [], 'top', 1.2, 2.1);
      conSub = mk(B.sub || [], 'sub', 0.9, 1.6);
    };

    // ---------------------------------------------------------------- points
    const rBase = d => Math.min(8, 2.1 + 1.5 * Math.sqrt(d.cites_in));
    for (const d of F.points) d.rb = rBase(d);

    // Draw lists, rebuilt when the color, filter or search changes (not on zoom).
    let buckets = [], hitPts = [], readPts = [], qt = d3.quadtree();
    const rebucket = () => {
      const m = new Map();
      for (const d of F.points) {
        if (!visible(d) || (HITS && HITS.has(d.i))) continue;
        const f = fillOf(d);
        if (!m.has(f)) m.set(f, []);
        m.get(f).push(d);
      }
      buckets = [...m].map(([fill, pts]) => ({ fill, pts }));
      hitPts = HITS ? F.points.filter(d => visible(d) && HITS.has(d.i)) : [];
      for (const d of hitPts) d.fill = fillOf(d);
      readPts = F.points.filter(d => visible(d) && d.reads && !(HITS && HITS.has(d.i)));
      qt = d3.quadtree(F.points.filter(visible), d => d.px, d => d.py);
    };

    let hov = -1;   // hovered point index

    // ---------------------------------------------------------------- canvas
    let vb = [0, 0, W, H], sv = vb;   // the view in plane coordinates: padded, and exact
    const inView = bb => bb[2] >= vb[0] && bb[0] <= vb[2] && bb[3] >= vb[1] && bb[1] <= vb[3];
    const ptIn = (d, r) => d.px + r >= vb[0] && d.px - r <= vb[2] && d.py + r >= vb[1] && d.py - r <= vb[3];
    const taper = u => 0.1 + 0.9 * Math.pow(Math.sin(Math.PI * u), 0.7);
    function ribbon(geo, hw) {   // a filled band along the route, widest mid-way and pointed at both ends
      const { pts, t: u, nx, ny } = geo, n = pts.length;
      ctx.moveTo(pts[0][0] + nx[0] * hw * taper(u[0]), pts[0][1] + ny[0] * hw * taper(u[0]));
      for (let i = 1; i < n; i++) { const w = hw * taper(u[i]); ctx.lineTo(pts[i][0] + nx[i] * w, pts[i][1] + ny[i] * w); }
      for (let i = n - 1; i >= 0; i--) { const w = hw * taper(u[i]); ctx.lineTo(pts[i][0] - nx[i] * w, pts[i][1] - ny[i] * w); }
      ctx.closePath();
    }
    function polyline(geo) { const p = geo.pts; ctx.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]); }
    const onScreen = c => c.px >= sv[0] && c.px <= sv[2] && c.py >= sv[1] && c.py <= sv[3];
    function drawRibbons(list, fade, anchored) {   // anchored: only connectors with an end on screen (the sub-regions in view)
      if (fade <= 0.01) return;
      for (const c of list) {
        if (!inView(c.geo.bb)) continue;
        const col = c.tr ? C.accent : C.mute;
        let fill = col;
        if (anchored) {
          // in a region: a connector to a sub-region off screen fades out on its way there, like the single lines do
          const ia = onScreen(c.A), ib = onScreen(c.B);
          if (!ia && !ib) continue;
          if (!(ia && ib) && c.n < 2 && c.A.path.split('.')[0] !== c.B.path.split('.')[0]) continue;   // a lone line to another region waits for the deep level
          if (!(ia && ib)) {
            const p0 = ia ? c.A : c.B, p1 = ia ? c.B : c.A, dx = p1.px - p0.px, dy = p1.py - p0.py, dl = Math.hypot(dx, dy) || 1, reach = 0.5 * Math.min(W, H) / k;
            fill = ctx.createLinearGradient(p0.px, p0.py, p0.px + dx / dl * reach, p0.py + dy / dl * reach);
            fill.addColorStop(0, col); fill.addColorStop(0.35, col); fill.addColorStop(1, clear(col));
          }
        }
        ctx.globalAlpha = fade * c.alpha;
        ctx.fillStyle = fill;
        ctx.beginPath(); ribbon(c.geo, c.w / 2 / k); ctx.fill();
      }
    }
    function strokeLines(idx, color, alpha, width) {
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width / k;
      ctx.beginPath();
      for (const j of idx) if (inView(edgeGeo[j].bb)) polyline(edgeGeo[j]);
      ctx.stroke();
    }

    function draw() {
      const [l0a, l0b] = FIELD_LEVELS.region, [s0, s1, s2, s3] = FIELD_LEVELS.sub, [e0, e1] = FIELD_LEVELS.line;
      const fRegion = clamp01((l0b - k) / (l0b - l0a)), fSub = Math.min(clamp01((k - s0) / (s1 - s0)), clamp01((s3 - k) / (s3 - s2))), fLine = clamp01((k - e0) / (e1 - e0));
      const m = 40 / k;
      vb = [-t.x / k - m, -t.y / k - m, (W - t.x) / k + m, (H - t.y) / k + m];
      sv = [-t.x / k, -t.y / k, (W - t.x) / k, (H - t.y) / k];
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * t.x, dpr * t.y);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';

      if (L.regions) {
        ctx.globalAlpha = 0.7; ctx.fillStyle = C.soft; ctx.strokeStyle = C.line; ctx.lineWidth = 1 / k;
        for (const h of hulls) { ctx.fill(h); ctx.stroke(h); }
      }
      const dimmed = HITS ? 0.45 : 1;
      if (L.cites) {
        drawRibbons(conTop, fRegion * dimmed);
        drawRibbons(conSub, fSub * dimmed, true);
        if (fLine > 0.01) {
          // a line with both ends on screen is drawn whole; one leaving the screen fades out over a stretch of it,
          // so lines to far regions read as directions rather than slicing across the view; neither end: not drawn
          const tr = [], other = [], half = [];
          for (const j of edgeVis) {
            const a = onScreen(F.points[F.edges[j][0]]), b = onScreen(F.points[F.edges[j][1]]);
            if (a && b) (F.edges[j][2] === ACC ? tr : other).push(j); else if (a || b) half.push([j, a]);
          }
          strokeLines(other, C.mute, 0.4 * fLine * dimmed, 1);
          strokeLines(tr, C.accent, 0.45 * fLine * dimmed, 1.1);
          const reach = 0.45 * Math.min(W, H) / k;
          ctx.lineWidth = 1 / k;
          for (const [j, aIn] of half) {
            const e = F.edges[j], p0 = F.points[aIn ? e[0] : e[1]], p1 = F.points[aIn ? e[1] : e[0]];
            const dx = p1.px - p0.px, dy = p1.py - p0.py, dl = Math.hypot(dx, dy) || 1;
            const col = e[2] === ACC ? C.accent : C.mute;
            const gr = ctx.createLinearGradient(p0.px, p0.py, p0.px + dx / dl * reach, p0.py + dy / dl * reach);
            gr.addColorStop(0, col); gr.addColorStop(1, clear(col));
            ctx.globalAlpha = (e[2] === ACC ? 0.45 : 0.4) * fLine * dimmed; ctx.strokeStyle = gr;
            ctx.beginPath(); polyline(edgeGeo[j]); ctx.stroke();
          }
        }
      }
      if (L.pulse && PULSE) {
        const pk = Math.pow(k, 0.6);
        for (const [i, w] of PULSE.heat) {
          const d = F.points[i];
          if (!visible(d)) continue;
          const R = (7 + 11 * Math.sqrt(w / PULSE.max)) * pk * 1.7 / k;   // screen px → plane units
          if (!ptIn(d, R)) continue;
          ctx.globalAlpha = 0.3;
          ctx.drawImage(heatSprite, d.px - R, d.py - R, 2 * R, 2 * R);
        }
      }

      // points: one path per color, filled, with a hairline in the background color to keep neighbours apart
      const rk = Math.pow(k, -0.55);
      const base = HITS ? 0.18 : (fieldState.color === 'age' ? 0.85 : 0.72);
      ctx.globalAlpha = base; ctx.strokeStyle = C.bg; ctx.lineWidth = 0.6 / k;
      for (const b of buckets) {
        ctx.fillStyle = b.fill;
        ctx.beginPath();
        for (const d of b.pts) { const r = d.rb * rk; if (!ptIn(d, r)) continue; ctx.moveTo(d.px + r, d.py); ctx.arc(d.px, d.py, r, 0, TAU); }
        ctx.fill(); ctx.stroke();
      }
      if (readPts.length) {
        ctx.globalAlpha = Math.min(1, base + 0.2); ctx.strokeStyle = C.read; ctx.lineWidth = 1.3 / k;
        ctx.beginPath();
        for (const d of readPts) { const r = d.rb * rk; if (!ptIn(d, r)) continue; ctx.moveTo(d.px + r, d.py); ctx.arc(d.px, d.py, r, 0, TAU); }
        ctx.stroke();
      }
      for (const d of hitPts) {
        const r = d.rb * rk;
        if (!ptIn(d, r)) continue;
        ctx.globalAlpha = 1; ctx.fillStyle = d.fill; ctx.strokeStyle = C.accent; ctx.lineWidth = 1.8 / k;
        ctx.beginPath(); ctx.arc(d.px, d.py, r, 0, TAU); ctx.fill(); ctx.stroke();
      }

      // marks: each a bubble round its visible members (a soft radial fill, a thin rim, dashed for an agent's proposal),
      // its name and the gloss of its note laid over it — the SVG presentations' drawing, on the canvas
      const rows = [];
      for (const m of marksShown()) {
        const pts = markIdx(m).map(i => F.points[i]).filter(visible);
        const blob = pts.length ? markBlob(pts.map(d => [d.px, d.py, d.rb * rk + 9 / k])) : null;
        if (blob && inView([blob.b.x0, blob.b.y0, blob.b.x1, blob.b.y1])) rows.push({ m, blob });
      }
      const mc = d3.color(C.mark), mcA = a => { const c = mc.copy(); c.opacity = a; return c.formatRgb(); };
      for (const { m, blob } of rows) {
        const on = markOn(m), path = new Path2D(blob.d), b = blob.b, R = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.62;
        const gr = ctx.createRadialGradient(b.cx, b.cy - (b.y1 - b.y0) * 0.05, 0, b.cx, b.cy, R);
        gr.addColorStop(0, mcA(on ? 0.3 : 0.2)); gr.addColorStop(0.65, mcA(on ? 0.2 : 0.12)); gr.addColorStop(1, mcA(on ? 0.12 : 0.07));
        ctx.globalAlpha = 1; ctx.fillStyle = gr; ctx.fill(path);
        ctx.strokeStyle = mcA(on ? 0.9 : 0.5); ctx.lineWidth = (on ? 1.4 : 1) / k;
        ctx.setLineDash(m.state === 'proposed' ? [2.5 / k, 3 / k] : []); ctx.stroke(path); ctx.setLineDash([]);
      }
      for (const l of markLabels(rows, k, -t.y)) {
        ctx.save(); ctx.translate(l.x, l.y); ctx.scale(1 / k, 1 / k);
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
        for (const q of l.lines) {
          const nm = q.c === 'mn';
          ctx.font = nm ? `600 ${MARK_TYPE.name}px Georgia, serif` : `italic ${MARK_TYPE.note}px Georgia, serif`;
          if ('letterSpacing' in ctx) ctx.letterSpacing = nm ? '1.7px' : '0px';
          ctx.globalAlpha = 0.9; ctx.lineWidth = 3.2; ctx.strokeStyle = C.bg; ctx.strokeText(q.t, 0, q.y);
          ctx.globalAlpha = 1; ctx.fillStyle = nm ? C.mark : C.fg; ctx.fillText(q.t, 0, q.y);
        }
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
        ctx.restore();
      }

      // hover: the point's own lines, at any level, and a soft halo
      if (hov >= 0) {
        const d = F.points[hov], r = d.rb * rk;
        const mine = (edgesOf.get(hov) || []).filter(j => visible(F.points[F.edges[j][0]]) && visible(F.points[F.edges[j][1]]));
        if (L.cites && mine.length) {
          strokeLines(mine, C.bg, 0.8, 3.2);
          strokeLines(mine, C.accent, 0.9, 1.5);
          ctx.globalAlpha = 0.9; ctx.fillStyle = C.accent;
          ctx.beginPath();
          for (const j of mine) { const o = F.points[F.edges[j][0] === hov ? F.edges[j][1] : F.edges[j][0]]; const ro = Math.max(1.6 / k, o.rb * rk * 0.7); ctx.moveTo(o.px + ro, o.py); ctx.arc(o.px, o.py, ro, 0, TAU); }
          ctx.fill();
        }
        const R = r + 14 / k;
        const gr = ctx.createRadialGradient(d.px, d.py, r * 0.6, d.px, d.py, R);
        gr.addColorStop(0, C.accent); gr.addColorStop(1, clear(C.accent));
        ctx.globalAlpha = 0.28; ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(d.px, d.py, R, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1; ctx.fillStyle = fillOf(d); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.6 / k;
        ctx.beginPath(); ctx.arc(d.px, d.py, r * 1.15, 0, TAU); ctx.fill(); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // ---------------------------------------------------------------- SVG counter-scaling (labels): only when k changes
    const styleSvg = () => {
      gLabels.attr('display', L.regions ? null : 'none');
      label.attr('transform', c => `translate(${c.px},${c.py + (c.dy || 0) / k}) scale(${1 / k})`)
        .style('opacity', c => c.path.includes('.') ? clamp01((k - 1.6) / 1.2) : clamp01((3.4 - k) / 1.2))
        .style('pointer-events', c => (c.path.includes('.') ? k >= 1.9 : k <= 3.2) ? null : 'none');
    };

    // one frame does everything the zoom asked for since the last one
    let raf = 0, styledK = NaN;
    function frame() {
      raf = 0;
      if (stale(g) || !canvas.isConnected) return;
      view.attr('transform', t);
      if (k !== styledK) { styledK = k; styleSvg(); }
      draw();
    }
    function requestDraw() { if (!raf) raf = requestAnimationFrame(frame); }
    // state changes (color, filter, layers, search): rebuild the draw lists, then one frame
    const restyle = () => { rebucket(); buildConnectors(); styledK = NaN; requestDraw(); };

    // ---------------------------------------------------------------- zoom + navigation
    let busy = false;   // mid-gesture: no hover hit-testing, no tooltip
    const zoom = d3.zoom().scaleExtent([0.6, 14])
      .on('start', () => { busy = true; if (hov >= 0) { hov = -1; svg.style('cursor', null); } tipOff(); })
      .on('zoom', ev => { t = ev.transform; k = t.k; requestDraw(); })
      .on('end', () => { busy = false; requestDraw(); });
    svg.call(zoom).on('dblclick.zoom', null);
    svg.on('dblclick', () => svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity));
    function zoomToPoints(pts, maxK = 6) {
      const [x0, x1] = d3.extent(pts, d => d.px), [y0, y1] = d3.extent(pts, d => d.py);
      const dx = Math.max(40, x1 - x0 + 60), dy = Math.max(40, y1 - y0 + 60);
      const kk = Math.min(maxK, 0.9 / Math.max(dx / W, dy / H));
      svg.transition().duration(650).ease(d3.easeCubicInOut).call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(kk).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
    }
    function zoomToCluster(c) {
      const members = F.points.filter(p => p.c === c.path || parentOf(p.c) === c.path);
      const dist = members.map(p => Math.hypot(p.px - c.px, p.py - c.py)), cut = (d3.median(dist) || 0) * 2.5;
      const core = members.filter((p, i) => dist[i] <= cut);
      if (core.length) zoomToPoints(core, c.path.includes('.') ? 7 : 3.2);
    }
    function flash(d) {
      gFx.append('circle').attr('cx', d.px).attr('cy', d.py).attr('r', 4 / k).attr('fill', 'none').attr('stroke', 'var(--accent)').attr('stroke-width', 2 / k)
        .transition().duration(1100).attr('r', 40 / Math.sqrt(k)).style('opacity', 0).remove();
    }

    // ---------------------------------------------------------------- hover + click: the point under the cursor, by quadtree
    const pick = ev => {
      const [mx, my] = d3.pointer(ev, svg.node());
      const px = (mx - t.x) / k, py = (my - t.y) / k;
      const reach = (Math.max(6, 8 * Math.pow(k, 0.45)) + 3) / k;   // the biggest point's screen radius, plus a little
      const d = qt.find(px, py, reach);
      return d && Math.hypot(d.px - px, d.py - py) <= (Math.max(4, d.rb * Math.pow(k, 0.45)) + 3) / k ? d : null;
    };
    const onLabel = ev => ev.target instanceof Element && ev.target.closest('.flabel');
    svg.on('mousemove.hover', ev => {
      if (busy) return;
      const d = onLabel(ev) ? null : pick(ev);
      const i = d ? d.i : -1;
      if (i !== hov) { hov = i; svg.style('cursor', d ? 'pointer' : null); requestDraw(); }
      if (d) tip(ev, pointTip(d));
      else tipOff();
    });
    svg.on('mouseleave.hover', () => { if (hov >= 0) { hov = -1; requestDraw(); } tipOff(); });
    svg.on('click.pick', ev => {
      if (onLabel(ev)) return;
      const d = pick(ev);
      if (!d) return;
      ev.stopPropagation(); tipOff(); openItem(d);
    });

    return {
      restyle, theme: requestDraw, pulse: requestDraw,
      hits: pts => { restyle(); if (pts.length) zoomToPoints(pts); },
      scene: d => { zoomToPoints([d], 5); flash(d); },
      region: c => zoomToCluster(c),
      start: hasQ => {
        const pv = MARK.pendingView;   // a mark's "go there" from another mode: its zoom
        if (pv && pv.mode === 'plane' && pv.t) { MARK.pendingView = null; svg.call(zoom.transform, d3.zoomIdentity.translate(pv.t.x, pv.t.y).scale(pv.t.k)); return; }
        if (!hasQ && fieldState.focus && byPath.get(fieldState.focus)) { zoomToCluster(byPath.get(fieldState.focus)); fieldState.focus = ''; }
      },
      // marks: every visible point is drawn here, so every one can be lassoed
      drawn: () => { const out = []; for (const d of F.points) if (visible(d)) out.push({ i: d.i, x: d.px * k + t.x, y: d.py * k + t.y }); return out; },
      view: () => ({ mode: 'plane', hash: '#/field', t: { x: +t.x.toFixed(2), y: +t.y.toFixed(2), k: +k.toFixed(4) } }),
      go: v => { if (v.t) svg.transition().duration(650).ease(d3.easeCubicInOut).call(zoom.transform, d3.zoomIdentity.translate(v.t.x, v.t.y).scale(v.t.k)); },
      fit: idx => { const pts = idx.map(i => F.points[i]).filter(visible); if (pts.length) zoomToPoints(pts, 8); },
      marks: requestDraw,
    };
  }

  // ================================================================ BLOBS
  function fieldBlobs() {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const DUR = reduce ? 0 : 620, FADE = reduce ? 0 : 280;
    const W = Math.max(600, wrap.clientWidth), H = Math.max(520, Math.min(860, innerHeight - wrap.getBoundingClientRect().top - 56));
    const svg = d3.select('#fsvg').attr('width', W).attr('height', H).attr('viewBox', [0, 0, W, H]).classed('fblobs', true);
    const defs = svg.append('defs');
    // glows in the pulse color: around a circle (opaque at its edge, gone by 1.32 r) and around a dot
    const grad = (id, stops) => defs.append('radialGradient').attr('id', id).selectAll('stop').data(stops).join('stop')
      .attr('offset', s => s[0]).style('stop-color', 'var(--pulse, var(--accent))').style('stop-opacity', s => s[1]);
    grad('bglow', [[0, 0.9], [0.8, 0.7], [0.9, 0.25], [1, 0]]);
    grad('bdglow', [[0, 0.85], [0.35, 0.55], [1, 0]]);
    const bg = svg.append('rect').attr('class', 'bbg').attr('width', W).attr('height', H).attr('fill', 'transparent');
    const gScenes = svg.append('g');
    // marks over the scenes: at the bottom round their dots, above it round the circles that hold their members
    const gMarks = svg.append('g').attr('class', 'fmarks'), gMB = gMarks.append('g'), gML = gMarks.append('g');
    markDefs(defs);
    let marksRaf = 0;
    function marksSoon() {
      if (marksRaf) return;
      marksRaf = requestAnimationFrame(() => {
        marksRaf = 0;
        if (stale(g) || !svg.node().isConnected) return;
        if (animating || !cur) { gMarks.attr('display', 'none'); setTimeout(marksSoon, 120); return; }   // a move between levels: after it lands
        gMarks.attr('display', null);
        const bottom = cur.kind === 'items' && cur.gUnder;
        if (bottom) gMB.selectAll('*').remove();
        const ringN = new Map();
        drawMarkSvg(bottom ? cur.gUnder : gMB, gML, m => {
          const out = [], seen = new Set();
          if (cur.kind === 'items') { for (const i of markIdx(m)) { const d = cur.lay.byI.get(i); if (d) out.push([d.x, d.y, d.dr + 9]); } return out; }
          const at = new Map(cur.lay.nodes.map(d => [d.path, d]));
          for (const i of markIdx(m)) {
            const p = F.points[i];
            if (!visible(p)) continue;
            const path = cur.path ? (parentOf(p.c) === cur.path ? p.c : null) : parentOf(p.c), d = path && at.get(path);
            if (!d || seen.has(path)) continue;
            seen.add(path); const k = ringN.get(path) || 0; ringN.set(path, k + 1); out.push([d.x, d.y, d.r * d.s + 6 + 5 * k]); out.ring = true;
          }
          return out;
        }, 1, marksSoon, 0, cur.kind === 'items' ? [] : cur.lay.nodes.filter(d => d.r >= 15).map(d => ({ x: d.x, y: d.y - 26, w: Math.min(d.r * 1.72, 190), h: 52 })), { bubble: cur.kind === 'items' });   // a click inside a bubble opens its card, never backs out
      });
    }
    const GAP = 40;                    // the least room between two circles, so every ribbon has some length to show
    const PREV = 0.84;                   // a circle's preview fills this share of its radius
    const parentPath = path => path.includes('.') ? path.slice(0, path.indexOf('.')) : '';
    const hashFor = path => path ? '#/field?c=' + path : '#/field';
    const above = (a, b) => a === '' ? b !== '' : b.startsWith(a + '.');   // a is a strict ancestor of b

    // members of every cluster (a region holds its sub-regions' items), filtered for the hidden blygs on demand
    const members = new Map();
    for (const d of F.points) for (const c of new Set([d.c, parentOf(d.c)])) { if (!members.has(c)) members.set(c, []); members.get(c).push(d); }
    const vis = path => (members.get(path) || []).filter(visible);

    // A level: '' (the regions), a region with sub-regions (its sub-regions), or a leaf (its items).
    const levelFor = path => {
      const c = path ? byPath.get(path) : null;
      if (!c) return { path: '', kind: 'blobs' };
      return { path, kind: c.children.length ? 'blobs' : 'items', c };
    };

    // ---------------------------------------------------------------- layouts, settled once per level and blyg filter
    // A level's layout is computed deterministically (UMAP centroids as the start, then 320 ticks of the same forces
    // the live view runs), cached, and mutated by the live wander while you're on it — so the miniature a circle shows
    // of its insides, and the place you come back out to, are where things last were.
    const LAY = new Map();
    const hidKey = () => [...fieldState.hidden].sort().join('|');
    const layoutFor = lv => {
      const key = hidKey(), old = LAY.get(lv.path);
      if (old && old.key === key) return old;
      const lay = lv.kind === 'blobs' ? layoutBlobs(lv, old) : layoutItems(lv);
      lay.key = key; LAY.set(lv.path, lay);
      return lay;
    };
    const clampIn = lay => { for (const d of lay.nodes) { d.x = Math.max(lay.M + d.r, Math.min(W - lay.M - d.r, d.x)); d.y = Math.max(lay.M + d.r, Math.min(H - lay.M - d.r, d.y)); } };
    function forces(sim, lay) {
      const maxN = d3.max(lay.links, l => l.n) || 1;
      sim.velocityDecay(0.42)
        .force('x', d3.forceX(W / 2).strength(0.02))
        .force('y', d3.forceY(H / 2).strength(0.05))
        .force('collide', d3.forceCollide(d => d.r + GAP / 2).strength(0.9).iterations(2))
        .force('link', d3.forceLink(lay.links).id(d => d.path).distance(l => l.source.r + l.target.r + GAP + 10).strength(l => 0.015 + 0.5 * Math.pow(l.n / maxN, 0.75)))
        .force('frame', () => {   // keep the group's bounding box, not just its mean, in the middle of the field
          const nodes = lay.nodes;
          const x0 = d3.min(nodes, d => d.x - d.r), x1 = d3.max(nodes, d => d.x + d.r), y0 = d3.min(nodes, d => d.y - d.r), y1 = d3.max(nodes, d => d.y + d.r);
          const dx = (W / 2 - (x0 + x1) / 2) * 0.08, dy = (H / 2 - (y0 + y1) / 2) * 0.08;
          for (const d of nodes) { d.x += dx; d.y += dy; }
        });
    }
    function layoutBlobs(lv, old) {
      const M = lv.path ? 44 : 14;      // inside a region, room at the edge for the stubs to elsewhere
      const kids = lv.path ? lv.c.children.map(p => byPath.get(p)) : topLevel;
      const nodes = kids.map(c => ({ c, path: c.path, n: vis(c.path).length, s: 1, theta: 0 })).filter(d => d.n > 0);
      if (!nodes.length) return { kind: 'blobs', nodes, links: [], M };
      // area ∝ items; the circles cover about a third of the field, the rest is room for the ribbons
      const area = (nodes.length > 8 ? 0.31 : 0.28) * (W - 2 * M) * (H - 2 * M);
      let kk = Math.sqrt(area / (Math.PI * d3.sum(nodes, d => d.n)));
      kk = Math.min(kk, 0.3 * Math.min(W, H) / Math.sqrt(d3.max(nodes, d => d.n)));
      for (const d of nodes) d.r = kk * Math.sqrt(d.n);
      // start: where the hidden-blyg change left them, else the UMAP centroids spread over the field
      const prev = old ? new Map(old.nodes.map(d => [d.path, d])) : new Map();
      const [x0, x1] = d3.extent(nodes, d => d.c.cx), [y0, y1] = d3.extent(nodes, d => d.c.cy);
      for (const d of nodes) {
        const o = prev.get(d.path);
        if (o) { d.x = o.x; d.y = o.y; continue; }
        d.x = W / 2 + ((d.c.cx - (x0 + x1) / 2) / ((x1 - x0) || 1)) * (W - 2 * M) * 0.6;
        d.y = H / 2 - ((d.c.cy - (y0 + y1) / 2) / ((y1 - y0) || 1)) * (H - 2 * M) * 0.6;
      }
      // connectors: region pairs at the top, pairs of this region's sub-regions inside it
      const here = new Set(nodes.map(d => d.path));
      const list = lv.path ? BUND.sub.filter(b => b.a !== b.b && here.has(b.a) && here.has(b.b)) : BUND.top.filter(b => here.has(b.a) && here.has(b.b));
      const links = list.map((b, i) => ({ source: b.a, target: b.b, a: b.a, b: b.b, n: b.n, by: b.by, tr: (b.by[ACC] || 0) / b.n > 0.5, bend: i % 2 ? 1 : -1 }));
      const lay = { kind: 'blobs', nodes, links, M };
      const sim = d3.forceSimulation(nodes).stop();
      forces(sim, lay);
      for (let i = 0; i < (old ? 160 : 320); i++) { sim.tick(); clampIn(lay); }
      for (const d of nodes) { d.vx = d.vy = 0; }
      // citations leaving the region, per sub-region, by the region they go to (context for the stubs)
      if (lv.path) for (const d of nodes) {
        d.out = new Map();
        for (const b of BUND.sub) {
          const mine = b.a === d.path ? b.b : b.b === d.path ? b.a : null;
          if (mine === null || parentOf(mine) === lv.path) continue;
          const r = parentOf(mine); d.out.set(r, (d.out.get(r) || 0) + b.n);
        }
        d.outN = d3.sum(d.out.values());
      }
      return lay;
    }
    function layoutItems(lv) {
      const R0 = Math.min(W, H) / 2 - 18, cx = W / 2, cy = H / 2;
      const pts = vis(lv.path);
      const lay = { kind: 'items', dots: [], R0, cx, cy, byI: new Map() };
      if (!pts.length) return lay;
      // the items at their UMAP positions around the median, every direction kept and the distance eased into the
      // circle (1 − e^(−0.8·d/median): the median item lands about halfway out, the stragglers bunch toward the rim
      // instead of shrinking the core to a speck); then a few ticks of collision so overlapping dots can be told apart
      const mx = d3.median(pts, p => p.x), my = d3.median(pts, p => p.y);
      const med = d3.median(pts, p => Math.hypot(p.x - mx, p.y - my)) || 1, lim = 0.93 * R0;
      const base = Math.max(3, Math.min(7, 0.2 * R0 / Math.sqrt(pts.length)));
      lay.dots = pts.map(p => {
        const dx = p.x - mx, dy = -(p.y - my), m = Math.hypot(dx, dy) || 1e-9, rr = lim * (1 - Math.exp(-0.8 * m / med));
        const hx = dx / m * rr, hy = dy / m * rr;
        return { p, i: p.i, hx: cx + hx, hy: cy + hy, x: cx + hx, y: cy + hy, dr: Math.min(base * 2, base + 1.5 * Math.sqrt(p.cites_in)) };
      });
      const sim = d3.forceSimulation(lay.dots).stop().velocityDecay(0.5)
        .force('x', d3.forceX(d => d.hx).strength(0.3)).force('y', d3.forceY(d => d.hy).strength(0.3))
        .force('collide', d3.forceCollide(d => d.dr + 1.2).iterations(2));
      for (let i = 0; i < 140; i++) {
        sim.tick();
        for (const d of lay.dots) { const dx = d.x - cx, dy = d.y - cy, m = Math.hypot(dx, dy), mx2 = R0 - d.dr - 3; if (m > mx2) { d.x = cx + dx * mx2 / m; d.y = cy + dy * mx2 / m; } }
      }
      lay.byI = new Map(lay.dots.map(d => [d.i, d]));
      return lay;
    }

    // ---------------------------------------------------------------- drawing a level
    let cur = null, animating = false, pendingFlash = null;

    // a circle's label: the region's distinguishing words (as many as fit), its count, and the central item where there's room
    function labelBlob(sel, d) {
      const t = sel.append('text').attr('class', 'blab').attr('text-anchor', 'middle');
      if (d.r < 15) return;
      const fs = Math.max(11, Math.min(17.5, d.r / 4.4)), width = d.r * 1.72;
      const words = d.c.name.length ? d.c.name : (d.c.rep || '').split(/\s+/).filter(Boolean).slice(0, 3);
      let name = words[0] || d.path;
      for (let n = Math.min(3, words.length); n >= 1; n--) { const s = words.slice(0, n).join(' · '); if (s.length * 0.55 * fs <= width) { name = s; break; } }
      const size = Math.max(9.5, Math.min(fs, width / (name.length * 0.55))), nch = Math.floor(width / (size * 0.55));
      const lines = [{ cls: 'bn', text: name.length <= nch ? name : name.slice(0, nch - 1) + '…', size }];
      const hitTxt = HITS && d.hits ? ` · ${d.hits} hit${d.hits === 1 ? '' : 's'}` : '';
      lines.push({ cls: 'bc', text: `∙ ${d.n}${hitTxt} ∙`, size: Math.max(9, Math.min(12, size * 0.72)) });
      if (d.c.name.length && d.r > 62 && d.c.rep) {
        const rs = Math.max(10, Math.min(12, d.r / 7.5)), rn = Math.floor(d.r * 1.5 / (rs * 0.5));
        lines.push({ cls: 'br', text: d.c.rep.length <= rn ? d.c.rep : d.c.rep.slice(0, rn - 1).trim() + '…', size: rs });
      }
      const hs = lines.map(l => l.size * 1.22), tot = d3.sum(hs);
      let yy = -tot / 2;
      lines.forEach((l, i) => { yy += hs[i]; t.append('tspan').attr('class', l.cls).attr('x', 0).attr('y', yy - hs[i] * 0.25).attr('font-size', l.size).text(l.text); });
    }
    // the rim: what the color control says about the items inside
    function rimBlob(sel, d, pts) {
      const arc = d3.arc().innerRadius(d.r - 3.2).outerRadius(d.r);
      const g2 = sel.append('g').attr('class', 'brim');
      if (fieldState.color === 'meaning') {
        const col = meaningTint(pts.map(p => p.i));
        if (col) g2.append('path').attr('d', arc({ startAngle: 0, endAngle: TAU })).attr('fill', col);
      } else if (fieldState.color === 'origin') {
        const counts = d3.rollups(pts, v => v.length, p => p.origin).sort((a, b) => (originRank.get(a[0]) ?? 99) - (originRank.get(b[0]) ?? 99));
        g2.selectAll('path').data(d3.pie().sort(null).value(e => e[1])(counts)).join('path').attr('d', arc).attr('fill', a => originColor(a.data[0]));
      } else if (fieldState.color === 'age') {
        g2.append('path').attr('d', arc({ startAngle: 0, endAngle: TAU })).attr('fill', ageRamp(d3.median(pts, ageT) || 0));
      } else {
        const share = pts.filter(p => p.reads).length / (pts.length || 1);
        if (share > 0) g2.append('path').attr('d', arc({ startAngle: 0, endAngle: TAU * share })).attr('fill', 'var(--read)');
      }
    }
    // the faint miniature of a circle's insides: the next level's own layout, scaled into it (the zoom lands on it)
    function previewBlob(sel, d) {
      const lay = layoutFor(levelFor(d.path));
      const gp = sel.append('g').attr('class', 'bprev');
      if (lay.kind === 'blobs') {
        if (!lay.nodes.length) return;
        const E = d3.packEnclose(lay.nodes.map(({ x, y, r }) => ({ x, y, r })));
        const s = PREV * d.r / E.r;
        d.prev = { x: E.x, y: E.y, s };
        gp.selectAll('circle').data(lay.nodes).join('circle').attr('cx', n => (n.x - E.x) * s).attr('cy', n => (n.y - E.y) * s).attr('r', n => n.r * s);
      } else {
        const s = d.r / lay.R0;
        d.prev = { x: lay.cx, y: lay.cy, s };
        gp.selectAll('circle').data(lay.dots).join('circle').attr('class', 'dot').attr('cx', n => (n.x - lay.cx) * s).attr('cy', n => (n.y - lay.cy) * s).attr('r', n => Math.max(0.7, n.dr * s)).style('fill', n => fillOf(n.p));
      }
    }

    function ribGeom(l) {
      const A = l.source, B = l.target, ra = A.r * A.s, rb = B.r * B.s;
      const dx = B.x - A.x, dy = B.y - A.y, D = Math.hypot(dx, dy) || 1, ux = dx / D, uy = dy / D, len = D - ra - rb;
      if (len < 3) return null;
      const sx = A.x + ux * ra, sy = A.y + uy * ra, ex = B.x - ux * rb, ey = B.y - uy * rb;
      const bend = l.bend * Math.min(22, len * 0.16), cx = (sx + ex) / 2 - uy * bend, cy = (sy + ey) / 2 + ux * bend;
      return { d: `M${sx.toFixed(1)},${sy.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`, mx: 0.25 * sx + 0.5 * cx + 0.25 * ex, my: 0.25 * sy + 0.5 * cy + 0.25 * ey, len };
    }

    function buildBlobs(st) {
      const { lay, scene } = st, nodes = lay.nodes;
      if (!nodes.length) { scene.append('text').attr('class', 'bempty').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text(`nothing visible here — every ${FW.origin} in it is hidden`); return; }
      const top = !st.path;
      for (const d of nodes) {
        d.pts = vis(d.path);
        d.heat = L.pulse && PULSE ? d3.sum(d.pts, p => HEAT.get(p.i) || 0) : 0;
        d.hits = HITS ? d.pts.filter(p => HITS.has(p.i)).length : 0;
      }
      const maxHeat = d3.max(nodes, d => d.heat) || 0, maxHits = d3.max(nodes, d => d.hits) || 0;
      const maxN = d3.max(lay.links, l => l.n) || 1;
      // A busy level keeps its thin connectors, and those that would run behind a third circle, for hover: at rest
      // the field shows the strong ties between neighbours, which is what the layout pulled together.
      const quietN = lay.links.length > 14 ? Math.max(2, 0.18 * maxN) : 1;
      const behind = l => nodes.some(o => {
        if (o === l.source || o === l.target) return false;
        const ax = l.source.x, ay = l.source.y, bx = l.target.x - ax, by = l.target.y - ay, t = Math.max(0, Math.min(1, ((o.x - ax) * bx + (o.y - ay) * by) / (bx * bx + by * by || 1)));
        return Math.hypot(ax + bx * t - o.x, ay + by * t - o.y) < o.r * 0.9;
      });
      for (const l of lay.links) {
        l.w = 1.4 + 2.3 * Math.log1p(l.n);
        l.alpha = 0.2 + 0.32 * Math.log1p(l.n) / Math.log1p(maxN);
        l.quiet = l.n < quietN || (lay.links.length > 8 && l.n < 0.5 * maxN && behind(l));
      }
      const gR = scene.append('g').attr('class', 'bribs').attr('display', L.cites ? null : 'none');
      const gS = scene.append('g').attr('class', 'bstubs').attr('display', L.cites ? null : 'none');
      const gB = scene.append('g').attr('class', 'bnodes');
      const gRL = scene.append('g').attr('class', 'bribl').attr('display', L.cites ? null : 'none');
      const rib = gR.selectAll('path').data(lay.links).join('path').attr('class', l => 'brib' + (l.tr ? ' tr' : '') + (l.quiet ? ' quiet' : ''))
        .attr('stroke-width', l => l.w).style('opacity', l => l.quiet ? null : l.alpha * (HITS && !(l.source.hits && l.target.hits) ? 0.35 : 1))
        .on('mousemove', (ev, l) => tip(ev, `<b>${esc(nameOf(l.source.c, 3))} ↔ ${esc(nameOf(l.target.c, 3))}</b><div class="small">${l.n} ${l.n === 1 ? FW.edge : FW.edges} between them · ${byTypes(l.by)}</div>`))
        .on('mouseleave', tipOff);
      const ribl = gRL.selectAll('text').data(lay.links).join('text').attr('class', l => l.quiet ? 'quiet' : '').text(l => l.n);
      // stubs: one per sub-region, toward where its citations to other regions go on the top-level map
      let stubs = null;
      if (!top) {
        const topLay = layoutFor(levelFor('')), at = new Map(topLay.nodes.map(d => [d.path, d])), here = at.get(st.path);
        for (const d of nodes) {
          let vx = 0, vy = 0;
          if (here) for (const [r, n] of d.out || []) { const o = at.get(r); if (!o) continue; const dx = o.x - here.x, dy = o.y - here.y, m = Math.hypot(dx, dy) || 1; vx += n * dx / m; vy += n * dy / m; }
          if (Math.hypot(vx, vy) < 1e-6) { vx = d.x - W / 2; vy = d.y - H / 2; }
          const m = Math.hypot(vx, vy) || 1; d.su = [vx / m, vy / m];
        }
        const out = nodes.filter(d => d.outN > 0);
        stubs = gS.selectAll('g').data(out).join('g');
        stubs.append('path').attr('class', 'bstub').attr('stroke-width', d => 1 + 0.6 * Math.log1p(d.outN));
        stubs.append('text').attr('class', 'bstubl').text(d => d.outN + ' out');
      }
      const node = gB.selectAll('g.bnode').data(nodes, d => d.path).join('g').attr('class', 'bnode')
        .attr('tabindex', 0).attr('role', 'button').attr('aria-label', d => `${nameOf(d.c, 4)}, ${d.n} items`)
        .style('opacity', d => HITS && !d.hits ? 0.32 : null);
      node.each(function (d) {
        const s = d3.select(this);
        const hi = maxHeat ? d.heat / maxHeat : 0;
        if (hi > 0.06) s.append('circle').attr('class', 'bhalo').attr('r', d.r * 1.22).attr('fill', 'url(#bglow)').style('opacity', 0.08 + 0.5 * Math.pow(hi, 1.3));
        s.append('circle').attr('class', 'bbody').attr('r', d.r).style('fill', fieldState.color === 'meaning' && d.pts ? meaningTint(d.pts.map(p => p.i), null, true) : null);
        if (d.heat > 0) s.append('circle').attr('class', 'btint').attr('r', d.r).style('opacity', 0.1 * hi);
        previewBlob(s, d);
        rimBlob(s, d, d.pts);
        if (HITS && d.hits) s.append('circle').attr('class', 'bhitring').attr('r', d.r + 3).attr('stroke-width', 1.5 + 3.5 * d.hits / maxHits);
        labelBlob(s, d);
      });
      const blobTip = d => {
        const conn = lay.links.filter(l => l.source === d || l.target === d).sort((a, b) => b.n - a.n);
        const within = (BUND.within || {})[d.path] || 0;
        const blygs = d3.rollups(d.pts, v => v.length, p => p.origin).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, n]) => `${esc(short(o).replace(/\/blyg$/, ''))} ${n}`).join(' · ');
        const lv2 = levelFor(d.path);
        return `<b>${esc(nameOf(d.c, 4))}</b><div class="small muted">${esc((d.c.rep || '').slice(0, 90))}</div>
          <div class="small">${d.n} items${within ? ` · ${within} ${FW.edges} inside` : ''} · ${blygs}</div>
          ${d.heat > 0 ? `<div class="small accent">pulse ${d.heat.toFixed(2)} · ${Math.round(100 * d.heat / (d3.sum(HEAT.values()) || 1))}% of the window</div>` : ''}
          ${HITS ? `<div class="small accent">${d.hits} of the search's ${HITS.size} hits</div>` : ''}
          ${conn.length ? `<div class="small">${conn.slice(0, 5).map(l => `${esc(nameOf((l.source === d ? l.target : l.source).c, 2))} <b>${l.n}</b>`).join(' · ')}${conn.length > 5 ? ` · +${conn.length - 5}` : ''}</div>` : ''}
          ${d.outN ? `<div class="small muted">${d.outN} to other regions: ${[...d.out].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r, n]) => `${esc(nameOf(byPath.get(r), 2))} ${n}`).join(' · ')}</div>` : ''}
          <div class="small muted">click to go in — ${lv2.kind === 'items' ? 'the items' : lv2.c.children.length + ' sub-regions'}</div>`;
      };
      const light = d => {
        gR.classed('hov', !!d); gRL.classed('hov', !!d);
        rib.classed('on', l => d && (l.source === d || l.target === d));
        ribl.classed('on', l => d && (l.source === d || l.target === d));
      };
      node.on('mouseenter', (ev, d) => light(d)).on('mousemove', (ev, d) => tip(ev, blobTip(d))).on('mouseleave', () => { light(null); tipOff(); })
        .on('click', (ev, d) => { ev.stopPropagation(); tipOff(); if (!animating) location.hash = hashFor(d.path); })
        .on('keydown', (ev, d) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); location.hash = hashFor(d.path); } });

      st.tick = () => {
        node.attr('transform', d => `translate(${d.x.toFixed(1)},${d.y.toFixed(1)})${d.s !== 1 ? ` scale(${d.s})` : ''}`);
        marksSoon();
        if (!L.cites) return;
        rib.each(function (l) { const gm = ribGeom(l); l.gm = gm; this.setAttribute('d', gm ? gm.d : ''); });
        // a count where there's room: not over a circle, not on top of a heavier ribbon's count
        const placed = [];
        ribl.each(function (l) {
          const gm = l.gm;
          const ok = gm && gm.len >= 22 && !nodes.some(o => Math.hypot(gm.mx - o.x, gm.my - o.y) < o.r * o.s + 6) && !placed.some(q => Math.abs(q[0] - gm.mx) < 18 && Math.abs(q[1] - gm.my) < 13);
          if (!ok) { this.setAttribute('visibility', 'hidden'); return; }
          if (!l.quiet) placed.push([gm.mx, gm.my]);
          this.removeAttribute('visibility'); this.setAttribute('x', gm.mx.toFixed(1)); this.setAttribute('y', (gm.my + 3.5).toFixed(1));
        });
        if (stubs) stubs.each(function (d) {
          const [ux, uy] = d.su, r = d.r * d.s, L0 = 14 + 7 * Math.log1p(d.outN);
          const x0 = d.x + ux * (r + 4), y0 = d.y + uy * (r + 4), x1 = d.x + ux * (r + 4 + L0), y1 = d.y + uy * (r + 4 + L0);
          this.firstChild.setAttribute('d', `M${x0.toFixed(1)},${y0.toFixed(1)}L${x1.toFixed(1)},${y1.toFixed(1)}`);
          this.lastChild.setAttribute('x', (x1 + ux * 12).toFixed(1)); this.lastChild.setAttribute('y', (y1 + uy * 10 + 3.5).toFixed(1));
        });
      };
      st.tick();
      // the live field: the settled forces, kept slightly warm, plus a slow random walk per circle so it breathes
      for (const d of nodes) d.theta = Math.random() * TAU;
      const sim = d3.forceSimulation(nodes).alpha(reduce ? 0 : 0.2).alphaTarget(reduce ? 0 : 0.18);
      forces(sim, lay);
      sim.force('wander', () => { if (reduce) return; for (const d of nodes) { d.theta += (Math.random() - 0.5) * 0.35; d.vx += Math.cos(d.theta) * 0.03; d.vy += Math.sin(d.theta) * 0.03; } })
        .on('tick', () => { if (stale(g) || !scene.node().isConnected) { sim.stop(); return; } clampIn(lay); st.tick(); });
      if (reduce) sim.stop();
      st.sim = sim;
      st.node = node;
    }

    function buildItems(st) {
      const { lay, scene } = st;
      scene.append('circle').attr('class', 'bcont').attr('cx', lay.cx).attr('cy', lay.cy).attr('r', lay.R0);
      st.gUnder = scene.append('g').attr('class', 'fmarks');   // the marks' bubbles, under the lines and the dots
      if (!lay.dots.length) { scene.append('text').attr('class', 'bempty').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text(`nothing visible here — every ${FW.origin} in it is hidden`); return; }
      const byI = lay.byI;
      const lines = [], ext = new Map();
      for (const e of F.edges) {
        const a = byI.get(e[0]), b = byI.get(e[1]);
        if (a && b) lines.push({ a, b, type: e[2] });
        else if ((a || b) && visible(F.points[e[0]]) && visible(F.points[e[1]])) { const k2 = (a || b).i; ext.set(k2, (ext.get(k2) || 0) + 1); }
      }
      const curve = l => { const { a, b } = l, dx = b.x - a.x, dy = b.y - a.y, bend = 0.18; return `M${a.x.toFixed(1)},${a.y.toFixed(1)}Q${((a.x + b.x) / 2 - dy * bend).toFixed(1)},${((a.y + b.y) / 2 + dx * bend).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`; };
      // pulse glows under everything
      if (L.pulse && PULSE) {
        const hot = lay.dots.filter(d => HEAT.has(d.i));
        scene.append('g').attr('class', 'bglows').selectAll('circle').data(hot).join('circle').attr('cx', d => d.x).attr('cy', d => d.y)
          .attr('r', d => d.dr + 5 + 16 * Math.sqrt(HEAT.get(d.i) / PULSE.max)).attr('fill', 'url(#bdglow)').style('opacity', 0.6);
      }
      const gl = scene.append('g').attr('class', 'blines' + (HITS ? ' dim' : '')).attr('display', L.cites ? null : 'none');
      const line = gl.selectAll('path').data(lines).join('path').attr('class', l => 'bline' + (l.type === ACC ? ' tr' : '')).attr('d', curve);
      const gd = scene.append('g').attr('class', 'bdots');
      const dot = gd.selectAll('circle').data(lay.dots, d => d.i).join('circle')
        .attr('class', d => 'bdot' + (d.p.reads ? ' read' : '') + (HITS && HITS.has(d.i) ? ' hit' : '') + (readerIsOpen(d.p) ? ' fopen' : ''))
        .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', d => d.dr).attr('fill', d => fillOf(d.p))
        .style('opacity', d => HITS && !HITS.has(d.i) ? 0.22 : null);
      dot.filter(d => HITS && HITS.has(d.i)).raise();
      const mine = d => l => l.a === d || l.b === d;
      dot.on('mouseenter', (ev, d) => { gl.classed('hov', true); line.classed('on', mine(d)).filter(mine(d)).raise(); d3.select(ev.currentTarget).classed('hov', true); })
        .on('mousemove', (ev, d) => tip(ev, pointTip(d.p) + (ext.get(d.i) ? `<div class="small muted">${ext.get(d.i)} ${ext.get(d.i) === 1 ? FW.edge : FW.edges} to items elsewhere</div>` : '')))
        .on('mouseleave', ev => { gl.classed('hov', false); line.classed('on', false); d3.select(ev.currentTarget).classed('hov', false); tipOff(); })
        .on('click', (ev, d) => { ev.stopPropagation(); tipOff(); openItem(d.p); });
      st.dot = dot;
      st.extN = d3.sum(ext.values());
      st.lineN = lines.length;
      st.tick = () => {};
    }

    function flashAt(i) {
      if (!cur || cur.kind !== 'items') return;
      const d = cur.lay.byI.get(i);
      if (!d) return;
      cur.scene.append('circle').attr('cx', d.x).attr('cy', d.y).attr('r', d.dr).attr('fill', 'none').attr('stroke', 'var(--accent)').attr('stroke-width', 2.2)
        .transition().duration(reduce ? 0 : 1300).attr('r', d.dr + 44).style('opacity', 0).remove();
    }

    function crumbs(st) {
      const el = main.querySelector('#fcrumb');
      if (!el) return;
      const chain = st.path ? [parentOf(st.path), st.path].filter((v, i, a) => a.indexOf(v) === i) : [];
      const link = (p2, label) => `<a href="${hashFor(p2)}">${esc(label)}</a>`;
      const parts = [chain.length ? link('', 'all regions') : '<span class="cur">all regions</span>']
        .concat(chain.map((p2, i) => i === chain.length - 1 ? `<span class="cur">${esc(nameOf(byPath.get(p2), 3))}</span>` : link(p2, nameOf(byPath.get(p2), 3))));
      let sum;
      if (st.kind === 'items') sum = `${st.lay.dots.length} items · ${st.lineN || 0} ${st.lineN === 1 ? FW.edge : FW.edges} among them${st.extN ? ` · ${st.extN} to elsewhere` : ''}`;
      else {
        const n = st.lay.nodes.length, cites = d3.sum(st.lay.links, l => l.n), out = d3.sum(st.lay.nodes, d => d.outN || 0);
        sum = `${n} ${st.path ? 'sub-regions' : 'regions'} · ${st.lay.links.length} connection${st.lay.links.length === 1 ? '' : 's'}, ${cites} ${FW.edges}${st.path ? ` · ${out} leaving` : ''}`;
      }
      el.innerHTML = parts.join('<span class="sep">›</span>') + `<span class="bsum">${sum}</span>`;
    }

    // ---------------------------------------------------------------- moving between levels
    // A zoom is drawn as a smooth zoom (d3.interpolateZoom) between two transforms {k, x, y}: p ↦ k·p + (x, y).
    const zoomInto = d => ({ k: 1 / d.prev.s, x: d.prev.x - d.x / d.prev.s, y: d.prev.y - d.y / d.prev.s });   // d's preview → the next level's layout
    const ID = { k: 1, x: 0, y: 0 };
    const fmtZ = z => `translate(${z.x},${z.y}) scale(${z.k})`;
    function zoomTween(sel, z0, z1, dur) {
      const v = z => [(W / 2 - z.x) / z.k, (H / 2 - z.y) / z.k, W / z.k];
      const i = d3.interpolateZoom(v(z0), v(z1));
      sel.attr('transform', fmtZ(z0));
      return sel.transition().duration(dur).ease(d3.easeCubicInOut)
        .attrTween('transform', () => t => { const [vx, vy, vw] = i(t), k = W / vw; return `translate(${W / 2 - vx * k},${H / 2 - vy * k}) scale(${k})`; });
    }
    function build(path) {
      const lv = levelFor(path), lay = layoutFor(lv);
      const scene = gScenes.append('g').attr('class', 'bscene');
      const st = { path: lv.path, kind: lv.kind, lay, scene, sim: null, tick: () => {} };
      setMeaningScope(lv.path ? (members.get(lv.path) || []).map(p => p.i) : null);
      if (lv.kind === 'blobs') buildBlobs(st); else buildItems(st);
      bg.style('cursor', st.path ? 'zoom-out' : null);
      return st;
    }
    const retire = st => { if (!st) return; st.sim && st.sim.stop(); st.scene.interrupt().transition().duration(FADE).style('opacity', 0).remove(); };
    const land = st => { cur = st; crumbs(st); renderRegions(); marksSoon(); if (pendingFlash !== null) { const i = pendingFlash; pendingFlash = null; setTimeout(() => flashAt(i), 60); } };

    function go(path, how) {
      path = levelFor(path).path;
      if (animating) { gScenes.selectAll('.bscene').interrupt().remove(); cur && cur.sim && cur.sim.stop(); cur = null; animating = false; }
      const old = cur;
      if (old && old.path === path && how !== 'refresh') { if (pendingFlash !== null) { const i = pendingFlash; pendingFlash = null; flashAt(i); } return; }
      tipOff();
      if (!old || how === 'refresh') {   // first paint, or the same level redrawn after a filter / overlay change
        if (old) { old.sim && old.sim.stop(); old.scene.remove(); }
        const st = build(path);
        if (!old) st.scene.style('opacity', 0).transition().duration(FADE).style('opacity', 1);
        land(st);
        return;
      }
      const d = old.kind === 'blobs' && parentPath(path) === old.path ? (old.lay.nodes.find(n => n.path === path) || null) : null;
      if (d && d.prev && !reduce) {
        // drill in: the others fade, the circle's own body and words fade, and the view zooms until its miniature is
        // the next level's layout; the new level then fades in over the miniature, in exactly the same place
        animating = true; old.sim && old.sim.stop();
        old.scene.selectAll('.bribs, .bstubs, .bribl').transition().duration(FADE).style('opacity', 0);
        old.node.filter(n => n !== d).transition().duration(FADE).style('opacity', 0);
        const me = old.node.filter(n => n === d);
        me.selectAll('.blab, .brim, .bhitring').transition().duration(FADE * 0.7).style('opacity', 0);
        me.selectAll('.bbody, .btint, .bhalo').transition().delay(DUR * 0.25).duration(DUR * 0.75).style('opacity', 0);
        me.select('.bprev').transition().duration(DUR).style('opacity', 1);
        zoomTween(old.scene, ID, zoomInto(d), DUR).on('end', () => {
          const st = build(path);
          st.scene.style('opacity', 0).transition().duration(FADE + 80).style('opacity', 1)
            .on('end', () => { old.scene.remove(); animating = false; });
          land(st);
        });
        return;
      }
      // back out (to any ancestor): the old level fades while the new one zooms out from inside the circle we came from
      const st = build(path);
      const from = st.kind === 'blobs' && above(path, old.path) ? st.lay.nodes.find(n => n.path === old.path || above(n.path, old.path)) : null;
      animating = !reduce;
      retire(old);
      if (from && from.prev && !reduce) {
        st.scene.style('opacity', 0).transition('fade').duration(FADE).style('opacity', 1);   // named: the zoom is a second transition on it
        zoomTween(st.scene, zoomInto(from), ID, DUR).on('end', () => { st.scene.attr('transform', null); animating = false; });
      } else {
        st.scene.style('opacity', 0).transition().duration(FADE + 120).style('opacity', 1).on('end', () => { animating = false; });
      }
      land(st);
    }

    bg.on('click', () => { if (cur && cur.path && !animating) location.hash = hashFor(parentPath(cur.path)); });
    const onKey = ev => {
      if (stale(g) || !svg.node().isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (ev.key === 'Escape' && cur && cur.path && !(ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement)) location.hash = hashFor(parentPath(cur.path));
    };
    document.addEventListener('keydown', onKey);
    const onVis = () => { if (stale(g)) { document.removeEventListener('visibilitychange', onVis); return; } if (cur && cur.sim && !reduce) { if (document.hidden) cur.sim.stop(); else cur.sim.restart(); } };
    document.addEventListener('visibilitychange', onVis);
    fieldHashNav = params => {
      if (stale(g) || !svg.node().isConnected || fieldState.mode !== 'blobs') return false;
      if (params.has('q') && params.get('q') !== fieldState.q) return false;
      go(params.get('c') || '');
      return true;
    };

    const refresh = () => { if (cur) go(cur.path, 'refresh'); };
    const navTo = path => { if (cur && levelFor(path).path === cur.path) go(path); else location.hash = hashFor(path); };
    return {
      restyle: refresh, theme: () => {}, pulse: refresh,
      hits: () => refresh(),
      scene: d => { pendingFlash = d.i; navTo(levelFor(d.c).path); },
      region: c => navTo(c.path),
      start: () => { fieldState.focus = ''; go(p.get('c') || ''); },
      current: () => cur ? cur.path : '',
      // marks: only the bottom level draws item dots; above it the lasso says to go in
      drawn: () => cur && cur.kind === 'items' && !animating ? cur.lay.dots.map(d => ({ i: d.i, x: d.x, y: d.y })) : null,
      view: () => ({ mode: 'blobs', hash: hashFor(cur ? cur.path : ''), path: cur ? cur.path : '' }),
      fit: idx => {
        const cs = [...new Set(idx.map(i => F.points[i].c))], tops = [...new Set(cs.map(parentOf))];
        navTo(cs.length === 1 ? cs[0] : tops.length === 1 ? tops[0] : '');
      },
      marks: marksSoon,
    };
  }

  // ================================================================ TOUR
  // The blobs read through a slice of the 4D layout (Ben, Oct 21: "a 2d slice through 4d space … weighted
  // by distance … move it/rotate it through the space", then "couldn't you just do the tour and apply the blob view to
  // separate slices?"). The regions are the 4D clusters, so they are fixed, nameable things that don't flicker; what moves
  // is the plane. Work in the layout's principal frame q = E(p − μ) (PC1 most spread). The plane is spanned by
  //   u = cos a₁·e₁ + sin a₁·e₃,   v = cos a₂·e₂ + sin a₂·e₄
  // (two tilts, each in its own plane, so u, v stay orthonormal), its complement by w₁ = −sin a₁·e₁ + cos a₁·e₃ and
  // w₂ = −sin a₂·e₂ + cos a₂·e₄. A point lands at (q·u, q·v); its depth is its distance from the slab centre along w₁, w₂
  // (the depth sliders, in standard deviations along each), and its weight exp(−depth²/σ²) — or, with a lens, exp(−|q − f|²/σ²)
  // around a focal point f. σ → ∞ weighs everything 1: the plain projection. Per frame, for whatever level is showing:
  // a circle's area is the weight of its members (Σ w, partly compensated so a thin slab doesn't shrink everything to
  // specks), its place the weighted mean of its members' projections, its ribbons Σ wᵢ·wⱼ over the citations between
  // the two; at the bottom the items sit at their projections, faded by weight, not removed. All of it is ~2.7k dot
  // products and 550 edges, recomputed on every control change; the hash carries the view, so a view is a link.
  function fieldTour() {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const DUR = reduce ? 0 : 560, FADE = reduce ? 0 : 260;
    // no pointer tooltips in the tour (Ben, Oct 23: the box following the mouse covers the clusters — "would rather just
    // look at the visuals"); the shared tip() is shadowed here, and the loupe carries the text at the bottom
    const tip = () => {};
    const isFull = () => document.body.classList.contains('ffull');
    const svg = d3.select('#fsvg').classed('fblobs', true);
    const defs = svg.append('defs');
    const grad = (id, stops) => defs.append('radialGradient').attr('id', id).selectAll('stop').data(stops).join('stop')
      .attr('offset', s => s[0]).style('stop-color', 'var(--pulse, var(--accent))').style('stop-opacity', s => s[1]);
    grad('bglow', [[0, 0.9], [0.8, 0.7], [0.9, 0.25], [1, 0]]);
    grad('bdglow', [[0, 0.85], [0.35, 0.55], [1, 0]]);
    const bg = svg.append('rect').attr('class', 'bbg').attr('fill', 'transparent');
    // W × H: the box the levels are laid out in, re-measured when the view goes full screen (and on resize while it is)
    let W = 0, H = 0;
    const measure = () => {
      W = Math.max(600, wrap.clientWidth);
      H = isFull() ? Math.max(480, innerHeight - dockH()) : Math.max(520, Math.min(860, innerHeight - wrap.getBoundingClientRect().top - 56));
      svg.attr('width', W).attr('height', H).attr('viewBox', [0, 0, W, H]);
      bg.attr('width', W).attr('height', H);
    };
    // full screen docks the controls in a strip along the bottom edge (Ben, Oct 29: the floating panel covered blobs and the
    // top pole); the field is laid out in the space above the strip, so nothing is drawn under it. h hides the strip and
    // the field takes the whole height. --dockh puts the breadcrumb line just above the controls.
    function dockH() {
      if (!isFull() || document.body.classList.contains('fbare')) return 0;
      const tour = main.querySelector('#ftour'), crumb = main.querySelector('#fcrumb');
      if (tour) document.body.style.setProperty('--dockh', tour.offsetHeight + 'px');
      let top = innerHeight;
      for (const el of [tour, crumb]) if (el) { const r = el.getBoundingClientRect(); if (r.height) top = Math.min(top, r.top); }
      return Math.max(0, innerHeight - top);
    }
    { const tourEl = main.querySelector('#ftour');   // keep the breadcrumb on the dock when the dock rewraps
      if (tourEl && window.ResizeObserver) new ResizeObserver(() => { if (isFull()) document.body.style.setProperty('--dockh', tourEl.offsetHeight + 'px'); }).observe(tourEl); }
    measure();
    // the pinch zoom is a transform on everything drawn (gZoom); the levels themselves never know about it
    const gZoom = svg.append('g');
    const gScenes = gZoom.append('g');
    // marks, under the pinch zoom. At the bottom a bubble lies under the dots it holds (the scene's own gUnder), where
    // they sit now (lens, pull and all); above it a bubble goes round the dots a leaf circle shows of the members, or
    // round the circle that holds them. Members outside the slab or the time window (weight < 0.1) are left out, as
    // their dots are. The names and notes are over everything.
    const gMarks = gZoom.append('g').attr('class', 'fmarks'), gMB = gMarks.append('g'), gML = gMarks.append('g');
    markDefs(defs);
    let marksRaf = 0;
    function marksSoon() {
      if (marksRaf) return;
      marksRaf = requestAnimationFrame(() => {
        marksRaf = 0;
        if (stale(g) || !svg.node().isConnected) return;
        if (animating || !cur) { gMarks.attr('display', 'none'); setTimeout(marksSoon, 120); return; }
        gMarks.attr('display', null);
        const zk = ZT.k, lvl = cur.path ? cur.path.split('.').length : 0;
        const at = cur.nodes ? new Map(cur.nodes.map(d => [d.path, d])) : null;
        const bottom = cur.kind === 'items' && cur.gUnder;
        if (bottom) gMB.selectAll('*').remove();
        drawMarkSvg(bottom ? cur.gUnder : gMB, gML, m => {
          const out = [];
          if (cur.kind === 'items') {
            for (const i of markIdx(m)) { const d = cur.byI && cur.byI.get(i); if (d && d.w >= 0.1) out.push([d.x, d.y, (d.rr || d.dr) + 9 / zk, d.ux ?? d.x, d.uy ?? d.y, d.dr / Math.sqrt(Math.max(1, zk)) * (d.cz || 1) + 9 / zk]); }
            const cs = cur.col && cur.col.get(m.id);
            if (cs && cs.v > 0.02 && out.length) { out.shape = cs.pts; out.ushape = cs.upts; out.col = cs; }
            return out;
          }
          return out;   // above the bottom level a mark draws no outline of its own (the counts below)
        }, zk, full => { if (full && cur && cur.hover) cur.hover(); marksSoon(); }, -ZT.y,
          [...(cur.nodes || []).filter(d => d.r >= 18).map(d => ({ x: d.x * zk, y: (d.y - 28) * zk, w: Math.min(d.r * 1.72, 190) * zk, h: 66 * zk })),   // the circles' names
           { x: W / 2 - ZT.x, y: 4 - ZT.y, w: 440, h: 24 }, { x: W / 2 - ZT.x, y: H - 44 - ZT.y, w: 440, h: 26 }],   // the poles, top and bottom
          // at the bottom a click on a mark's name collapses it (or opens it out); shift-click opens its card
          cur.kind === 'items' ? { bubble: true, click: (m, ev) => ev.shiftKey ? markOpen(m.id) : markColSet(m.id, !markCol(m.id)), hint: m => markCol(m.id) ? 'click: open it out · shift-click: its card' : 'click: collapse · shift-click: its card' } : {});
        // Above the bottom level (Ben, Nov 20: the rings round the regions "just get noisy and too much … im making
        // potentially a lot of them in subregions"): no outline per mark; a circle that holds members of any marks gets
        // one small count on its lower right rim.
        const held = new Map();   // circle → how many marks have members in it
        if (!bottom && at) for (const m of marksShown()) {
          const hit = new Set();
          for (const i of markIdx(m)) {
            if (!(WT[i] >= 0.1)) continue;
            const anc = ancestors(cOf(F.points[i]));
            if (lvl && anc[lvl - 1] !== cur.path) continue;
            const d = at.get(anc[lvl]);
            if (d && d.r >= 3) hit.add(d);
          }
          for (const d of hit) held.set(d, (held.get(d) || 0) + 1);
        }
        const badge = n => `${n} mark${n === 1 ? '' : 's'}`;
        const bd = gMB.selectAll('g.fmbadge').data([...held], e => e[0].path).join(e => { const g2 = e.append('g').attr('class', 'fmbadge'); g2.append('rect'); g2.append('text'); return g2; });
        bd.attr('transform', ([d]) => `translate(${(d.x + d.r * 0.74).toFixed(1)},${(d.y + d.r * 0.74).toFixed(1)}) scale(${(1 / zk).toFixed(4)})`);
        bd.select('text').attr('y', 3.5).text(([, n]) => badge(n));
        bd.select('rect').attr('x', ([, n]) => -(badge(n).length * 5.9 + 14) / 2).attr('y', -8).attr('height', 16).attr('rx', 8).attr('width', ([, n]) => badge(n).length * 5.9 + 14);
        // the legend says what a mark's name does, when there are names to click
        const lgd = main.querySelector('#flegend');
        if (lgd) {
          let sp = lgd.querySelector('.fmleg');
          const show = cur.kind === 'items' && !!gML.select('g.fml').node();
          if (show && !sp) { sp = document.createElement('span'); sp.className = 'fmleg'; sp.textContent = ' · click a mark\u2019s name to collapse it · shift-click for its card'; lgd.appendChild(sp); }
          else if (!show && sp) sp.remove();
        }
      });
    }
    // rim labels: what each direction of the plane means right now (poles), drawn outside the zoom so a pinch leaves them
    const gPoles = svg.append('g').attr('class', 'bpoles').attr('display', L.poles === false ? 'none' : null);
    const GAP = 24, PREV = 0.84, DEG = Math.PI / 180, N = F.points.length;
    // the tour's trees can be three deep (region › sub-region › neighborhood), so every path walk is by '.'
    const parentPath = path => path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
    const ancestors = c => { const parts = c.split('.'); return parts.map((_, k) => parts.slice(0, k + 1).join('.')); };   // '3.2.1' → 3, 3.2, 3.2.1
    const above = (a, b) => a === '' ? b !== '' : b.startsWith(a + '.');

    // ---------------------------------------------------------------- tour state ↔ hash ↔ localStorage
    // time: tm '' (all time), 'win' (a window of width ts centred on tw) or 'upto' (everything written before tw); tw and
    // ts are in rank units over the visible items' `created`, so the 2002–2025 archives and the 2026 network share the slider
    // meaning + time opens with time across (∠₁ 90°, newest on the right) and every item counted; the others on the plane
    // of most spread with the slab through the middle
    const TDEF = tourSpace === 'mt' ? { a1: 90, a2: 0, s1: 0, s2: 0, sig: Infinity, lens: '', tm: '', tw: 1, ts: 0.12, sp: 'mt', rg: 'th' }
      : { a1: 0, a2: 0, s1: 0, s2: 0, sig: tourSpace === 'ar' ? Infinity : 0.6, lens: '', tm: '', tw: 1, ts: 0.12, sp: tourSpace, rg: 'th' };
    const fromStore = t => t ? { ...t, sig: t.sig === 'inf' ? Infinity : Number(t.sig) || TDEF.sig } : {};
    const TS = { ...TDEF, ...fromStore(fieldState.tour) };
    const parseT = params => {
      if (!params.has('t')) return null;
      const [a1, a2, s1, s2, sg] = params.get('t').split(',');
      const v = { a1: Number(a1), a2: Number(a2), s1: Number(s1), s2: Number(s2), sig: sg === 'inf' ? Infinity : Number(sg), lens: params.get('lens') || '', tm: '', tw: TDEF.tw, ts: TDEF.ts, sp: params.get('sp') === 'mt' ? 'mt' : params.get('sp') === 'ar' ? 'ar' : 'm4', rg: params.get('rg') === 'era' ? 'era' : 'th' };
      if (params.has('w')) {
        const [tm, tw, ts] = params.get('w').split(',');
        if ((tm === 'win' || tm === 'upto') && Number.isFinite(Number(tw)) && Number(ts) > 0) Object.assign(v, { tm, tw: clamp01(Number(tw)), ts: Math.min(1, Number(ts)) });
      }
      return [v.a1, v.a2, v.s1, v.s2].every(Number.isFinite) && v.sig > 0 ? v : null;
    };
    Object.assign(TS, parseT(p) || {});
    TS.sp = tourSpace; TS.rg = tourEras ? 'era' : 'th';
    // a meaning + time view from before time went across (time up was ∠₂ 90°): the same picture, turned
    if (tourSpace === 'mt' && TS.a1 === 0 && Math.abs(TS.a2) === 90) { TS.a1 = TS.a2; TS.a2 = 0; }
    const FIXED = tourSpace === 'mt' && TIME_FIXED;   // time stays across: no ∠₁ slider, the drift leaves it alone
    if (FIXED) TS.a1 = 90;
    const tStr = o => `t=${Math.round(o.a1)},${Math.round(o.a2)},${o.s1.toFixed(2)},${o.s2.toFixed(2)},${o.sig === Infinity ? 'inf' : o.sig.toFixed(3)}${o.lens ? '&lens=' + o.lens : ''}${o.tm ? `&w=${o.tm},${o.tw.toFixed(3)},${o.ts.toFixed(3)}` : ''}${o.sp === 'mt' ? '&sp=mt' + (o.rg === 'era' ? '&rg=era' : '') : o.sp === 'ar' ? '&sp=ar' : ''}`;
    const tParam = () => tStr(TS);
    const hashFor = path => '#/field?' + (path ? 'c=' + path + '&' : '') + tParam();
    let hashTimer = 0;
    const persist = () => {   // the view in the address bar (without a hashchange, so the router stays out of it) and in localStorage
      if (hashTimer) return;
      hashTimer = setTimeout(() => {
        hashTimer = 0;
        if (stale(g) || !svg.node().isConnected) return;
        history.replaceState(null, '', hashFor(cur ? cur.path : ''));
        fieldState.tour = { ...TS, sig: TS.sig === Infinity ? 'inf' : TS.sig }; saveFieldState();
      }, 250);
    };

    // ---------------------------------------------------------------- the frame, and the projection
    const MT = tourSpace === 'mt', AR = tourSpace === 'ar', FR = AR ? F.frameA : MT ? F.frameT : F.frame;
    // meaning + time puts time across (Ben, Oct 23: "the time axis can go left/right … pointing right by default", the
    // control bar being above): the frame's slots are reordered to PC2, PC1, time, PC3, so tilt ∠₁ turns time into the
    // screen's horizontal (at 90°, newest on the right) with the most spread meaning direction running up it, and depth
    // ↕₁ is the slice through time
    const SLOT = MT ? [1, 0, 3, 2] : [0, 1, 2, 3], AXN = MT ? ['PC2', 'PC1', 'time', 'PC3'] : AR ? ['A1', 'A2', 'A3', 'A4'] : ['PC1', 'PC2', 'PC3', 'PC4'];
    const E = SLOT.map(k => FR.basis[k]), MU = FR.mean, SD = SLOT.map(k => FR.sd[k]);
    const toQ = v => E.map(e => e[0] * (v[0] - MU[0]) + e[1] * (v[1] - MU[1]) + e[2] * (v[2] - MU[2]) + e[3] * (v[3] - MU[3]));
    const Q = F.points.map(d => toQ(AR ? d.pA : MT ? d.pT : d.p4));
    const QC = new Map(CL.map(c => [c.path, toQ(c.m4)]));
    const PX = new Float32Array(N), PY = new Float32Array(N), WT = new Float32Array(N);
    let R = { c1: 1, s1: 0, c2: 1, s2: 0 }, TOT = 0, VISN = 0;
    const sdAlong = (a, i, j) => Math.hypot(Math.sin(a) * SD[i], Math.cos(a) * SD[j]);   // spread along w (the PCs are uncorrelated)
    const lensQ = () => {
      if (!TS.lens) return null;
      if (TS.lens === 'o') return [0, 0, 0, 0];
      if (TS.lens.startsWith('i:')) return Q[Number(TS.lens.slice(2))] || null;
      if (TS.lens.startsWith('c:')) return QC.get(TS.lens.slice(2)) || null;
      return null;
    };
    // ---------------------------------------------------------------- time: a second weight beside the slab
    // Each item's rank by `created` among the visible items (0 = oldest, 1 = newest). The dates are lumpy — one
    // archive back to 2002, another to 2018, most of the network since August 2026 — so a calendar slider would
    // be one frame at the end; on ranks every stretch of the slider holds the same number of items, and the date ticks
    // under it show how unevenly the calendar is spread.
    const TIME = F.points.map(d => Date.parse(d.created || d.updated || '') || 0);
    const RANK = new Float32Array(N);
    let ORDER = [];
    function rerank() {
      ORDER = d3.range(N).filter(i => visible(F.points[i])).sort((a, b) => TIME[a] - TIME[b]);
      const n = ORDER.length;
      ORDER.forEach((i, k) => { RANK[i] = n > 1 ? k / (n - 1) : 0.5; });
    }
    rerank();
    const ALLORD = d3.range(N).sort((a, b) => TIME[a] - TIME[b] || a - b);
    const rankAll = t => d3.bisector(i => TIME[i]).right(ALLORD, t) / Math.max(1, ALLORD.length - 1);   // a moment's place among all items
    const timeAt = r => ORDER.length ? TIME[ORDER[Math.round(clamp01(r) * (ORDER.length - 1))]] : 0;
    // win: a soft box (½ at the edges, ~0 a quarter-width outside); upto: a soft step a few hundredths wide
    const timeW = r => !TS.tm ? 1 : TS.tm === 'upto' ? 1 / (1 + Math.exp((r - TS.tw) / 0.006)) : 1 / (1 + Math.pow(Math.abs(r - TS.tw) / (TS.ts / 2), 8));
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fmtSpan = (t0, t1) => {
      const a = new Date(t0), b = new Date(t1);
      if (t1 - t0 < 100 * 864e5) return `${MON[a.getMonth()]} ${a.getDate()}${a.getFullYear() !== b.getFullYear() ? ', ' + a.getFullYear() : ''} – ${MON[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
      return `${MON[a.getMonth()]} ${a.getFullYear()} – ${MON[b.getMonth()]} ${b.getFullYear()}`;
    };
    const fmtDay = t => { const a = new Date(t); return `${MON[a.getMonth()]} ${a.getDate()}, ${a.getFullYear()}`; };
    const timeLabel = () => !TS.tm ? 'all time' : TS.tm === 'upto' ? `written by ${fmtDay(timeAt(TS.tw))}` : fmtSpan(timeAt(TS.tw - TS.ts / 2), timeAt(TS.tw + TS.ts / 2));
    // what the counts are counting: '' when nothing is weighted (σ = ∞, all time), otherwise the slab/lens and/or the time
    const where = () => [TS.sig === Infinity ? '' : TS.lens ? 'the lens' : 'the slab', !TS.tm ? '' : TS.tm === 'upto' ? 'the time so far' : 'the time window'].filter(Boolean).join(' and ');
    const counting = () => TS.sig !== Infinity || !!TS.tm;

    const lensName = () => {
      if (TS.lens === 'o') return 'the centre of the field';
      if (TS.lens.startsWith('i:')) { const d = F.points[Number(TS.lens.slice(2))]; return d ? (d.title || '(untitled)') : '?'; }
      if (TS.lens.startsWith('c:')) { const c = byPath.get(TS.lens.slice(2)); return c ? nameOf(c, 3) : '?'; }
      return '';
    };
    // how much of the arrows lies in the plane: Σ (in-plane displacement)² / Σ |displacement|² over the arrows between
    // visible items, in the tour's four dimensions — the number the arrow space is built to raise
    let ALIGN = 0;
    function alignment() {
      const { c1, s1, c2, s2 } = R;
      let inp = 0, all = 0;
      for (const [i, j] of F.edges) {
        if (!visible(F.points[i]) || !visible(F.points[j])) continue;
        const a = Q[i], b = Q[j], d0 = a[0] - b[0], d1 = a[1] - b[1], d2 = a[2] - b[2], d3 = a[3] - b[3];
        const x = c1 * d0 + s1 * d2, y = c2 * d1 + s2 * d3;
        inp += x * x + y * y; all += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
      }
      ALIGN = all ? inp / all : 0;
    }
    function project() {
      const a1 = TS.a1 * DEG, a2 = TS.a2 * DEG, c1 = Math.cos(a1), s1 = Math.sin(a1), c2 = Math.cos(a2), s2 = Math.sin(a2);
      const o1 = TS.s1 * sdAlong(a1, 0, 2), o2 = TS.s2 * sdAlong(a2, 1, 3);
      // the lens measures distance over four dimensions, the slab over two: σ√2 for the lens keeps one thickness about one share
      const f = lensQ(), inv = TS.sig === Infinity ? 0 : 1 / (TS.sig * TS.sig * (f ? 2 : 1));
      R = { c1, s1, c2, s2, o1, o2, f, inv };
      TOT = 0; VISN = 0;
      for (let i = 0; i < N; i++) {
        const q = Q[i];
        PX[i] = c1 * q[0] + s1 * q[2]; PY[i] = c2 * q[1] + s2 * q[3];
        const on = visible(F.points[i]);
        WT[i] = on ? spaceW(q) * (TS.tm ? timeW(RANK[i]) : 1) : 0;
        TOT += WT[i]; VISN += on ? 1 : 0;
      }
      alignment();
    }
    // the slab's (or the lens's) weight at any point of the 4D frame, under the current projection
    function spaceW(q) {
      const { c1, s1, c2, s2, o1, o2, f, inv } = R;
      if (!inv) return 1;
      let dd;
      if (f) dd = (q[0] - f[0]) ** 2 + (q[1] - f[1]) ** 2 + (q[2] - f[2]) ** 2 + (q[3] - f[3]) ** 2;
      else { const d1 = -s1 * q[0] + c1 * q[2] - o1, d2 = -s2 * q[1] + c2 * q[3] - o2; dd = d1 * d1 + d2 * d2; }
      return Math.exp(-dd * inv);
    }
    const projQ = q => [R.c1 * q[0] + R.s1 * q[2], R.c2 * q[1] + R.s2 * q[3]];
    const fmtW = w => w >= 9.5 ? String(Math.round(w)) : w >= 0.95 ? w.toFixed(1).replace(/\.0$/, '') : w >= 0.05 ? '<1' : '0';

    // members of every 4D cluster (a region holds its sub-regions' items), as point indexes
    const members = new Map();
    for (const d of F.points) for (const c of ancestors(cOf(d))) { if (!members.has(c)) members.set(c, []); members.get(c).push(d.i); }
    const levelFor = path => {
      const c = path ? byPath.get(path) : null;
      if (!c) return { path: '', kind: 'blobs' };
      return { path, kind: c.children.length ? 'blobs' : 'items', c };
    };

    // ---------------------------------------------------------------- the control panel
    const panel = main.querySelector('#ftour');
    const sigToV = s => s === Infinity ? 100 : Math.round(99 * Math.log(s / 0.1) / Math.log(50));
    const vToSig = v => v >= 100 ? Infinity : 0.1 * Math.pow(50, v / 99);
    const sliders = [
      { k: 's1', label: 'depth ↕₁', min: -2.5, max: 2.5, step: 0.01, title: FIXED ? 'slide the slab along the first hidden direction of meaning (time stays across the screen)' : MT ? 'slide the slab along the first hidden direction — at time ∠₁ = 0° that is time itself, so the slab is a slice of one stretch of time (synchronic)' : 'slide the slab along the first hidden direction (in standard deviations along it)' },
      { k: 's2', label: 'depth ↕₂', min: -2.5, max: 2.5, step: 0.01, title: 'slide the slab along the second hidden direction' },
      { k: 'a1', label: MT ? 'time ∠₁' : 'tilt ∠₁', min: -90, max: 90, step: 1, title: MT ? 'turn the plane’s horizontal axis toward time: at 90° time runs left to right, newest on the right (diachronic); at 0° time is hidden and ↕₁ slices through it' : 'turn the plane’s horizontal axis toward the first hidden direction (PC1 → PC3)' },
      { k: 'a2', label: 'tilt ∠₂', min: -90, max: 90, step: 1, title: `turn the plane’s vertical axis toward the second hidden direction (${AXN[1]} → ${AXN[3]})` },
      { k: 'sig', label: 'thickness', min: 0, max: 100, step: 1, title: 'how much of the space around the plane counts — thin is a sharp slice, ∞ is the plain projection' },
    ].filter(s => !(FIXED && s.k === 'a1'));
    // hold: a control the drift leaves alone (Ben, Oct 23: "fix the time dimension when its drifting… keep it fixed at 90
    // degrees going to the right"). Kept per space, since ∠₁ is time only in meaning + time; time starts held there.
    const HOLDABLE = ['s1', 's2', 'a1', 'a2'];
    fieldState.holds = fieldState.holds || {};
    const holds = new Set(fieldState.holds[tourSpace] ?? (MT ? ['a1'] : []));
    if (FIXED) holds.add('a1');
    let VIEWS = [];
    try { VIEWS = JSON.parse(localStorage.fieldViews || '[]'); } catch {}
    const saveViews = () => { try { localStorage.fieldViews = JSON.stringify(VIEWS); } catch {} };
    panel.innerHTML = `<div class="trow">
        ${SPACES.length > 1 ? `<span class="fctl tsp">${SPACES.map(s => ({
          m4: `<a href="#" data-sp="m4" title="the four directions are all meaning (a 4D UMAP of the embeddings)">meaning 4D</a>`,
          mt: `<a href="#" data-sp="mt" title="three directions of meaning (a 3D UMAP) and time as the fourth — regions are themes, sub-regions are scenes (a theme in a stretch of time)">meaning + time</a>`,
          ar: `<a href="#" data-sp="ar" title="the four directions the ${FW.edges} move along most (the top axes of their displacements in the embedding space, cited → citing, each turned so the ${FW.edges} tend to the + side); items are the raw vectors on those axes — a flat projection, so regions blur where UMAP pulls them apart, but a direction means what the ${FW.edges} made it mean. Shares of the ${FW.edges}' energy: ${F.frameA ? F.frameA.share.map(x => Math.round(100 * x) + '%').join(' / ') : ''}">arrows</a>`,
        })[s]).join('')}</span>` : ''}
        ${MT ? `<span class="fctl trg">regions: <a href="#" data-rg="th" title="regions clustered on meaning alone; time enters one level down, in the scenes">themes</a><a href="#" data-rg="era" title="regions clustered on meaning and time together (time as wide as the widest meaning direction) — themes in their eras">themes + eras</a></span>` : ''}
        <span class="fctl tmode"><a href="#" data-tm="slab" title="weigh items by their distance from the plane">slab</a><a href="#" data-tm="lens" title="weigh items by their distance from a point — shift-click a circle or a dot to put it there">lens</a></span>
        ${sliders.map(s => `<label class="tsl" data-k="${s.k}" title="${esc(s.title)}"><span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}"><output></output>${HOLDABLE.includes(s.k) ? `<a href="#" class="thold" data-hold="${s.k}" title="hold this one still while the plane drifts">hold</a>` : ''}</label>`).join('')}
        <span class="fctl"><a href="#" data-tact="drift" title="let the plane wander through the space on its own (a grand tour)">drift</a><a href="#" data-tact="reset" title="the plane of most spread, the slab through the middle, all time">reset</a><a href="#" data-tact="save" title="keep this view (plane, slab, lens, time, level) under a name">save view</a></span>
        <span class="fctl"><a href="#" data-tact="loupe" title="a magnifier follows the mouse and opens the nearest items into text — at the bottom level, and in the open space between circles above it (key: m)">loupe</a><a href="#" data-tact="fill" title="when the slice holds only a few small circles, zoom smoothly so they fill the field (key: z)">fill</a><a href="#" data-tact="ease" title="the loupe's text circles drift toward their places instead of snapping there (key: e)">ease</a><a href="#" data-tact="poles" title="name the edges of the plane: the words that set the items at each edge apart from the rest of this level — does the direction mean anything? (key: p)">poles</a><a href="#" data-tact="full" title="just the field, filling the screen (key: f; h hides the controls)">full screen</a></span>
      </div>
      <div class="trow ttime">
        <span class="fctl ttm">${[['', 'all time', 'every item counts whenever it was written'], ['win', 'window', 'only items written inside a window of time'], ['upto', 'up to', 'items written up to a moment — the network as it stood then']].map(([k, l, t]) => `<a href="#" data-time="${k}" title="${t}">${l}</a>`).join('')}</span>
        <label class="tsl twhen" title="when: drag through the items in the order they were written (equal steps = equal numbers of items)"><span>when</span><span class="ttrack"><input type="range" min="0" max="1000" step="1"><span class="tticks"></span></span></label>
        <label class="tsl tspan" title="how wide the window is, as a share of all the items"><span>span</span><input type="range" min="0" max="100" step="1"><output></output></label>
        <span class="fctl"><a href="#" data-tact="play" title="run the time forward from here (from the start if at the end)">▶ play</a></span>
        <span class="tdate"></span>
      </div>
      <div class="trow small"><span class="tstat muted"></span><span class="tlens"></span><span class="tviews"></span></div>`;
    const $in = k => panel.querySelector(`.tsl[data-k="${k}"] input`), $out = k => panel.querySelector(`.tsl[data-k="${k}"] output`);
    const $when = panel.querySelector('.twhen input'), $span = panel.querySelector('.tspan input');
    const spanToV = s => Math.round(100 * Math.log(s / 0.01) / Math.log(100)), vToSpan = v => 0.01 * Math.pow(100, v / 100);   // 1% … all of it, log
    // date ticks under the when slider: year starts (round years first) and, where the items are dense, month starts
    // date ticks over an ordering of items by time, as ranks: year starts (round years first), month starts, and where a
    // month holds a big share of the items (the network's autumn) its 8th, 15th and 22nd; `gap` is the closest two may sit
    function timeTicks(order, gap) {
      if (!order.length) return [];
      const t0 = TIME[order[0]], t1 = TIME[order[order.length - 1]], cands = [];
      const rankOf = t => d3.bisector(i => TIME[i]).left(order, t) / Math.max(1, order.length - 1);
      for (let y = new Date(t0).getFullYear() + 1; y <= new Date(t1).getFullYear(); y++) cands.push({ r: rankOf(Date.UTC(y, 0, 1)), label: String(y), pri: y % 5 ? 1 : 0 });
      for (let t = Date.UTC(new Date(t0).getFullYear(), new Date(t0).getMonth() + 1, 1); t <= t1; t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)) {
        const m = new Date(t).getUTCMonth(), y = new Date(t).getUTCFullYear();
        if (m) cands.push({ r: rankOf(t), label: MON[m], pri: 2 });
        if (rankOf(Date.UTC(y, m + 1, 1)) - rankOf(t) > 0.12) for (const day of [8, 15, 22]) cands.push({ r: rankOf(Date.UTC(y, m, day)), label: `${MON[m]} ${day}`, pri: 3 });
      }
      const kept = [];
      for (const c of cands.sort((a, b) => a.pri - b.pri)) if (c.r > 0.01 && c.r < 0.99 && kept.every(k => Math.abs(k.r - c.r) > gap)) kept.push(c);
      return kept;
    }
    function drawTicks() {
      panel.querySelector('.tticks').innerHTML = timeTicks(ORDER, 0.1).map(c => `<i style="left:${(c.r * 100).toFixed(1)}%">${c.label}</i>`).join('');
    }
    // meaning + time: gridlines for the time axis, once time is tilted into the screen — vertical lines, labelled along
    // the bottom edge (iso-time lines through the middle of meaning; exact at ∠₁ = 90°) — and each region's or scene's
    // span of time, for its label
    const AXTICKS = MT ? timeTicks(ALLORD, 0.035) : [];
    function drawTimeAxis(gAx, cx, scale) {
      const sv = R.s1, show = Math.abs(sv) > 0.35;
      gAx.attr('display', show ? null : 'none').style('opacity', clamp01((Math.abs(sv) - 0.35) / 0.4));
      if (!show) return;
      const ticks = AXTICKS.map(t => ({ ...t, x: W / 2 + (sv * ((t.r - 0.5) * F.frameT.time.scale - MU[3]) - cx) * scale })).filter(t => t.x > 24 && t.x < W - 24);
      const kept = [];   // labels need more room across than they did stacked
      for (const t of ticks.slice().sort((a, b) => a.pri - b.pri)) if (kept.every(k => Math.abs(k.x - t.x) > 44)) kept.push(t);
      const tk = gAx.selectAll('g').data(kept, t => t.label).join(e => { const g2 = e.append('g'); g2.append('line'); g2.append('text'); return g2; });
      tk.select('line').attr('y1', 0).attr('y2', H).attr('x1', t => t.x).attr('x2', t => t.x).attr('class', t => t.pri <= 1 ? 'yr' : null);
      tk.select('text').attr('x', t => t.x + 3).attr('y', H - 8).text(t => t.label);
    }
    const SPANS = new Map();
    const spanOf = path => {
      if (!SPANS.has(path)) {
        const ts = (members.get(path) || []).map(i => TIME[i]).sort((a, b) => a - b);
        SPANS.set(path, ts.length ? fmtSpan(d3.quantileSorted(ts, 0.1), d3.quantileSorted(ts, 0.9)) : '');
      }
      return SPANS.get(path);
    };
    function syncPanel() {
      for (const s of sliders) {
        $in(s.k).value = s.k === 'sig' ? sigToV(TS.sig) : TS[s.k];
        $out(s.k).textContent = s.k === 'sig' ? (TS.sig === Infinity ? '∞' : TS.sig.toFixed(2)) : s.k[0] === 'a' ? `${Math.round(TS[s.k])}°` : (TS[s.k] >= 0 ? '+' : '−') + Math.abs(TS[s.k]).toFixed(2) + 'σ';
      }
      panel.querySelectorAll('a[data-time]').forEach(a => a.classList.toggle('on', a.dataset.time === TS.tm));
      panel.querySelectorAll('a[data-sp]').forEach(a => a.classList.toggle('on', a.dataset.sp === TS.sp));
      panel.querySelectorAll('a[data-hold]').forEach(a => a.classList.toggle('on', holds.has(a.dataset.hold)));
      panel.querySelectorAll('a[data-rg]').forEach(a => a.classList.toggle('on', a.dataset.rg === TS.rg));
      $when.value = Math.round(TS.tw * 1000); $span.value = spanToV(TS.ts);
      panel.querySelector('.tspan output').textContent = Math.round(TS.ts * 100) + '%';
      panel.querySelector('.twhen').classList.toggle('off', !TS.tm);
      panel.querySelector('.tspan').classList.toggle('off', TS.tm !== 'win'); $span.disabled = TS.tm !== 'win';
      panel.querySelector('.tdate').textContent = timeLabel();
      panel.querySelector('a[data-tact="play"]').classList.toggle('on', !!playing);
      panel.querySelector('a[data-tact="play"]').textContent = playing ? '❚❚ pause' : '▶ play';
      panel.querySelector('a[data-tact="loupe"]').classList.toggle('on', L.loupe !== false);
      panel.querySelector('a[data-tact="ease"]').classList.toggle('on', !!L.ease);
      panel.querySelector('a[data-tact="fill"]').classList.toggle('on', L.fill !== false);
      panel.querySelector('a[data-tact="poles"]').classList.toggle('on', L.poles !== false);
      panel.querySelector('a[data-tact="full"]').classList.toggle('on', isFull());
      const lens = !!TS.lens;
      panel.querySelectorAll('a[data-tm]').forEach(a => a.classList.toggle('on', (a.dataset.tm === 'lens') === lens));
      for (const k of ['s1', 's2']) { panel.querySelector(`.tsl[data-k="${k}"]`).classList.toggle('off', lens); $in(k).disabled = lens; }
      panel.querySelector('.tlens').innerHTML = lens ? `lens on <b>${esc(lensName().slice(0, 60))}</b> <a href="#" data-tact="unlens" title="back to the slab">×</a>` : '';
      panel.querySelector('.tviews').innerHTML = VIEWS.length ? 'saved: ' + VIEWS.map((v, i) => `<span class="tview"><a href="${esc(v.hash)}">${esc(v.name)}</a><a href="#" data-unview="${i}" title="forget this view">×</a></span>`).join('') : '';
      panel.querySelectorAll('a[data-tact="unlens"]').forEach(a => a.onclick = ev => { ev.preventDefault(); setLens(''); });
      panel.querySelectorAll('a[data-unview]').forEach(a => a.onclick = ev => { ev.preventDefault(); VIEWS.splice(Number(a.dataset.unview), 1); saveViews(); syncPanel(); });
    }
    // meaning + time: where the slab sits in time (time hidden), or which way time runs (time tilted in)
    const timeAt4 = q4 => { const r = clamp01((q4 + MU[3]) / F.frameT.time.scale + 0.5); return TIME[ALLORD[Math.round(r * (ALLORD.length - 1))]]; };
    function timeAxisNote() {
      if (!MT) return '';
      const a1 = TS.a1 * DEG;
      if (Math.abs(Math.sin(a1)) > 0.7) return ` · time runs ${Math.sin(a1) > 0 ? 'left to right' : 'right to left'}`;
      if (TS.sig === Infinity || TS.lens) return '';
      const o1 = TS.s1 * sdAlong(a1, 0, 2);   // the slab centre along w₁ = −sin∠₁·PC2 + cos∠₁·time
      return ` · slab centred near ${fmtDay(timeAt4(o1 * Math.cos(a1)))}`;
    }
    const status = () => {
      const axes = `plane: ${AXN[0]}${TS.a1 ? `→${AXN[2]} ${Math.round(TS.a1)}°` : ''} × ${AXN[1]}${TS.a2 ? `→${AXN[3]} ${Math.round(TS.a2)}°` : ''}${timeAxisNote()} · ${Math.round(100 * ALIGN)}% of the ${FW.edges} in the plane`;
      panel.querySelector('.tstat').textContent = !counting() ? `${axes} · thickness ∞, all time — every item counts (the plain projection)` : `${axes}${TS.sig === Infinity ? ' · thickness ∞' : ''} · ≈${Math.round(TOT).toLocaleString()} of ${VISN.toLocaleString()} items inside ${where()}`;
      panel.querySelector('.tdate').textContent = timeLabel();
    };
    for (const s of sliders) $in(s.k).addEventListener('input', ev => {
      stopDrift();
      const v = Number(ev.target.value);
      TS[s.k] = s.k === 'sig' ? vToSig(v) : v;
      syncPanel(); schedule();
    });
    // time controls
    panel.querySelectorAll('a[data-time]').forEach(a => a.onclick = ev => {
      ev.preventDefault(); stopPlay();
      TS.tm = a.dataset.time;
      if (TS.tm === 'win' && TS.tw > 1 - TS.ts / 2) TS.tw = 1 - TS.ts / 2;   // a window ending at the newest item, not half off the end
      syncPanel(); schedule();
    });
    $when.addEventListener('input', () => { stopPlay(); if (!TS.tm) TS.tm = 'upto'; TS.tw = Number($when.value) / 1000; syncPanel(); schedule(); });
    $span.addEventListener('input', () => { TS.ts = vToSpan(Number($span.value)); syncPanel(); schedule(); });
    // play: the time runs forward through the items at a steady number of items per second (≈ the whole field in 40 s)
    let playing = 0, playT = 0;
    function playFrame(t) {
      if (!playing || stale(g) || !svg.node().isConnected) { playing = 0; return; }
      const dt = Math.min(0.1, (t - (playT || t)) / 1000); playT = t;
      TS.tw = Math.min(1, TS.tw + dt / 40);
      if (TS.tw >= 1) { TS.tw = 1; playing = 0; }
      syncPanel(); schedule();
      if (playing) playing = requestAnimationFrame(playFrame);
    }
    function stopPlay() { if (playing) cancelAnimationFrame(playing); playing = 0; }
    panel.querySelector('a[data-tact="play"]').onclick = ev => {
      ev.preventDefault();
      if (playing) { stopPlay(); syncPanel(); return; }
      if (!TS.tm) TS.tm = 'upto';
      if (TS.tw >= 0.999) TS.tw = TS.tm === 'win' ? TS.ts / 2 : 0.02;
      playT = 0; playing = requestAnimationFrame(playFrame); syncPanel(); schedule();
    };
    panel.querySelectorAll('a[data-sp]').forEach(a => a.onclick = ev => {
      ev.preventDefault();
      if (a.dataset.sp === TS.sp || !SPACES.includes(a.dataset.sp)) return;
      stopDrift(); stopPlay();
      // into meaning + time: open on the plane of meaning (PC1) across and time up, every item counted; back: the default plane
      Object.assign(TS, a.dataset.sp === 'mt' ? { sp: 'mt', a1: 90, a2: 0, s1: 0, s2: 0, sig: Infinity, lens: '' } : { sp: a.dataset.sp === 'ar' ? 'ar' : 'm4', a1: 0, a2: 0, s1: 0, s2: 0, sig: a.dataset.sp === 'ar' ? Infinity : TDEF.sig, lens: '' });
      fieldState.tour = { ...TS, sig: TS.sig === Infinity ? 'inf' : TS.sig }; saveFieldState();
      fieldHashNav = null; history.replaceState(null, '', '#/field?' + tParam()); route();   // the regions differ between the spaces: rebuild, not move in place
    });
    panel.querySelectorAll('a[data-rg]').forEach(a => a.onclick = ev => {
      ev.preventDefault();
      if (a.dataset.rg === TS.rg) return;
      TS.rg = a.dataset.rg;   // the view stays; the regions are rebuilt (a path means different regions in the two trees)
      fieldState.tour = { ...TS, sig: TS.sig === Infinity ? 'inf' : TS.sig }; saveFieldState();
      fieldHashNav = null; history.replaceState(null, '', '#/field?' + tParam()); route();
    });
    panel.querySelector('a[data-tact="loupe"]').onclick = ev => { ev.preventDefault(); L.loupe = L.loupe === false; saveFieldState(); syncPanel(); if (cur && cur.loupe) cur.loupe(); };
    const toggleFill = () => { L.fill = L.fill === false; saveFieldState(); syncPanel(); if (cur && cur.update) cur.update(); };
    panel.querySelector('a[data-tact="fill"]').onclick = ev => { ev.preventDefault(); toggleFill(); };
    const toggleEase = () => { L.ease = !L.ease; saveFieldState(); syncPanel(); };
    panel.querySelector('a[data-tact="ease"]').onclick = ev => { ev.preventDefault(); toggleEase(); };
    panel.querySelector('a[data-tact="full"]').onclick = ev => { ev.preventDefault(); setFull(!isFull()); };
    const togglePoles = () => { L.poles = L.poles === false; saveFieldState(); syncPanel(); gPoles.attr('display', L.poles === false ? 'none' : null); poleKey = ''; schedulePoles(); };
    panel.querySelector('a[data-tact="poles"]').onclick = ev => { ev.preventDefault(); togglePoles(); };
    function setLens(l) { TS.lens = l; syncPanel(); schedule(); }
    // going somewhere moves the slab onto it: the depths are set to the target's own, so a region you drill into (or an
    // item a scene points at) is inside the slice rather than wherever the slab happened to be. Not with a lens (it is
    // already a place) and not at σ = ∞ (nothing to move).
    function recenter(q) {
      if (TS.lens || !q || TS.sig === Infinity) return;
      const a1 = TS.a1 * DEG, a2 = TS.a2 * DEG, lim = 2.5;
      TS.s1 = Math.max(-lim, Math.min(lim, (-Math.sin(a1) * q[0] + Math.cos(a1) * q[2]) / sdAlong(a1, 0, 2)));
      TS.s2 = Math.max(-lim, Math.min(lim, (-Math.sin(a2) * q[1] + Math.cos(a2) * q[3]) / sdAlong(a2, 1, 3)));
      stopDrift(); syncPanel();
    }
    const enter = path => { recenter(QC.get(path)); location.hash = hashFor(path); };
    panel.querySelectorAll('a[data-tm]').forEach(a => a.onclick = ev => {
      ev.preventDefault();
      if (a.dataset.tm === 'slab') return setLens('');
      if (!TS.lens) setLens(cur && cur.path ? 'c:' + cur.path : 'o');   // no focus picked yet: the region you're in, or the middle
    });
    panel.querySelector('a[data-tact="reset"]').onclick = ev => { ev.preventDefault(); stopDrift(); stopPlay(); Object.assign(TS, TDEF); syncPanel(); schedule(); };
    panel.querySelector('a[data-tact="save"]').onclick = ev => {
      ev.preventDefault();
      const name = (prompt('name this view') || '').trim();
      if (!name) return;
      VIEWS.push({ name: name.slice(0, 40), hash: hashFor(cur ? cur.path : '') }); saveViews(); syncPanel();
    };
    // drift: each control bounces between its limits at its own slow speed, so the plane never retraces its path quickly
    let drift = 0, driftT = 0;
    const DV = { a1: 7, a2: -5.3, s1: 0.13, s2: -0.09 }, LIM = { a1: 88, a2: 88, s1: 1.8, s2: 1.8 };
    function driftFrame(t) {
      if (!drift || stale(g) || !svg.node().isConnected) { drift = 0; return; }
      const dt = Math.min(0.1, (t - (driftT || t)) / 1000); driftT = t;
      for (const k of (TS.lens ? ['a1', 'a2'] : ['a1', 'a2', 's1', 's2']).filter(k => !holds.has(k))) {
        TS[k] += DV[k] * dt;
        if (Math.abs(TS[k]) > LIM[k]) { TS[k] = Math.sign(TS[k]) * LIM[k]; DV[k] = -DV[k]; }
      }
      syncPanel(); schedule();
      drift = requestAnimationFrame(driftFrame);
    }
    panel.querySelectorAll('a[data-hold]').forEach(a => a.onclick = ev => {
      ev.preventDefault(); ev.stopPropagation();
      const k = a.dataset.hold; holds.has(k) ? holds.delete(k) : holds.add(k);
      fieldState.holds[tourSpace] = [...holds]; saveFieldState(); syncPanel();
    });
    const driftBtn = panel.querySelector('a[data-tact="drift"]');
    const fabDrift = () => main.querySelector('#ffab [data-fab="drift"]');
    function stopDrift() { if (drift) cancelAnimationFrame(drift); drift = 0; driftBtn.classList.remove('on'); fabDrift()?.classList.remove('on'); }
    driftBtn.onclick = ev => { ev && ev.preventDefault && ev.preventDefault(); if (drift) return stopDrift(); if (reduce) return; driftT = 0; driftBtn.classList.add('on'); fabDrift()?.classList.add('on'); drift = requestAnimationFrame(driftFrame); };

    // ---------------------------------------------------------------- one update per frame for whatever changed
    let cur = null, animating = false, pendingFlash = null, raf = 0;
    function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (stale(g) || !svg.node().isConnected) return; update(); }); }
    // ---------------------------------------------------------------- poles: what the directions mean
    // UMAP's axes mean nothing on their own (Ben, Oct 24: "the orientation of the plane … the directions, etc. don't
    // correspond to meaning") — so ask, live, whether the ones showing happen to be nameable: the items at each edge of
    // the current projection (the outer 15% along ±u and ±v, among those inside the slab at this level) are named against
    // the level's background by the same KL share the regions are named by (/api/field/terms). In meaning + time, once
    // time is turned into the horizontal, the two horizontal poles are simply earlier and later.
    const POLE_CACHE = new Map();
    let poleReq = 0, poleTimer = 0, poleKey = '';
    function poleSets() {
      const rows = (cur && cur.path ? members.get(cur.path) || [] : d3.range(N)).filter(i => visible(F.points[i]));
      const live = rows.filter(i => WT[i] > 0.05);
      const cand = live.length >= 40 ? live : rows;
      if (cand.length < 12) return null;
      const k = Math.max(8, Math.round(cand.length * 0.15));
      const byX = cand.slice().sort((a, b) => PX[a] - PX[b]), byY = cand.slice().sort((a, b) => PY[a] - PY[b]);
      return { bg: rows, sets: [byX.slice(-k), byX.slice(0, k), byY.slice(-k), byY.slice(0, k)] };   // right, left, top, bottom
    }
    const timeAcross = () => MT && Math.abs(R.s1) > 0.7;
    function drawPoles(terms) {
      const across = timeAcross();
      const txt = (t, i) => across && i < 2 ? ((R.s1 > 0) === (i === 0) ? 'later' : 'earlier') : (t || []).slice(0, 3).join(' · ');
      const labels = [
        // the side labels are turned on their sides, so the arrow that points outward once turned is ↑ on both; the
        // time poles carry none (earlier and later say it)
        { k: 'r', x: W - 14, y: H / 2, rot: 90, anchor: 'middle', text: across ? txt(terms[0], 0) : '↑ ' + txt(terms[0], 0) },
        { k: 'l', x: 14, y: H / 2, rot: -90, anchor: 'middle', text: across ? txt(terms[1], 1) : '↑ ' + txt(terms[1], 1) },
        { k: 't', x: W / 2, y: 21, rot: 0, anchor: 'middle', text: '↑ ' + txt(terms[2], 2) },
        { k: 'b', x: W / 2, y: H - (MT ? 26 : 10), rot: 0, anchor: 'middle', text: txt(terms[3], 3) + ' ↓' },
      ];
      const t = gPoles.selectAll('text').data(labels, d => d.k).join(e => e.append('text').style('opacity', 0));
      t.attr('text-anchor', d => d.anchor).attr('transform', d => `translate(${d.x},${d.y}) rotate(${d.rot})`).classed('time', (d, i) => across && i < 2)
        .classed('tb', d => d.k === 't' || d.k === 'b');   // the top and bottom labels are set larger than the turned side ones
      t.each(function (d) { const el = d3.select(this); if (el.text() !== d.text) { el.text(d.text).style('opacity', 0).transition().duration(reduce ? 0 : 420).style('opacity', 1); } });
    }
    function poles() {
      if (L.poles === false || !cur) return;
      const ps = poleSets();
      if (!ps) { gPoles.selectAll('text').remove(); return; }
      // the key is the sets themselves (sizes and a sum), so the same edge seen twice is one request
      const key = `${cur.path}|${timeAcross() ? 'ta' : ''}|` + ps.sets.map(a => a.length + ':' + d3.sum(a)).join('|');
      if (key === poleKey) return;
      poleKey = key;
      if (POLE_CACHE.has(key)) { drawPoles(POLE_CACHE.get(key)); return; }
      const req = ++poleReq;
      fetch('/api/field/terms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ps) })
        .then(r => r.json()).then(terms => {
          if (!Array.isArray(terms)) return;
          POLE_CACHE.set(key, terms);
          if (POLE_CACHE.size > 400) POLE_CACHE.delete(POLE_CACHE.keys().next().value);
          if (req === poleReq && key === poleKey && !stale(g) && svg.node().isConnected) drawPoles(terms);
        }).catch(() => {});
    }
    // the labels wait for the plane to settle a moment (a drag of the tilt slider is many frames), then update together
    function schedulePoles() { if (poleTimer) clearTimeout(poleTimer); poleTimer = setTimeout(() => { poleTimer = 0; if (!stale(g) && svg.node().isConnected) poles(); }, 160); }

    function update() {
      project(); status(); persist();
      if (cur) cur.update();
      schedulePoles();
    }

    // ---------------------------------------------------------------- a circle
    function labelNode(sel, d) {
      const t = sel.append('text').attr('class', 'blab').attr('text-anchor', 'middle');
      if (d.r < 18) return;
      const fs = Math.max(11, Math.min(17.5, d.r / 4.4)), width = d.r * 1.72;
      const words = d.c.name.length ? d.c.name : (d.c.rep || '').split(/\s+/).filter(Boolean).slice(0, 3);
      let name = words[0] || d.path;
      for (let n = Math.min(3, words.length); n >= 1; n--) { const s = words.slice(0, n).join(' · '); if (s.length * 0.55 * fs <= width) { name = s; break; } }
      const size = Math.max(9.5, Math.min(fs, width / (name.length * 0.55))), nch = Math.floor(width / (size * 0.55));
      const lines = [{ cls: 'bn', text: name.length <= nch ? name : name.slice(0, nch - 1) + '…', size }];
      const count = !counting() ? `${d.n}` : `${fmtW(d.w)} of ${d.n}`;
      lines.push({ cls: 'bc', text: `∙ ${count}${HITS && d.hits >= 0.05 ? ` · ${fmtW(d.hits)} hit${d.hits >= 0.95 && d.hits < 1.5 ? '' : 's'}` : ''} ∙`, size: Math.max(9, Math.min(12, size * 0.72)) });
      if (MT && d.r > 30) lines.push({ cls: 'bt', text: spanOf(d.path), size: Math.max(9, Math.min(11.5, d.r / 7)) });
      else if (d.c.name.length && d.r > 64 && d.c.rep) {
        const rs = Math.max(10, Math.min(12, d.r / 7.5)), rn = Math.floor(d.r * 1.5 / (rs * 0.5));
        lines.push({ cls: 'br', text: d.c.rep.length <= rn ? d.c.rep : d.c.rep.slice(0, rn - 1).trim() + '…', size: rs });
      }
      const hs = lines.map(l => l.size * 1.22), tot = d3.sum(hs);
      let yy = -tot / 2;
      lines.forEach((l, i) => { yy += hs[i]; t.append('tspan').attr('class', l.cls).attr('x', 0).attr('y', yy - hs[i] * 0.25).attr('font-size', l.size).text(l.text); });
    }
    function rimNode(sel, d) {
      if (d.r < 8) return;
      const arc = d3.arc().innerRadius(d.r - 3.2).outerRadius(d.r);
      const g2 = sel.append('g').attr('class', 'brim');
      if (fieldState.color === 'meaning') {
        const col = meaningTint(d.idx, i => WT[i]);
        if (col) g2.append('path').attr('d', arc({ startAngle: 0, endAngle: TAU })).attr('fill', col);
      } else if (fieldState.color === 'origin') {
        const counts = d3.rollups(d.idx, v => d3.sum(v, i => WT[i]), i => F.points[i].origin).filter(e => e[1] > 0.01).sort((a, b) => (originRank.get(a[0]) ?? 99) - (originRank.get(b[0]) ?? 99));
        g2.selectAll('path').data(d3.pie().sort(null).value(e => e[1])(counts)).join('path').attr('d', arc).attr('fill', a => originColor(a.data[0]));
      } else if (fieldState.color === 'age') {
        const live = d.idx.filter(i => WT[i] > 0.05);
        g2.append('path').attr('d', arc({ startAngle: 0, endAngle: TAU })).attr('fill', ageRamp(d3.median(live, i => ageT(F.points[i])) || 0));
      } else {
        const share = d3.sum(d.idx, i => F.points[i].reads ? WT[i] : 0) / (d.w || 1);
        if (share > 0) g2.append('path').attr('d', arc({ startAngle: 0, endAngle: TAU * Math.min(1, share) })).attr('fill', 'var(--read)');
      }
    }
    // the miniature of a circle's insides, under the same slab: sub-region circles, or (above a leaf) its items as dots
    function previewNode(sel, d) {
      const gp = sel.append('g').attr('class', 'bprev');
      d.pdots = null; d.pdotBy = null;   // a leaf's dots, kept for the lasso and the marks: [i, x, y] around the circle's centre
      if (d.r < 14 || d.w < 0.05) return;
      const wm = idx => { let w = 0, x = 0, y = 0; for (const i of idx) { w += WT[i]; x += WT[i] * PX[i]; y += WT[i] * PY[i]; } return { w, x: w ? x / w : 0, y: w ? y / w : 0 }; };
      if (d.c.children.length) {
        const kids = d.c.children.map(path => ({ path, ...wm(members.get(path) || []) })).filter(k => k.w > 0.02);
        for (const k of kids) { k.r = d.r * Math.sqrt(0.42 * k.w / d.w); k.dx = k.x - d.wx; k.dy = -(k.y - d.wy); k.m = Math.hypot(k.dx, k.dy); }
        let s = Infinity;
        for (const k of kids) if (k.m > 1e-9) s = Math.min(s, Math.max(0, PREV * d.r - k.r) / k.m);
        if (!Number.isFinite(s)) s = 0;
        gp.selectAll('circle').data(kids).join('circle').attr('cx', k => k.dx * s).attr('cy', k => k.dy * s).attr('r', k => k.r);
      } else {
        const live = d.idx.filter(i => WT[i] > 0.04);
        const rad = live.map(i => Math.hypot(PX[i] - d.wx, PY[i] - d.wy)).sort((a, b) => a - b);
        const s = 0.82 * d.r / (rad[Math.floor(rad.length * 0.9)] || rad[rad.length - 1] || 1);
        const dr = Math.max(0.8, Math.min(2.4, d.r / 40));
        const pos = live.map(i => { const dx = (PX[i] - d.wx) * s, dy = -(PY[i] - d.wy) * s, m = Math.hypot(dx, dy), mx = d.r * 0.9; return m > mx ? [i, dx * mx / m, dy * mx / m] : [i, dx, dy]; });
        d.pdots = pos; d.pdotBy = new Map(pos.map(q => [q[0], [q[1], q[2]]]));
        gp.selectAll('circle').data(pos).join('circle').attr('class', 'dot').attr('r', dr).style('fill', q => fillOf(F.points[q[0]])).style('fill-opacity', q => 0.2 + 0.6 * WT[q[0]])
          .attr('cx', q => q[1]).attr('cy', q => q[2]);
      }
    }
    // an arrow between two circles, from the cited region to the citing one (the way ideas travel; Ben, Oct 23: "these citations are directed …
    // a different weight each way"). When citations run both ways each arrow
    // bends to its own left, so the pair reads ⇄ with its own width each way; one way only, a gentle bend. The shaft
    // leaves and meets the circles a little to that side, and ends at the base of a filled head sized to its width.
    function arrowGeom(a) {
      const A = a.from, B = a.to, ra = A.r * A.s, rb = B.r * B.s;
      const dx = B.x - A.x, dy = B.y - A.y, D = Math.hypot(dx, dy) || 1, ux = dx / D, uy = dy / D, len = D - ra - rb;
      if (len < 8 || A.r < 3 || B.r < 3) return null;
      const nx = uy, ny = -ux;   // the arrow's left
      const bend = (a.other ? 1 : 0.35) * Math.min(20, len * 0.18);
      const fa = Math.min(0.45, 0.6 * bend / ra), fb = Math.min(0.45, 0.6 * bend / rb);
      const sx = A.x + ra * (ux * Math.cos(fa) + nx * Math.sin(fa)), sy = A.y + ra * (uy * Math.cos(fa) + ny * Math.sin(fa));
      const tx = B.x + rb * (-ux * Math.cos(fb) + nx * Math.sin(fb)), ty = B.y + rb * (-uy * Math.cos(fb) + ny * Math.sin(fb));
      const cx = (sx + tx) / 2 + nx * bend, cy = (sy + ty) / 2 + ny * bend;
      const tm = Math.hypot(tx - cx, ty - cy) || 1, tux = (tx - cx) / tm, tuy = (ty - cy) / tm;
      const h = Math.min(len * 0.4, 6 + 1.4 * a.w), hw = h * 0.5;
      const bx = tx - tux * h, by = ty - tuy * h, ex = tx - tux * h * 0.6, ey = ty - tuy * h * 0.6;
      return {
        d: `M${sx.toFixed(1)},${sy.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`,
        h: `M${tx.toFixed(1)},${ty.toFixed(1)}L${(bx - tuy * hw).toFixed(1)},${(by + tux * hw).toFixed(1)}L${(bx + tuy * hw).toFixed(1)},${(by - tux * hw).toFixed(1)}Z`,
        mx: 0.25 * sx + 0.5 * cx + 0.25 * ex, my: 0.25 * sy + 0.5 * cy + 0.25 * ey, len,
      };
    }

    // ---------------------------------------------------------------- a level of circles
    function buildBlobs(st) {
      const { scene } = st;
      const M = st.path ? 46 : 16;
      const kids = st.path ? st.c.children.map(path => byPath.get(path)).filter(Boolean) : topLevel;
      const nodes = kids.map(c => ({ c, path: c.path, idx: members.get(c.path) || [], x: W / 2, y: H / 2, r: 0, s: 1, theta: Math.random() * TAU }));
      const nodeOf = new Int16Array(N).fill(-1);
      nodes.forEach((d, j) => { for (const i of d.idx) nodeOf[i] = j; });
      // the citations between circles (fixed per level; their weights move with the slab) and, inside a region, those leaving it
      const pairs = new Map(), outs = [];
      for (const [i, j, type] of F.edges) {
        const A = nodeOf[i], B = nodeOf[j];
        if (A >= 0 && B >= 0 && A !== B) {
          const [a, b] = A < B ? [A, B] : [B, A], key = a + '|' + b;
          let l = pairs.get(key);
          if (!l) pairs.set(key, l = { source: nodes[a], target: nodes[b], edges: [], fw: [], bw: [], byF: {}, byB: {}, by: {}, n: 0 });
          l.edges.push([i, j]); l.by[type] = (l.by[type] || 0) + 1; l.n++;
          const fw = A === a;   // the citing item is in the source circle
          (fw ? l.fw : l.bw).push([i, j]); const by2 = fw ? l.byF : l.byB; by2[type] = (by2[type] || 0) + 1;
        } else if (st.path && (A >= 0) !== (B >= 0)) outs.push({ node: A >= 0 ? A : B, i: A >= 0 ? i : j, o: A >= 0 ? j : i });
      }
      const links = [...pairs.values()].sort((a, b) => b.n - a.n);
      links.forEach((l, k) => { l.tr = (l.by[ACC] || 0) / l.n > 0.5; l.bend = k % 2 ? 1 : -1; });
      // one arrow per direction that has citations, the way ideas travel: from the cited circle to the citing one
      // (fw = citations made from inside the source circle, so their arrow runs target → source)
      const arrs = links.flatMap(l => [
        l.fw.length ? { l, from: l.target, to: l.source, edges: l.fw, other: l.bw.length, tr: (l.byF[ACC] || 0) / l.fw.length > 0.5 } : null,
        l.bw.length ? { l, from: l.source, to: l.target, edges: l.bw, other: l.fw.length, tr: (l.byB[ACC] || 0) / l.bw.length > 0.5 } : null,
      ]).filter(Boolean);
      const gAx = MT ? scene.append('g').attr('class', 'btaxis') : null;
      const gR = scene.append('g').attr('class', 'bribs').attr('display', L.cites ? null : 'none');
      const gS = scene.append('g').attr('class', 'bstubs').attr('display', L.cites ? null : 'none');
      const gB = scene.append('g').attr('class', 'bnodes');
      const gRL = scene.append('g').attr('class', 'bribl').attr('display', L.cites ? null : 'none');
      // the loupe in the open space between the circles (Ben, Oct 23): the nearest items whose places in this projection
      // fall under it (at most 50, nearest first). Over a circle it gives way, and a click there still goes in.
      const gLD = scene.append('g').attr('class', 'bldots');
      const ring = scene.append('circle').attr('class', 'bloupe').attr('display', 'none');
      const gBub = scene.append('g').attr('class', 'bbubs');
      const gapLoupe = () => L.loupe !== false && !MARK.on && !animating && cur === st && !!FOC && !!st.gapOn;
      const GAP_R = 88, GAP_N = 4;   // smaller and quieter than the bottom level's (Ben: "slightly smaller/more minimal")
      ring.classed('gap', true);
      const bubbles = makeBubbles(gBub, gapLoupe, { R: GAP_R, BR: 80 });
      const LD = new Map();   // item → its dot object, reused so the text circles keep their state
      st.hover = () => {
        st.gapOn = L.loupe !== false && !MARK.on && !animating && cur === st && !!FOC && !!st.xf && !nodes.some(d => d.r >= 3 && Math.hypot(d.x - FOC[0], d.y - FOC[1]) <= d.r + 2);
        ring.attr('display', st.gapOn ? null : 'none');
        if (!st.gapOn) { gLD.selectAll('*').remove(); bubbles.clear(); return; }
        const zk = ZT.k, rl = GAP_R / zk, { cx: ox, cy: oy, scale } = st.xf;
        const dotOf = (i, bx, by) => {
          let d = LD.get(i);
          if (!d) LD.set(i, d = { i, p: F.points[i] });
          d.bx = bx; d.by = by; d.w = WT[i]; d.dd = Math.hypot(bx - FOC[0], by - FOC[1]); [d.x, d.y, d.z] = fish(bx, by, rl);
          return d;
        };
        let near = [], text = [];
        for (const i of st.path ? (members.get(st.path) || []) : d3.range(N)) {
          if (WT[i] < 0.1) continue;
          const bx = W / 2 + (PX[i] - ox) * scale, by = H / 2 - (PY[i] - oy) * scale;
          if (Math.hypot(bx - FOC[0], by - FOC[1]) < rl) near.push(dotOf(i, bx, by));
        }
        near.sort((p, q) => p.dd - q.dd);
        near = near.slice(0, 50);
        // one text circle per post: a blyg mirrored at two addresses carries the same posts twice
        for (const d of near) { const key = (d.p.title || '') + '|' + (d.p.author || ''); if (text.length < GAP_N && !text.some(x => (x.p.title || '') + '|' + (x.p.author || '') === key)) text.push(d); }
        ring.attr('cx', FOC[0]).attr('cy', FOC[1]).attr('r', rl);
        gLD.selectAll('circle').data(near, d => d.i).join('circle').attr('class', 'ldot')
          .attr('cx', d => d.x.toFixed(1)).attr('cy', d => d.y.toFixed(1)).attr('r', d => (2 * d.z / Math.sqrt(Math.max(1, zk))).toFixed(2))
          .style('fill', d => fillOf(d.p)).style('opacity', d => 0.3 + 0.7 * d.w)
          .on('click', (ev, d) => { ev.stopPropagation(); openItem(d.p); });
        bubbles.target(text, rl);
      };
      const rib = gR.selectAll('g').data(arrs).join(e => { const g2 = e.append('g'); g2.append('path').attr('class', 'rs'); g2.append('path').attr('class', 'rh'); return g2; })
        .attr('class', a => 'brib arrow' + (a.tr ? ' tr' : ''));
      const ribl = gRL.selectAll('text').data(arrs).join('text');
      const stubs = st.path ? gS.selectAll('g').data(nodes).join('g') : null;
      if (stubs) { stubs.append('path').attr('class', 'bstub'); stubs.append('text').attr('class', 'bstubl'); }
      const node = gB.selectAll('g.bnode').data(nodes, d => d.path).join('g').attr('class', 'bnode').attr('tabindex', 0).attr('role', 'button');
      const nodeTip = d => {
        const conn = links.filter(l => (l.source === d || l.target === d) && l.ne >= 0.05).sort((a, b) => b.ne - a.ne);
        const blygs = d3.rollups(d.idx, v => d3.sum(v, i => WT[i]), i => F.points[i].origin).filter(e => e[1] >= 0.05).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, w]) => `${esc(short(o).replace(/\/blyg$/, ''))} ${fmtW(w)}`).join(' · ');
        const lv2 = levelFor(d.path);
        return `<b>${esc(nameOf(d.c, 4))}</b><div class="small muted">${esc((d.c.rep || '').slice(0, 90))}</div>
          <div class="small">${!counting() ? `${d.n} items` : `≈${fmtW(d.w)} of its ${d.n} items inside ${where()}`}${blygs ? ' · ' + blygs : ''}</div>
          ${d.heat > 0.001 ? `<div class="small accent">pulse ${d.heat.toFixed(2)} inside</div>` : ''}
          ${HITS ? `<div class="small accent">${fmtW(d.hits)} of the search's ${HITS.size} hits inside</div>` : ''}
          ${conn.length ? `<div class="small">${conn.slice(0, 5).map(l => `${esc(nameOf((l.source === d ? l.target : l.source).c, 2))} <b>${fmtW(l.ne)}</b>`).join(' · ')}${conn.length > 5 ? ` · +${conn.length - 5}` : ''}</div>` : ''}
          ${d.outW >= 0.05 ? `<div class="small muted">≈${fmtW(d.outW)} to other regions</div>` : ''}
          <div class="small muted">click to go in — ${lv2.kind === 'items' ? 'the items' : lv2.c.children.length + ' sub-regions'} · shift-click: lens here</div>`;
      };
      const light = d => {
        gR.classed('hov', !!d); gRL.classed('hov', !!d);
        rib.classed('on', a => d && (a.from === d || a.to === d));
        ribl.classed('on', a => d && (a.from === d || a.to === d));
      };
      let hovNode = null;
      node.on('mouseenter', (ev, d) => { hovNode = d; light(d); }).on('mousemove', (ev, d) => tip(ev, nodeTip(d))).on('mouseleave', () => { hovNode = null; light(null); tipOff(); })
        .on('click', (ev, d) => {
          ev.stopPropagation(); tipOff();
          if (ev.shiftKey) return setLens('c:' + d.path);
          if (!animating) enter(d.path);
        })
        .on('keydown', (ev, d) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); enter(d.path); } });

      const clampIn = () => { for (const d of nodes) { if (d.r < 3) continue; d.x = Math.max(M + d.r, Math.min(W - M - d.r, d.x)); d.y = Math.max(M + d.r, Math.min(H - M - d.r, d.y)); } };
      const collide = d3.forceCollide(d => d.r >= 3 ? d.r + GAP / 2 : 0).strength(0.75).iterations(2);
      const sim = d3.forceSimulation(nodes).stop().velocityDecay(0.38).alphaTarget(reduce ? 0 : 0.03)
        .force('target', () => { for (const d of nodes) { d.vx += (d.tx - d.x) * 0.07; d.vy += (d.ty - d.y) * 0.07; } })
        .force('collide', collide)
        .force('wander', () => { if (reduce) return; for (const d of nodes) { d.theta += (Math.random() - 0.5) * 0.35; d.vx += Math.cos(d.theta) * 0.02; d.vy += Math.sin(d.theta) * 0.02; } });

      st.update = () => {
        // sizes: area ∝ weight inside the slab, on the scale a fully counted level would have, partly compensated when the
        // slab holds little (by (N/Σw)^¼, at most 2.2×) so a thin slice stays legible; the label carries the true count
        const nfull = nodes.map(d => d.idx.filter(i => visible(F.points[i])).length);
        const Nfull = d3.sum(nfull) || 1;
        let kk0 = Math.sqrt((nodes.length > 8 ? 0.31 : 0.28) * (W - 2 * M) * (H - 2 * M) / (Math.PI * Nfull));
        kk0 = Math.min(kk0, 0.3 * Math.min(W, H) / Math.sqrt(d3.max(nfull) || 1));
        let wsum = 0;
        nodes.forEach((d, j) => {
          d.n = nfull[j];
          let w = 0, x = 0, y = 0, heat = 0, hits = 0;
          for (const i of d.idx) {
            const wi = WT[i];
            if (!wi) continue;
            w += wi; x += wi * PX[i]; y += wi * PY[i];
            if (HEAT.size) heat += (HEAT.get(i) || 0) * wi;
            if (HITS && HITS.has(i)) hits += wi;
          }
          // the place: the weighted mean of the members' projections, held toward the full centroid when little is inside
          const [fx, fy] = projQ(QC.get(d.path));
          // qx, qy: the full centroid's projection (not fx/fy, which d3-force reads as pinned positions)
          d.qx = fx; d.qy = fy; d.w = w; d.heat = L.pulse ? heat : 0; d.hits = hits;
          const k0 = 0.6;
          d.wx = (x + k0 * fx) / (w + k0); d.wy = (y + k0 * fy) / (w + k0);
          wsum += w;
        });
        const comp = Math.max(1, Math.min(2.2, Math.pow(Nfull / Math.max(wsum, 1e-6), 0.25)));
        for (const d of nodes) { d.r = Math.min(0.34 * Math.min(W, H), kk0 * comp * Math.sqrt(d.w)); if (d.r < 3) d.r = 0; }
        // the frame: the full centroids fitted into the field (depends on the tilt, not on the slab, so sliding doesn't zoom)
        let cx = d3.mean(nodes, d => d.qx), cy = d3.mean(nodes, d => d.qy);
        const ex = d3.max(nodes, d => Math.abs(d.qx - cx)) || 1, ey = d3.max(nodes, d => Math.abs(d.qy - cy)) || 1;
        const rFull = 0.5 * kk0 * Math.sqrt(d3.max(nfull) || 1);
        let scale = Math.min((W / 2 - M - rFull) / ex, (H / 2 - M - rFull) / ey);
        // Fill (Ben, Nov 6: "when the slab is thin the clusters are small and its all concentrated in the center … they
        // should largely scale up if its just a few small ones just to fill more of the screen. but smoothly"). The
        // frame above is fitted to the full centroids, so sliding alone never zooms; on top of it, a similarity
        // transform (positions and radii together, so nothing new overlaps) blows up the visible circles' bounding box
        // to fill the field: at most 3×, never past a circle 0.42 of the short side, never below 1×. It is eased
        // (τ 0.45 s, the circles following on their springs), so the view breathes as the slab moves rather than
        // jumping, and set at once when a level opens. Toggle: `fill` in the panel, key z.
        {
          let tgt = { f: 1, ox: 0, oy: 0 };
          const V = nodes.filter(d => d.r >= 3);
          if (L.fill !== false && V.length) {
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, rmax = 0;
            for (const d of V) {
              const bx = W / 2 + (d.wx - cx) * scale, by = H / 2 - (d.wy - cy) * scale;
              x0 = Math.min(x0, bx - d.r); x1 = Math.max(x1, bx + d.r); y0 = Math.min(y0, by - d.r); y1 = Math.max(y1, by + d.r);
              rmax = Math.max(rmax, d.r);
            }
            // Two limits (Ben, after the first pass: "now they're overlapping … i still like when they're spatially
            // separated and you can see the arrows"): the targets' box must fit, and so must the circles once the
            // collision force has spread them — the targets sit closer than the settled circles do, and a layout
            // pushed past the edge gets clamped back into overlap. The second is a packing budget: the circles plus
            // the gap each keeps, at a loose density (0.4) in the square on the short side. Largest f in [1, 3] that
            // passes both, by bisection.
            const W2 = W - 2 * M, H2 = H - 2 * M, side = Math.min(W2, H2);
            const fits = f => (x1 - x0) * f <= W2 * 0.92 && (y1 - y0) * f <= H2 * 0.92 && f * rmax <= 0.36 * side
              && V.reduce((a, d) => a + Math.PI * (f * (d.r + GAP / 2) + 6) ** 2, 0) <= 0.4 * side * side;
            let f = 1;
            if (fits(1)) { let lo = 1, hi = 3; if (fits(hi)) lo = hi; else for (let it = 0; it < 18; it++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; } f = lo; }
            tgt = { f, ox: (W / 2 - (x0 + x1) / 2) / scale, oy: (H / 2 - (y0 + y1) / 2) / scale };
          }
          const now = performance.now();
          if (!st.fz || reduce) st.fz = { ...tgt };
          else {
            const k = 1 - Math.exp(-Math.min(0.1, (now - (st.fzT || now)) / 1000) / 0.45);
            st.fz.f += (tgt.f - st.fz.f) * k; st.fz.ox += (tgt.ox - st.fz.ox) * k; st.fz.oy += (tgt.oy - st.fz.oy) * k;
          }
          st.fzT = now;
          const fz = st.fz;
          cx -= fz.ox; cy += fz.oy; scale *= fz.f;
          for (const d of nodes) d.r *= fz.f;
          const moving = Math.abs(tgt.f - fz.f) > 0.003 || Math.abs(tgt.ox - fz.ox) * scale > 0.5 || Math.abs(tgt.oy - fz.oy) * scale > 0.5;
          if (moving && !st.fzRaf) st.fzRaf = requestAnimationFrame(() => { st.fzRaf = 0; if (!stale(g) && cur === st && !animating && svg.node().isConnected) st.update(); });   // a drill in flight finishes first; its end calls update
          if (!moving) st.fzT = 0;
        }
        for (const d of nodes) { d.tx = W / 2 + (d.wx - cx) * scale; d.ty = H / 2 - (d.wy - cy) * scale; }
        st.xf = { cx, cy, scale };
        if (gAx) drawTimeAxis(gAx, cx, scale);
        if (!st.placed) { for (const d of nodes) { d.x = d.tx; d.y = d.ty; } st.placed = true; for (let i = 0; i < 60; i++) { sim.tick(); clampIn(); } }
        // arrows: Σ wᵢ·wⱼ over each direction's citations (a pair's total is both); the faint ones wait for a hover
        let maxNe = 0;
        for (const l of links) l.ne = 0;
        for (const a of arrs) { let s = 0; for (const [i, j] of a.edges) s += WT[i] * WT[j]; a.ne = s; a.l.ne += s; maxNe = Math.max(maxNe, s); }
        const quietNe = Math.max(0.3, arrs.length > 22 ? 0.15 * maxNe : 0);
        for (const a of arrs) {
          a.w = 1.3 + 2.3 * Math.log1p(a.ne);
          a.alpha = 0.22 + 0.4 * Math.log1p(a.ne) / Math.log1p(maxNe || 1);
          a.quiet = a.ne < quietNe;
        }
        rib.attr('stroke-width', a => a.w).classed('quiet', a => a.quiet).style('opacity', a => a.quiet ? null : a.alpha * (HITS && !(a.from.hits >= 0.05 && a.to.hits >= 0.05) ? 0.35 : 1));
        ribl.classed('quiet', a => a.quiet || a.ne < 0.95).text(a => fmtW(a.ne));
        // an arrow whose citations all lie outside the slice stands for nothing in view: not drawn, even on a hover
        // (Ben, Nov 9: "arrows labeled with a 0 just shouldn't be drawn")
        rib.attr('display', a => a.ne < 0.05 ? 'none' : null);
        ribl.attr('display', a => a.ne < 0.05 ? 'none' : null);
        // stubs: per sub-region, the weight of its citations leaving the region, pointed (in this same projection) toward
        // the regions they go to
        if (stubs) {
          for (const d of nodes) { d.out = new Map(); d.outW = 0; }
          for (const o of outs) {
            const w = WT[o.i] * WT[o.o];
            if (w < 1e-4) continue;
            const d = nodes[o.node], to = ancestors(cOf(F.points[o.o]))[st.path.split('.').length - 1];   // the far end's ancestor at this level: a sibling, or a region elsewhere
            d.out.set(to, (d.out.get(to) || 0) + w); d.outW += w;
          }
          const [hx, hy] = projQ(QC.get(st.path));
          for (const d of nodes) {
            let vx = 0, vy = 0;
            for (const [r, w] of d.out) { const [ox, oy] = projQ(QC.get(r)), dx = ox - hx, dy = -(oy - hy), m = Math.hypot(dx, dy) || 1; vx += w * dx / m; vy += w * dy / m; }
            if (Math.hypot(vx, vy) < 1e-9) { vx = d.x - W / 2; vy = d.y - H / 2; }
            const m = Math.hypot(vx, vy) || 1; d.su = [vx / m, vy / m];
          }
          stubs.style('display', d => d.outW >= 0.5 && d.r >= 3 ? null : 'none');
          stubs.select('path').attr('stroke-width', d => 1 + 0.6 * Math.log1p(d.outW));
          stubs.select('text').text(d => fmtW(d.outW) + ' out');
        }
        // the circles' insides
        const maxHeat = d3.max(nodes, d => d.heat) || 0, maxHits = d3.max(nodes, d => d.hits) || 0;
        node.style('display', d => d.r >= 3 ? null : 'none').style('opacity', d => HITS && d.hits < 0.05 ? 0.32 : clamp01((d.r - 3) / 8) * 0.7 + 0.3)
          .attr('aria-label', d => `${nameOf(d.c, 4)}, ${fmtW(d.w)} of ${d.n} items inside`);
        node.each(function (d) {
          const s = d3.select(this);
          s.selectAll('*').remove();
          if (d.r < 3) return;
          const hi = maxHeat ? d.heat / maxHeat : 0;
          if (hi > 0.06) s.append('circle').attr('class', 'bhalo').attr('r', d.r * 1.22).attr('fill', 'url(#bglow)').style('opacity', 0.08 + 0.5 * Math.pow(hi, 1.3));
          s.append('circle').attr('class', 'bbody').attr('r', d.r).style('fill', fieldState.color === 'meaning' ? meaningTint(d.idx, i => WT[i], true) : null);
          if (d.heat > 0) s.append('circle').attr('class', 'btint').attr('r', d.r).style('opacity', 0.1 * hi);
          previewNode(s, d);
          rimNode(s, d);
          if (HITS && d.hits >= 0.05) s.append('circle').attr('class', 'bhitring').attr('r', d.r + 3).attr('stroke-width', 1.5 + 3.5 * d.hits / (maxHits || 1));
          labelNode(s, d);
        });
        // the gap grows with the fill (×f, the same as everything else), so a zoomed-in slice is the unzoomed one
        // scaled, with room for its arrows between the circles
        const gapK = st.fz ? st.fz.f : 1;
        collide.radius(d => d.r >= 3 ? d.r + GAP * gapK / 2 : 0);
        if (hovNode) light(hovNode);
        if (FOC && st.hover) st.hover();
        st.tick(); crumbs(st);
        if (!reduce) sim.alpha(Math.max(sim.alpha(), 0.3)).restart();
      };
      st.tick = () => {
        node.attr('transform', d => `translate(${d.x.toFixed(1)},${d.y.toFixed(1)})`);
        marksSoon();
        if (!L.cites) return;
        rib.each(function (a) { const gm = arrowGeom(a); a.gm = gm; this.firstChild.setAttribute('d', gm ? gm.d : ''); this.lastChild.setAttribute('d', gm ? gm.h : ''); });
        const placed = [];
        ribl.each(function (l) {
          const gm = l.gm;
          const ok = gm && gm.len >= 22 && !nodes.some(o => o.r >= 3 && Math.hypot(gm.mx - o.x, gm.my - o.y) < o.r + 6) && !placed.some(q => Math.abs(q[0] - gm.mx) < 18 && Math.abs(q[1] - gm.my) < 13);
          if (!ok) { this.setAttribute('visibility', 'hidden'); return; }
          if (!l.quiet) placed.push([gm.mx, gm.my]);
          this.removeAttribute('visibility'); this.setAttribute('x', gm.mx.toFixed(1)); this.setAttribute('y', (gm.my + 3.5).toFixed(1));
        });
        if (stubs) stubs.each(function (d) {
          if (!d.su || d.r < 3) return;
          const [ux, uy] = d.su, L0 = 14 + 7 * Math.log1p(d.outW);
          const x0 = d.x + ux * (d.r + 4), y0 = d.y + uy * (d.r + 4), x1 = d.x + ux * (d.r + 4 + L0), y1 = d.y + uy * (d.r + 4 + L0);
          this.firstChild.setAttribute('d', `M${x0.toFixed(1)},${y0.toFixed(1)}L${x1.toFixed(1)},${y1.toFixed(1)}`);
          this.lastChild.setAttribute('x', (x1 + ux * 12).toFixed(1)); this.lastChild.setAttribute('y', (y1 + uy * 10 + 3.5).toFixed(1));
        });
      };
      sim.on('tick', () => { if (stale(g) || !scene.node().isConnected) { sim.stop(); return; } clampIn(); st.tick(); });
      st.sim = sim; st.nodes = nodes; st.links = links;
      st.summary = () => {
        const shown = nodes.filter(d => d.r >= 3).length, ne = d3.sum(links, l => l.ne), out = d3.sum(nodes, d => d.outW || 0);
        return `${shown} of ${nodes.length} ${st.path ? 'sub-regions' : 'regions'} inside · ≈${fmtW(ne)} ${FW.edges} between them${st.path && out >= 0.5 ? ` · ≈${fmtW(out)} leaving` : ''}`;
      };
    }

    // ---------------------------------------------------------------- the loupe's machinery (the bottom level, and the
    // open space between the circles above it): a circular fisheye around the cursor, and the drifting text circles
    const RL = 130, DIST = 2.6, NBUB = 6, BUB_R = 100;
    const fish = (x, y, rl) => {
      const dx = x - FOC[0], dy = y - FOC[1], dd = Math.hypot(dx, dy);
      if (dd >= rl) return [x, y, 1, false];
      const e = Math.exp(DIST), k0 = e / (e - 1) * rl, k1 = DIST / rl;
      if (!dd) return [x, y, k0 * k1 * 0.75 + 0.25, true];
      const k = k0 * (1 - Math.exp(-dd * k1)) / dd * 0.75 + 0.25;
      // the size: a floor for anything inside the ring, so its edge reads as an edge, rising toward the centre — but
      // never by more than the lens moves the dots apart there (k, ~2.4 at the centre), so dots that touch outside
      // the loupe do not grow into each other under the cursor, where they are being picked
      return [FOC[0] + dx * k, FOC[1] + dy * k, Math.max(1.9, Math.min(1.9 + 1.5 * Math.pow(1 - dd / rl, 1.5), k)), true];
    };
    // The text circles (Ben, Oct 23, after a fixed-slot pass: "still kinda slide around and its geometric … instead of
    // snapping to the target configuration it drifts towards it"). The target is geometric: the nearest six on the rim,
    // each in its own direction, sized by its distance from the cursor (like the slab's weight), pushed apart to clear
    // each other. Each circle's angle and size then ease toward that target, so it slides rather than snaps, grows in as
    // it arrives and shrinks away as it leaves. `live` is the nearest items as dot objects ({ i, p, bx, by, x, y }),
    // nearest first; `alive()` says whether the loupe this belongs to is still up.
    // `o.R` / `o.BR`: the ring's and the circles' radii (the loupe between the circles is the smaller, quieter one)
    // The part of the scene that can be seen, in its own coordinates: the svg cut by the window, less the dock in full
    // screen. The text circles are kept inside it.
    function visibleBox(zk) {
      const rc = svg.node().getBoundingClientRect();
      const dock = isFull() && !document.body.classList.contains('fbare') ? (parseFloat(getComputedStyle(document.body).getPropertyValue('--dockh')) || 0) + 26 : 0;
      const l = Math.max(0, -rc.left), t = Math.max(0, -rc.top), r = Math.min(W, innerWidth - rc.left), b = Math.min(H, innerHeight - rc.top - dock);
      return [(l - ZT.x) / zk, (t - ZT.y) / zk, (r - ZT.x) / zk, (b - ZT.y) / zk];
    }
    function makeBubbles(gBub, alive, o = {}) {
      const R0 = o.R || RL, BR = o.BR || BUB_R, sc = BR / BUB_R;
      const BS = new Map();   // dot → its circle's eased state { a, s } and target { ta, ts }
      let pointedB = null, bubRaf = 0, bubT = 0;
      function target(live, rl) {
        const dist = d => Math.hypot(d.bx - FOC[0], d.by - FOC[1]);
        const want = new Set(live);
        for (const d of live) {
          let b = BS.get(d);
          const ga = Math.atan2(d.by - FOC[1], d.bx - FOC[0]) || -Math.PI / 2;
          if (!b) BS.set(d, b = { d, a: ga, s: 0 });
          b.ts = 0.7 + 0.3 * Math.exp(-((dist(d) / (0.55 * rl)) ** 2)); b.ga = ga;   // 70% at the rim (still readable) to full near the cursor
        }
        for (const b of BS.values()) if (!want.has(b.d)) b.ts = 0;
        const act = [...BS.values()].filter(b => b.ts > 0);
        for (const b of act) b.ta = b.ga;
        const wrap = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
        for (let it = 0; it < 30 && act.length > 1; it++) {
          for (const b of act) b.ta = wrap(b.ta);
          act.sort((p, q) => p.ta - q.ta);
          for (let j = 0; j < act.length; j++) {
            const p = act[j], q = act[(j + 1) % act.length], rr = BR * (p.ts + q.ts) / 2;
            const gap = 2 * Math.asin(Math.min(1, (rr + 5) / (R0 + rr)));
            let diff = q.ta - p.ta; if (j === act.length - 1) diff += TAU;
            if (diff < gap) { p.ta -= (gap - diff) / 2; q.ta += (gap - diff) / 2; }
          }
        }
        // Near an edge of the window some directions have no room for a circle. It used to be pushed back in, onto the
        // loupe and the dots under it (Ben, Nov 10: "bumping up against the top of the window, covering up the map
        // itself/making it hard to click"). Now, nearest item first, a circle that does not fit turns to the nearest
        // direction where it does and is clear of those already placed; when there is none it is not shown, so near
        // an edge the loupe opens fewer items rather than covering itself.
        {
          const zk = ZT.k, [x0, y0, x1, y1] = visibleBox(zk), placed = [];
          const fits = (a, ts) => { const rs = BR * ts / zk, r = rl + rs + 6 / zk, x = FOC[0] + Math.cos(a) * r, y = FOC[1] + Math.sin(a) * r; return x >= x0 + rs && x <= x1 - rs && y >= y0 + rs && y <= y1 - rs; };
          const clear = (a, ts) => placed.every(q => Math.abs(wrap(a - q.ta)) >= 0.97 * 2 * Math.asin(Math.min(1, (BR * (ts + q.ts) / 2 + 5) / (R0 + BR * (ts + q.ts) / 2))));
          for (const d of live) {
            const b = BS.get(d);
            if (!b || !(b.ts > 0)) continue;
            let a = null;
            if (fits(b.ta, b.ts) && clear(b.ta, b.ts)) a = b.ta;
            else for (let k = 1; k <= 60 && a === null; k++) for (const sg of [1, -1]) { const c = wrap(b.ta + sg * k * 0.0524); if (fits(c, b.ts) && clear(c, b.ts)) { a = c; break; } }   // 3° steps, either way round
            if (a === null) { b.ts = 0; continue; }
            b.ta = a; placed.push(b);
          }
        }
        pointedB = live.find(d => { const b = BS.get(d); return b && b.ts > 0; }) || null;
        const fetch = live.map(d => d.i).filter(i => !EXC.has(i) && !EXCWANT.has(i));
        if (fetch.length) fetchExcerpts(fetch, () => { if (alive()) draw(); });
        if (!bubRaf) { bubT = 0; bubRaf = requestAnimationFrame(frame); }
      }
      function frame(t) {
        bubRaf = 0;
        if (stale(g) || !alive()) return;
        const dt = bubT ? Math.min(0.1, (t - bubT) / 1000) : 1 / 60; bubT = t;
        // angle: eased (τ 0.35 s) and capped at 2.6 rad/s round the ring, so a dot the cursor passes over (whose direction
        // swings half a turn) carries its circle round rather than flinging it; size: eased (τ 0.2 s)
        // Default since Nov 6 (Ben: "i kinda liked it like before when they just instantaneously snapped to the closest
        // spot"): snap — every circle sits at its target at once; the eased drift is the `ease` toggle (key e)
        const snap = reduce || !L.ease;
        const ka = snap ? 1 : 1 - Math.exp(-dt / 0.35), ks = snap ? 1 : 1 - Math.exp(-dt / 0.2), wmax = snap ? Infinity : 2.6 * dt;
        let moving = false;
        for (const [d, b] of BS) {
          const da = ((b.ta - b.a + Math.PI) % TAU + TAU) % TAU - Math.PI;   // the short way round
          if (b.ts > 0) b.a += Math.max(-wmax, Math.min(wmax, da * ka));   // a leaving circle keeps its direction while it shrinks
          b.s += (b.ts - b.s) * ks;
          if (b.ts === 0 && b.s < 0.02) { BS.delete(d); continue; }
          if ((b.ts > 0 && Math.abs(da) > 0.002) || Math.abs(b.ts - b.s) > 0.004) moving = true;
        }
        draw();
        if (moving) bubRaf = requestAnimationFrame(frame);
      }
      function draw() {
        if (!FOC) return;
        const zk = ZT.k, rl = R0 / zk;
        const [x0, y0, x1, y1] = visibleBox(zk);
        const bubs = [...BS.values()];
        for (const b of bubs) {
          const rs = BR * b.s / zk, r = rl + rs + 6 / zk;
          b.x = Math.max(x0 + rs, Math.min(x1 - rs, FOC[0] + Math.cos(b.a) * r));
          b.y = Math.max(y0 + rs, Math.min(y1 - rs, FOC[1] + Math.sin(b.a) * r));
        }
        const bub = gBub.selectAll('g.bub').data(bubs, b => b.d.i).join(enter => {
          // a text circle opens its item like its dot does (Ben, Oct 29: clicking in the loupe did nothing)
          const e = enter.append('g').attr('class', 'bub').on('click', (ev, b) => { ev.stopPropagation(); tipOff(); openItem(b.d.p); });
          e.append('line');
          e.append('g').attr('class', 'bubc');
          return e;
        });
        bub.sort((p, q) => p.s - q.s).classed('first', b => b.d === pointedB).style('opacity', b => Math.min(1, b.s * 1.8));
        bub.select('line').attr('x1', b => b.d.x).attr('y1', b => b.d.y).attr('x2', b => b.x).attr('y2', b => b.y).style('stroke', b => fillOf(b.d.p));
        bub.select('g.bubc').attr('transform', b => `translate(${b.x.toFixed(1)},${b.y.toFixed(1)}) scale(${(b.s * sc / zk).toFixed(4)})`).each(function (b) {
          const key = b.d.i + ':' + (EXC.has(b.d.i) ? 1 : 0);
          if (this.dataset.key === key) return;
          this.dataset.key = key;
          const s = d3.select(this); s.selectAll('*').remove();
          s.append('circle').attr('r', BUB_R).style('stroke', fillOf(b.d.p));
          const p = b.d.p, ex = EXC.get(b.d.i) || null, own = ex && ex.own && ex.x;
          s.append('foreignObject').attr('x', -BUB_R).attr('y', -BUB_R).attr('width', 2 * BUB_R).attr('height', 2 * BUB_R)
            .html(`<div xmlns="http://www.w3.org/1999/xhtml" class="bubt" style="width:${2 * BUB_R}px;height:${2 * BUB_R}px;padding:${Math.round(BUB_R * 0.3)}px ${Math.round(BUB_R * 0.24)}px">${own ? '' : `<b>${esc((p.title || '(untitled)').slice(0, 90))}</b>`}${ex && ex.x ? `<span class="${own ? 'own' : ''}">${esc(ex.x)}</span>` : ''}<i>${esc((p.author || short(p.origin)).slice(0, 26))} · ${fmtDate(p.created || p.updated)}</i></div>`);
        });
      }
      return { target, draw, clear() { gBub.selectAll('*').remove(); BS.clear(); } };
    }

    // ---------------------------------------------------------------- the bottom: items at their projections
    function buildItems(st) {
      const { scene } = st;
      const R0 = Math.min(W, H) / 2 - 18, cx = W / 2, cy = H / 2;
      scene.append('circle').attr('class', 'bcont').attr('cx', cx).attr('cy', cy).attr('r', R0);
      st.gUnder = scene.append('g').attr('class', 'fmarks');   // the marks' bubbles, under the lines and the dots
      const idx = (members.get(st.path) || []).filter(i => visible(F.points[i]));
      if (!idx.length) { scene.append('text').attr('class', 'bempty').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text(`nothing visible here — every ${FW.origin} in it is hidden`); st.update = () => {}; st.tick = () => {}; return; }
      const base = Math.max(3, Math.min(7, 0.2 * R0 / Math.sqrt(idx.length)));
      const dots = idx.map(i => ({ i, p: F.points[i], dr: Math.min(base * 2, base + 1.5 * Math.sqrt(F.points[i].cites_in)), x: cx, y: cy }));
      const byI = new Map(dots.map(d => [d.i, d]));
      // citations as arrows in the direction an idea travels (Ben, Oct 23: "in the normal way that makes sense for
      // time"): from the cited item (a) to the one that cites it (b), so with time up the screen they mostly climb; two
      // items that cite each other are one line with a head at each end
      const lines = [], ext = new Map(), pairOf = new Map();
      for (const e of F.edges) {
        const a = byI.get(e[0]), b = byI.get(e[1]);
        if (a && b) {
          const back = pairOf.get(b.i + '|' + a.i);
          if (back) { back.mutual = true; if (e[2] === ACC) back.type = ACC; continue; }
          const l = { a: b, b: a, type: e[2], dv: e[3] || 0, mutual: false };   // e = [citing, cited, type, version quoted]: the arrow runs cited → citing
          pairOf.set(a.i + '|' + b.i, l); lines.push(l);
        }
        else if ((a || b) && visible(F.points[e[0]]) && visible(F.points[e[1]])) { const k2 = (a || b).i; ext.set(k2, (ext.get(k2) || 0) + 1); }
      }
      // an open arrowhead (two strokes) at (x, y) pointing along (ux, uy): drawn in the line's own path, so it takes the
      // line's colour, opacity and hover with it
      const head = (x, y, ux, uy, h) => { const w = h * 0.5; return `M${(x - ux * h - uy * w).toFixed(1)},${(y - uy * h + ux * w).toFixed(1)}L${x.toFixed(1)},${y.toFixed(1)}L${(x - ux * h + uy * w).toFixed(1)},${(y - uy * h - ux * w).toFixed(1)}`; };
      const endOf = (d, k) => k >= 0 && d.vp && unfolded(d) ? { x: d.vp[k][0], y: d.vp[k][1], rr: 2.6 / Math.sqrt(Math.max(1, ZT.k)) } : d;
      const curve = l => {
        const a = endOf(l.a, l.ka ?? -1), b = endOf(l.b, l.kb ?? -1), dx = b.x - a.x, dy = b.y - a.y, bend = 0.18;
        const qx = (a.x + b.x) / 2 - dy * bend, qy = (a.y + b.y) / 2 + dx * bend;
        // trimmed to the dots' edges, so the heads sit outside them
        const ua = [qx - a.x, qy - a.y], ub = [b.x - qx, b.y - qy], ma = Math.hypot(...ua) || 1, mb = Math.hypot(...ub) || 1;
        const ra = (a.rr || a.dr) + 1.5, rb = (b.rr || b.dr) + 1.5;
        const sx = a.x + ua[0] / ma * ra, sy = a.y + ua[1] / ma * ra, ex = b.x - ub[0] / mb * rb, ey = b.y - ub[1] / mb * rb;
        let d = `M${sx.toFixed(1)},${sy.toFixed(1)}Q${qx.toFixed(1)},${qy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;
        if (Math.hypot(ex - sx, ey - sy) < 8) return d;
        const h = 5.5 / Math.sqrt(Math.max(1, ZT.k));
        d += head(ex, ey, ub[0] / mb, ub[1] / mb, h);
        if (l.mutual) d += head(sx, sy, -ua[0] / ma, -ua[1] / ma, h);
        return d;
      };
      const gGlow = scene.append('g').attr('class', 'bglows');
      const gl = scene.append('g').attr('class', 'blines' + (HITS ? ' dim' : '')).attr('display', L.cites ? null : 'none');
      const line = gl.selectAll('path').data(lines).join('path').attr('class', l => 'bline' + (l.type === ACC ? ' tr' : ''));
      // An item revised by hand carries a thin ring: a living document. In meaning + time its history unfolds while its
      // dot is hovered or it is open in the reader — a line from where it was first written to where each later version
      // sits on the time axis, a tick at each (the diachronic inside an item), the tick's note on hover.
      // At rest every item is its latest version, a dot, which is all a blyg serves of it. (Ben, Nov 9: with a line
      // drawn for every revised item the level was "kinda ugly"; most were one blyg's bulk re-versions, which are now
      // only counted — `vb`.)
      const revised = dots.filter(d => d.p.vt && d.p.vt.length);
      const versioned = MT ? revised : [];
      let hovV = null, hovT = 0, hovK = null;   // the dot whose history is held open by the pointer, its release timer, the tick under the pointer
      const unfolded = d => MT && (d === hovV || readerIsOpen(d.p));
      const holdV = d => { clearTimeout(hovT); if (MT && d.p.vt && hovV !== d) { hovV = d; place(); } };
      const releaseV = () => { clearTimeout(hovT); hovT = setTimeout(() => { if (!hovV) return; hovV = null; if (cur === st && scene.node().isConnected) place(); }, 350); };   // long enough to reach a tick
      fieldReaderChanged = () => { if (cur === st && scene.node().isConnected) place(); };
      // meaning + time: an arrow's ends on the version lines. The tail is the version of the cited item that was quoted
      // (transclusions and stubs pin it; exact). The head is the citing item's earliest version made after that — the
      // atlas keeps no record of which revision added a quote, but none can have quoted it before it existed (inferred).
      // -1 = the item's dot (its first version). Two items citing each other keep their dots. An end sits on its version
      // only while that item's history is unfolded (endOf); otherwise on the dot.
      if (MT) for (const l of lines) {
        l.ka = l.kb = -1;
        if (l.mutual) continue;
        let tA = Date.parse(l.a.p.created || l.a.p.updated || '') || 0;
        if (l.dv >= 2 && l.a.p.vt) { const k = l.a.p.vt.findIndex(([v]) => v === l.dv); if (k >= 0) { l.ka = k; tA = Date.parse(l.a.p.vt[k][1]); } }
        const tB = Date.parse(l.b.p.created || l.b.p.updated || '') || 0;
        if (tB < tA && l.b.p.vt) l.kb = l.b.p.vt.findIndex(([, t]) => Date.parse(t) >= tA);
      }
      const gRing = scene.append('g').attr('class', 'brings');
      const vring = gRing.selectAll('circle').data(revised, d => d.i).join('circle').style('color', d => fillOf(d.p));
      const gd = scene.append('g').attr('class', 'bdots');
      const dot = gd.selectAll('circle').data(dots, d => d.i).join('circle')
        .attr('class', d => 'bdot' + (d.p.reads ? ' read' : '') + (HITS && HITS.has(d.i) ? ' hit' : '') + (readerIsOpen(d.p) ? ' fopen' : '')).attr('r', d => d.dr).attr('fill', d => fillOf(d.p));
      const mine = d => l => l.a === d || l.b === d;
      dot.on('mouseenter', (ev, d) => { gl.classed('hov', true); line.classed('on', mine(d)).filter(mine(d)).raise(); d3.select(ev.currentTarget).classed('hov', true); holdV(d); markLift(d.i, marksSoon); })
        .on('mousemove', (ev, d) => tip(ev, pointTip(d.p) + `<div class="small">${!counting() ? '' : `weight ${WT[d.i].toFixed(2)} — ${WT[d.i] > 0.5 ? 'inside' : WT[d.i] > 0.1 ? 'at the edge of' : 'outside'} ${where()} · `}shift-click: lens here</div>` + (ext.get(d.i) ? `<div class="small muted">${ext.get(d.i)} ${ext.get(d.i) === 1 ? FW.edge : FW.edges} to items elsewhere</div>` : '')))
        .on('mouseleave', ev => { gl.classed('hov', false); line.classed('on', false); d3.select(ev.currentTarget).classed('hov', false); tipOff(); releaseV(); markLift(null, marksSoon); })
        .on('click', (ev, d) => { ev.stopPropagation(); tipOff(); if (ev.shiftKey) return setLens('i:' + d.i); openItem(d.p); });
      // the histories sit over the dots, so an unfolded line and its ticks are never under a neighbour; a tick holds
      // its line open, opens the item like its dot does, and while hovered is labelled with its version, date and the
      // start of its note — a label fixed to the tick, since the tour has no pointer tooltips (the reader's history
      // has the notes in full)
      const gV = scene.append('g').attr('class', 'bvers');
      const ver = gV.selectAll('g').data(versioned, d => d.i).join(e => { const g2 = e.append('g').attr('display', 'none'); g2.append('path'); return g2; }).style('color', d => fillOf(d.p));
      ver.selectAll('circle.vtick').data(d => d.p.vt.map((_, k) => ({ d, k }))).join('circle').attr('class', 'vtick');
      ver.selectAll('circle.vhit').data(d => d.p.vt.map((_, k) => ({ d, k }))).join('circle').attr('class', 'vhit')
        .on('mouseenter', (ev, v) => { hovK = v; holdV(v.d); place(); })
        .on('mouseleave', () => { hovK = null; vlabel.attr('display', 'none'); releaseV(); })
        .on('click', (ev, v) => { ev.stopPropagation(); openItem(v.d.p); });
      const vlabel = gV.append('text').attr('class', 'vlabel').attr('display', 'none');
      vlabel.append('tspan').attr('class', 'vlh');
      vlabel.append('tspan').attr('class', 'vln').attr('dy', '1.25em');
      // the loupe (Ben, Oct 22: "a magnifying circle follows the mouse … zooms in on the individual blygs, and expands some
      // of their text in little circles"): a circular fisheye over the dots inside it (d3-fisheye's formula), and the
      // nearest few items opened into text circles around its rim — title, the opening of the text, who and when. The
      // circles don't take the mouse; clicking a dot still opens it.
      const ring = scene.append('circle').attr('class', 'bloupe').attr('display', 'none');
      const gBub = scene.append('g').attr('class', 'bbubs');
      const bubbles = makeBubbles(gBub, () => cur === st && !!FOC && loupeOn());
      // Marked dots squeezed toward their mark’s middle (the glom, MARK_GLOM), eased in over 0.7 s when the level opens or
      // the set of marks changes. The offsets are recomputed from the dots' own places on every frame, so they follow the
      // slab and the tilt without lag; a dot in two marks takes the average of the two pulls, so it never flickers.
      let pullT = 0, pullSig = '', pullRaf = 0;
      const pullAmt = () => {
        const sig = marksShown().map(m => m.id + ':' + markIdx(m).length).join(',');
        if (sig !== pullSig) { pullSig = sig; pullT = performance.now(); }
        const u = reduce ? 1 : clamp01((performance.now() - pullT) / 700);
        if (u < 1 && !pullRaf) pullRaf = requestAnimationFrame(() => { pullRaf = 0; if (cur === st && scene.node().isConnected) place(); });
        return 1 - Math.pow(1 - u, 3);
      };
      // pull weights: a collapsing mark's pull hands over to its collapse (1 → 0 as it collapses, back as it opens)
      const pullOffsets = wt => {
        const acc = new Map();
        for (const m of marksShown()) {
          const k = wt.has(m.id) ? wt.get(m.id) : 1;
          if (k <= 0.001) continue;
          const mem = markIdx(m).map(i => byI.get(i)).filter(d => d && d.w >= 0.1);
          if (mem.length < 2) continue;
          // the glom (Ben, Nov 20: "glom them together more … sacrifice more spatial relation within the mark"): each
          // member keeps its direction from the mark's middle, its distance squeezed to r0·tanh(ρ/r0) — the near ones
          // hardly move, the far ones come in most, none ends further than r0. r0: the members' median distance, or the
          // room the dots need side by side (area ≈ n dots of diameter 2.5 dr), whichever is larger.
          const mx = d3.mean(mem, d => d.bx), my = d3.mean(mem, d => d.by);
          const rho = mem.map(d => Math.hypot(d.bx - mx, d.by - my));
          const r0 = Math.max(MARK_GLOM * (d3.median(rho) || 1), 1.3 * d3.mean(mem, d => d.dr) * Math.sqrt(mem.length));
          mem.forEach((d, j) => {
            const q = rho[j] > 1e-9 ? r0 * Math.tanh(rho[j] / r0) / rho[j] : 1;
            const a = acc.get(d.i) || [0, 0, 0]; a[0] += k * (mx + (d.bx - mx) * q - d.bx); a[1] += k * (my + (d.by - my) * q - d.by); a[2]++; acc.set(d.i, a);
          });
        }
        return acc;
      };

      // ---------------------------------------------------------------- collapsing a mark (Ben, Nov 19: "it collapses them
      // into a blob … pulls them together into another region basically. But youd still be able to see inside … the
      // collapse stretches the space sorta. like the projection")
      // DISPLAY ONLY, like the loupe and the pull: the shape block, the lasso's maths, the layout and every number about a
      // mark read the real places. A collapsed mark (state per mark in localStorage, amount c, MARK_COLLAPSE by default)
      // is drawn as a near-circle, and the space round it is a rubber sheet:
      //   · its boundary along each ray from its centre, R(θ) — where the ray leaves the union of its members' discs, the
      //     same discs its bubble is drawn round — becomes R'(θ) = (1 − c)·R(θ) + c·r, r a region-sized circle (area ∝
      //     members);
      //   · inside, a point's distance is scaled by R'/R (members keep their angle and their order outward);
      //   · outside, ρ ↦ ρ + (R' − R)·s(u), u = (ρ − R)/(F − R), s(u) = (1 − u)²(1 + 2u), identity beyond F. F − R is at
      //     least 2|R' − R|, so the map keeps increasing along every ray (s′ ≥ −1.5): nothing crosses anything.
      // Each map keeps every point on its ray and is increasing along it, so it is one-to-one; several collapsed marks are
      // applied one after another (by id), and a chain of one-to-one maps cannot fold, however their zones overlap. It works
      // at the loupe's stage, before the loupe: the loupe then magnifies the warped sheet.
      const NB = 72, CA = new Map();   // mark id → its collapse animation { from, to, t0, v }
      let colRaf = 0;
      const easeIO = u => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      // the collapses showing now, by id: { m, v (amount now), k (what is left of its pull) }
      function collapses() {
        const now = performance.now(), out = [];
        let moving = false;
        for (const m of [...marksShown()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))) {
          const to = markCol(m.id);
          let a = CA.get(m.id);
          if (!a) CA.set(m.id, a = { from: to, to, t0: 0, v: to });   // first seen on this level: as it was left, no animation
          if (a.to !== to) { a.from = a.v; a.to = to; a.t0 = now; }
          const u = reduce || !a.t0 ? 1 : clamp01((now - a.t0) / 600);
          a.v = a.from + (a.to - a.from) * easeIO(u);
          if (u < 1) moving = true;
          if (a.v > 0.001) out.push({ m, v: a.v, k: Math.max(0, 1 - a.v / Math.max(a.from, a.to, 1e-3)) });
        }
        if (moving && !colRaf) colRaf = requestAnimationFrame(() => { colRaf = 0; if (cur === st && scene.node().isConnected) place(); });
        return out;
      }
      const binOf = th => { const f = ((th / TAU) % 1 + 1) % 1 * NB, k0 = Math.floor(f) % NB; return [k0, (k0 + 1) % NB, f - Math.floor(f)]; };
      const atBin = (A, th) => { const [k0, k1, t] = binOf(th); return A[k0] + (A[k1] - A[k0]) * t; };
      // one mark's warp, from the dots where they are now (sx, sy): its centre, R and R' per bin, and the map itself
      function collapseOf(m, v, zk) {
        const mem = markIdx(m).map(i => byI.get(i)).filter(d => d && d.w >= 0.1);
        if (!mem.length) return null;
        const cx = d3.mean(mem, d => d.sx), cy = d3.mean(mem, d => d.sy);
        const R = new Float64Array(NB).fill(NaN);
        for (const d of mem) {
          const dx = d.sx - cx, dy = d.sy - cy, pr = d.dr / Math.sqrt(Math.max(1, zk)) + 9 / zk;   // the bubble's disc round the dot
          for (let k = 0; k < NB; k++) {
            const ph = k * TAU / NB, c0 = Math.cos(ph), s0 = Math.sin(ph), t = dx * c0 + dy * s0, e = -dx * s0 + dy * c0;
            if (Math.abs(e) >= pr) continue;
            const ex = t + Math.sqrt(pr * pr - e * e);
            if (ex > 0 && !(R[k] >= ex)) R[k] = ex;
          }
        }
        // rays that miss every disc (a centre in a gap): filled from their neighbours round the circle, then smoothed
        const have = [...R.keys()].filter(k => R[k] === R[k]);
        if (!have.length) return null;
        for (let k = 0; k < NB; k++) if (R[k] !== R[k]) {
          let a = k, b = k, da = 0, db = 0;
          while (R[a] !== R[a]) { a = (a + NB - 1) % NB; da++; }
          while (R[b] !== R[b]) { b = (b + 1) % NB; db++; }
          R[k] = (R[a] * db + R[b] * da) / (da + db);
        }
        const pmin = 9 / zk;
        for (let pass = 0; pass < 3; pass++) { const T = Float64Array.from(R); for (let k = 0; k < NB; k++) R[k] = Math.max(pmin, 0.25 * T[(k + NB - 1) % NB] + 0.5 * T[k] + 0.25 * T[(k + 1) % NB]); }
        // r: a region-sized circle — area ∝ members (MARK_R per √member), and at least wide enough to hold its own name, as a
        // region's circle does (so a small mark opens the space round it rather than shrinking); at most a third of the level
        const nameR = (markTextW(markName(m).toUpperCase(), true) / 2 + 16) / zk;   // the name as it is set in a collapsed mark, and a margin
        const r = Math.min(0.32 * R0, Math.max(22 / zk, nameR, MARK_R * Math.sqrt(mem.length)));
        // the blend toward r can still be narrower than the name (a mark smaller than r): from v ≈ 0.5 the outline holds it
        const hold = Math.min(nameR, 0.32 * R0) * clamp01((v - 0.2) / 0.3);
        const Rn = R.map(x => Math.max((1 - v) * x + v * r, hold));
        const warp = (x, y) => {
          const dx = x - cx, dy = y - cy, rho = Math.hypot(dx, dy);
          if (rho < 1e-9) return [x, y];
          const th = Math.atan2(dy, dx), Rt = atBin(R, th), Rnt = atBin(Rn, th);
          let q;
          if (rho < Rt) q = rho * Rnt / Rt;
          else {
            const dl = Rnt - Rt, Fr = Math.max(1.5 * Math.max(Rt, Rnt), 2 * Math.abs(dl));
            const u = (rho - Rt) / Fr;
            q = u >= 1 ? rho : rho + dl * (1 - u) * (1 - u) * (1 + 2 * u);
          }
          return [cx + dx * q / rho, cy + dy * q / rho];
        };
        // the dots inside shrink a little with the space they are given (at most to 55%)
        const Rm = d3.mean(R), shrink = 1 + (Math.max(0.55, Math.min(1, Math.sqrt(d3.mean(Rn) / Rm))) - 1) * v;
        return { m, v, cx, cy, Rn, warp, shrink, n: mem.length, ids: new Set(mem.map(d => d.i)) };
      }
      function place() {
        const on = loupeOn() && FOC, zk = ZT.k, rl = RL / zk, zr = 1 / Math.sqrt(Math.max(1, zk));
        const E = pullAmt(), cols = collapses(), wt = new Map(cols.map(c => [c.m.id, c.k]));
        const off = E ? pullOffsets(wt) : null;
        for (const d of dots) {
          const o = off && off.get(d.i);
          d.sx = d.bx + (o ? E * o[0] / o[2] : 0); d.sy = d.by + (o ? E * o[1] / o[2] : 0); d.cz = 1;
        }
        // the collapses, one after another; each one's outline is carried through the ones after it
        const warps = [], shapes = [];
        for (const c of cols) {
          const w = collapseOf(c.m, c.v, zk);
          if (!w) continue;
          for (const d of dots) { [d.sx, d.sy] = w.warp(d.sx, d.sy); if (w.ids.has(d.i)) d.cz *= w.shrink; }
          for (const s2 of shapes) s2.pts = s2.pts.map(([x, y]) => w.warp(x, y));
          shapes.push({ id: c.m.id, v: c.v, n: w.n, pts: w.Rn.map ? Array.from(w.Rn, (rr, k) => [w.cx + rr * Math.cos(k * TAU / NB), w.cy + rr * Math.sin(k * TAU / NB)]) : [] });
          warps.push(w.warp);
        }
        st.warps = warps;
        for (const d of dots) {
          d.ux = d.sx; d.uy = d.sy;   // where it is before the loupe (the marks' labels hold to this, so they stay put under it)
          if (on) [d.x, d.y, d.z, d.inL] = fish(d.sx, d.sy, rl); else { d.x = d.sx; d.y = d.sy; d.z = 1; d.inL = false; }
        }
        // a collapsed mark's outline: under the loupe too (its label keeps to the outline without it)
        st.col = new Map(shapes.map(s2 => [s2.id, { v: s2.v, n: s2.n, upts: s2.pts, pts: on ? s2.pts.map(([x, y]) => fish(x, y, rl)) : s2.pts }]));
        for (const d of dots) d.rr = d.dr * d.z * zr * d.cz;
        dot.attr('cx', d => d.x.toFixed(1)).attr('cy', d => d.y.toFixed(1)).attr('r', d => d.rr.toFixed(2))
          .style('opacity', d => d.op * (on && !d.inL ? 0.45 : 1));
        vring.attr('cx', d => d.x.toFixed(1)).attr('cy', d => d.y.toFixed(1)).attr('r', d => (d.rr + 2.6 * zr).toFixed(2)).style('opacity', d => d.op * (on && !d.inL ? 0.45 : 1));
        for (const d of versioned) d.vp = d.vb.map(([x, y]) => { for (const w of warps) [x, y] = w(x, y); return on ? fish(x, y, rl) : [x, y]; });
        line.attr('d', curve);
        marksSoon();
        ver.attr('display', d => unfolded(d) ? null : 'none');
        const open = ver.filter(unfolded);
        open.select('path').attr('d', d => 'M' + [[d.x, d.y], ...d.vp].map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join('L'));
        open.selectAll('circle.vtick').attr('cx', v => v.d.vp[v.k][0]).attr('cy', v => v.d.vp[v.k][1]).attr('r', v => (v.k === v.d.vp.length - 1 ? 3.4 : 2.4) * zr);
        open.selectAll('circle.vhit').attr('cx', v => v.d.vp[v.k][0]).attr('cy', v => v.d.vp[v.k][1]).attr('r', 8 * zr);
        if (hovK && unfolded(hovK.d)) {
          const [n, at, note] = hovK.d.p.vt[hovK.k], [vx, vy] = hovK.d.vp[hovK.k], left = vx > cx + R0 * 0.35;   // near the right edge the label runs leftward
          vlabel.attr('display', null).attr('text-anchor', left ? 'end' : 'start').attr('transform', `translate(${vx.toFixed(1)},${vy.toFixed(1)}) scale(${(1 / zk).toFixed(4)})`).style('fill', fillOf(hovK.d.p)).raise();
          vlabel.select('.vlh').attr('x', left ? -10 : 10).attr('y', -14).text(`v${n} · ${fmtDay(Date.parse(at))}`);
          vlabel.select('.vln').attr('x', left ? -10 : 10).text(note ? (note.length > 72 ? note.slice(0, 71).replace(/\s+\S*$/, '') + '…' : note) : '');
        } else vlabel.attr('display', 'none');
        gGlow.selectAll('circle').attr('cx', d => d.x).attr('cy', d => d.y);
        ring.attr('display', on ? null : 'none');
        if (!on) { bubbles.clear(); return; }
        ring.attr('cx', FOC[0]).attr('cy', FOC[1]).attr('r', rl);
        const dist = d => Math.hypot(d.bx - FOC[0], d.by - FOC[1]);
        bubbles.target(dots.filter(d => d.w >= 0.1 && dist(d) < rl).sort((p, q) => dist(p) - dist(q)).slice(0, NBUB), rl);
      }
      // Items written at one moment about one thing land on one spot, and a pile of dots can be neither read nor
      // clicked (Ben, Nov 10: "the circles for blygs pile up and it's hard to click on specific ones"). So the dots
      // that count (weight ≥ 0.1) are pushed apart until they touch, each held toward its own place: a pile becomes a
      // small cluster around where it was. Each update starts from the last one's offsets, so the cluster holds its
      // shape while the slab or the tilt moves. A revised item's ring is given room.
      let spreadRuns = 0;
      function spread() {
        const ns = dots.filter(d => d.w >= 0.1).map(d => ({ d, tx: d.bx, ty: d.by, x: d.bx + (d.ox || 0), y: d.by + (d.oy || 0), r: d.dr + (d.p.vt ? 3.2 : 0.9) }));
        for (const d of dots) if (d.w < 0.1) d.ox = d.oy = 0;
        if (ns.length < 2) return;
        const ticks = spreadRuns++ ? 28 : 140;
        const sim = d3.forceSimulation(ns).stop().alphaDecay(1 - Math.pow(0.03, 1 / ticks)).velocityDecay(0.45)
          .force('x', d3.forceX(n => n.tx).strength(0.22)).force('y', d3.forceY(n => n.ty).strength(0.22))
          .force('c', d3.forceCollide(n => n.r).strength(0.85).iterations(2));
        for (let k = 0; k < ticks; k++) {
          sim.tick();
          for (const n of ns) { const dx = n.x - cx, dy = n.y - cy, m = Math.hypot(dx, dy), lim = R0 - n.r - 2; if (m > lim) { n.x = cx + dx / m * lim; n.y = cy + dy / m * lim; } }   // inside the circle
        }
        for (const n of ns) { n.d.ox = n.x - n.tx; n.d.oy = n.y - n.ty; n.d.bx = n.x; n.d.by = n.y; }
      }
      st.update = () => {
        // positions: the projection around the leaf's centroid, every direction kept and the distance eased into the circle
        // (1 − e^(−0.8·d/median), as the blobs' bottom level), so the tilt moves the dots and the slab only fades them
        const [fx, fy] = projQ(QC.get(st.path));
        const med = d3.median(dots, d => Math.hypot(PX[d.i] - fx, PY[d.i] - fy)) || 1, lim = 0.93 * R0;
        const ease = (px, py, dr) => { const dx = px - fx, dy = -(py - fy), m = Math.hypot(dx, dy) || 1e-9, rr = Math.min(lim * (1 - Math.exp(-0.8 * m / med)), R0 - dr - 3); return [cx + dx / m * rr, cy + dy / m * rr]; };
        for (const d of dots) { [d.bx, d.by] = ease(PX[d.i], PY[d.i], d.dr); d.w = WT[d.i]; }
        spread();
        // a version's place: the item's meaning, at the version's moment on the time axis, projected and eased like a dot
        for (const d of versioned) {
          const q = Q[d.i];
          d.vb = d.p.vt.map(([, t]) => { const qt = (rankAll(Date.parse(t)) - 0.5) * F.frameT.time.scale - MU[3]; return ease(R.c1 * q[0] + R.s1 * qt, R.c2 * q[1] + R.s2 * q[3], d.dr); });   // time is slot 2
        }
        for (const d of dots) d.op = (HITS && !HITS.has(d.i) ? 0.35 : 1) * (0.08 + 0.92 * d.w);
        dot.style('pointer-events', d => d.w < 0.1 ? 'none' : null);
        dot.filter(d => d.w >= 0.1).raise();
        line.style('opacity', l => Math.max(0.06, Math.min(1, l.a.w * l.b.w * 1.2)));
        const hot = L.pulse && PULSE ? dots.filter(d => HEAT.has(d.i) && d.w > 0.05) : [];
        gGlow.selectAll('circle').data(hot, d => d.i).join('circle')
          .attr('r', d => d.dr + 5 + 16 * Math.sqrt(HEAT.get(d.i) / PULSE.max)).attr('fill', 'url(#bdglow)').style('opacity', d => 0.6 * d.w);
        place();
        crumbs(st);
      };
      st.zoomed = place;
      st.loupe = place;
      st.hover = place;
      st.tick = () => {};
      st.byI = byI;
      st.summary = () => `≈${fmtW(d3.sum(dots, d => d.w))} of ${dots.length} items inside · ${lines.length} ${lines.length === 1 ? FW.edge : FW.edges} among them${ext.size ? ` · ${d3.sum(ext.values())} to elsewhere` : ''}`;
    }

    function flashAt(i) {
      if (!cur || cur.kind !== 'items') return;
      const d = cur.byI.get(i);
      if (!d) return;
      cur.scene.append('circle').attr('cx', d.x).attr('cy', d.y).attr('r', d.dr).attr('fill', 'none').attr('stroke', 'var(--accent)').attr('stroke-width', 2.2)
        .transition().duration(reduce ? 0 : 1300).attr('r', d.dr + 44).style('opacity', 0).remove();
    }
    function crumbs(st) {
      const el = main.querySelector('#fcrumb');
      if (!el || st !== cur) return;
      const chain = st.path ? ancestors(st.path) : [];
      const link = (p2, label) => `<a href="${hashFor(p2)}">${esc(label)}</a>`;
      const parts = [chain.length ? link('', 'all regions') : '<span class="cur">all regions</span>']
        .concat(chain.map((p2, i) => i === chain.length - 1 ? `<span class="cur">${esc(nameOf(byPath.get(p2), 3))}</span>` : link(p2, nameOf(byPath.get(p2), 3))));
      el.innerHTML = parts.join('<span class="sep">›</span>') + `<span class="bsum">${st.summary ? st.summary() : ''}</span>`;
    }

    // ---------------------------------------------------------------- moving between levels
    function build(path) {
      const lv = levelFor(path);
      const scene = gScenes.append('g').attr('class', 'bscene');
      const st = { path: lv.path, kind: lv.kind, c: lv.c, scene, sim: null, update: () => {}, tick: () => {} };
      setMeaningScope(lv.path ? members.get(lv.path) || [] : null);
      if (lv.kind === 'blobs') buildBlobs(st); else buildItems(st);
      bg.style('cursor', st.path ? 'zoom-out' : null);
      return st;
    }
    const land = st => {
      cur = st; project(); status(); st.update(); crumbs(st); renderRegions(); persist(); poleKey = ''; schedulePoles();
      if (pendingFlash !== null) { const i = pendingFlash; pendingFlash = null; setTimeout(() => flashAt(i), 60); }
    };
    // anything left behind by a transition that was cut off (a scene whose fade-and-remove never ran: zoomed up and
    // tinted, it paints the whole field — Ben, Nov 6, "the whole background got painted blue")
    const sweepScenes = () => { if (!cur) return; gScenes.selectAll('.bscene').filter(function () { return this !== cur.scene.node(); }).interrupt().remove(); };
    function go(path, how) {
      path = levelFor(path).path;
      if (animating) { gScenes.selectAll('.bscene').interrupt(); gScenes.selectAll('.bscene').filter(function () { return !cur || this !== cur.scene.node(); }).remove(); if (cur) cur.scene.style('opacity', 1).attr('transform', null); animating = false; }
      const old = cur;
      if (old && old.path === path && how !== 'refresh') { if (pendingFlash !== null) { const i = pendingFlash; pendingFlash = null; flashAt(i); } return; }
      tipOff();
      // a pinch in progress: the move carries on from the pinched view (the zoom moves onto the old scene, the new one
      // starts inside the same transform), and the zoom itself is back at rest for the new level
      const pre = how !== 'refresh' && (ZT.k !== 1 || ZT.x || ZT.y) ? `translate(${ZT.x.toFixed(2)},${ZT.y.toFixed(2)}) scale(${ZT.k.toFixed(4)}) ` : '';
      resetZoom();
      if (old && pre) old.scene.attr('transform', pre);
      if (!old || how === 'refresh') {
        if (old) { old.sim && old.sim.stop(); old.scene.remove(); }
        const st = build(path);
        if (!old) st.scene.style('opacity', 0).transition().duration(FADE).style('opacity', 1);
        land(st);
        return;
      }
      old.sim && old.sim.stop();
      const st = build(path);
      land(st);
      const into = old.kind === 'blobs' && parentPath(path) === old.path ? old.nodes.find(n => n.path === path) : null;
      const from = st.kind === 'blobs' && above(path, old.path) ? st.nodes.find(n => n.path === old.path || above(n.path, old.path)) : null;
      if (reduce) { old.scene.remove(); return; }
      animating = true;
      if (into && into.r >= 3) {
        // in: the old level zooms into the circle and fades as the new one comes up where the circle was
        const k = Math.min(W, H) / 2 / into.r;
        old.scene.transition().duration(DUR).ease(d3.easeCubicInOut).attr('transform', `translate(${W / 2},${H / 2}) scale(${k}) translate(${-into.x},${-into.y})`).style('opacity', 0).remove();
        st.scene.attr('transform', `${pre}translate(${into.x},${into.y}) scale(${into.r / (Math.min(W, H) / 2)}) translate(${-W / 2},${-H / 2})`).style('opacity', 0)
          .transition().duration(DUR).ease(d3.easeCubicInOut).attr('transform', 'translate(0,0) scale(1)').style('opacity', 1).on('end', () => { st.scene.attr('transform', null); animating = false; sweepScenes(); if (cur && cur.update) cur.update(); });
      } else if (from && from.r >= 3) {
        // out: the old level shrinks back into its circle in the new one
        const k = from.r / (Math.min(W, H) / 2);
        old.scene.transition().duration(DUR).ease(d3.easeCubicInOut).attr('transform', `translate(${from.x},${from.y}) scale(${k}) translate(${-W / 2},${-H / 2})`).style('opacity', 0).remove();
        st.scene.style('opacity', 0).transition().duration(DUR).style('opacity', 1).on('end', () => { animating = false; sweepScenes(); if (cur && cur.update) cur.update(); });
      } else {
        old.scene.transition().duration(FADE).style('opacity', 0).remove();
        st.scene.style('opacity', 0).transition().duration(FADE + 120).style('opacity', 1).on('end', () => { animating = false; sweepScenes(); if (cur && cur.update) cur.update(); });
      }
    }

    bg.on('click', () => { if (dragged) { dragged = false; return; } if (cur && cur.path && !animating) location.hash = hashFor(parentPath(cur.path)); });
    const onKey = ev => {
      if (stale(g) || !svg.node().isConnected) { document.removeEventListener('keydown', onKey); stopDrift(); stopPlay(); return; }
      if ((ev.target instanceof HTMLInputElement && ev.target.type !== 'range') || ev.target instanceof HTMLTextAreaElement || (ev.target && ev.target.isContentEditable)) return;   // typing in a card
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'Escape') {
        if (cur && cur.path) location.hash = hashFor(parentPath(cur.path));
        else if (isFull()) setFull(false);   // the fallback without the Fullscreen API (with it, the browser takes Escape)
      } else if (ev.key === 'f') setFull(!isFull());
      else if (ev.key === 'h' && isFull()) toggleBare();
      else if (ev.key === 'e') toggleEase();
      else if (ev.key === 'z') toggleFill();
      else if (ev.key === 'c') { const as = [...main.querySelectorAll('a[data-color]')], k = as.findIndex(a => a.classList.contains('on')); if (as.length) as[(k + 1) % as.length].click(); }   // cycle the color (the bar is hidden in full screen)
      else if (ev.key === 'm') { L.loupe = L.loupe === false; saveFieldState(); syncPanel(); if (cur && cur.loupe) cur.loupe(); }
      else if (ev.key === 'p') togglePoles();
    };
    document.addEventListener('keydown', onKey);

    // ---------------------------------------------------------------- full screen
    // The page's own chrome (header, the bar, the side panel, the legend) is hidden by a class on <body>; the Fullscreen
    // API is asked for on top when the browser has it. The tour's controls float over the field and h hides them.
    function setFull(on) {
      document.body.classList.toggle('ffull', on);
      document.body.classList.toggle('fbare', on);   // just the field at first; the controls come back with h or the button
      const de = document.documentElement;
      if (on && !document.fullscreenElement && de.requestFullscreen) de.requestFullscreen().catch(() => {});
      if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      syncPanel(); relayout();
    }
    function toggleBare() { document.body.classList.toggle('fbare'); relayout(); }
    let relayoutTimer = 0;
    function relayout() {
      clearTimeout(relayoutTimer);
      relayoutTimer = setTimeout(() => { if (stale(g) || !svg.node().isConnected) return; const w0 = W, h0 = H; measure(); if ((W !== w0 || H !== h0) && cur) { resetZoom(); go(cur.path, 'refresh'); } }, 60);
    }
    const onFs = () => {
      if (stale(g) || !svg.node().isConnected) { document.removeEventListener('fullscreenchange', onFs); removeEventListener('resize', onResize); return; }
      if (!document.fullscreenElement && isFull()) { document.body.classList.remove('ffull', 'fbare'); syncPanel(); }
      relayout();
    };
    const onResize = () => { if (stale(g) || !svg.node().isConnected) { removeEventListener('resize', onResize); return; } if (isFull()) relayout(); };
    document.addEventListener('fullscreenchange', onFs);
    addEventListener('resize', onResize);
    const fab = main.querySelector('#ffab');
    if (fab) {
      fab.querySelector('[data-fab="bare"]').onclick = toggleBare;
      fab.querySelector('[data-fab="exit"]').onclick = () => setFull(false);
      fab.querySelector('[data-fab="drift"]').onclick = () => driftBtn.click();
    }

    // ---------------------------------------------------------------- pinch / scroll zoom
    // Above the bottom it is a semantic zoom: the level grows under the fingers, and once the circle under them fills
    // most of the view the drill takes over (the same animation as a click, continued from where the pinch left it);
    // pinching out past ~0.7 backs out. Let go short of either and it eases back. At the bottom (the items) it is a plain
    // geometric zoom, up to 10×, panned by dragging the background or scrolling sideways; pinching out below ~0.75
    // backs out to the region.
    let ZT = { k: 1, x: 0, y: 0 }, springTimer = 0, gesturing = 0, dragged = false;
    const applyZoom = () => {
      gZoom.attr('transform', ZT.k === 1 && !ZT.x && !ZT.y ? null : `translate(${ZT.x.toFixed(2)},${ZT.y.toFixed(2)}) scale(${ZT.k.toFixed(4)})`);
      if (cur && cur.zoomed) cur.zoomed();
      marksSoon();
    };
    function resetZoom() { clearTimeout(springTimer); gZoom.interrupt(); ZT = { k: 1, x: 0, y: 0 }; applyZoom(); }
    const clampPan = () => {
      if (ZT.k >= 1) { ZT.x = Math.max(W - W * ZT.k, Math.min(0, ZT.x)); ZT.y = Math.max(H - H * ZT.k, Math.min(0, ZT.y)); }
      else { ZT.x = (W - W * ZT.k) / 2; ZT.y = (H - H * ZT.k) / 2; }   // below 1 (on the way out), keep it centred
    };
    function springBack() {
      clearTimeout(springTimer);
      springTimer = setTimeout(() => {
        if (!cur || animating) return;
        if (cur.kind === 'items' && ZT.k >= 1) return;   // geometric: stays where it was put
        const from = { ...ZT };
        gZoom.transition().duration(reduce ? 0 : 260).ease(d3.easeCubicOut).tween('spring', () => t => { ZT = { k: from.k + (1 - from.k) * t, x: from.x * (1 - t), y: from.y * (1 - t) }; applyZoom(); });
      }, 220);
    }
    function zoomAt(mx, my, f) {
      if (!cur || animating) return;
      gZoom.interrupt(); tipOff();
      const items = cur.kind === 'items';
      const k2 = Math.max(items ? 0.5 : 0.45, Math.min(items ? 10 : 6, ZT.k * f));
      ZT = { k: k2, x: mx - (mx - ZT.x) * k2 / ZT.k, y: my - (my - ZT.y) * k2 / ZT.k };
      if (items) clampPan();
      applyZoom();
      if (!items) {
        const sx = (mx - ZT.x) / ZT.k, sy = (my - ZT.y) / ZT.k;
        const hit = cur.nodes.find(d => d.r >= 3 && Math.hypot(d.x - sx, d.y - sy) <= d.r);
        if (hit && f > 1 && hit.r * ZT.k >= 0.42 * Math.min(W, H)) { clearTimeout(springTimer); enter(hit.path); return; }
      }
      if (cur.path && ZT.k < (items ? 0.75 : 0.7) && f < 1) { clearTimeout(springTimer); location.hash = hashFor(parentPath(cur.path)); return; }
      springBack();
    }
    const svgPt = ev => { const r = svg.node().getBoundingClientRect(); return [(ev.clientX - r.left) * W / r.width, (ev.clientY - r.top) * H / r.height]; };
    const onWheel = ev => {
      if (stale(g) || !svg.node().isConnected) return;
      ev.preventDefault();
      if (gesturing) return;   // Safari sends a pinch as gesture events; don't count it twice
      const [mx, my] = svgPt(ev);
      if (cur && cur.kind === 'items' && ZT.k > 1.001 && !ev.ctrlKey && Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) { ZT.x -= ev.deltaX; clampPan(); applyZoom(); return; }
      const f = Math.pow(2, -ev.deltaY * (ev.deltaMode === 1 ? 0.05 : ev.deltaMode ? 1 : 0.002) * (ev.ctrlKey ? 5 : 1));
      zoomAt(mx, my, f);
    };
    svg.node().addEventListener('wheel', onWheel, { passive: false });
    let gScale = 1;
    svg.node().addEventListener('gesturestart', ev => { ev.preventDefault(); gesturing = 1; gScale = 1; });
    svg.node().addEventListener('gesturechange', ev => { ev.preventDefault(); const [mx, my] = svgPt(ev); zoomAt(mx, my, ev.scale / gScale); gScale = ev.scale; });
    svg.node().addEventListener('gestureend', ev => { ev.preventDefault(); gesturing = 0; });
    // drag the background to pan the bottom level when zoomed in
    bg.on('pointerdown', ev => {
      if (!cur || cur.kind !== 'items' || ZT.k <= 1.001) return;
      const [x0, y0] = svgPt(ev), z0 = { ...ZT };
      let moved = false;
      const mv = e => { const [x, y] = svgPt(e); if (Math.hypot(x - x0, y - y0) > 3) moved = true; ZT.x = z0.x + x - x0; ZT.y = z0.y + y - y0; clampPan(); applyZoom(); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); dragged = moved; };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });

    // ---------------------------------------------------------------- the loupe's focus and the text it opens
    let FOC = null, loupeRaf = 0;   // the mouse, in the level's own coordinates (under the zoom)
    const loupeOn = () => L.loupe !== false && !MARK.on && !MARK.lab && !!cur && cur.kind === 'items' && !animating;
    // marks at the bottom level: what the pointer is over — a mark's name, or (the smallest) bubble round it — decides which
    // mark is lifted with its note showing. Decided from the pointer's place rather than enter/leave on the shapes, so
    // crossing the dots inside a bubble does not flicker it.
    const markUnder = ev => {
      const lab = ev.target && ev.target.closest ? ev.target.closest('.fml') : null;
      if (lab) return [d3.select(lab).datum().r.m.id, true];
      if (!cur || cur.kind !== 'items' || !cur.gUnder) return [null, false];
      for (const p of cur.gUnder.selectAll('path.fmbhit').nodes().reverse()) {   // the last drawn is the smallest
        const m = p.getScreenCTM();
        if (!m) continue;
        const q = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        if (p.isPointInFill(q)) return [d3.select(p).datum().m.id, false];
      }
      return [null, false];
    };
    svg.on('mousemove.marks', ev => {
      MARK.geomHover = !!cur && cur.kind === 'items';
      if (!MARK.geomHover || MARK.on) return;
      const [id, lab] = markUnder(ev);
      if (id === MARK.hov && lab === MARK.lab) return;
      const relabel = lab !== MARK.lab;
      MARK.hov = id; MARK.lab = lab;
      if (relabel && cur.hover) cur.hover();   // onto or off a name: the loupe steps aside or comes back
      marksSoon();
    }).on('mouseleave.marks', () => { if (MARK.geomHover && (MARK.hov !== null || MARK.lab)) { MARK.hov = null; MARK.lab = false; if (cur && cur.hover) cur.hover(); marksSoon(); } });
    svg.on('mousemove.loupe', ev => {
      if (!cur || !cur.hover) return;
      const [mx, my] = svgPt(ev);
      FOC = [(mx - ZT.x) / ZT.k, (my - ZT.y) / ZT.k];
      if (!loupeRaf) loupeRaf = requestAnimationFrame(() => { loupeRaf = 0; if (cur && cur.hover && !stale(g)) cur.hover(); });
    }).on('mouseleave.loupe', () => { FOC = null; if (cur && cur.hover) cur.hover(); });
    const EXC = new Map(), EXCWANT = new Set();
    let excTimer = 0, excQueue = [], excCbs = [];
    function fetchExcerpts(ids, cb) {
      for (const i of ids) { EXCWANT.add(i); excQueue.push(i); }
      excCbs.push(cb);
      clearTimeout(excTimer);
      excTimer = setTimeout(async () => {
        const q = excQueue.splice(0), cbs = excCbs.splice(0);
        try { const r = await api('/field/excerpts?i=' + q.join(',')); for (const [k, v] of Object.entries(r)) EXC.set(Number(k), v); } catch {}
        for (const i of q) if (!EXC.has(i)) EXC.set(i, null);
        if (!stale(g)) cbs.forEach(f => f());
      }, 140);
    }
    const onVis = () => { if (stale(g)) { document.removeEventListener('visibilitychange', onVis); return; } if (cur && cur.sim && !reduce) { if (document.hidden) cur.sim.stop(); else cur.sim.restart(); } };
    document.addEventListener('visibilitychange', onVis);
    fieldHashNav = params => {
      if (stale(g) || !svg.node().isConnected || fieldState.mode !== 'tour') return false;
      if (params.has('q') && params.get('q') !== fieldState.q) return false;
      const t = parseT(params);
      if (t && (t.sp !== TS.sp || (t.sp === 'mt' && t.rg !== TS.rg))) return false;   // other regions (the other space, or the other tree): the page is rebuilt
      if (t && tStr(t) !== tParam()) { stopDrift(); Object.assign(TS, t); syncPanel(); project(); status(); }   // a saved view or the back button; our own drill links carry the current view
      go(params.get('c') || '');
      if (cur) cur.update();
      return true;
    };

    drawTicks(); syncPanel(); project(); status();
    const refresh = () => { rerank(); drawTicks(); if (cur) { project(); status(); go(cur.path, 'refresh'); } };
    const navTo = (path, q) => { recenter(q || QC.get(path)); if (cur && levelFor(path).path === cur.path) { go(path); schedule(); } else location.hash = hashFor(path); };
    return {
      restyle: refresh, theme: () => {}, pulse: () => schedule(),
      hits: () => refresh(),
      scene: d => { pendingFlash = d.i; navTo(levelFor(cOf(d)).path, Q[d.i]); },
      region: c => navTo(c.path),
      start: () => { fieldState.focus = ''; go(p.get('c') || ''); },
      current: () => cur ? cur.path : '',
      // marks: the dots drawn now — the bottom level's (weight ≥ 0.1, the ones that take a click), or above it the dots
      // the leaf circles show — in #fsvg's coordinates, through the pinch zoom
      drawn: () => {
        if (!cur || animating) return null;
        const out = [], zk = ZT.k, sx = x => ZT.x + zk * x, sy = y => ZT.y + zk * y;
        if (cur.kind === 'items') { for (const d of cur.byI ? cur.byI.values() : []) if (d.w >= 0.1) out.push({ i: d.i, x: sx(d.x), y: sy(d.y) }); return out; }
        for (const d of cur.nodes || []) if (d.r >= 3 && d.pdots) for (const [i, px, py] of d.pdots) if (WT[i] >= 0.1) out.push({ i, x: sx(d.x + px), y: sy(d.y + py) });
        return out.length ? out : null;
      },
      view: () => ({ mode: 'tour', hash: hashFor(cur ? cur.path : ''), path: cur ? cur.path : '', tour: { ...TS, sig: TS.sig === Infinity ? 'inf' : TS.sig } }),
      // the deepest region holding every member, the slab moved onto their middle
      fit: idx => {
        if (!idx.length) return;
        let common = cOf(F.points[idx[0]]).split('.');
        for (const i of idx) { const p2 = cOf(F.points[i]).split('.'); let k = 0; while (k < common.length && common[k] === p2[k]) k++; common = common.slice(0, k); }
        navTo(common.join('.'), [0, 1, 2, 3].map(k => d3.mean(idx, i => Q[i][k])));
      },
      marks: () => { if (cur && cur.kind === 'items' && cur.zoomed) cur.zoomed(); else marksSoon(); },   // a collapse moves the dots
      lasso: () => { if (cur && cur.hover) cur.hover(); },   // the loupe steps aside while the lasso is out, and comes back
    };
  }

  // ================================================================ shared: loaders, side panel, controls
  const pres = mode === 'plane' ? fieldPlane() : mode === 'tour' ? fieldTour() : fieldBlobs();
  const restyle = () => { rebund(); pres.restyle(); };

  async function loadPulse() {
    let d;
    try { d = await api('/field/pulse' + (fieldState.days ? `?days=${fieldState.days}` : '')); } catch { return; }   // cut off by leaving the page (Safari rejects it)
    if (stale(g)) return;
    PULSE = d; PULSE.max = d3.max(d.heat, h => h[1]) || 1;
    HEAT = new Map(d.heat);
    renderScenes(); renderRegions(); pres.pulse();
  }
  // One search box (Ben, Nov 10: two at the top, only one of which touched the map, and none in full screen). On the
  // field the page's search bar lights up the map; what is lit shows as a chip — in the bar, and floating in full
  // screen — with the same search as a list one click away. In full screen `/` opens a small box over the map.
  const topQ = document.getElementById('q');
  function syncChip(n) {
    const qs = fieldState.q;
    for (const el of main.querySelectorAll('[data-qchip]')) {
      el.hidden = !qs;
      if (!qs) continue;
      const float = el.classList.contains('fqfloat');
      el.innerHTML = `<span class="muted">lit</span> <b>${esc(qs.length > 40 ? qs.slice(0, 39) + '…' : qs)}</b>${n === undefined ? ' <span class="muted">…</span>' : ` <span class="muted">${n} ${n === 1 ? 'hit' : 'hits'}</span>`}${float ? '' : ` <a href="#/search/${encodeURIComponent(qs)}" title="the same search as a ranked list">as a list</a>`} <a href="#" data-qclear title="clear the search">${float ? '×' : 'clear'}</a>`;
      el.querySelector('[data-qclear]').onclick = ev => { ev.preventDefault(); runSearch(''); };
    }
  }
  async function runSearch(qstr) {
    fieldState.q = qstr;
    if (topQ && topQ.value.trim() !== qstr) topQ.value = qstr;
    if (!qstr) { HITS = null; syncChip(); pres.hits([]); return; }
    syncChip();
    const r = await api('/field/search?q=' + encodeURIComponent(qstr));
    if (stale(g) || fieldState.q !== qstr) return;
    HITS = new Map(r.hits.map(h => [h.i, h.score]));
    syncChip(r.hits.length);
    pres.hits(r.hits.map(h => F.points[h.i]));
  }
  fieldSearch = runSearch;

  // ---------------------------------------------------------------- side panel
  const regionHeat = c => { let s = 0; for (const [i, w] of HEAT) { const p = F.points[i]; if (visible(p) && (cOf(p) === c.path || parentOf(cOf(p)) === c.path)) s += w; } return s; };
  function renderScenes() {
    const el = main.querySelector('#fscenes');
    if (!PULSE || !OVERLAYS) { el.innerHTML = ''; return; }
    const sc = PULSE.scenes.filter(s => s.i !== null).slice(0, 10);
    el.innerHTML = `<h2>scenes <span class="muted">— pulse since ${fmtDate(PULSE.since)}, ${PULSE.events_total} events</span></h2>` +
      (!sc.length && !fieldState.days && PULSE.last_viewed ? `<div class="muted small">nothing since you marked all seen (${fmtWhen(PULSE.last_viewed)}) — try a 3d or 7d window</div>` : '') +
      (sc.map(s => `<div class="fscene"><a href="#" data-scene="${s.i}">${esc((s.title || '(untitled)').slice(0, 70))}</a><div class="muted small">${esc(s.author || '')} · ${s.events} event${s.events === 1 ? '' : 's'} · ${s.participants} blyg${s.participants === 1 ? '' : 's'}${s.changed ? ' · <span class="read">changed since you read</span>' : s.read ? ' · <span class="read">read</span>' : ''}</div></div>`).join('') || '<div class="muted small">nothing moved in the window</div>');
    el.querySelectorAll('a[data-scene]').forEach(a => a.onclick = ev => { ev.preventDefault(); pres.scene(F.points[Number(a.dataset.scene)]); });
  }
  function renderRegions() {
    const el = main.querySelector('#fregions');
    if (!el) return;
    const tot = d3.sum([...HEAT].filter(([i]) => visible(F.points[i])), h => h[1]) || 1;
    const hot = PULSE && HEAT.size > 0;
    const here = pres && pres.current ? parentOf(pres.current() || '') : null;
    const rows = topLevel.map(c => ({ c, heat: hot ? regionHeat(c) / tot : 0 })).sort((a, b) => hot ? b.heat - a.heat : b.c.size - a.c.size);
    el.innerHTML = `<h2>regions <span class="muted">— ${hot ? 'by share of the pulse' : 'by size'}</span></h2>` + rows.map(({ c, heat }) => `<div class="fregion${here === c.path ? ' here' : ''}"><a href="#" data-region="${c.path}">${esc(nameOf(c, 3))}</a>
      <span class="muted small">${c.size}${PULSE && heat ? ` · <b class="accent">${Math.round(heat * 100)}%</b>` : ''}</span>${PULSE ? `<i class="fbar2" style="width:${Math.round(heat * 100)}%"></i>` : ''}
      <div class="muted small frep2">${esc((c.rep || '').slice(0, 60))}</div></div>`).join('');
    el.querySelectorAll('a[data-region]').forEach(a => a.onclick = ev => { ev.preventDefault(); pres.region(byPath.get(a.dataset.region)); });
  }
  function renderOrigins() {
    const el = main.querySelector('#forigins');
    el.innerHTML = `<h2>${FW.origins} <span class="muted">— click to hide/show</span></h2>` + F.origins.map(o => `<button class="forigin ${fieldState.hidden.has(o.origin) ? 'off' : ''}" data-origin="${esc(o.origin)}"><i style="background:${originColor(o.origin)}"></i>${esc(o.short.length > 30 ? o.short.slice(0, 29) + '…' : o.short)} <span class="muted">${o.n}</span></button>`).join('');
    el.querySelectorAll('button[data-origin]').forEach(b => b.onclick = () => {
      const o = b.dataset.origin;
      if (fieldState.hidden.has(o)) fieldState.hidden.delete(o); else fieldState.hidden.add(o);
      b.classList.toggle('off', fieldState.hidden.has(o)); saveFieldState();
      restyle(); renderRegions();
    });
  }
  renderOrigins(); renderRegions();

  // ---------------------------------------------------------------- marks: the side-panel list, the lasso, "go there"
  function renderMarks() {
    const el = main.querySelector('#fmarks');
    if (!el) return;
    const ms = MARKS || [];
    el.innerHTML = `<h2>marks <span class="muted">— <a href="#" data-lasso title="lasso some dots (key l)">l</a> to lasso</span></h2>` + (ms.length
      ? ms.map(m => `<div class="fmrow${m.state === 'proposed' ? ' prop' : ''}${MARK.hl === m.id ? ' hl' : ''}"><i></i><a href="#" data-mark="${esc(String(m.id))}">${esc(markName(m))}</a> <span class="muted small">${m.n ?? markIdx(m).length}${m.made_by === 'agent' ? ' · agent' : ''}${m.state === 'proposed' ? ' · proposal' : ''}</span>${m.note ? `<div class="muted small fmrnote">${esc(m.note.length > 90 ? m.note.slice(0, 89) + '…' : m.note)}</div>` : ''}</div>`).join('')
      : '<div class="muted small">none yet — press <b>l</b> (or <b>mark</b> above the map) and drag around some dots</div>');
    const byId = id => ms.find(m => String(m.id) === id);
    el.querySelectorAll('a[data-mark]').forEach(a => {
      const m = byId(a.dataset.mark);
      a.onclick = ev => { ev.preventDefault(); if (m) markOpen(m.id); };
      a.onmouseenter = () => { if (m && MARK.hl !== m.id) { MARK.hl = m.id; pres.marks && pres.marks(); } };
      a.onmouseleave = () => { if (m && MARK.hl === m.id && !MCARDS.has(String(m.id))) { MARK.hl = null; pres.marks && pres.marks(); } };
    });
    el.querySelectorAll('a[data-lasso]').forEach(a => a.onclick = ev => { ev.preventDefault(); lassoSet(!MARK.on); });
  }
  MARK.refresh = () => { if (stale(g) || !wrap.isConnected) return; renderMarks(); pres.marks && pres.marks(); };
  // "go there": the view the mark was made in — mode, level, plane, hidden blygs (a hash, plus the plane's zoom) — or,
  // with no view, the map fitted to the members
  MARK.go = (view, members) => {
    if (stale(g) || !wrap.isConnected) return;
    const idx = (members || []).map(x => KEYI.get(x.origin + '|' + x.id)).filter(i => i !== undefined);
    if (!view || !MODES.includes(view.mode)) { if (idx.length && pres.fit) pres.fit(idx); return; }
    const hid = Array.isArray(view.hidden) ? view.hidden : null;
    const hidChanged = !!hid && (hid.length !== fieldState.hidden.size || hid.some(o => !fieldState.hidden.has(o)));
    if (hidChanged) fieldState.hidden = new Set(hid);
    if (view.mode === 'tour' && view.tour) fieldState.tour = view.tour;
    const hash = view.hash || '#/field';
    if (view.mode === mode && !hidChanged) {
      if (mode === 'plane') return pres.go(view);
      if (location.hash !== hash) location.hash = hash;   // the router hands it to the live view, which moves in place
      return;
    }
    fieldState.mode = view.mode; saveFieldState();
    MARK.pendingView = view;
    fieldHashNav = null; history.replaceState(null, '', hash); route();
  };

  // The lasso: a layer over the map that takes the pointer while it is out (l, or `mark`); a freehand loop selects the
  // dots drawn inside it — what each presentation's drawn() says is on screen now — and opens the card that names them.
  const legendEl = main.querySelector('#flegend'), fsvg = main.querySelector('#fsvg');
  const lz = d3.select(wrap).append('svg').attr('class', 'flasso');
  const lzPath = lz.append('path').attr('class', 'flz'), lzDots = lz.append('g');
  const hint = d3.select(wrap).append('div').attr('class', 'flzhint').attr('hidden', true);
  const toSvg = ([x, y]) => { const r = fsvg.getBoundingClientRect(), vb = fsvg.viewBox.baseVal; return [(x - r.left) * vb.width / r.width, (y - r.top) * vb.height / r.height]; };
  const toLz = ([x, y]) => { const r = lz.node().getBoundingClientRect(); return [x - r.left, y - r.top]; };
  const NODOTS = 'zoom in to mark — at this level there are no dots to lasso';
  function lassoSet(on) {
    MARK.on = !!on;
    lz.classed('on', MARK.on);
    main.querySelectorAll('.fbar a[data-lasso], [data-fab="mark"]').forEach(a => a.classList.toggle('on', MARK.on));
    if (MARK.on) {
      const msg = pres.drawn() ? 'drag around the dots to mark them · Esc cancels' : NODOTS;
      hint.attr('hidden', null).text(msg);
      legendEl.innerHTML = `<b>lasso</b> — ${msg}`;
    } else { hint.attr('hidden', true); legend(); }
    if (pres.lasso) pres.lasso(MARK.on);
  }
  const clearLasso = () => { lzPath.attr('d', null); lzDots.selectAll('*').remove(); lz.classed('done', false); };
  let poly = null;
  const drawPoly = () => lzPath.attr('d', poly && poly.length > 1 ? 'M' + poly.map(q => toLz(q).map(v => v.toFixed(1)).join(',')).join('L') + 'Z' : null);
  lz.on('pointerdown', ev => {
    if (!MARK.on || ev.button !== 0) return;
    ev.preventDefault(); lz.node().setPointerCapture(ev.pointerId);
    if (MARK.pending) MARK.pending.close();
    clearLasso();
    poly = [[ev.clientX, ev.clientY]];
  }).on('pointermove', ev => {
    if (!poly) return;
    const q = poly[poly.length - 1];
    if (Math.hypot(ev.clientX - q[0], ev.clientY - q[1]) < 3) return;
    poly.push([ev.clientX, ev.clientY]); drawPoly();
  }).on('pointerup pointercancel', () => {
    if (!poly) return;
    const pts = poly; poly = null;
    closeLasso(pts);
  });
  function closeLasso(pts) {
    const sv = pts.map(toSvg);
    if (pts.length < 4 || Math.abs(d3.polygonArea(sv)) < 80) { clearLasso(); return; }   // a click, not a loop
    const dots = pres.drawn();
    if (!dots) { clearLasso(); hint.text(NODOTS); return; }
    const seen = new Set(), sel = [];
    for (const d of dots) if (!seen.has(d.i) && d3.polygonContains(sv, [d.x, d.y])) { seen.add(d.i); sel.push(d); }
    if (!sel.length) { clearLasso(); hint.text('nothing inside that loop — try again, or Esc'); return; }
    // the loop and its dots stay drawn while the card is open
    const r = fsvg.getBoundingClientRect(), vb = fsvg.viewBox.baseVal, lr = lz.node().getBoundingClientRect();
    lzDots.selectAll('circle').data(sel).join('circle').attr('r', 4.5)
      .attr('cx', d => d.x * r.width / vb.width + r.left - lr.left).attr('cy', d => d.y * r.height / vb.height + r.top - lr.top);
    lz.classed('done', true);
    lassoSet(false);
    const view = Object.assign(pres.view ? pres.view() : { mode }, { hidden: [...fieldState.hidden], color: fieldState.color });
    const gesture = { kind: 'lasso', points: sv.map(q => q.map(v => Math.round(v * 10) / 10)), w: Math.round(vb.width), h: Math.round(vb.height) };
    markSaveCard(sel.map(d => F.points[d.i]), gesture, view, d3.max(pts, q => q[0]) + 18, d3.min(pts, q => q[1]), clearLasso);
  }
  main.querySelectorAll('.fbar a[data-lasso]').forEach(a => a.onclick = ev => { ev.preventDefault(); lassoSet(!MARK.on); });
  const fabMark = main.querySelector('[data-fab="mark"]');
  if (fabMark) fabMark.onclick = () => lassoSet(!MARK.on);
  // l toggles the lasso; Esc puts it (or an unsaved card) away before the view's own Esc goes up a level
  const onMarkKey = ev => {
    if (stale(g) || !wrap.isConnected) { removeEventListener('keydown', onMarkKey, true); return; }
    const t = ev.target, typing = (t instanceof HTMLInputElement && t.type !== 'range') || t instanceof HTMLTextAreaElement || (t && t.isContentEditable);
    if (ev.key === 'Escape') {
      if (MARK.on) { ev.preventDefault(); ev.stopImmediatePropagation(); lassoSet(false); return; }
      if (MARK.pending && !typing) { ev.preventDefault(); ev.stopImmediatePropagation(); MARK.pending.close(); return; }
      if (typing && t.closest && t.closest('.fmcard')) { ev.stopImmediatePropagation(); t.blur(); }   // out of the card's field, and no further
      return;
    }
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'l') { ev.preventDefault(); ev.stopImmediatePropagation(); lassoSet(!MARK.on); }
  };
  addEventListener('keydown', onMarkKey, true);
  renderMarks();
  marksLoad().then(() => MARK.refresh());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => MARK.refresh());   // the labels' targets are measured from the drawn text: again once the fonts are in

  // ---------------------------------------------------------------- tooltip + controls
  const $tip = main.querySelector('#ftip');
  function tip(ev, html) { $tip.innerHTML = html; $tip.hidden = false; const r = wrap.getBoundingClientRect(); $tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 340) + 'px'; $tip.style.top = Math.min(ev.clientY - r.top + 16, r.height - $tip.offsetHeight - 6) + 'px'; }
  function tipOff() { $tip.hidden = true; }
  main.querySelectorAll('a[data-mode]').forEach(a => a.onclick = ev => { ev.preventDefault(); if (a.dataset.mode === mode) return; fieldState.mode = a.dataset.mode; saveFieldState(); history.replaceState(null, '', '#/field'); route(); });   // the levels of one tree mean nothing in another
  main.querySelectorAll('input[data-layer]').forEach(cb => cb.onchange = () => { L[cb.dataset.layer] = cb.checked; saveFieldState(); if (cb.dataset.layer === 'marks' || cb.dataset.layer === 'notes') pres.marks && pres.marks(); else if (cb.checked && cb.dataset.layer === 'pulse' && !PULSE) loadPulse(); else restyle(); });
  main.querySelectorAll('a[data-days]').forEach(a => a.onclick = ev => { ev.preventDefault(); fieldState.days = Number(a.dataset.days); saveFieldState(); main.querySelectorAll('a[data-days]').forEach(b => b.classList.toggle('on', b === a)); L.pulse = true; main.querySelector('input[data-layer=pulse]').checked = true; loadPulse(); });
  main.querySelectorAll('a[data-color]').forEach(a => a.onclick = ev => { ev.preventDefault(); fieldState.color = a.dataset.color; saveFieldState(); main.querySelectorAll('a[data-color]').forEach(b => b.classList.toggle('on', b === a)); legend(); restyle(); });
  // `/`: to the search — the page's bar, or in full screen (where the bar is hidden) a small box over the map. Enter
  // searches and puts the box away; an empty Enter clears.
  const find = main.querySelector('.ffind'), ffq = find.querySelector('input');
  const asList = qs => { location.hash = '#/search/' + encodeURIComponent(qs); };
  ffq.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return;
    const v = ffq.value.trim();
    if (ev.shiftKey && v) return asList(v);
    runSearch(v); find.hidden = true; ffq.blur();
  });
  ffq.addEventListener('input', () => { if (!ffq.value.trim() && fieldState.q) runSearch(''); });
  ffq.addEventListener('blur', () => { find.hidden = true; });
  function openFind() { find.hidden = false; ffq.value = fieldState.q || ''; ffq.focus(); ffq.select(); }
  const onSlash = ev => {
    if (stale(g) || !find.isConnected) { document.removeEventListener('keydown', onSlash); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || (ev.target && ev.target.isContentEditable)) return;
    // Enter lights the map and lets go of the box, so shift+Enter has to work from the map as well: the lit search, as a list
    if (ev.key === 'Enter' && ev.shiftKey && fieldState.q) { ev.preventDefault(); return asList(fieldState.q); }
    if (ev.key !== '/') return;
    ev.preventDefault();
    if (document.body.classList.contains('ffull')) openFind();
    else if (topQ) { topQ.focus(); topQ.select(); }
  };
  document.addEventListener('keydown', onSlash);
  // The key is written on a button in the full-screen corner (Ben, Nov 10: nothing there said `/` searches).
  const findBtn = main.querySelector('[data-fab="find"]');
  if (findBtn) findBtn.onclick = openFind;

  pres.restyle();
  pres.start(!!fieldState.q);
  if (L.pulse) loadPulse();
  if (fieldState.q) runSearch(fieldState.q);
}
