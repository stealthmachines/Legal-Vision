#!/usr/bin/env node
/**
 * chat.mjs — Interactive multi-voice terminal chat
 *
 * Sends every message to up to three voices in parallel:
 *   A — Local LLM via MCP server on :3333  (llm_query tool)
 *   B — Local LLM via MCP server on :3334  (llm_query tool)
 *   C — Cloud LLM (Anthropic Claude, OpenAI, or custom OpenAI-compat endpoint)
 *
 * Any voice that is offline or unconfigured is skipped gracefully.
 * All responses are logged to the ERL ledger (branch: chat_session).
 *
 * Usage:
 *   node chat.mjs
 *   node chat.mjs --modelA qwen3.5-9b@q3_k_xl:2 --modelB qwen3.5-9b@q3_k_xl
 *   node chat.mjs --cloud anthropic               # use Anthropic Claude (default)
 *   node chat.mjs --cloud openai                  # use OpenAI
 *   node chat.mjs --cloud none                    # disable cloud voice
 *   node chat.mjs --cloud-model claude-sonnet-4-5 # override cloud model
 *   node chat.mjs --cloud-url http://host/v1      # custom OpenAI-compat endpoint
 *   node chat.mjs --no-local                      # cloud only
 *   node chat.mjs --voices A,C                    # only voices A and C
 *   node chat.mjs --temp 0.8 --max-tokens 400
 *
 * Environment variables for cloud auth:
 *   ANTHROPIC_API_KEY   — for --cloud anthropic (default)
 *   OPENAI_API_KEY      — for --cloud openai
 *   CLOUD_API_KEY       — fallback for any provider
 *
 * Cloud voice comes and goes: if the API key is missing or the request fails,
 * that turn is skipped and the conversation continues.
 */

import http            from 'http';
import https           from 'https';
import crypto          from 'crypto';
import { createInterface } from 'readline';

// ── ANSI colours ──────────────────────────────────────────────────────────────
const TTY = process.stdout.isTTY;
const c = {
  reset:   TTY ? '\x1b[0m'  : '', bold:    TTY ? '\x1b[1m'  : '',
  dim:     TTY ? '\x1b[2m'  : '', red:     TTY ? '\x1b[31m' : '',
  green:   TTY ? '\x1b[32m' : '', yellow:  TTY ? '\x1b[33m' : '',
  blue:    TTY ? '\x1b[34m' : '', magenta: TTY ? '\x1b[35m' : '',
  cyan:    TTY ? '\x1b[36m' : '', gray:    TTY ? '\x1b[90m' : '',
  white:   TTY ? '\x1b[97m' : '',
};

// Voice colours
const VOICE_COLOR = {
  A: c.cyan,
  B: c.yellow,
  C: c.magenta,
};

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const arg     = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i+1] ?? def : def; };
const hasFlag = (flag) => argv.includes(flag);

let MODEL_A        = arg('--modelA',      'qwen3.5-9b@q3_k_xl:2');
let MODEL_B        = arg('--modelB',      'qwen3.5-9b@q3_k_xl');
const CLOUD_PROV   = arg('--cloud',       'anthropic');          // anthropic | openai | none
const CLOUD_URL    = arg('--cloud-url',   '');                   // custom OpenAI-compat base URL
const TEMP         = parseFloat(arg('--temp',       '0.7'));
const MAX_TOK      = parseInt(arg('--max-tokens',   '300'));
const NO_LOCAL     = hasFlag('--no-local');
const HELP         = hasFlag('--help') || hasFlag('-h');

// Default cloud models per provider
const DEFAULT_CLOUD_MODEL = {
  anthropic: 'claude-sonnet-4-5',
  openai:    'gpt-4o-mini',
  custom:    'default',
};
const CLOUD_MODEL = arg('--cloud-model', DEFAULT_CLOUD_MODEL[CLOUD_PROV] ?? 'claude-sonnet-4-5');

