// Marks — places the reader marks on the map, with an agent on the same page.
//
// A mark is a set of items the reader picked out on the map, with the reader's own name and note. It is tied to items,
// not coordinates, so it survives a new layout. Three layers, kept apart: the reader's name and note; a computed label
// (the shape block, marks-shape.ts, no model); and notes, each marked as the reader's or an agent's.
//
// The reader makes marks on the map (the lasso). An agent may only propose one: a proposal is drawn differently
// until the reader keeps it, and a kept one still records that an agent made it. Membership is frozen when the mark is
// made; a member revised later stays in the mark at its latest version. Nothing here publishes anything.

import type Database from 'better-sqlite3';
import * as fs from 'fs';
import { locateItem } from './core.js';
import { itemUrl, OLLAMA_URL } from './search.js';
import { MARKS_AI } from './config.js';
import { field } from './field.js';
import { apartTerms, computeShape, liveParts, renderShape, shapeKey } from './marks-shape.js';
import type { Shape } from './marks-shape.js';

export interface MarkRow { id: number; name: string; note: string | null; made_by: 'reader' | 'agent'; state: 'kept' | 'proposed'; created: string; updated: string; n: number }
export interface MemberRef { origin: string; id: string }

const now = () => new Date().toISOString();
const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function row(d: Database.Database, id: number): any {
  const m = d.prepare(`SELECT * FROM marks WHERE id=?`).get(id) as any;
  if (!m) throw new Error(`no mark #${id}`);
  return m;
}
const membersOf = (d: Database.Database, id: number): (MemberRef & { version: number | null })[] =>
  (d.prepare(`SELECT origin, item_id AS id, version FROM mark_members WHERE mark_id=? ORDER BY rowid`).all(id) as any[]);
const brief = (m: any, n: number): MarkRow => ({ id: m.id, name: m.name, note: m.note, made_by: m.made_by, state: m.state, created: m.created, updated: m.updated, n });

/** Every mark, with its members and where each one sits on the current map (`i`, null when not placed). */
export function listMarks(d: Database.Database) {
  const v = field(d);
  const marks = d.prepare(`SELECT * FROM marks ORDER BY updated DESC`).all() as any[];
  return marks.map(m => {
    const members = membersOf(d, m.id).map(x => ({ origin: x.origin, id: x.id, i: v.index.get(`${x.origin}|${x.id}`) ?? null }));
    return { ...brief(m, members.length), members };
  });
}

/** Resolve refs (bare id, URL, "origin id", or {origin, id}) to held items; unknown refs are an error, not a silent drop. */
function resolve(d: Database.Database, refs: (string | MemberRef)[]): (MemberRef & { version: number })[] {
  const out = new Map<string, MemberRef & { version: number }>();
  const missing: string[] = [];
  for (const r of refs) {
    const loc = typeof r === 'string' ? locateItem(d, r) : locateItem(d, r);
    const it = loc ? d.prepare(`SELECT origin, id, version FROM items WHERE origin=? AND id=?`).get(loc.origin, loc.id) as any : null;
    if (!it) { missing.push(typeof r === 'string' ? r : `${r.origin} ${r.id}`); continue; }
    out.set(`${it.origin}|${it.id}`, { origin: it.origin, id: it.id, version: it.version });
  }
  if (missing.length) throw new Error(`not in the atlas: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5})` : ''}`);
  return [...out.values()];
}

export function createMark(d: Database.Database, a: { name?: string; note?: string | null; members: (string | MemberRef)[]; view?: any; gesture?: any; made_by?: 'reader' | 'agent' }) {
  const members = resolve(d, a.members);
  if (!members.length) throw new Error('a mark needs at least one item');
  const by = a.made_by === 'agent' ? 'agent' : 'reader';
  const t = now();
  const id = d.transaction(() => {
    const id = Number(d.prepare(`INSERT INTO marks (name, note, made_by, state, view, gesture, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(String(a.name ?? '').trim(), a.note?.trim() || null, by, by === 'agent' ? 'proposed' : 'kept', a.view ? JSON.stringify(a.view) : null, a.gesture ? JSON.stringify(a.gesture) : null, t, t).lastInsertRowid);
    const ins = d.prepare(`INSERT OR IGNORE INTO mark_members (mark_id, origin, item_id, version) VALUES (?, ?, ?, ?)`);
    for (const m of members) ins.run(id, m.origin, m.id, m.version);
    return id;
  })();
  shapeOf(d, id);   // computed when the mark is saved
  return markListRow(d, id);
}

function markListRow(d: Database.Database, id: number) {
  const v = field(d), m = row(d, id);
  const members = membersOf(d, id).map(x => ({ origin: x.origin, id: x.id, i: v.index.get(`${x.origin}|${x.id}`) ?? null }));
  return { ...brief(m, members.length), members };
}

