// Blyg Atlas — embeddings: one model (nomic-embed-text v1.5, 768 dimensions), two ways to run it.
//
//   ollama   the Ollama server's `nomic-embed-text` (GPU where there is one; ~15 items/s on an Apple laptop)
//   local    the same weights as ONNX, run inside this process by transformers.js (CPU; ~5 items/s on the same
//            laptop; a one-time ~550 MB download into .model-cache/)
//
// The two give the same vectors — measured 2026-11-09 on 64 items against stored Ollama vectors, cosine 1.0000 at
// full precision (the quantized ONNX file reads 0.96–0.98 and is not used) — so an atlas can be embedded by one and
// searched through the other, and nothing needs re-embedding when Ollama comes or goes.
//
// Which one runs: BLYG_EMBEDDER or atlas.config.json `embedder` = "ollama" | "local" | "auto" (default). On auto,
// Ollama is used when it answers and has the model pulled, and the in-process model otherwise. A different model
// name (BLYG_EMBED_MODEL) is an Ollama model with no in-process twin: it runs on Ollama or not at all.
//
// On auto the choice is not for the life of the process. One slow answer does not decide it: Ollama gets a second
// try a moment later before the in-process model takes over (a laptop just awake answers late; seen 2026-11-10, when
// a long-running dashboard's first search of the morning downloaded 550 MB and stayed on the CPU). And while the
// in-process model is standing in, Ollama is looked for again every few minutes and taken back when it answers.

import * as fs from 'fs';
import * as path from 'path';
import { CONFIG, MODEL_CACHE } from './config.js';

export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = 'nomic-embed-text';
export const EMBED_MODEL = process.env.BLYG_EMBED_MODEL || DEFAULT_MODEL;
export const LOCAL_MODEL = 'nomic-ai/nomic-embed-text-v1.5';   // the ONNX export of what Ollama serves as nomic-embed-text

export type Backend = 'ollama' | 'local';
type Want = Backend | 'auto';
const WANT: Want = (() => {
  const w = String(process.env.BLYG_EMBEDDER || CONFIG.embedder || 'auto').toLowerCase();
  if (w !== 'ollama' && w !== 'local' && w !== 'auto') throw new Error(`embedder must be "ollama", "local" or "auto" (got "${w}")`);
  return w;
})();
const HAS_TWIN = EMBED_MODEL === DEFAULT_MODEL;

const say = (s: string) => process.stderr.write(s + '\n');

// ---------------------------------------------------------------- choosing

let chosen: { backend: Backend; why: string } | null = null;
let standIn = false;        // the in-process model is running only because Ollama did not answer (auto)
let lastProbe = 0;          // when Ollama was last looked for while the stand-in runs
const RETRY_AFTER_MS = 2000, RECHECK_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function ollamaHasModel(timeoutMs = 1500): Promise<{ up: boolean; has: boolean }> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { up: false, has: false };
    const j: any = await r.json();
    const names: string[] = Array.isArray(j.models) ? j.models.map((m: any) => String(m.name || m.model || '')) : [];
    return { up: true, has: names.some(n => n === EMBED_MODEL || n.startsWith(EMBED_MODEL + ':')) };
  } catch { return { up: false, has: false }; }
}

function fallBack(why: string): { backend: Backend; why: string } {
  standIn = true; lastProbe = Date.now();
  return chosen = { backend: 'local', why };
}

/** Which backend this process embeds with, and why. Decided on first use; on auto, a stand-in in-process model gives
 *  way to Ollama again when Ollama is back (looked for at most every RECHECK_MS). */
export async function embedder(): Promise<{ backend: Backend; why: string }> {
  if (chosen && standIn && Date.now() - lastProbe >= RECHECK_MS) {
    lastProbe = Date.now();
    const o = await ollamaHasModel();
    if (o.up && o.has) {
      say(`[embed] Ollama is answering at ${OLLAMA_URL} again — back to it`);
      standIn = false;
      const ex = extractor; extractor = null;   // let the in-process model's memory go
      if (ex) ex.then(p => p?.dispose?.()).catch(() => {});
      return chosen = { backend: 'ollama', why: `Ollama at ${OLLAMA_URL}` };
    }
  }
  if (chosen) return chosen;
  if (WANT === 'local') {
    if (!HAS_TWIN) throw new Error(`embedder is set to "local", but ${EMBED_MODEL} is an Ollama model with no in-process version — unset BLYG_EMBED_MODEL or use Ollama`);
    return chosen = { backend: 'local', why: 'embedder set to local' };
  }
  if (WANT === 'ollama') return chosen = { backend: 'ollama', why: 'embedder set to ollama' };
  let o = await ollamaHasModel();
  if (!o.up) { await sleep(RETRY_AFTER_MS); o = await ollamaHasModel(4000); }   // one slow or missed answer is not "no Ollama"
  if (o.up && o.has) return chosen = { backend: 'ollama', why: `Ollama at ${OLLAMA_URL}` };
  const why = o.up ? `Ollama is running but ${EMBED_MODEL} is not pulled (ollama pull ${EMBED_MODEL})` : `no Ollama at ${OLLAMA_URL}`;
  if (!HAS_TWIN) throw new Error(`${why}, and ${EMBED_MODEL} has no in-process version — start Ollama and pull the model, or unset BLYG_EMBED_MODEL`);
  return fallBack(`${why} — running the same model in this process`);
}

