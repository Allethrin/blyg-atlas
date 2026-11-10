/**
 * Cross-encoder reranker — Jina API backend with local fallback.
 *
 * Scores (query, document) pairs jointly, which is much sharper than bi-encoder
 * cosine similarity for fine relevance distinctions. Scores are in [0, 1], so
 * they support a meaningful relevance threshold (unlike cosine).
 *
 * Backend dispatch is by model name: names starting with "jina" call the Jina
 * rerank API (fast, needs JINA_API_KEY); anything else loads a local ONNX
 * cross-encoder via transformers.js (slow on modest hardware, fully offline).
 * Default is the Jina API when JINA_API_KEY is set, local otherwise. A failed
 * API call falls back to the local model so search never breaks offline.
 * NOTE: score calibration differs per model — a --min-score tuned on one
 * model does not transfer to another. Exception: jinaai/jina-reranker-v2-base-multilingual
 * run locally is the same weights as the API model (q8 ONNX vs API over 180 pairs:
 * mean |Δ|≈0.001, max ≈0.045), so thresholds transfer between those two.
 *
 * Model options (BLYG_RERANK_MODEL env, or --rerank-model):
 *   jina-reranker-v2-base-multilingual            API default
 *   jinaai/jina-reranker-v2-base-multilingual    ~280MB (q8)  same model, local — scores comparable to API
 *   Xenova/ms-marco-MiniLM-L-6-v2                 ~23MB  fastest local, English-only baseline
 *   mixedbread-ai/mxbai-rerank-xsmall-v1          ~87MB  small-machine fallback
 *   mixedbread-ai/mxbai-rerank-base-v1           ~190MB  better, needs more RAM/CPU
 */

import * as fs from 'fs';
import * as path from 'path';
import { ENV_PATH, MODEL_CACHE } from './config.js';

// Fill env gaps from the repo-root .env (gitignored) — existing env vars win.
// Needed when this runs as a subprocess whose environment may not carry API keys.
try {
  const envFile = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env — fine, rely on shell env */ }

const JINA_API_KEY = process.env.JINA_API_KEY || '';
const JINA_DEFAULT_MODEL = 'jina-reranker-v2-base-multilingual';
const LOCAL_DEFAULT_MODEL = 'mixedbread-ai/mxbai-rerank-xsmall-v1';
const DEFAULT_MODEL = JINA_API_KEY ? JINA_DEFAULT_MODEL : LOCAL_DEFAULT_MODEL;
export const RERANKER_MODEL = process.env.RERANKER_MODEL || DEFAULT_MODEL;

const CACHE_DIR = MODEL_CACHE;
const MAX_TOKENS = 512; // pairs beyond this are truncated
const BATCH_SIZE = 8;   // keep peak memory low on small machines

let loaded: { tokenizer: any; model: any; name: string } | null = null;

async function load(modelName: string) {
  if (loaded && loaded.name === modelName) return loaded;
  const { AutoTokenizer, AutoModelForSequenceClassification, AutoConfig, env } = await import('@huggingface/transformers');
  env.cacheDir = CACHE_DIR;
  // first use downloads the model (jina-reranker-v2 is ~280 MB); say so, or the first search just looks hung
  if (!fs.existsSync(path.join(CACHE_DIR, modelName, 'onnx'))) {
    process.stderr.write(`[rerank] downloading the reranker (${modelName}, once) into ${path.relative(process.cwd(), CACHE_DIR) || CACHE_DIR}/ — the first search waits for it\n`);
  }
  const tokenizer = await AutoTokenizer.from_pretrained(modelName);
  // jinaai repos ship a config without model_type (they rely on custom Python
  // code via auto_map), but the ONNX export is a plain XLM-R graph — patch the
  // type so transformers.js can resolve the architecture.
  const config = await AutoConfig.from_pretrained(modelName);
  if (!config.model_type && (config as any).architectures?.[0]?.startsWith('XLMRoberta')) {
    config.model_type = 'xlm-roberta';
  }
  const model = await AutoModelForSequenceClassification.from_pretrained(modelName, { dtype: 'q8', config });
  loaded = { tokenizer, model, name: modelName };
  return loaded;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

async function rerankJina(query: string, texts: string[], modelName: string): Promise<number[]> {
  const res = await fetch('https://api.jina.ai/v1/rerank', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${JINA_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelName,
      query,
      documents: texts,
      return_documents: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jina rerank API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { results: Array<{ index: number; relevance_score: number }> };
  if (!Array.isArray(data.results) || data.results.length !== texts.length) {
    throw new Error(`Jina rerank returned ${data.results?.length ?? 0} scores for ${texts.length} documents`);
  }
  const scores = new Array<number>(texts.length);
  for (const r of data.results) scores[r.index] = r.relevance_score;
  return scores;
}

/**
 * Score each text's relevance to the query. Returns scores in [0, 1], same order as texts.
 */
export async function rerank(query: string, texts: string[], modelName: string = RERANKER_MODEL): Promise<number[]> {
  // API models are bare names like "jina-reranker-v2-base-multilingual"; HF repo
  // ids contain a "/" (e.g. "jinaai/jina-reranker-v2-base-multilingual") and run locally.
  if (modelName.startsWith('jina') && !modelName.includes('/')) {
    if (!JINA_API_KEY) throw new Error(`model ${modelName} needs JINA_API_KEY (set it in .env or pass a local --rerank-model)`);
    try {
      return await rerankJina(query, texts, modelName);
    } catch (err: any) {
      console.error(`Jina rerank failed (${err.message}) — falling back to local ${LOCAL_DEFAULT_MODEL}`);
      return rerankLocal(query, texts, LOCAL_DEFAULT_MODEL);
    }
  }
  return rerankLocal(query, texts, modelName);
}

async function rerankLocal(query: string, texts: string[], modelName: string): Promise<number[]> {
  const { tokenizer, model } = await load(modelName);
  const scores: number[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const inputs = tokenizer(new Array(batch.length).fill(query), {
      text_pair: batch,
      padding: true,
      truncation: true,
      max_length: MAX_TOKENS
    });
    const { logits } = await model(inputs);
    const data: Float32Array = logits.data;
    const perItem = data.length / batch.length;
    for (let j = 0; j < batch.length; j++) {
      // single-logit relevance head; if a model has 2 logits, use the positive class
      scores.push(sigmoid(data[j * perItem + (perItem - 1)]));
    }
  }

  return scores;
}