export function updateMark(d: Database.Database, id: number, a: { name?: string; note?: string | null; state?: string }) {
  const m = row(d, id);
  const name = a.name !== undefined ? String(a.name).trim() : m.name;
  const note = a.note !== undefined ? (a.note?.trim() || null) : m.note;
  const state = a.state === 'kept' || a.state === 'proposed' ? a.state : m.state;
  d.prepare(`UPDATE marks SET name=?, note=?, state=?, updated=? WHERE id=?`).run(name, note, state, now(), id);
  return markListRow(d, id);
}

export function addNote(d: Database.Database, id: number, text: string, author: 'reader' | 'agent' = 'reader') {
  row(d, id);
  const t = String(text ?? '').trim();
  if (!t) throw new Error('an empty note');
  const at = now();
  const nid = Number(d.prepare(`INSERT INTO mark_notes (mark_id, author, text, at) VALUES (?, ?, ?, ?)`).run(id, author, t, at).lastInsertRowid);
  d.prepare(`UPDATE marks SET updated=? WHERE id=?`).run(at, id);
  return { id: nid, author, text: t, at };
}

export function deleteMark(d: Database.Database, id: number) {
  row(d, id);
  d.transaction(() => {
    d.prepare(`DELETE FROM mark_notes WHERE mark_id=?`).run(id);
    d.prepare(`DELETE FROM mark_members WHERE mark_id=?`).run(id);
    d.prepare(`DELETE FROM marks WHERE id=?`).run(id);
  })();
  return { deleted: id };
}

/** The stored shape, recomputed when the layout or the members changed since. */
export function shapeOf(d: Database.Database, id: number): Shape {
  const m = row(d, id), members = membersOf(d, id), view = parse(m.view);
  const key = shapeKey(d, members, view);
  if (m.shape && m.shape_key === key) { const s = parse(m.shape); if (s) return s; }
  const s = computeShape(d, { members, view });
  d.prepare(`UPDATE marks SET shape=?, shape_key=? WHERE id=?`).run(JSON.stringify(s), key, id);
  return s;
}

function live(d: Database.Database, id: number, reads: boolean) {
  const others = (d.prepare(`SELECT id, name, state FROM marks WHERE id<>?`).all(id) as any[]).map(o => ({ ...o, members: membersOf(d, o.id) }));
  return liveParts(d, membersOf(d, id), others, { reads });
}

/** One mark for the page: the reader's layer, members, notes, the shape block and its text. */
export function getMark(d: Database.Database, id: number, opts: { reads?: boolean } = {}) {
  const m = row(d, id), v = field(d);
  const shape = shapeOf(d, id), lp = live(d, id, !!opts.reads);
  const q = d.prepare(`SELECT title, author_name, created, page, kind FROM items WHERE origin=? AND id=?`);
  const members = membersOf(d, id).map(x => {
    const it = q.get(x.origin, x.id) as any;
    return { i: v.index.get(`${x.origin}|${x.id}`) ?? null, origin: x.origin, id: x.id, version: x.version, title: it?.title ?? null, author: it?.author_name ?? null, created: it?.created ?? null, url: it ? itemUrl(x.origin, x.id, it.page, it.kind) : null };
  });
  return {
    mark: { ...brief(m, members.length), view: parse(m.view), gesture: parse(m.gesture) },
    members, notes: d.prepare(`SELECT id, author, text, at FROM mark_notes WHERE mark_id=? ORDER BY at`).all(id),
    shape: { ...shape, ...lp }, shape_text: renderShape(m.name, shape, lp),
  };
}

/** One mark for an agent: the shape block as text, the notes, and the member texts up to a token budget (oldest
 *  first); the rest are named as left out, reachable with blyg_item. */
export function openMark(d: Database.Database, id: number, opts: { budget_tokens?: number; reads?: boolean; json?: boolean } = {}) {
  const g = getMark(d, id, { reads: opts.reads });
  const budget = Math.max(0, opts.budget_tokens ?? 12000);
  const q = d.prepare(`SELECT content_text, version, created FROM items WHERE origin=? AND id=?`);
  const rows = g.members.map(x => ({ x, it: q.get(x.origin, x.id) as any })).sort((a, b) => String(a.it?.created ?? '').localeCompare(String(b.it?.created ?? '')));
  let used = 0;
  const texts: any[] = [], left: any[] = [];
  for (const { x, it } of rows) {
    const text = String(it?.content_text ?? ''), cost = Math.ceil(text.length / 4);
    const head = { ref: x.id, title: x.title, author: x.author, created: x.created, version: it?.version ?? null, marked_version: x.version, url: x.url };
    if (used + cost <= budget) { texts.push({ ...head, text }); used += cost; } else left.push({ ...head, tokens: cost });
  }
  return {
    mark: { id: g.mark.id, name: g.mark.name, note: g.mark.note, made_by: g.mark.made_by, state: g.mark.state, created: g.mark.created },
    shape_text: g.shape_text, ...(opts.json ? { shape: g.shape } : {}),
    notes: g.notes,
    texts, tokens_included: used, budget_tokens: budget,
    ...(left.length ? { left_out: left, left_out_note: `${left.length} member${left.length === 1 ? '' : 's'} over the budget — raise budget_tokens, or read them with blyg_item` } : {}),
  };
}