// --voices A,B,C filter
const VOICES_RAW  = arg('--voices', 'A,B,C');
const ACTIVE_VOICES = new Set(VOICES_RAW.toUpperCase().split(',').map(v => v.trim()));

if (HELP) {
  console.log(`
  ${c.bold}chat.mjs${c.reset} — Interactive multi-voice terminal chat

  ${c.cyan}node chat.mjs${c.reset}                              start chat (all voices)
  ${c.cyan}node chat.mjs --voices A,C${c.reset}                 only use voices A and C
  ${c.cyan}node chat.mjs --modelA MODEL_ID${c.reset}            set local LLM-A model key
  ${c.cyan}node chat.mjs --modelB MODEL_ID${c.reset}            set local LLM-B model key
  ${c.cyan}node chat.mjs --cloud anthropic${c.reset}            cloud voice: Anthropic Claude (default)
  ${c.cyan}node chat.mjs --cloud openai${c.reset}               cloud voice: OpenAI
  ${c.cyan}node chat.mjs --cloud none${c.reset}                 disable cloud voice
  ${c.cyan}node chat.mjs --cloud-model MODEL_ID${c.reset}       override cloud model
  ${c.cyan}node chat.mjs --cloud-url http://host/v1${c.reset}   custom OpenAI-compat endpoint
  ${c.cyan}node chat.mjs --no-local${c.reset}                   disable both local voices
  ${c.cyan}node chat.mjs --temp 0.8${c.reset}                   sampling temperature (default 0.7)
  ${c.cyan}node chat.mjs --max-tokens 400${c.reset}             max response tokens (default 300)

  ${c.bold}Environment:${c.reset}
    ANTHROPIC_API_KEY   Anthropic API key
    OPENAI_API_KEY      OpenAI API key
    CLOUD_API_KEY       Fallback key for any provider

  ${c.bold}Chat commands:${c.reset}
    /quit  /exit        end session
    /voices             show current voice status
    /only A             respond with voice A only (this turn)
    /only B,C           respond with voices B and C only (this turn)
    /reset              clear conversation history
    /help               show this message
  `);
  process.exit(0);
}

// ── Live model assignment ────────────────────────────────────────────────────
/**
 * Query LM Studio for currently loaded models and let the user assign them
 * to Voice A (slot 1 / :3333) and Voice B (slot 2 / :3334).
 * Returns { modelA, modelB } — falls back to CLI flags if no models are found
 * or the user skips.
 */
async function pickVoiceModels() {
  let loaded = [];
  try {
    const res = await fetch('http://127.0.0.1:1234/v1/models', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const json = await res.json();
      loaded = (json.data ?? []).map(m => m.id ?? m.model ?? String(m))
                               .filter(id => !id.includes('embed') && !id.includes('nomic'));
    }
  } catch { /* LM Studio not up — use CLI defaults */ }

  if (loaded.length === 0) return { modelA: MODEL_A, modelB: MODEL_B };

  console.log(`\n${c.bold}── Assign loaded models to voices ─────────────────────${c.reset}`);
  console.log(`${c.dim}  (Enter to accept defaults shown, or type a number)${c.reset}\n`);

  loaded.forEach((m, i) => console.log(`    ${c.cyan}[${i + 1}]${c.reset}  ${m}`));
  console.log();

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const ask  = (q) => new Promise(r => rl2.question(q, a => r(a.trim())));

  // Voice A
  const defaultA = loaded.find(m => m.endsWith(':2') || m.endsWith(':1')) ?? loaded[0] ?? MODEL_A;
  const ansA = await ask(`  ${c.cyan}Voice A${c.reset} ${c.dim}(port 3333)${c.reset} [default: ${c.bold}${defaultA}${c.reset}]: `);
  const chosenA = ansA === ''
    ? defaultA
    : (!isNaN(parseInt(ansA)) && loaded[parseInt(ansA) - 1]) ? loaded[parseInt(ansA) - 1] : ansA;

  // Voice B
  const defaultB = loaded.find(m => m !== chosenA && !m.endsWith(':2')) ?? loaded[loaded.length > 1 ? 1 : 0] ?? MODEL_B;
  const ansB = await ask(`  ${c.yellow}Voice B${c.reset} ${c.dim}(port 3334)${c.reset} [default: ${c.bold}${defaultB}${c.reset}]: `);
  const chosenB = ansB === ''
    ? defaultB
    : (!isNaN(parseInt(ansB)) && loaded[parseInt(ansB) - 1]) ? loaded[parseInt(ansB) - 1] : ansB;

  rl2.close();
  console.log(`\n  ${c.green}✓${c.reset}  Voice A → ${c.bold}${chosenA}${c.reset}`);
  console.log(`  ${c.green}✓${c.reset}  Voice B → ${c.bold}${chosenB}${c.reset}\n`);
  return { modelA: chosenA, modelB: chosenB };
}

