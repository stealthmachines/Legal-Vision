#!/usr/bin/env node
/**
 * install.mjs — zero-to-running installer for Easy by zCHG.org
 *
 * What this does, in order:
 *   1. Checks Node.js ≥ 18 (the only hard prerequisite — this file needs node to run)
 *   2. Runs npm install
 *   3. Detects / installs LM Studio (Windows: silent NSIS installer; macOS: DMG mount + cp; Linux: AppImage)
 *   4. Downloads the GGUF model file directly into the LM Studio models folder
 *   5. Imports the GGUF into LM Studio via `lms import`
 *   6. Starts the LM Studio server via `lms server start`
 *   7. Loads the model via `lms load`
 *   8. Launches the MCP stack via launch.mjs
 *
 * Run:
 *   node install.mjs            — full install + launch
 *   node install.mjs --no-launch  — install only, don't start the stack
 *   node install.mjs --skip-model — skip model download (if you already have one)
 *   node install.mjs --status     — just show current state
 */

import { execSync, spawnSync, spawn } from 'child_process';
import { existsSync, mkdirSync, createWriteStream, readdirSync, statSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { get as httpsGet } from 'https';
import { get as httpGet } from 'http';
import path from 'path';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Node.js version guard ─────────────────────────────────────────────────────
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) {
  process.stderr.write(
    `\n[install] ERROR: Node.js >= 18 is required (found v${process.versions.node}).\n` +
    `          Download the LTS version from: https://nodejs.org\n` +
    `          Then re-run: node install.mjs\n\n`
  );
  process.exit(1);
}

// ── ANSI colours ──────────────────────────────────────────────────────────────
const TTY = process.stdout.isTTY;
const c = {
  reset:  TTY ? '\x1b[0m'  : '', bold:   TTY ? '\x1b[1m'  : '',
  red:    TTY ? '\x1b[31m' : '', green:  TTY ? '\x1b[32m' : '',
  yellow: TTY ? '\x1b[33m' : '', cyan:   TTY ? '\x1b[36m' : '',
  gray:   TTY ? '\x1b[90m' : '',
};
const ok   = (msg) => console.log(`${c.green}  ✓${c.reset}  ${msg}`);
const info = (msg) => console.log(`${c.cyan}  →${c.reset}  ${msg}`);
const warn = (msg) => console.log(`${c.yellow}  ⚠${c.reset}  ${msg}`);
const fail = (msg) => { console.error(`${c.red}  ✗${c.reset}  ${msg}`); };
const head = (msg) => console.log(`\n${c.bold}${msg}${c.reset}`);

// ── CLI flags ─────────────────────────────────────────────────────────────────
const argv       = process.argv.slice(2);
const NO_LAUNCH  = argv.includes('--no-launch');
const SKIP_MODEL = argv.includes('--skip-model');
const STATUS     = argv.includes('--status');
const HELP       = argv.includes('--help') || argv.includes('-h');

if (HELP) {
  console.log(`
  ${c.bold}install.mjs${c.reset} — zero-to-running installer

  ${c.cyan}node install.mjs${c.reset}               full install + start MCP stack
  ${c.cyan}node install.mjs --no-launch${c.reset}   install only, don't start the stack
  ${c.cyan}node install.mjs --skip-model${c.reset}  skip GGUF download (model already present)
  ${c.cyan}node install.mjs --status${c.reset}      show current install state and exit
  `);
  process.exit(0);
}

// ── Platform detection ────────────────────────────────────────────────────────
const IS_WIN   = process.platform === 'win32';
const IS_MAC   = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const HOME     = os.homedir();

// ── LM Studio paths (per-platform) ───────────────────────────────────────────
// lms CLI tool — bundled inside the LM Studio data dir as bin/lms (or lms.exe)
const LMS_DATA = IS_WIN
  ? path.join(HOME, '.lmstudio')
  : IS_MAC
    ? path.join(HOME, '.lmstudio')
    : path.join(HOME, '.lmstudio');

const LMS_BIN = IS_WIN
  ? path.join(LMS_DATA, 'bin', 'lms.exe')
  : path.join(LMS_DATA, 'bin', 'lms');

const LMS_MODELS_DIR = path.join(LMS_DATA, 'models');

