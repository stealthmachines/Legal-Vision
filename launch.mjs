#!/usr/bin/env node
/**
 * launch.mjs — Easy by zCHG.org  (v0.11 + model-picker)
 *
 * Cross-platform one-click stack launcher with interactive model folder
 * selection. Supports Ollama and LM Studio model directories out of the box,
 * walks them recursively for .gguf files, and lets you pick a model at startup
 * instead of hard-coding one.
 *
 * Usage:
 *   node launch.mjs                          — interactive model picker + start
 *   node launch.mjs --no-proxy               — skip coord-proxy (:1233)
 *   node launch.mjs --no-picker              — skip model picker, use whatever is loaded
 *   node launch.mjs --model-dir <path>       — scan a custom folder (recursive)
 *   node launch.mjs --load-model <MODEL_ID>  — load a specific model by ID then exit
 *   node launch.mjs --status                 — probe ports + show loaded LLMs
 *   node launch.mjs --help                   — show this message
 *
 * Double-click shortcuts:
 *   Windows  → start.bat
 *   macOS    → bash start.sh
 *   Linux    → bash start.sh
 */

import { spawn, execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, statSync } from 'fs';
import { createServer }   from 'net';
import { createInterface } from 'readline';
import { fileURLToPath }  from 'url';
import path               from 'path';
import os                 from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Node.js version guard ─────────────────────────────────────────────────────
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) {
  process.stderr.write(
    `[launch] Node.js >= 18 required (found v${process.versions.node}).\n` +
    `         Download: https://nodejs.org\n`
  );
  process.exit(1);
}

// ── ANSI colours (disabled when not a TTY) ────────────────────────────────────
const TTY = process.stdout.isTTY;
const c = {
  reset:   TTY ? '\x1b[0m'  : '',  bold:    TTY ? '\x1b[1m'  : '',
  dim:     TTY ? '\x1b[2m'  : '',  red:     TTY ? '\x1b[31m' : '',
  green:   TTY ? '\x1b[32m' : '',  yellow:  TTY ? '\x1b[33m' : '',
  blue:    TTY ? '\x1b[34m' : '',  magenta: TTY ? '\x1b[35m' : '',
  cyan:    TTY ? '\x1b[36m' : '',  gray:    TTY ? '\x1b[90m' : '',
};

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv        = process.argv.slice(2);
const NO_PROXY    = argv.includes('--no-proxy');
const NO_PICKER   = argv.includes('--no-picker');
const STATUS      = argv.includes('--status');
const HELP        = argv.includes('--help') || argv.includes('-h');
const LOAD_IDX    = argv.indexOf('--load-model');
const LOAD_MODEL  = LOAD_IDX >= 0 ? argv[LOAD_IDX + 1] : null;
const DIR_IDX     = argv.indexOf('--model-dir');
const CUSTOM_DIR  = DIR_IDX >= 0 ? argv[DIR_IDX + 1] : null;

if (HELP) {
  console.log(`
  ${c.bold}launch.mjs${c.reset} — Easy by zCHG.org

  ${c.cyan}node launch.mjs${c.reset}                          start everything (interactive model picker)
  ${c.cyan}node launch.mjs --no-picker${c.reset}              skip picker, use whatever LM Studio has loaded
  ${c.cyan}node launch.mjs --no-proxy${c.reset}               skip coord-proxy (:1233)
  ${c.cyan}node launch.mjs --model-dir <path>${c.reset}        scan a custom folder for .gguf files (recursive)
  ${c.cyan}node launch.mjs --load-model MODEL_ID${c.reset}     ask LM Studio to load a model then exit
  ${c.cyan}node launch.mjs --status${c.reset}                 probe ports + show loaded LLMs
  ${c.cyan}node launch.mjs --help${c.reset}                   this message

  Ports:  3333 server.js · 3334 server-dos.js · 1233 coord-proxy · 1234 LM Studio

  Default model folders scanned (recursive):
    Ollama  macOS   ~/.ollama/models
    Ollama  Linux   /usr/share/ollama/.ollama/models
    Ollama  Windows C:\\Users\\<user>\\.ollama\\models
    LMStudio macOS  ~/.lmstudio/models
    LMStudio Linux  ~/.lmstudio/models
    LMStudio Win    %USERPROFILE%\\.lmstudio\\models
  `);
  process.exit(0);
}

// ── Tesseract discovery for MCP OCR tools ────────────────────────────────────
function detectTesseractPath() {
  if (process.env.TESSERACT_PATH) return process.env.TESSERACT_PATH;
  if (process.platform !== 'win32') return null;

  const cands = [
    'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
  ];
  for (const c of cands) {
    if (existsSync(c)) return c;
  }
  return null;
}

const TESSERACT_PATH = detectTesseractPath();
const TESSERACT_ENV = TESSERACT_PATH
  ? {
      TESSERACT_PATH,
      PATH: `${path.dirname(TESSERACT_PATH)};${process.env.PATH || ''}`,
    }
  : {};