// ── Conversation history (kept per voice for context) ─────────────────────────
// Local voices get their context from the ERL ledger (server-side).
// Cloud voice gets an in-process message array we maintain here.
const cloudHistory = [];

// ── SSE → MCP tool call helper ────────────────────────────────────────────────
function sseCall(port, toolName, toolArgs, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let sessionUrl = null;
    let posted     = false;
    let sseBuf     = '';
    const msgId    = crypto.randomInt(1000, 9999);

    const req = http.get(`http://127.0.0.1:${port}/sse`, (res) => {
      res.on('data', chunk => {
        sseBuf += chunk.toString();
        const lines = sseBuf.split('\n');
        sseBuf = lines.pop();

        for (const line of lines) {
          if (!posted && line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data.startsWith('/')) {
              sessionUrl = `http://127.0.0.1:${port}${data}`;
              posted     = true;
              const body = JSON.stringify({
                jsonrpc: '2.0', id: msgId,
                method:  'tools/call',
                params:  { name: toolName, arguments: toolArgs },
              });
              const postReq = http.request(sessionUrl, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
              }, (postRes) => {
                let r = '';
                postRes.on('data', d => r += d);
                postRes.on('end', () => {
                  if (postRes.statusCode !== 202) { req.destroy(); resolve({ port, body: r }); }
                });
              });
              postReq.on('error', reject);
              postReq.write(body); postReq.end();
            }
          }
          if (posted && line.startsWith('data:')) {
            const data = line.slice(5).trim();
            try {
              const json = JSON.parse(data);
              if (json.id === msgId && (json.result !== undefined || json.error !== undefined)) {
                req.destroy(); resolve({ port, body: data });
              }
            } catch { /* not our frame */ }
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error(`timeout :${port}`)); }, timeoutMs);
  });
}

function parseLocalResult(r) {
  try {
    const parsed  = JSON.parse(r.body);
    const content = parsed?.result?.content?.[0]?.text;
    return content ? JSON.parse(content) : { raw: r.body.slice(0, 600) };
  } catch { return { raw: r.body?.slice(0, 600) }; }
}