// LM Studio app download URLs (official releases)
const LMS_DOWNLOAD = {
  win32:  'https://releases.lmstudio.ai/win32/x64/latest/LM-Studio-Setup.exe',
  darwin: 'https://releases.lmstudio.ai/mac/arm64/latest/LM-Studio.dmg',  // Apple Silicon
  linux:  'https://releases.lmstudio.ai/linux/x86_64/latest/LM-Studio.AppImage',
};

// ── Model to download ─────────────────────────────────────────────────────────
// Hugging Face direct GGUF download. ~4.3 GB at Q2_K_XL.
const MODEL_URL      = 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-UD-Q2_K_XL.gguf?download=true';
const MODEL_FILENAME = 'Qwen3.5-9B-UD-Q2_K_XL.gguf';
const MODEL_USER_REPO = 'unsloth/Qwen3.5-9B-GGUF'; // used with `lms import --user-repo`
// The model key lms assigns after import (user/repo/filename without ext → lmstudio key)
const MODEL_KEY      = 'qwen3.5-9b@q2_k_xl';  // approximate — lms ls will show actual key

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function lms(...args) {
  if (!existsSync(LMS_BIN)) return { ok: false, out: '', err: 'lms not found' };
  const r = spawnSync(LMS_BIN, args, { encoding: 'utf8', timeout: 30000 });
  return {
    ok:  r.status === 0,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
    status: r.status,
  };
}

function lmsAsync(args, label) {
  return new Promise((resolve) => {
    info(`Running: lms ${args.join(' ')}`);
    const child = spawn(LMS_BIN, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Download a URL to a local file, showing progress. */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https') ? httpsGet : httpGet;
    const req = getter(url, { headers: { 'User-Agent': 'Easy-zCHG-Installer/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const total    = parseInt(res.headers['content-length'] || '0', 10);
      let   received = 0;
      let   lastPct  = -1;

      mkdirSync(path.dirname(destPath), { recursive: true });
      const out = createWriteStream(destPath);

      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            process.stdout.write(`\r     ${pct}%  (${(received / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)`);
            lastPct = pct;
          }
        } else {
          process.stdout.write(`\r     ${(received / 1e6).toFixed(1)} MB downloaded...`);
        }
      });

      res.pipe(out);
      out.on('finish', () => { process.stdout.write('\n'); resolve(); });
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** Find the first .gguf file in the models dir that matches MODEL_FILENAME */
function findModelInLmsDir() {
  if (!existsSync(LMS_MODELS_DIR)) return null;
  // Walk up to 3 levels deep (user/repo/file.gguf)
  const walk = (dir, depth) => {
    if (depth > 3) return null;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          const found = walk(full, depth + 1);
          if (found) return found;
        } else if (entry === MODEL_FILENAME) {
          return full;
        }
      } catch { /* skip permission errors */ }
    }
    return null;
  };
  return walk(LMS_MODELS_DIR, 0);
}

/** Check if a model key is loaded in lms ps output */
function modelIsLoaded(keyFragment) {
  const r = lms('ps');
  return r.ok && r.out.toLowerCase().includes(keyFragment.toLowerCase());
}