// ── Processes ─────────────────────────────────────────────────────────────────
const STACK = [
  { label: 'MCP-A ', color: c.cyan,   script: 'server.js',      port: 3333, env: { ...TESSERACT_ENV } },
  { label: 'MCP-B ', color: c.yellow, script: 'server-dos.js',  port: 3334, env: { MCP_PORT: '3334', ...TESSERACT_ENV } },
  { label: 'PROXY ', color: c.blue,   script: 'coord-proxy.js', port: 1233, env: {}, skip: () => NO_PROXY },
];

// ── Port probe ─────────────────────────────────────────────────────────────────
function portInUse(port) {
  return new Promise(resolve => {
    const srv = createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => { srv.close(); resolve(false); });
    srv.listen(port, '127.0.0.1');
  });
}

// ── Platform constants ────────────────────────────────────────────────────────
const IS_WIN   = process.platform === 'win32';
const IS_MAC   = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const HOME     = os.homedir();

// ── Default model folder definitions ─────────────────────────────────────────
//
//   Ollama
//     macOS   : ~/.ollama/models
//     Linux   : /usr/share/ollama/.ollama/models  (standard install)
//               also check ~/.ollama/models        (user install)
//     Windows : C:\Users\<user>\.ollama\models
//
//   LM Studio
//     macOS   : ~/.lmstudio/models
//     Linux   : ~/.lmstudio/models
//     Windows : %USERPROFILE%\.lmstudio\models
//
function getDefaultModelDirs() {
  const dirs = [];

  if (IS_WIN) {
    dirs.push(
      { label: 'Ollama',    path: path.join(HOME, '.ollama', 'models') },
      { label: 'LM Studio', path: path.join(HOME, '.lmstudio', 'models') },
    );
  } else if (IS_MAC) {
    dirs.push(
      { label: 'Ollama',    path: path.join(HOME, '.ollama', 'models') },
      { label: 'LM Studio', path: path.join(HOME, '.lmstudio', 'models') },
    );
  } else {
    // Linux — check both standard system install and user install for Ollama
    dirs.push(
      { label: 'Ollama (system)', path: '/usr/share/ollama/.ollama/models' },
      { label: 'Ollama (user)',   path: path.join(HOME, '.ollama', 'models') },
      { label: 'LM Studio',      path: path.join(HOME, '.lmstudio', 'models') },
    );
  }

  // Always append custom dir if passed via --model-dir
  if (CUSTOM_DIR) {
    dirs.push({ label: `Custom (${CUSTOM_DIR})`, path: CUSTOM_DIR });
  }

  return dirs;
}

// ── Recursive .gguf scanner ───────────────────────────────────────────────────
/**
 * Walk a directory recursively, collecting every .gguf file found.
 * Returns array of { name, fullPath, sizeGB, dir } objects.
 * Silently skips permission errors and symlink loops.
 *
 * @param {string} rootDir
 * @param {number} maxDepth - stop recursing beyond this level (default: 6)
 */
function scanGgufFiles(rootDir, maxDepth = 6) {
  const results = [];
  if (!existsSync(rootDir)) return results;

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir); }
    catch { return; } // permission denied

    for (const entry of entries) {
      const full = path.join(dir, entry);
      let st;
      try { st = statSync(full); }
      catch { continue; }

      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.toLowerCase().endsWith('.gguf')) {
        results.push({
          name:    entry,
          fullPath: full,
          sizeGB:  (st.size / 1e9).toFixed(1),
          dir:     path.relative(rootDir, dir) || '.',
        });
      }
    }
  };

  walk(rootDir, 0);
  return results;
}

/**
 * Scan all default model dirs (+ custom if given) and return a combined,
 * deduplicated list of GGUFs tagged with their source label.
 */
function scanAllModelDirs() {
  const seen    = new Set();
  const models  = [];

  for (const { label, path: dir } of getDefaultModelDirs()) {
    const found = scanGgufFiles(dir);
    for (const m of found) {
      if (seen.has(m.fullPath)) continue;
      seen.add(m.fullPath);
      models.push({ ...m, source: label });
    }
  }

  return models;
}

// ── LM Studio lms CLI helpers ─────────────────────────────────────────────────
const LMS_BIN = (() => {
  const bin = IS_WIN ? 'lms.exe' : 'lms';
  return path.join(HOME, '.lmstudio', 'bin', bin);
})();

function lmsRun(...args) {
  if (!existsSync(LMS_BIN)) return { ok: false, out: '' };
  try {
    const r = spawnSync(LMS_BIN, args, { encoding: 'utf8', timeout: 20000 });
    return { ok: r.status === 0, out: (r.stdout || '').trim() };
  } catch { return { ok: false, out: '' }; }
}

/** Non-blocking lms load (fire-and-forget) */
function lmsLoadModelBg(key) {
  if (!existsSync(LMS_BIN)) return;
  console.log(`${c.cyan}[LM Studio]${c.reset} Loading model in background: ${c.bold}${key}${c.reset}`);
  const child = spawn(LMS_BIN, ['load', key, '-y'], { stdio: 'ignore', detached: true });
  child.unref();
}