// ── Check if a local MCP port is up ──────────────────────────────────────────
async function portAlive(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/sse`, res => {
      req.destroy();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

// ── Cloud LLM caller ──────────────────────────────────────────────────────────
/**
 * Returns { response: string } or { error: string }.
 * Supports Anthropic Messages API and OpenAI Chat Completions API.
 * Adds/updates cloudHistory so each turn is in context for C.
 */
async function callCloud(userMessage) {
  if (CLOUD_PROV === 'none') return { error: 'cloud disabled' };

  const apiKey =
    process.env.ANTHROPIC_API_KEY  ||  // preferred for Anthropic
    process.env.OPENAI_API_KEY      ||  // preferred for OpenAI
    process.env.CLOUD_API_KEY       ||  // generic fallback
    '';

  if (!apiKey) {
    return { error: 'no API key — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or CLOUD_API_KEY' };
  }

  // Maintain history
  cloudHistory.push({ role: 'user', content: userMessage });

  try {
    let responseText;

    // ── Anthropic Messages API ────────────────────────────────────────────────
    if (CLOUD_PROV === 'anthropic' && !CLOUD_URL) {
      const body = JSON.stringify({
        model:      CLOUD_MODEL,
        max_tokens: MAX_TOK,
        messages:   cloudHistory.map(m => ({ role: m.role, content: m.content })),
      });

      responseText = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.anthropic.com',
          path:     '/v1/messages',
          method:   'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length':    Buffer.byteLength(body),
          },
        }, res => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.error)    return reject(new Error(json.error.message ?? JSON.stringify(json.error)));
              if (json.content?.[0]?.text) return resolve(json.content[0].text);
              reject(new Error(`Unexpected Anthropic response: ${data.slice(0, 200)}`));
            } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.write(body); req.end();
      });

    // ── OpenAI Chat Completions API (also used for custom endpoints) ──────────
    } else {
      const baseUrl  = CLOUD_URL || (CLOUD_PROV === 'openai' ? 'https://api.openai.com/v1' : 'https://api.openai.com/v1');
      const url      = new URL(`${baseUrl}/chat/completions`);
      const isHttps  = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const body = JSON.stringify({
        model:      CLOUD_MODEL,
        max_tokens: MAX_TOK,
        temperature: TEMP,
        messages:   cloudHistory,
      });

      responseText = await new Promise((resolve, reject) => {
        const req = transport.request({
          hostname: url.hostname,
          port:     url.port || (isHttps ? 443 : 80),
          path:     url.pathname + url.search,
          method:   'POST',
          headers: {
            'Content-Type':   'application/json',
            'Authorization':  `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(body),
          },
        }, res => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.error)                         return reject(new Error(JSON.stringify(json.error)));
              const msg = json.choices?.[0]?.message?.content;
              if (msg) return resolve(msg);
              reject(new Error(`Unexpected response: ${data.slice(0, 200)}`));
            } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.write(body); req.end();
      });
    }

    // Add assistant turn to history
    cloudHistory.push({ role: 'assistant', content: responseText });
    return { response: responseText };

  } catch (err) {
    // Don't add failed turns to history
    cloudHistory.pop(); // remove the user message we just pushed
    return { error: err.message };
  }
}

// ── Log a response to ERL via local port ─────────────────────────────────────
async function logToErl(port, voice, model, prompt, response) {
  const promptHash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
  try {
    await sseCall(port, 'erl_append', {
      content: JSON.stringify({ voice, model, prompt_hash: promptHash, response }),
      branch:  'chat_session',
      tags:    ['chat', `voice_${voice}`, model],
    }, 10000);
  } catch { /* logging is best-effort */ }
}

// ── Voice probe ───────────────────────────────────────────────────────────────
async function probeVoices() {
  const aUp = !NO_LOCAL && ACTIVE_VOICES.has('A') && await portAlive(3333);
  const bUp = !NO_LOCAL && ACTIVE_VOICES.has('B') && await portAlive(3334);
  const cUp = ACTIVE_VOICES.has('C') && CLOUD_PROV !== 'none' &&
    !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.CLOUD_API_KEY);

  return { A: aUp, B: bUp, C: cUp };
}

// ── Print a voice response ────────────────────────────────────────────────────
function printVoice(label, model, text, error) {
  const col   = VOICE_COLOR[label] ?? c.white;
  const bar   = '─'.repeat(55);
  const header = `${col}${c.bold}── Voice ${label}${c.reset}${col}: ${model}${c.reset}`;
  console.log(`\n${header}`);
  console.log(`${col}${bar}${c.reset}`);
  if (error) {
    console.log(`  ${c.dim}${error}${c.reset}`);
  } else {
    const lines = text.split('\n');
    for (const line of lines) console.log(`  ${line}`);
  }
  console.log();
}