export function renderMarkList(rows: ReturnType<typeof listMarks>): string {
  if (!rows.length) return '(no marks yet — lasso some items on the map, or `blyg-atlas mark add --name … <ref> …`)';
  return rows.map(m => `#${m.id} ${m.name ? `"${m.name}"` : '(unnamed)'} · ${m.n} items${m.state === 'proposed' ? ' · proposed by an agent' : m.made_by === 'agent' ? ' · made by an agent, kept' : ''} · ${m.updated.slice(0, 10)}${m.note ? `\n    ${m.note.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`).join('\n');
}

// ---------------------------------------------------------------- suggestions for a fresh lasso
// Two tiers. The first is no model: the words that set the set apart (the same rule that names regions), instant. The
// second, only when the reader has set a local model and written a prompt (atlas.config.json `marks`), hands that model
// the shape block and the member titles — never the full texts — and returns what it wrote. No prompt ships with the
// atlas: what a mark is called is the reader's to decide, so the prompt is a file they own.

const shuffle = <T>(xs: T[]): T[] => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export function suggestTerms(d: Database.Database, members: MemberRef[], view?: any) {
  // a plural beside its singular ("quixote", "quixotes") is one word
  const terms = apartTerms(d, { members, view }, 6).filter((t, i, all) => !all.some((u, j) => j !== i && (t === u + 's' || t === u + 'es'))).slice(0, 3);
  return { text: terms.join(' · '), terms, source: 'terms' as const };
}

/** The prompt file with <!-- comments --> dropped, or null when it is missing or empty after that. */
function readPrompt(file: string | null): string | null {
  if (!file) return null;
  try { const t = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim(); return t || null; } catch { return null; }
}

export async function suggestModel(d: Database.Database, members: MemberRef[], view: any, what: 'name' | 'note', over: { model?: string; prompt?: string } = {}) {
  const model = over.model ?? MARKS_AI.model;
  const prompt = over.prompt ?? readPrompt(MARKS_AI.prompts[what]);
  if (!model) return { text: null, reason: 'no model set (atlas.config.json → marks.model)' };
  if (!prompt) return { text: null, reason: `no ${what} prompt (atlas.config.json → marks.prompts.${what}, a file you write)` };
  const t0 = Date.now();
  const refs = resolve(d, members);
  const shape = computeShape(d, { members: refs, view });
  const block = renderShape('', shape).split('\n').slice(1).join('\n');   // without the header line, which carries no name yet
  const q = d.prepare(`SELECT title, author_name FROM items WHERE origin=? AND id=?`);
  const titles = refs.slice(0, 60).map(m => { const it = q.get(m.origin, m.id) as any; return `- ${it?.title ?? '(untitled)'}${it?.author_name ? ` (${it.author_name})` : ''}`; }).join('\n') + (refs.length > 60 ? `\n- … and ${refs.length - 60} more` : '');
  const templated = /\{\{(block|titles)\}\}/.test(prompt);
  const messages = templated
    ? [{ role: 'user', content: prompt.replace(/\{\{block\}\}/g, block).replace(/\{\{titles\}\}/g, titles) }]
    : [{ role: 'system', content: prompt }, { role: 'user', content: `${block}\n\nMember titles:\n${titles}` }];
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model, messages, stream: false, think: false, keep_alive: '15m', options: { temperature: 0.8, num_predict: what === 'name' ? 100 : 200 } }),
  });
  if (!r.ok) return { text: null, reason: `Ollama ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const raw = String(((await r.json()) as any)?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // a name prompt may ask for several (one per line, best first): every line is an option, the first is the suggestion
  // a small model sometimes wraps its list in markdown, kind tags or commentary: keep only short name-like lines
  // (list markers, emphasis, a leading "name:", a short tag in brackets after the name, quotes; a line that still has a
  // colon or runs past six words is commentary)
  const clean = (l: string) => l.replace(/\*\*|__|`/g, '').replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').replace(/^(name|title)\s*:\s*/i, '').replace(/\s*[(\[][^()\[\]]{1,24}[)\]]\s*$/, '').replace(/^["'“*#\s]+|["'”*\s.]+$/g, '');
  const nameLike = (l: string) => l && !/[:;]/.test(l) && l.split(/\s+/).length <= 6;
  // shuffled: a model tends to list its options in the same order every time, so the first would always be the same sort
  const options = what === 'name' ? shuffle([...new Set(raw.split('\n').map(clean).filter(nameLike))].slice(0, 8)) : [];
  // a note is the first paragraph, without markdown
  const text = what === 'name' ? (options[0] ?? '') : (raw.split(/\n\s*\n/)[0] ?? '').replace(/\*\*|__/g, '').trim().slice(0, 800);
  return text ? { text, ...(options.length > 1 ? { options } : {}), source: 'model' as const, model, ms: Date.now() - t0 } : { text: null, reason: 'the model returned nothing' };
}