/** One line for a log or a status page: "nomic-embed-text via Ollama" / "… in-process (no Ollama at …)". */
export async function embedderLabel(): Promise<string> {
  const e = await embedder();
  return e.backend === 'ollama' ? `${EMBED_MODEL} via Ollama` : `${EMBED_MODEL} in-process (${e.why.split(' — ')[0]})`;
}

// ---------------------------------------------------------------- ollama

async function ollamaEmbed(texts: string[]): Promise<number[][]> {
  // Prefer the batched endpoint; fall back to one-at-a-time on older servers.
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(120_000),
  }).catch((e) => { throw new Error(`Ollama unreachable at ${OLLAMA_URL}: ${e.message}`); });
  if (res.ok) {
    const j: any = await res.json();
    if (Array.isArray(j.embeddings) && j.embeddings.length === texts.length) return j.embeddings;
  }
  const out: number[][] = [];
  for (const t of texts) {
    const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: t }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`Ollama embeddings HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    if (!Array.isArray(j.embedding)) throw new Error('Ollama returned no embedding');
    out.push(j.embedding);
  }
  return out;
}

// ---------------------------------------------------------------- in-process

let extractor: Promise<any> | null = null;

function loadLocal(): Promise<any> {
  if (extractor) return extractor;
  extractor = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = MODEL_CACHE;
    const cached = fs.existsSync(path.join(MODEL_CACHE, LOCAL_MODEL, 'onnx', 'model.onnx'));
    if (!cached) say(`[embed] downloading the embedding model (${LOCAL_MODEL}, ~550 MB, once) into ${path.relative(process.cwd(), MODEL_CACHE) || MODEL_CACHE}/ …`);
    let lastPct = -10;
    const progress_callback = cached ? undefined : (p: any) => {
      if (p?.status !== 'progress' || !/model\.onnx$/.test(p.file || '') || typeof p.progress !== 'number') return;
      if (p.progress - lastPct >= 10) { lastPct = Math.floor(p.progress / 10) * 10; say(`[embed]   ${lastPct}%`); }
    };
    // full precision: the quantized file drifts from Ollama's vectors (cosine ~0.97), fp32 does not
    return pipeline('feature-extraction', LOCAL_MODEL, { dtype: 'fp32', progress_callback } as any);
  })().catch((e) => { extractor = null; throw new Error(`could not load the in-process embedding model (${e.message}) — it needs a one-time download from huggingface.co; or start Ollama and run: ollama pull ${DEFAULT_MODEL}`); });
  return extractor;
}

async function localEmbed(texts: string[]): Promise<number[][]> {
  const ex = await loadLocal();
  const out: number[][] = [];
  // one text at a time: on CPU a padded batch of mixed lengths is slower than the same texts singly
  for (const t of texts) out.push((await ex(t, { pooling: 'mean', normalize: true })).tolist()[0]);
  return out;
}

// ---------------------------------------------------------------- the two calls the rest of the atlas makes

/** Embed texts (already carrying their `search_document: ` / `search_query: ` prefix). */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const e = await embedder();
  if (e.backend === 'local') return localEmbed(texts);
  try { return await ollamaEmbed(texts); }
  catch (err: any) {
    // Ollama was there when this process started and is not now. On auto, try it once more a moment later, then carry
    // on in-process rather than fail a search or a morning run (and keep looking for it: embedder()); when Ollama
    // was asked for by name, say so.
    if (WANT !== 'auto' || !HAS_TWIN) throw err;
    await sleep(RETRY_AFTER_MS);
    try { return await ollamaEmbed(texts); } catch { /* twice: stand in */ }
    say(`[embed] ${err.message} — switching to the in-process model until Ollama answers again`);
    fallBack(`Ollama stopped answering at ${OLLAMA_URL}`);
    return localEmbed(texts);
  }
}

export async function embedQuery(q: string): Promise<Float32Array> {
  const [v] = await embedTexts([`search_query: ${q}`]);
  return Float32Array.from(v);
}