// ── Banner ────────────────────────────────────────────────────────────────────
async function showBanner(voices) {
  console.log(`\n${c.bold}${c.cyan}╔══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.cyan}║        Multi-Voice Chat  ·  Easy by zCHG.org         ║${c.reset}`);
  console.log(`${c.bold}${c.cyan}╚══════════════════════════════════════════════════════╝${c.reset}\n`);

  const voiceRows = [
    { label: 'A', model: MODEL_A,      port: ':3333', up: voices.A, source: 'local' },
    { label: 'B', model: MODEL_B,      port: ':3334', up: voices.B, source: 'local' },
    { label: 'C', model: CLOUD_MODEL,  port: CLOUD_PROV === 'none' ? 'disabled' : CLOUD_PROV, up: voices.C, source: 'cloud' },
  ];

  for (const v of voiceRows) {
    const col = VOICE_COLOR[v.label] ?? c.white;
    const sym = v.up ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`;
    const src = v.source === 'cloud' ? `${c.magenta}[cloud]${c.reset}` : `${c.cyan}[local]${c.reset}`;
    const status = v.up ? '' : `  ${c.dim}(offline/unconfigured — will be skipped)${c.reset}`;
    console.log(`  ${sym}  ${col}Voice ${v.label}${c.reset}  ${src}  ${c.dim}${v.model}${c.reset}  ${c.gray}${v.port}${c.reset}${status}`);
  }

  if (!voices.C && CLOUD_PROV !== 'none') {
    console.log(`\n  ${c.yellow}⚠${c.reset}  Cloud voice C needs an API key:`);
    if (CLOUD_PROV === 'anthropic' || CLOUD_PROV === 'none') {
      console.log(`       ${c.dim}set ANTHROPIC_API_KEY=sk-ant-...${c.reset}`);
    }
    if (CLOUD_PROV === 'openai') {
      console.log(`       ${c.dim}set OPENAI_API_KEY=sk-...${c.reset}`);
    }
    console.log(`       ${c.dim}or CLOUD_API_KEY=<key> for any provider${c.reset}`);
  }

  console.log(`\n  ${c.dim}Type your message and press Enter. /help for commands.${c.reset}\n`);
}

// ── Main chat loop ─────────────────────────────────────────────────────────────
let voices = await probeVoices();

// Live model assignment — skip if --no-local or both local voices are down
if (!NO_LOCAL && (voices.A || voices.B)) {
  const { modelA, modelB } = await pickVoiceModels();
  MODEL_A = modelA;
  MODEL_B = modelB;
}

await showBanner(voices);

const rl = createInterface({
  input:  process.stdin,
  output: process.stdout,
  prompt: `${c.bold}${c.white}You ›${c.reset} `,
});

rl.prompt();

rl.on('line', async (raw) => {
  const line = raw.trim();
  if (!line) { rl.prompt(); return; }

  // ── Built-in commands ──────────────────────────────────────────────────────
  if (line === '/quit' || line === '/exit') {
    console.log(`\n${c.dim}Session ended.${c.reset}\n`);
    process.exit(0);
  }

  if (line === '/help') {
    console.log(`
  ${c.bold}Commands:${c.reset}
    /quit /exit       end session
    /voices           re-probe and show voice status
    /only A           this turn: only voice A responds
    /only A,C         this turn: only voices A and C respond
    /reset            clear cloud conversation history
    /help             this message
    `);
    rl.prompt(); return;
  }

  if (line === '/voices') {
    voices = await probeVoices();
    await showBanner(voices);
    rl.prompt(); return;
  }

  if (line === '/reset') {
    cloudHistory.length = 0;
    console.log(`\n  ${c.green}✓${c.reset}  Cloud conversation history cleared.\n`);
    rl.prompt(); return;
  }

  // /only A  or  /only A,B,C
  let turnVoices = voices;
  let userMessage = line;
  if (line.startsWith('/only ')) {
    const subset = new Set(line.slice(6).toUpperCase().split(',').map(v => v.trim()));
    turnVoices = { A: voices.A && subset.has('A'), B: voices.B && subset.has('B'), C: voices.C && subset.has('C') };
    rl.prompt(); return; // need the actual message on next line
    // NOTE: /only sets override for ONE turn — handled by capturing next line
    // Simple implementation: treat remainder as the message if present on same line
  }
  if (line.startsWith('/only ')) {
    const parts   = line.slice(6).split(' ');
    const subset  = new Set(parts[0].toUpperCase().split(',').map(v => v.trim()));
    userMessage   = parts.slice(1).join(' ').trim();
    turnVoices    = { A: voices.A && subset.has('A'), B: voices.B && subset.has('B'), C: voices.C && subset.has('C') };
    if (!userMessage) { rl.prompt(); return; }
  }

  console.log(); // spacing before responses

  // ── Fire all active voices in parallel ────────────────────────────────────
  const promptHash = crypto.createHash('sha256').update(userMessage).digest('hex').slice(0, 16);

  const jobs = [];

  if (turnVoices.A) {
    jobs.push(
      sseCall(3333, 'llm_query', {
        prompt:      userMessage,
        model:       MODEL_A,
        max_tokens:  MAX_TOK,
        temperature: TEMP,
        log:         true,
        branch:      'chat_session',
      }, 90000)
        .then(r  => ({ voice: 'A', result: parseLocalResult(r) }))
        .catch(e => ({ voice: 'A', error: e.message }))
    );
  }

  if (turnVoices.B) {
    jobs.push(
      sseCall(3334, 'llm_query', {
        prompt:      userMessage,
        model:       MODEL_B,
        max_tokens:  MAX_TOK,
        temperature: TEMP,
        log:         true,
        branch:      'chat_session',
      }, 90000)
        .then(r  => ({ voice: 'B', result: parseLocalResult(r) }))
        .catch(e => ({ voice: 'B', error: e.message }))
    );
  }

  if (turnVoices.C) {
    jobs.push(
      callCloud(userMessage)
        .then(r  => ({ voice: 'C', result: r }))
        .catch(e => ({ voice: 'C', error: e.message }))
    );
  }

  if (jobs.length === 0) {
    console.log(`  ${c.yellow}⚠${c.reset}  No voices are online. Check stack with ${c.cyan}node launch.mjs --status${c.reset}\n`);
    rl.prompt(); return;
  }

  // Wait for all voices — show them as they arrive if possible
  // (Promise.allSettled gives us all results after all complete)
  const results = await Promise.allSettled(jobs);

  for (const settled of results) {
    if (settled.status === 'rejected') continue;
    const { voice, result, error } = settled.value;
    const model = voice === 'A' ? MODEL_A : voice === 'B' ? MODEL_B : `${CLOUD_PROV}/${CLOUD_MODEL}`;

    if (error) {
      printVoice(voice, model, null, error);
    } else if (result?.error) {
      printVoice(voice, model, null, result.error);
    } else {
      const text = result?.response ?? result?.raw ?? '(no response)';
      printVoice(voice, model, text, null);

      // Log cloud voice to ERL (local voices log themselves via the tool)
      if (voice === 'C' && (voices.A || voices.B)) {
        const erlPort = voices.A ? 3333 : 3334;
        logToErl(erlPort, 'C', `${CLOUD_PROV}/${CLOUD_MODEL}`, userMessage, text).catch(() => {});
      }
    }
  }

  // Re-probe ports silently so voices that come online mid-session are picked up
  voices = await probeVoices();

  rl.prompt();
});

rl.on('close', () => {
  console.log(`\n${c.dim}Session ended.${c.reset}\n`);
  process.exit(0);
});
