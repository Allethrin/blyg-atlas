// Blyg Atlas — where things live and the few knobs a reader may turn.
//
// Everything is anchored on ATLAS_DIR (the repo root by default): the database, the seed list, the field
// sidecar, the model cache. Each setting is read in this order: environment variable → atlas.config.json
// in ATLAS_DIR (optional, gitignored; see atlas.config.example.json) → default. Nothing in here is required
// for a first run: clone, copy seeds.example.json to seeds.json, crawl.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const expandHome = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

export const ATLAS_DIR = process.env.BLYG_ATLAS_DIR ? path.resolve(expandHome(process.env.BLYG_ATLAS_DIR)) : path.resolve(__dirname, '..');

interface AtlasConfig {
  db?: string;          // path to atlas.db (default ATLAS_DIR/atlas.db)
  seeds?: string;       // path to seeds.json (default ATLAS_DIR/seeds.json)
  contact?: string;     // how a crawled site can reach you; goes in the User-Agent beside this repo's URL (unset: the repo's URL alone)
  own_origin?: string;  // your own blyg's origin, if you publish one — your items are left out of pulse and standing queries
  publisher?: string;   // path to a publisher script that takes `reply <ref> <text> [--quote …] [--dry-run|--yes --no-mention]`
                        // and `mention <id> --wait`; when set, the dashboard offers casual replies
  embedder?: 'auto' | 'ollama' | 'local';   // how nomic-embed-text runs: Ollama, in this process, or (default) Ollama when it answers — src/embed.ts
  port?: number;        // dashboard port (default 5053)
  field?: {             // what the Field offers. Default: one view — the tour through meaning + time,
                        // time fixed left to right. The other presentations and spaces are still built; list them to get them back.
    modes?: ('tour' | 'blobs' | 'plane')[];   // presentations; the first is the default (default ['tour'])
    spaces?: ('mt' | 'm4' | 'ar')[];          // tour spaces: meaning + time, meaning in 4D, the arrow space (default ['mt'])
    time_fixed?: boolean;                     // meaning + time: no control turns time out of the horizontal (default true)
  };
}

function readConfig(): AtlasConfig {
  try { return JSON.parse(fs.readFileSync(path.join(ATLAS_DIR, 'atlas.config.json'), 'utf8')); } catch { return {}; }
}
export const CONFIG: AtlasConfig = readConfig();
const local = (p: string | undefined) => (p ? path.resolve(ATLAS_DIR, expandHome(p)) : undefined);

export const VERSION: string = (() => { try { return JSON.parse(fs.readFileSync(path.join(ATLAS_DIR, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })();
export const DB_PATH = local(process.env.ATLAS_DB || process.env.BLYG_ATLAS_DB || CONFIG.db) || path.join(ATLAS_DIR, 'atlas.db');
export const SEEDS_PATH = local(process.env.BLYG_SEEDS || CONFIG.seeds) || path.join(ATLAS_DIR, 'seeds.json');
export const REPO_URL = 'https://github.com/Allethrin/blyg-atlas';
// Who is running this copy, for the User-Agent; '' when unset. Kept to printable ASCII (a header cannot carry anything else) and to a sane length.
export const CONTACT = String(process.env.BLYG_CONTACT || CONFIG.contact || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 200);
export const OWN_ORIGIN: string | null = process.env.BLYG_OWN_ORIGIN || CONFIG.own_origin || null;
export const PUBLISHER: string | null = local(process.env.BLYG_PUBLISHER || CONFIG.publisher) || null;
export const PORT = Number(process.env.BLYG_PORT || CONFIG.port || 5053);
export const FIELD_UI = { modes: ['tour'], spaces: ['mt'], time_fixed: true, ...(CONFIG.field || {}) };
export const SIDECAR_PATH = path.join(ATLAS_DIR, 'field-sidecar.json');
export const MODEL_CACHE = path.join(ATLAS_DIR, '.model-cache');
export const ENV_PATH = path.join(ATLAS_DIR, '.env');