/** Check if lms server is running */
function serverIsRunning() {
  const r = lms('server', 'status');
  return r.ok && r.out.toLowerCase().includes('running');
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS mode
// ─────────────────────────────────────────────────────────────────────────────
if (STATUS) {
  head('── Install status ──────────────────────────────────────');
  console.log(`  Node.js        : ${process.version} ${nodeMajor >= 18 ? c.green+'✓'+c.reset : c.red+'✗ (need ≥ 18)'+c.reset}`);

  const lmsExists = existsSync(LMS_BIN);
  console.log(`  LM Studio (lms): ${lmsExists ? c.green+'✓  '+LMS_BIN+c.reset : c.red+'✗  not found'+c.reset}`);

  if (lmsExists) {
    const srv = serverIsRunning();
    console.log(`  LMS server     : ${srv ? c.green+'✓  running'+c.reset : c.yellow+'✗  stopped'+c.reset}`);
    const ps = lms('ps');
    console.log(`  Loaded models  :\n${ps.out || '    (none)'}`);
    const ls = lms('ls');
    console.log(`  On-disk models :\n${ls.out || '    (none)'}`);
  }

  const nm = existsSync(path.join(__dirname, 'node_modules', '@modelcontextprotocol', 'sdk'));
  console.log(`  npm deps       : ${nm ? c.green+'✓  installed'+c.reset : c.yellow+'✗  run install'+c.reset}`);
  console.log();
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — npm install
// ─────────────────────────────────────────────────────────────────────────────
head('Step 1/6 — npm dependencies');
const marker = path.join(__dirname, 'node_modules', '@modelcontextprotocol', 'sdk');
if (existsSync(marker)) {
  ok('node_modules already present — skipping npm install');
} else {
  info('Running npm install ...');
  try {
    execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
    ok('npm install complete');
  } catch {
    fail('npm install failed. Fix errors above and re-run.');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — LM Studio installation
// ─────────────────────────────────────────────────────────────────────────────
head('Step 2/6 — LM Studio');
if (existsSync(LMS_BIN)) {
  ok(`LM Studio CLI found: ${LMS_BIN}`);
} else {
  const downloadUrl = LMS_DOWNLOAD[process.platform];
  if (!downloadUrl) {
    fail(`Unsupported platform: ${process.platform}. Install LM Studio manually from https://lmstudio.ai`);
    process.exit(1);
  }

  const ext     = path.extname(new URL(downloadUrl.split('?')[0]).pathname);
  const tmpFile = path.join(os.tmpdir(), `LMStudio-installer${ext}`);

  info(`Downloading LM Studio installer (${downloadUrl.split('/').at(-1).split('?')[0]}) ...`);
  try {
    await download(downloadUrl, tmpFile);
    ok(`Downloaded to ${tmpFile}`);
  } catch (err) {
    fail(`Download failed: ${err.message}`);
    fail(`Manual install: https://lmstudio.ai`);
    process.exit(1);
  }

  info('Installing LM Studio silently ...');
  try {
    if (IS_WIN) {
      // NSIS silent install: /S = silent, /D = install dir (optional)
      execSync(`"${tmpFile}" /S`, { stdio: 'inherit', timeout: 120_000 });
    } else if (IS_MAC) {
      // Mount DMG, copy .app to /Applications
      execSync(`hdiutil attach "${tmpFile}" -nobrowse -quiet`, { stdio: 'inherit' });
      const mountPoint = execSync(`hdiutil info | grep "LM Studio" | awk '{print $1}'`).toString().trim();
      execSync(`cp -R "/Volumes/LM Studio/LM Studio.app" /Applications/`, { stdio: 'inherit' });
      execSync(`hdiutil detach "${mountPoint}" -quiet`, { stdio: 'inherit' });
      // Run LM Studio once briefly to set up ~/.lmstudio
      info('First-run setup (may take a few seconds) ...');
      execSync(`open -a "LM Studio" && sleep 8 && osascript -e 'quit app "LM Studio"'`, { stdio: 'inherit', timeout: 20_000 });
    } else if (IS_LINUX) {
      execSync(`chmod +x "${tmpFile}"`, { stdio: 'inherit' });
      // AppImage: run once with --appimage-extract-and-run to let it set up
      info('LM Studio AppImage — running first-time setup ...');
      execSync(`"${tmpFile}" --no-sandbox &`, { stdio: 'inherit', timeout: 15_000 });
      await new Promise(r => setTimeout(r, 8000));
    }
  } catch (err) {
    fail(`Silent install failed: ${err.message}`);
    fail(`Please install LM Studio manually: https://lmstudio.ai`);
    fail(`Then re-run: node install.mjs`);
    process.exit(1);
  }

  // Verify lms is now available
  if (!existsSync(LMS_BIN)) {
    warn('LM Studio installed but lms CLI not found yet — may need a restart.');
    warn(`Expected: ${LMS_BIN}`);
    warn('If LM Studio installed correctly, open a new terminal and re-run: node install.mjs');
    process.exit(1);
  }
  ok('LM Studio installed successfully');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Download the GGUF model
// ─────────────────────────────────────────────────────────────────────────────
head('Step 3/6 — Model download');
if (SKIP_MODEL) {
  info('--skip-model set — skipping download');
} else {
  // Check if the model is already on disk in the LM Studio models folder
  const existing = findModelInLmsDir();
  if (existing) {
    ok(`Model already present: ${existing}`);
  } else {
    const tmpGguf = path.join(os.tmpdir(), MODEL_FILENAME);
    const inPlace = existsSync(tmpGguf);

    if (inPlace) {
      info(`Found partial/complete download at ${tmpGguf} — skipping re-download`);
    } else {
      info(`Downloading model (this is ~4 GB — go get a coffee) ...`);
      info(`Source: ${MODEL_URL.split('?')[0]}`);
      try {
        await download(MODEL_URL, tmpGguf);
        ok(`Downloaded: ${tmpGguf}`);
      } catch (err) {
        fail(`Model download failed: ${err.message}`);
        fail(`You can manually download the GGUF from:`);
        fail(`  ${MODEL_URL.split('?')[0]}`);
        fail(`Then import it via:  lms import "<path>" --user-repo "${MODEL_USER_REPO}" -y`);
        process.exit(1);
      }
    }

    // ── Step 3b: Import into LM Studio ──────────────────────────────────────
    head('Step 3b/6 — Import model into LM Studio');
    info(`Running: lms import "${tmpGguf}" --user-repo "${MODEL_USER_REPO}" -y --copy`);
    const imported = await lmsAsync(
      ['import', tmpGguf, '--user-repo', MODEL_USER_REPO, '-y', '--copy'],
      'lms import'
    );
    if (imported) {
      ok('Model imported into LM Studio');
    } else {
      warn('lms import returned non-zero. This may be OK if the model already exists.');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Start LM Studio server
// ─────────────────────────────────────────────────────────────────────────────
head('Step 4/6 — LM Studio server');
if (serverIsRunning()) {
  ok('Server already running on :1234');
} else {
  info('Starting LM Studio server (lms server start) ...');
  const started = await lmsAsync(['server', 'start'], 'lms server start');
  if (started) {
    ok('Server started on :1234');
  } else {
    fail('lms server start failed.');
    fail('Start LM Studio manually, enable the server in Settings → Server, then re-run.');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — Load the model
// ─────────────────────────────────────────────────────────────────────────────
head('Step 5/6 — Load model');

// Find the actual model key from lms ls output
function findModelKey() {
  const r = lms('ls');
  if (!r.ok) return null;
  // Look for a line containing the filename or a recognizable part of it
  const lines = r.out.split('\n');
  for (const line of lines) {
    const l = line.toLowerCase();
    if (l.includes('q2_k_xl') || l.includes('qwen3.5-9b-ud-q2')) {
      // Extract first token (the model key)
      const key = line.trim().split(/\s+/)[0];
      if (key && key.length > 3) return key;
    }
  }
  return null;
}

if (modelIsLoaded('q2_k_xl')) {
  ok('Model already loaded in memory');
} else {
  const modelKey = findModelKey() || MODEL_KEY;
  info(`Loading model: ${modelKey}`);
  info('(This may take 30–90 seconds the first time)');
  const loaded = await lmsAsync(
    ['load', modelKey, '-y', '--identifier', 'qwen3.5-9b@q2_k_xl'],
    'lms load'
  );
  if (loaded) {
    ok(`Model loaded: ${modelKey}`);
  } else {
    warn('lms load returned non-zero. Model may still be loading.');
    warn(`Check: lms ps`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6 — Launch MCP stack
// ─────────────────────────────────────────────────────────────────────────────
head('Step 6/6 — MCP stack');
if (NO_LAUNCH) {
  info('--no-launch set — skipping stack start');
  console.log(`\n${c.green}${c.bold}Installation complete.${c.reset}`);
  console.log(`  Start the stack:  node launch.mjs`);
  console.log(`  Run a demo:       node _twin_demo.mjs`);
  console.log(`  Triad demo:       node _triad_demo.mjs\n`);
} else {
  info('Starting MCP stack (node launch.mjs) ...');
  console.log(`  ${c.gray}Press Ctrl+C to stop.${c.reset}\n`);

  const stack = spawn(process.execPath, [path.join(__dirname, 'launch.mjs')], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stack.kill(sig);
      process.exit(0);
    });
  }

  stack.on('exit', (code) => process.exit(code ?? 0));
}