/**
 * After an import into local/imported/<basename>, derive the LM Studio key
 * by scanning `lms ls` for a line whose key contains the stem of the filename.
 *
 * LM Studio key format for local imports: typically just the stem lowercased
 * with underscores converted to hyphens and a quantisation @-suffix, but for
 * files imported via --user-repo local/imported it often falls back to the
 * generic alias "imported". We therefore:
 *   1. Check lms ls for any key that shares meaningful tokens with the filename,
 *      weighting model-family tokens (e.g. "35b", "a3b") 3× over quant tokens
 *      (e.g. "q2", "xl") to avoid false matches on shared quantization suffixes.
 *   2. Fall back to constructing the key from the stem ourselves.
 */
// Generic quantization tokens that appear across many model names — low disambiguation value.
const QUANT_TOKENS = new Set([
  'q2','q3','q4','q5','q6','q8','f16','f32','bf16',
  'xl','xs','km','ks','kl','kxl','ud','imat',
]);

function findKeyAfterImport(ggufBasename) {
  const r = lmsRun('ls');

  const stem         = ggufBasename.replace(/\.gguf$/i, '');
  const stemLower    = stem.toLowerCase();
  const allTokens    = stemLower.split(/[-_.]/).filter(t => t.length >= 2 && !/^\d+$/.test(t));
  // Family tokens identify the model/variant; quant tokens are shared across many models.
  const familyTokens = allTokens.filter(t => !QUANT_TOKENS.has(t));
  const quantTokens  = allTokens.filter(t =>  QUANT_TOKENS.has(t));

  if (r.ok && r.out) {
    const lines = r.out.split('\n').map(l => l.trim()).filter(Boolean);
    let bestKey   = null;
    let bestScore = 0;

    for (const line of lines) {
      if (/^(you |llm |embed |name |─|no model)/i.test(line)) continue;
      const key = line.trim().split(/\s+/)[0];
      if (!key || key.length < 3 || key === 'imported') continue;

      const keyLower = key.toLowerCase().replace(/@/g, '-').replace(/_/g, '-');

      // Family tokens worth 3 pts; quant tokens worth 1 pt.
      // Must match at least one family token to be a valid candidate.
      const familyHits = familyTokens.filter(t => keyLower.includes(t)).length;
      const quantHits  = quantTokens.filter(t => keyLower.includes(t)).length;
      const score      = familyHits * 3 + quantHits;

      if (familyHits > 0 && score > bestScore) {
        bestScore = score;
        bestKey   = key;
      }
    }

    if (bestKey && bestScore >= 3) return bestKey;
  }

  // Fallback: derive key from stem (LM Studio lowercases and hyphenates)
  return stemLower.replace(/_/g, '-');
}

/**
 * Blocking lms load with optional slot (identifier) assignment.
 * @param {string} key       - LM Studio model key (e.g. qwen3.5-9b@q3_k_xl)
 * @param {string|null} slot - identifier suffix: null = use key as-is, ':2' = key:2
 */
async function lmsLoadModelSync(key, slot) {
  if (!existsSync(LMS_BIN)) {
    console.log(`${c.yellow}[LM Studio]${c.reset} lms not found — cannot load model automatically.`);
    return false;
  }
  const identifier = (slot != null && slot !== '') ? `${key}${slot}` : key;
  const lm = await checkLmStudio();
  if (lm.up && lm.models.includes(identifier)) {
    console.log(`${c.green}[LM Studio]${c.reset} ${identifier} is already loaded — skipping.`);
    return true;
  }
  const args = ['load', key, '-y', '--gpu', 'max', '-c', '200000', '--identifier', identifier];
  return new Promise(resolve => {
    console.log(`${c.cyan}[LM Studio]${c.reset} Loading ${c.bold}${key}${c.reset} as ${c.bold}${identifier}${c.reset} (ctx=200k, gpu=max) — this may take 30–90 s...`);
    let stderrBuf = '';
    const child = spawn(LMS_BIN, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    child.stderr.on('data', d => { stderrBuf += d.toString(); });
    child.on('close', code => {
      const alreadyExists = /already exists|already loaded/i.test(stderrBuf);
      if (alreadyExists) {
        console.log(`${c.green}[LM Studio]${c.reset} ${identifier} was already present — continuing.`);
      }
      resolve(code === 0 || alreadyExists);
    });
  });
}

/** Import a GGUF file into LM Studio, return the real key lms assigned. */
async function lmsImportGguf(ggufPath) {
  if (!existsSync(LMS_BIN)) return { ok: false, key: null };
  const basename = path.basename(ggufPath);
  return new Promise(resolve => {
    const guessRepo = 'local/imported';
    console.log(`${c.cyan}[LM Studio]${c.reset} Importing ${basename} ...`);
    let stderrBuf = '';
    const child = spawn(LMS_BIN, ['import', ggufPath, '--user-repo', guessRepo, '-y', '--copy'], {
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    child.stderr.on('data', d => { const t = d.toString(); stderrBuf += t; process.stderr.write(t); });
    child.on('close', async code => {
      const alreadyExists = stderrBuf.includes('already exists') || stderrBuf.includes('already imported');
      const succeeded     = code === 0 || alreadyExists;

      // Give LM Studio time to register the import before querying lms ls.
      // Retry up to 3 times with 2 s gaps if the key isn't found immediately.
      let realKey = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        realKey = findKeyAfterImport(basename);
        if (realKey) break;
        console.log(`${c.gray}[LM Studio]${c.reset} Key not found yet — retrying (${attempt}/3)...`);
      }

      if (realKey) {
        console.log(`${c.cyan}[LM Studio]${c.reset} Model key resolved: ${c.bold}${realKey}${c.reset}`);
      } else {
        console.log(`${c.yellow}[LM Studio]${c.reset} Could not resolve key automatically.`);
        console.log(`             Run ${c.cyan}lms ls${c.reset} to find it, then use ${c.cyan}--load-model <key>${c.reset}`);
        // Print lms ls raw output to help the user identify the key manually
        const raw = lmsRun('ls');
        if (raw.out) console.log(`\n${c.dim}lms ls output:\n${raw.out}${c.reset}\n`);
      }

      // Write per-model config so KV-cache quant is applied on next load
      if (succeeded) {
        const destGguf = path.join(getLmsDownloadsFolder(), 'local', 'imported', basename);
        if (existsSync(destGguf)) writeModelLoadConfig(destGguf);
      }

      resolve({ ok: succeeded, key: realKey });
    });
  });
}

/**
 * Ask which LM Studio slot(s) to load the model into.
 * Returns one of: 'slot1', 'slot2', 'both', 'skip'
 */
async function askSlot(modelName, currentModels) {
  const s1 = currentModels[0] ?? '(empty)';
  const s2 = currentModels[1] ?? '(empty)';
  console.log(`\n  ${c.bold}Which slot should "${modelName}" load into?${c.reset}`);
  console.log(`    ${c.cyan}[1]${c.reset}  Slot 1 — port 3333   currently: ${c.dim}${s1}${c.reset}`);
  console.log(`    ${c.cyan}[2]${c.reset}  Slot 2 — port 3334   currently: ${c.dim}${s2}${c.reset}`);
  console.log(`    ${c.cyan}[3]${c.reset}  Both slots`);
  console.log(`    ${c.cyan}[s]${c.reset}  Skip — don't load now\n`);
  const answer = await prompt(`  ${c.bold}Slot choice [1/2/3/s]:${c.reset} `);
  const a = answer.trim().toLowerCase();
  if (a === '1') return 'slot1';
  if (a === '2') return 'slot2';
  if (a === '3' || a === 'both') return 'both';
  return 'skip';
}

// ── LM Studio REST helpers ────────────────────────────────────────────────────
async function checkLmStudio(lmPort = 1234) {
  try {
    const res = await fetch(`http://127.0.0.1:${lmPort}/v1/models`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { up: true, models: [], raw: await res.text() };
    const json = await res.json();
    const models = (json.data ?? []).map(m => m.id ?? m.model ?? String(m));
    return { up: true, models };
  } catch {
    return { up: false, models: [] };
  }
}

async function loadLmModel(modelId, lmPort = 1234) {
  try {
    const res = await fetch(`http://127.0.0.1:${lmPort}/api/v0/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    return res.ok
      ? { ok: true,  message: `Load request accepted (${res.status})` }
      : { ok: false, message: `LM Studio returned ${res.status}: ${text.slice(0, 120)}` };
  } catch (err) {
    return { ok: false, message: `Request failed: ${err.message}` };
  }
}

async function ensureLmsServer() {
  if (!existsSync(LMS_BIN)) return;
  const st = lmsRun('server', 'status');
  if (st.out.toLowerCase().includes('running')) return;
  console.log(`${c.cyan}[LM Studio]${c.reset} Server not running — starting via lms server start ...`);
  const started = spawnSync(LMS_BIN, ['server', 'start'], { stdio: 'inherit', timeout: 20000 });
  if (started.status === 0) {
    console.log(`${c.green}[LM Studio]${c.reset} Server started on :1234`);
  } else {
    console.log(`${c.yellow}[LM Studio]${c.reset} Could not auto-start — open LM Studio manually or run install.mjs first.`);
  }
}

// ── Status display ─────────────────────────────────────────────────────────────
async function showStatus() {
  const rows = [
    { port: 3333, label: 'server.js      (MCP primary)' },
    { port: 3334, label: 'server-dos.js  (MCP peer)   ' },
    { port: 1233, label: 'coord-proxy.js (phi-routing) ' },
    { port: 1234, label: 'LM Studio      (LLM backend) ' },
  ];
  console.log(`\n${c.bold}── Stack status ───────────────────────────────────────${c.reset}`);
  for (const { port, label } of rows) {
    const up  = await portInUse(port);
    const sym = up ? `${c.green}✓${c.reset}` : `${c.gray}✗${c.reset}`;
    console.log(`  ${sym}  :${port}  ${label}`);
  }

  const lm = await checkLmStudio();
  if (lm.up) {
    console.log(`\n${c.bold}── LM Studio :1234 — loaded models ────────────────────${c.reset}`);
    if (lm.models.length === 0) {
      console.log(`  ${c.yellow}⚠  No models loaded.${c.reset}  Open LM Studio and load at least one.`);
    } else {
      for (const m of lm.models) console.log(`  ${c.green}●${c.reset}  ${m}`);
    }
    const EXPECTED = ['qwen3.5-9b@q3_k_xl:2', 'qwen3.5-9b@q3_k_xl'];
    const missing  = EXPECTED.filter(e => !lm.models.includes(e));
    if (missing.length) {
      console.log(`\n  ${c.yellow}⚠  Demo scripts expect:${c.reset}`);
      for (const m of missing)
        console.log(`       ${c.gray}${m}${c.reset}  — not loaded  (node launch.mjs --load-model "${m}")`);
    }
  } else {
    console.log(`\n  ${c.gray}✗  LM Studio :1234 unreachable — start it before running demos.${c.reset}`);
  }

  // Show model dirs and counts
  console.log(`\n${c.bold}── Model folders ──────────────────────────────────────${c.reset}`);
  for (const { label, path: dir } of getDefaultModelDirs()) {
    const found = existsSync(dir) ? scanGgufFiles(dir) : [];
    const exists = existsSync(dir);
    const sym = exists ? (found.length > 0 ? c.green : c.yellow) : c.gray;
    console.log(`  ${sym}${label}${c.reset}  ${c.dim}${dir}${c.reset}`);
    if (found.length > 0) {
      for (const m of found)
        console.log(`       ${c.gray}${m.name}${c.reset}  ${c.dim}(${m.sizeGB} GB)${c.reset}`);
    } else if (exists) {
      console.log(`       ${c.gray}(no .gguf files found)${c.reset}`);
    } else {
      console.log(`       ${c.gray}(folder not found)${c.reset}`);
    }
  }
  console.log();
}

// ── Readline prompt helper ────────────────────────────────────────────────────
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

// ── Interactive model picker ──────────────────────────────────────────────────
/**
 * Scan all model folders, present a numbered list, let the user pick one.
 * Returns { action, model } where action is one of:
 *   'load-id'    — load by LM Studio model ID (user typed an ID)
 *   'import'     — import a local .gguf path then load it
 *   'skip'       — skip, use whatever is already loaded
 */
async function runModelPicker() {
  console.log(`\n${c.bold}${c.cyan}── Model Picker ───────────────────────────────────────${c.reset}`);
  console.log(`${c.dim}Scanning model folders for .gguf files...${c.reset}`);

  const models = scanAllModelDirs();

  if (models.length === 0) {
    console.log(`\n  ${c.yellow}⚠  No .gguf files found in any default folder.${c.reset}`);
    console.log(`  Checked:`);
    for (const { label, path: dir } of getDefaultModelDirs())
      console.log(`    ${c.dim}${label}: ${dir}${c.reset}`);
    console.log(`\n  Options:`);
    console.log(`    • Pass ${c.cyan}--model-dir <path>${c.reset} to scan a custom folder`);
    console.log(`    • Type a model ID directly to load from LM Studio`);
    console.log(`    • Press Enter to skip and use whatever is loaded\n`);
  } else {
    console.log(`\n  Found ${c.bold}${models.length}${c.reset} model(s):\n`);

    // Group by source for readability
    const bySource = {};
    for (const m of models) {
      (bySource[m.source] ??= []).push(m);
    }

    let idx = 1;
    const indexedModels = [];
    for (const [source, list] of Object.entries(bySource)) {
      console.log(`  ${c.bold}${source}${c.reset}`);
      for (const m of list) {
        const subdir = m.dir !== '.' ? `  ${c.dim}${m.dir}${c.reset}` : '';
        console.log(`    ${c.cyan}[${idx}]${c.reset}  ${m.name}  ${c.gray}(${m.sizeGB} GB)${subdir}`);
        indexedModels.push({ idx: idx++, ...m });
      }
      console.log();
    }
  }

  // Build prompt string
  const lm = await checkLmStudio();
  const alreadyLoaded = lm.up && lm.models.length > 0;
  const skipHint = alreadyLoaded
    ? `(or Enter to keep ${c.green}${lm.models[0]}${c.reset} already loaded)`
    : `(or Enter to skip)`;

  console.log(`  ${c.dim}You can also type:${c.reset}`);
  console.log(`    • A number from the list above to import+load that .gguf`);
  console.log(`    • A model ID (e.g. ${c.cyan}qwen3.5-9b@q3_k_xl${c.reset}) to load directly from LM Studio`);
  console.log(`    • A full path to a .gguf file not in the list`);
  console.log(`    • ${c.cyan}s${c.reset} or blank to skip ${skipHint}\n`);

  const models_indexed = scanAllModelDirs(); // re-use same scan result via closure above

  // Build a flat indexed array for lookup
  const allFound = scanAllModelDirs();
  let   n        = 1;
  const byIdx    = {};
  for (const m of allFound) byIdx[n++] = m;

  const answer = await prompt(`  ${c.bold}Your choice:${c.reset} `);

  // Blank or 's' → skip
  if (!answer || answer.toLowerCase() === 's') {
    if (alreadyLoaded) {
      console.log(`\n  ${c.green}✓${c.reset}  Using already-loaded model(s): ${lm.models.join(', ')}\n`);
    } else {
      console.log(`\n  ${c.yellow}⚠${c.reset}  Skipping — make sure a model is loaded in LM Studio before running demos.\n`);
    }
    return { action: 'skip' };
  }

  // Numeric → index into found list
  const num = parseInt(answer, 10);
  if (!isNaN(num) && byIdx[num]) {
    const chosen = byIdx[num];
    console.log(`\n  ${c.cyan}→${c.reset}  Selected: ${c.bold}${chosen.name}${c.reset}  (${chosen.sizeGB} GB)\n`);
    return { action: 'import', model: chosen };
  }

  // Full path to a .gguf
  if (answer.endsWith('.gguf') && existsSync(answer)) {
    const st  = statSync(answer);
    const sizeGB = (st.size / 1e9).toFixed(1);
    console.log(`\n  ${c.cyan}→${c.reset}  Custom path: ${answer}  (${sizeGB} GB)\n`);
    return { action: 'import', model: { name: path.basename(answer), fullPath: answer, sizeGB } };
  }

  // Otherwise treat as a model ID string
  console.log(`\n  ${c.cyan}→${c.reset}  Loading model ID: ${c.bold}${answer}${c.reset}\n`);
  return { action: 'load-id', modelId: answer };
}

// ── Preset sync — copy preset file + write per-model load configs ────────────

// The inference (operation) fields mirrored from inference1.preset.json.
// Writing these directly into each per-model config causes LM Studio to
// recognise inference1 as the selected preset for that model.
const MODEL_OPERATION_FIELDS = [
  { key: 'llm.prediction.temperature',            value: 1 },
  { key: 'llm.prediction.llama.cpuThreads',        value: 3 },
  { key: 'llm.prediction.topKSampling',            value: 20 },
  { key: 'llm.prediction.topPSampling',            value: 0.95 },
  { key: 'llm.prediction.repeatPenalty',           value: { checked: true, value: 1 } },
  { key: 'llm.prediction.llama.presencePenalty',   value: { checked: true, value: 0 } },
  { key: 'llm.prediction.minPSampling',            value: { checked: true, value: 0 } },
];

// The load fields we want applied to every model.
const MODEL_LOAD_FIELDS = [
  { key: 'llm.load.contextLength',                     value: 200000 },
  { key: 'llm.load.llama.acceleration.offloadRatio',   value: 999    }, // clamped to hw max by LM Studio
  { key: 'llm.load.llama.kCacheQuantizationType',      value: { checked: true, value: 'q4_0' } },
  { key: 'llm.load.llama.vCacheQuantizationType',      value: { checked: true, value: 'q4_0' } },
];

/** Read the LM Studio downloads folder from settings.json (falls back to ~/.lmstudio/models). */
function getLmsDownloadsFolder() {
  try {
    const s = JSON.parse(readFileSync(path.join(HOME, '.lmstudio', 'settings.json'), 'utf8'));
    if (s.downloadsFolder) return s.downloadsFolder;
  } catch {}
  return path.join(HOME, '.lmstudio', 'models');
}

/**
 * Write (or update) the per-model load config for a given .gguf absolute path.
 * Preserves any existing prediction (operation) fields.
 * Returns true if the file was written.
 */
function writeModelLoadConfig(ggufAbsPath) {
  const dlBase     = getLmsDownloadsFolder();
  const configBase = path.join(HOME, '.lmstudio', '.internal', 'user-concrete-model-default-config');
  const rel        = path.relative(dlBase, ggufAbsPath);
  if (rel.startsWith('..')) return false; // not under downloads folder

  const configPath = path.join(configBase, rel + '.json');
  let existing = null;
  if (existsSync(configPath)) {
    try { existing = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
  }

  const config = {
    preset:    '@local:inference1',
    operation: { fields: MODEL_OPERATION_FIELDS },
    load:      { fields: MODEL_LOAD_FIELDS },
  };

  // Skip write if already identical
  const alreadyOk =
    existing &&
    JSON.stringify(existing.load?.fields)      === JSON.stringify(MODEL_LOAD_FIELDS) &&
    JSON.stringify(existing.operation?.fields) === JSON.stringify(MODEL_OPERATION_FIELDS);
  if (alreadyOk) return false;

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, newText, 'utf8');
  return true;
}

/**
 * Walk the downloads folder and write load configs for every .gguf found.
 * Skips files whose config is already up to date.
 */
function applyLoadConfigToAllModels() {
  const dlBase = getLmsDownloadsFolder();
  if (!existsSync(dlBase)) return;
  const ggufs = scanGgufFiles(dlBase, 5);
  let updated = 0;
  for (const m of ggufs) { if (writeModelLoadConfig(m.fullPath)) updated++; }
  if (updated > 0)
    console.log(`${c.green}[preset]${c.reset} Load config written for ${updated} model(s) (ctx=200k, gpu=max, kv=Q4_0).`);
  else
    console.log(`${c.green}[preset]${c.reset} All model load configs already up to date.`);
}

function ensurePreset() {
  const src  = path.join(__dirname, 'inference1.preset.json');
  const dest = path.join(HOME, '.lmstudio', 'config-presets', 'inference1.preset.json');
  let presetWritten = false;

  if (!existsSync(src)) {
    console.log(`${c.yellow}[preset]${c.reset} inference1.preset.json not found in project — skipping.`);
  } else {
    const srcText  = readFileSync(src, 'utf8');
    const destText = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (srcText !== destText) {
      try {
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        presetWritten = true;
        console.log(`${c.green}[preset]${c.reset} inference1.preset.json installed → ${dest}`);
      } catch (e) {
        console.log(`${c.yellow}[preset]${c.reset} Could not copy preset: ${e.message}`);
      }
    } else {
      console.log(`${c.green}[preset]${c.reset} inference1.preset.json already up to date.`);
    }
  }

  // If the preset was freshly written while LM Studio is already running, stop
  // the server so ensureLmsServer() restarts it — otherwise LM Studio won't
  // pick up the new preset file until a manual restart.
  if (presetWritten && existsSync(LMS_BIN)) {
    const st = lmsRun('server', 'status');
    if (st.out.toLowerCase().includes('running')) {
      console.log(`${c.yellow}[preset]${c.reset} Restarting LM Studio to load new preset...`);
      spawnSync(LMS_BIN, ['server', 'stop'], { stdio: 'ignore', timeout: 10000 });
    }
  }

  // Write per-model configs so every model loads with the desired settings
  applyLoadConfigToAllModels();
}

// ── Dependency check + npm install ───────────────────────────────────────────
function ensureDeps() {
  try { execSync('npm --version', { stdio: 'ignore' }); }
  catch {
    process.stderr.write(
      `[launch] npm not found. npm is bundled with Node.js — reinstall Node.\n` +
      `         https://nodejs.org\n`
    );
    process.exit(1);
  }
  const marker = path.join(__dirname, 'node_modules', '@modelcontextprotocol', 'sdk');
  if (!existsSync(marker)) {
    console.log(`${c.cyan}[install]${c.reset} node_modules missing — running npm install...`);
    try {
      execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
      console.log(`${c.green}[install]${c.reset} Done.\n`);
    } catch {
      console.error(`${c.red}[install]${c.reset} npm install failed. Fix errors above and retry.`);
      process.exit(1);
    }
  }
}

// ── Inline wuwei health writer ────────────────────────────────────────────────
function startHealthWriter() {
  const stateDir = path.join(__dirname, 'wuwei-routing', 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(__dirname, 'wuwei-routing', 'logs'), { recursive: true });

  const write = async () => {
    const check = (port) => portInUse(port).then(up => up ? 'HEALTHY' : 'DOWN');
    const [mcp, dos, llm] = await Promise.all([check(3333), check(3334), check(1234)]);
    const now = new Date().toISOString();
    const health = {
      timestamp:    now,
      cycle_id:     Math.floor(Date.now() / 1000),
      local_mcp:     { port: 3333, status: mcp, last_check: now, llm_context: 200000 },
      local_mcp_dos: { port: 3334, status: dos, last_check: now, llm_context: 199999 },
      llm:           { port: 1234, status: llm, last_check: now },
    };
    try {
      writeFileSync(path.join(stateDir, 'health.json'),   JSON.stringify(health, null, 2));
      writeFileSync(path.join(stateDir, 'active_server'), mcp === 'HEALTHY' ? 'local-mcp' : 'local-mcp-dos');
      writeFileSync(path.join(stateDir, 'last_cycle'),    now);
    } catch { /* non-fatal */ }
  };

  write();
  return setInterval(write, 30_000);
}

// ── Process spawner ───────────────────────────────────────────────────────────
const children = [];

function spawnProc({ label, color, script, env }) {
  const tag  = `${color}[${label}]${c.reset} `;
  const proc = spawn(process.execPath, [script], {
    cwd: __dirname,
    env: { ...process.env, ...env },
  });
  children.push(proc);

  const log = (stream, isErr) => {
    stream.on('data', chunk => {
      chunk.toString()
        .split('\n')
        .filter(l => l.trim())
        .forEach(l => {
          if (isErr) process.stderr.write(tag + c.red + l + c.reset + '\n');
          else       process.stdout.write(tag + l + '\n');
        });
    });
  };

  log(proc.stdout, false);
  log(proc.stderr, true);

  proc.on('exit', (code, sig) => {
    const reason = sig ?? `code ${code}`;
    if (code !== 0)
      process.stdout.write(`${tag}${c.red}process exited (${reason})${c.reset}\n`);
  });

  return proc;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${c.cyan}[launch]${c.reset} ${sig} — stopping stack...\n`);
  for (const ch of children) { try { ch.kill('SIGTERM'); } catch {} }
  setTimeout(() => {
    for (const ch of children) { try { ch.kill('SIGKILL'); } catch {} }
    process.exit(0);
  }, 2500).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════

if (STATUS) { await showStatus(); process.exit(0); }

// --load-model: send load request then exit
if (LOAD_MODEL) {
  console.log(`${c.cyan}[load-model]${c.reset} Requesting LM Studio load: ${c.bold}${LOAD_MODEL}${c.reset}`);
  console.log(`${c.gray}             (LM Studio must be running at :1234)${c.reset}`);
  const result = await loadLmModel(LOAD_MODEL);
  if (result.ok) {
    console.log(`${c.green}[load-model]${c.reset} ${result.message}`);
    console.log(`             Run ${c.cyan}node launch.mjs --status${c.reset} to verify.`);
  } else {
    console.log(`${c.yellow}[load-model]${c.reset} ${result.message}`);
    console.log(`             LM Studio v0.3.x+ required for the load API.`);
  }
  process.exit(result.ok ? 0 : 1);
}

ensureDeps();
ensurePreset();

console.log(`\n${c.bold}${c.cyan}Easy by zCHG.org${c.reset}`);
console.log(`${c.gray}Node ${process.version}  ·  ${process.platform}/${process.arch}  ·  ${new Date().toISOString()}${c.reset}`);

// ── LM Studio preflight ───────────────────────────────────────────────────────
await ensureLmsServer();

// ── Model picker ──────────────────────────────────────────────────────────────
if (!NO_PICKER) {
  const pick = await runModelPicker();

  // Get current slot contents for the slot-picker display
  const lmNow    = await checkLmStudio();
  const curSlots = lmNow.models.slice(0, 2);

  if (pick.action === 'import') {
    const { ok, key } = await lmsImportGguf(pick.model.fullPath);
    const resolvedKey = key ?? path.basename(pick.model.fullPath, '.gguf').toLowerCase();

    if (!ok && !key) {
      console.log(`${c.yellow}[LM Studio]${c.reset} Import returned non-zero and key not resolved.`);
      console.log(`             Run ${c.cyan}lms ls${c.reset} to find the model key, then:`);
      console.log(`             ${c.cyan}node launch.mjs --load-model <key>${c.reset}`);
    } else {
      console.log(`${c.green}[LM Studio]${c.reset} Import complete — key: ${c.bold}${resolvedKey}${c.reset}`);
      const slot = await askSlot(pick.model.name, curSlots);
      if (slot === 'slot1') {
        await lmsLoadModelSync(resolvedKey, '');          // load as primary identifier
      } else if (slot === 'slot2') {
        await lmsLoadModelSync(resolvedKey, ':2');        // load as :2 identifier
      } else if (slot === 'both') {
        await lmsLoadModelSync(resolvedKey, '');
        await lmsLoadModelSync(resolvedKey, ':2');
      }
      // 'skip' → imported but not loaded now
    }

  } else if (pick.action === 'load-id') {
    const slot = await askSlot(pick.modelId, curSlots);
    if (slot === 'slot1') {
      await lmsLoadModelSync(pick.modelId, '');
    } else if (slot === 'slot2') {
      await lmsLoadModelSync(pick.modelId, ':2');
    } else if (slot === 'both') {
      await lmsLoadModelSync(pick.modelId, '');
      await lmsLoadModelSync(pick.modelId, ':2');
    }
  }
  // 'skip' → do nothing
}

// ── Final status before spawning ──────────────────────────────────────────────
await showStatus();

// ── Spawn stack ───────────────────────────────────────────────────────────────
for (const proc of STACK) {
  if (proc.skip?.()) { console.log(`  ${c.gray}↷ :${proc.port} skipped (--no-proxy)${c.reset}`); continue; }
  const busy = await portInUse(proc.port);
  if (busy) {
    console.log(`  ${c.gray}✓ :${proc.port} already up — skipping${c.reset}`);
    continue;
  }
  console.log(`  ${proc.color}→ ${proc.script}${c.reset}`);
  spawnProc(proc);
  await new Promise(r => setTimeout(r, 700)); // stagger startup
}

startHealthWriter();

console.log(`\n${c.bold}Stack running.${c.reset}  ${c.gray}Ctrl+C to stop all.${c.reset}\n`);
