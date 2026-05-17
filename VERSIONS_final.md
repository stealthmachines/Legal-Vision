# MCP-Jailbreak — Versioning Reference

> Covers all submitted zips, in true chronological order (derived from internal timestamps, not zip filenames).
> "Context bloat" = total size of all persistent state that can be loaded back into an LLM context window:
> audit log + ERL ledger + system context files + notes.

---

## Chronological Timeline

```
2026-05-04 15:27  state1          ← session snapshot, single server, leanest state
2026-05-04 16:31  state0          ← session snapshot, single server, knowledge base populated
2026-05-04 17:32  state2          ← session snapshot, single server, cleanup tooling drafted
2026-05-04 20:47  wuwei-routing   ← v0.4: dual server added, HDGL daemon, no coord-proxy
2026-05-04 20:47  wuwei-routing_2 ← v0.5: coord-proxy added
2026-05-04 20:47  twin-flames     ← v0.6: ERL Merkle checkpoints, dual-LLM README
2026-05-04 22:11  twin-flames2    ← v0.7: concurrent write safety (spinlock)
2026-05-04 22:56  twin-flames3    ← v0.8: demo scripts, triad session, ERL grows to 25 entries
2026-05-04 23:36  twin-flames4    ← v0.9: launch.mjs, cross-platform startup
2026-05-04 23:38  twin-flames5    ← v0.10: --load-model flag, --status shows loaded LLMs
2026-05-05 00:20  pre-easy        ← v0.11: install.mjs, zero-to-running installer
```

---

## state1

**Zip:** `state1.zip`  
**Snapshot time:** 2026-05-04 ~15:27  
**Type:** Session snapshot (single server)  
**Repo version equivalent:** pre-v0.4 baseline

### What it is
The earliest captured state. A fresh-ish single-server session where the LLM had just begun working with the ERL ledger and discovered context was at 63.2% utilization. No cleanup tooling exists yet. The notes folder has only 2 files covering ERL standardization and a token recovery summary.

### Architecture
- Single MCP server — `server.js` on `:3333`
- No `server-dos.js`, no `coord-proxy.js`, no wuwei routing daemon
- Start: `npm install && node server.js`

### Key files
| File | Purpose |
|------|---------|
| `server.js` | MCP server — 57 tools, Wu-Wei unfold pipeline |
| `tools_erl.js` | ERL v3 ledger tools |
| `start-server.js` | Simple process wrapper |
| `mcp.json` | LM Studio SSE config pointing to `:3333` |
| `notes/erl_standardization.md` | ERL schema docs |
| `notes/token_recovery_summary.md` | Token efficiency notes |

### ERL ledger state
- 6 entries across 3 active branches: `session_context`, `task_analysis`, `conversation_absorption_05_04`
- No `twin_flame_evals` or `triad_session` branches

### Context bloat
| Component | Size |
|-----------|------|
| System context (prompt + MD + JSON) | 31 KB |
| Audit log | 10 KB |
| ERL ledger | 9 KB |
| Notes | 5 KB (2 files) |
| **Total** | **57 KB** |

### "Just works" rating: ✅ High
### Multi-bot invocation: ❌ None

---

## state0

**Zip:** `state0.zip`  
**Snapshot time:** 2026-05-04 ~16:31  
**Type:** Session snapshot (single server)  
**Repo version equivalent:** pre-v0.4, post-cleanup-protocol run

### What it is
Despite the name, state0 is *later* than state1 (the naming is misleading — go by timestamps). The LLM ran a 4-step "Context Clearing Protocol" during this session, compressing its knowledge into a ~1200-token summary and writing it to `notes/MCP_SERVER_v3_knowledge.md`. The session ended mid-flow with the LLM calling `unfold()` on `erl_first_cleanup` — a tool that didn't yet exist in `server.js`.

### Architecture
Identical to state1 — single server only.

### Key files added vs state1
| File | Purpose |
|------|---------|
| `tools_cleanup.js` | ERL cleanup tool skeleton |
| `notes/MCP_SERVER_v3_knowledge.md` | Compressed ~1200-token knowledge base |
| `notes/ERL_cleanup_instructions.md` | Cleanup protocol docs |
| `notes/erl_first_cleanup_tool_guide.md` | Tool guide (written by LLM) |

### ERL ledger state
- 6 entries, same branches as state1

### Context bloat
| Component | Size |
|-----------|------|
| System context | 31 KB |
| Audit log | 12 KB |
| ERL ledger | 9 KB |
| Notes | 13 KB (5 files) |
| **Total** | **66 KB** |

### "Just works" rating: ✅ High
### Multi-bot invocation: ❌ None
### Notable: Best pre-populated single-server starting point — knowledge base already built.

---

## state2

**Zip:** `state2.zip`  
**Snapshot time:** 2026-05-04 ~17:32  
**Type:** Session snapshot (single server)  
**Repo version equivalent:** pre-v0.4, cleanup tooling drafted

### What it is
The LLM followed through on what state0 started. It generated `tools_erl_cleanup.js`, `erl_cleanup_wrapper.mjs`, and `server.patch`, and wrote 3 additional notes documenting the integration. The audit log shows it repeatedly attempted to patch `server.js` to register `erl_first_cleanup` as a live MCP tool — using `shell`, `fs_read`, `fs_write`, `findstr` — but the patch never landed (`server.js` size is identical to state0/state1). The session ends with the LLM searching for a "robust server patching utility."

**Known bug:** `server.patch` uses `require()` syntax inside an ES module context — it would throw `ReferenceError: require is not defined` if applied and called.

### Architecture
Identical to state0/state1 — single server only.

### Key files added vs state0
| File | Purpose |
|------|---------|
| `tools_erl_cleanup.js` | Standalone cleanup tool implementation |
| `erl_cleanup_wrapper.mjs` | Runnable standalone: `node erl_cleanup_wrapper.mjs` |
| `server.patch` | Informational patch — **do not auto-apply** (has `require()` bug) |
| `notes/ERL_First_Cleanup_Tool.md` | Tool spec |
| `notes/ERL_First_Cleanup_Tool_Integration.md` | Integration guide |
| `notes/ERL_cleanup_manual_guide.md` | Manual fallback instructions |

### ERL ledger state
- 6 entries, same branches as state1/state0

### Context bloat
| Component | Size |
|-----------|------|
| System context | 31 KB |
| Audit log | 20 KB |
| ERL ledger | 9 KB |
| Notes | 18 KB (8 files) |
| **Total** | **79 KB** |

### "Just works" rating: ✅ High (core server); ⚠️ use `erl_cleanup_wrapper.mjs` standalone only
### Multi-bot invocation: ❌ None

---

## wuwei-routing (v0.4)

**Zip:** `wuwei-routing.zip`  
**Snapshot time:** 2026-05-04 ~20:47  
**Type:** Code release snapshot  
**Repo version:** v0.4

### What it is
The first version where the dual-server architecture appears. `server-dos.js` (the secondary MCP server on `:3334`) and the wuwei-routing HDGL daemon were added. The `coord-proxy.js` is **not yet present**. Startup is entirely manual — 3 separate terminal windows required. The wuwei-routing README still has a hardcoded `C:\Users\Owner\Downloads\...` path, indicating it hadn't been generalized yet.

### Architecture
- MCP Server A: `server.js` on `:3333`
- MCP Server B: `server-dos.js` on `:3334`
- HDGL daemon: `wuwei-routing/start.bat` (PowerShell, Windows-only)
- No coord-proxy
- Start: manual 3-terminal process

### Key files added vs state2
| File | Purpose |
|------|---------|
| `server-dos.js` | Secondary MCP server (mirror) |
| `wuwei-routing/start.bat` | HDGL daemon launcher |
| `wuwei-routing/start-routes.ps1` | PowerShell routing daemon |
| `wuwei-routing/router-phi.ps1` | Phi-routing logic |
| `wuwei-routing/state/` | Health/active-server state files |
| `notes/dual-*`, `notes/hdgl-*`, `notes/hybrid-*` | Architecture notes (7 new files) |

### ERL ledger state
- 6 entries, same branches as state series

### Context bloat
| Component | Size |
|-----------|------|
| System context | 31 KB |
| Audit log | 22 KB |
| ERL ledger | 9 KB |
| Notes | 44 KB (12 files) |
| **Total** | **107 KB** |

### "Just works" rating: ❌ Low — Windows-only daemon, hardcoded paths, 3 manual terminals
### Multi-bot invocation: ❌ None

---

## wuwei-routing_2 (v0.5)

**Zip:** `wuwei-routing__2_.zip`  
**Snapshot time:** 2026-05-04 ~20:47 (same audit log timestamp as v0.4)  
**Type:** Code release snapshot  
**Repo version:** v0.5

### What it is
`coord-proxy.js` arrives. The coordination proxy sits on `:1233` and implements the phi-emergent SOLO/RELAY/CHALLENGE routing modes (61.8% / 23.6% / 14.6% split based on SHA-256 → golden ratio mapping). This is the first version where two LLM instances can genuinely cooperate on a request. Startup is now 4 manual terminals.

### Architecture
- MCP Server A: `server.js` on `:3333`
- MCP Server B: `server-dos.js` on `:3334`
- Coord Proxy: `coord-proxy.js` on `:1233` (OpenAI-compatible API)
- HDGL daemon: `wuwei-routing/`
- Start: 4 manual terminals (still Windows-primary)

### Key files added vs v0.4
| File | Purpose |
|------|---------|
| `coord-proxy.js` | Phi-routing proxy — SOLO / RELAY / CHALLENGE modes |

### Routing modes
| Mode | Frequency | Behavior |
|------|-----------|----------|
| SOLO | 61.8% | Single LLM, HDGL biases which instance |
| RELAY | 23.6% | LLM1 drafts → LLM2 refines |
| CHALLENGE | 14.6% | LLM1 answers → LLM2 critiques → LLM1 revises |

### Context bloat
Identical to v0.4 — **107 KB** (same audit log, same ERL, same notes)

### "Just works" rating: ❌ Low — same manual multi-terminal issues as v0.4
### Multi-bot invocation: ❌ No demo scripts yet — must call coord-proxy API manually

---

## twin-flames (v0.6)

**Zip:** `twin-flames.zip`  
**Snapshot time:** 2026-05-04 ~20:47 (same audit timestamp)  
**Type:** Code release snapshot  
**Repo version:** v0.6

### What it is
README rewritten as `local-mcp v3.0.0 — Wu-Wei Unfold Architecture`, prominently documenting the dual-LLM stack for the first time. The internal code change is ERL Merkle checkpoints: every 50 appends, a SHA-256 checkpoint is stored so `erlVerify` can skip already-verified segments (O(tail) instead of O(n)). Functionally identical stack to v0.5.

### Key changes vs v0.5
- ERL `erlAppend` adds `CHECKPOINT_INTERVAL = 50` Merkle checkpointing
- README overhauled to document dual-LLM architecture, phi-routing modes, LLM slot assignments

### Context bloat
Identical to v0.4/v0.5 — **107 KB**

### "Just works" rating: ⚠️ Medium-low — documented startup but still 4 manual terminals
### Multi-bot invocation: ❌ No demo scripts

---

## twin-flames2 (v0.7)

**Zip:** `twin-flames2.zip`  
**Snapshot time:** 2026-05-04 ~22:11  
**Type:** Code release snapshot  
**Repo version:** v0.7

### What it is
Concurrent write safety lands. When two MCP servers write to `erl-ledger.json` simultaneously, the previous code would silently clobber entries. v0.7 adds a spinlock via `erl-ledger.json.lock` and a read-merge-write pattern: on save, the server re-reads disk state and merges it with in-memory state before writing, so neither server loses entries. Also introduces the `LOCK_FILE` constant. This is the first version where running both servers simultaneously is actually safe.

### Key changes vs v0.6
- `getLedger()` / `erlSave()` now use file locking (`erl-ledger.json.lock`)
- Read-merge-write on every ledger save — hash-keyed entries make union safe
- `server.js` grows from 116 KB → 140 KB; `server-dos.js` from 116 KB → 133 KB

### Context bloat
Identical to v0.4–v0.6 — **107 KB**

### "Just works" rating: ⚠️ Medium-low — same startup, but dual-server mode now actually reliable
### Multi-bot invocation: ❌ No demo scripts

---

## twin-flames3 (v0.8)

**Zip:** `twin-flames3.zip`  
**Snapshot time:** 2026-05-04 ~22:56  
**Type:** Code release snapshot  
**Repo version:** v0.8

### What it is
The first version with runnable multi-bot invocation scripts. Three demo/utility scripts appear: `_twin_demo.mjs`, `_triad_demo.mjs`, and `_probe.mjs`. The ERL ledger jumps from 6 to 25 entries, adding `twin_flame_evals` (8 entries) and `triad_session` (3 entries) branches — evidence the demos were actually run. `start-all.ps1` replaces manual terminal management (Windows/PowerShell only). README renamed to `MCP-Jailbreak-0.3 · state0`.

### Key files added vs v0.7
| File | Purpose |
|------|---------|
| `_twin_demo.mjs` | Runs same question through both LLM instances, logs divergence to ERL |
| `_triad_demo.mjs` | 3-voice conversation: LLM-A + LLM-B + Copilot; fully CLI-parameterized |
| `_probe.mjs` | Health/connectivity probe for all stack ports |
| `start-all.ps1` | Launches all 4 processes from one PowerShell script |

### User prompt — `_twin_demo.mjs`
Hardcoded question (edit `QUESTION` const to change):
```
node _twin_demo.mjs
```

### User prompt — `_triad_demo.mjs`
Fully parameterized:
```
node _triad_demo.mjs --question "Your question here"
node _triad_demo.mjs --modelA qwen3.5-9b@q3_k_xl:2 --modelB qwen3.5-9b@q3_k_xl
node _triad_demo.mjs --no-copilot
```

### ERL ledger state
- 25 entries | branches: `session_context` (12), `twin_flame_evals` (8), `triad_session` (3), `task_analysis` (1), `conversation_absorption_05_04` (1)

### Context bloat
| Component | Size |
|-----------|------|
| System context | 27 KB (JSON trimmed from 20 KB → 16 KB) |
| Audit log | 31 KB |
| ERL ledger | 24 KB |
| Notes | 44 KB (12 files) |
| **Total** | **129 KB** |

### "Just works" rating: ⚠️ Medium — `start-all.ps1` helps on Windows; macOS/Linux still manual
### Multi-bot invocation: ✅ Yes — `_twin_demo.mjs` and `_triad_demo.mjs`

---

## twin-flames4 (v0.9)

**Zip:** `twin-flames4.zip`  
**Snapshot time:** 2026-05-04 ~23:36  
**Type:** Code release snapshot  
**Repo version:** v0.9

### What it is
`launch.mjs` arrives — a cross-platform single-command stack launcher. Node ≥ 18 version guard, auto-`npm install` on first run, colour-coded process output, clean Ctrl+C shutdown via SIGTERM propagation. `start.bat` and `start.sh` added as double-click shortcuts. macOS and Linux users can now use the full stack for the first time.

### Key files added vs v0.8
| File | Purpose |
|------|---------|
| `launch.mjs` | Cross-platform launcher — starts all 3 servers + wuwei daemon |
| `start.bat` | Windows double-click shortcut → `node launch.mjs` |
| `start.sh` | macOS/Linux shell shortcut → `node launch.mjs` |

### launch.mjs options
```
node launch.mjs              # start everything
node launch.mjs --no-proxy   # skip coord-proxy (LM Studio not running)
node launch.mjs --status     # probe ports only
node launch.mjs --help
npm start / npm run status
```

### Context bloat
Identical to v0.8 — **129 KB**

### "Just works" rating: ✅ Medium-high — `node launch.mjs` on any OS; LM Studio must be pre-running with model loaded
### Multi-bot invocation: ✅ Yes — same demo scripts as v0.8

---

## twin-flames5 (v0.10)

**Zip:** `twin-flames5.zip`  
**Snapshot time:** 2026-05-04 ~23:38  
**Type:** Code release snapshot  
**Repo version:** v0.10

### What it is
Quality-of-life improvement to `launch.mjs`: `--load-model MODEL_ID` lets you ask LM Studio to load a specific model programmatically via the LM Studio REST API, and `--status` now reports which models are actually loaded in LM Studio (not just whether the port is responding). Meaningfully reduces the "did it actually start?" debugging loop. `launch.mjs` grows from 11 KB → 14 KB.

### Key changes vs v0.9
- `launch.mjs` adds `--load-model MODEL_ID` flag (calls LM Studio `lms load` API)
- `--status` now lists loaded models, not just port liveness
- Prerequisites section added to README

### launch.mjs options added
```
node launch.mjs --load-model MODEL_ID   # trigger LM Studio to load a specific model
node launch.mjs --status                # probe ports + show which models are loaded
```

### Context bloat
Identical to v0.8/v0.9 — **129 KB**

### "Just works" rating: ✅ High — best standalone version before installer
### Multi-bot invocation: ✅ Yes — same demo scripts as v0.8

---

## pre-easy (v0.11)

**Zip:** `pre-easy.zip`  
**Snapshot time:** 2026-05-05 ~00:20  
**Type:** Code release snapshot  
**Repo version:** v0.11 (pre-release of "Easy by zCHG.org")

### What it is
Zero-to-running installer. `install.mjs` handles the entire setup chain on a fresh machine. Package renamed from `local-mcp` to `easy-zchg`. `INSTALL.bat` is the Windows double-click entry point; `install.sh` for macOS/Linux. The "Easy" branding signals this is being prepared for public distribution.

### What `install.mjs` does automatically
1. Checks Node.js ≥ 18
2. Runs `npm install`
3. Detects/installs LM Studio (Windows: silent NSIS; macOS: DMG mount + cp; Linux: AppImage)
4. Downloads Qwen3.5-9B-UD-Q2_K_XL GGUF (~4.3 GB) from HuggingFace
5. Imports model via `lms import`
6. Starts LM Studio server via `lms server start`
7. Loads model via `lms load`
8. Launches full MCP stack via `launch.mjs`

### Key files added vs v0.10
| File | Purpose |
|------|---------|
| `install.mjs` | Full zero-to-running installer |
| `install.sh` | macOS/Linux install entry point |
| `INSTALL.bat` | Windows install entry point |
| `install-bootstrap.ps1` | PowerShell bootstrap (Node install fallback) |

### install.mjs options
```
node install.mjs                  # full install + launch
node install.mjs --no-launch      # install only, don't start stack
node install.mjs --skip-model     # skip 4 GB GGUF download
node install.mjs --status         # show what's installed, what's missing
```

### Known friction points
- 4.3 GB model download will fail on corporate firewalls / metered connections
- LM Studio silent install may not work on ARM Linux or non-standard macOS setups
- `install.mjs` does not verify available disk space before downloading

### Context bloat
Identical to v0.8–v0.10 — **129 KB**

### "Just works" rating: ✅✅ Highest — `INSTALL.bat` or `bash install.sh` on a fresh machine
### Multi-bot invocation: ✅ Yes — same demo scripts as v0.8

---

## Feature Matrix

| Zip | Version | Single Server | Dual Server | Coord Proxy | HDGL Daemon | launch.mjs | install.mjs | Demo Scripts | Multi-bot Prompt | Context Bloat |
|-----|---------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---:|
| state1 | pre-v0.4 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 57 KB |
| state0 | pre-v0.4 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 66 KB |
| state2 | pre-v0.4 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 79 KB |
| wuwei-routing | v0.4 | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | 107 KB |
| wuwei-routing_2 | v0.5 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | 107 KB |
| twin-flames | v0.6 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | 107 KB |
| twin-flames2 | v0.7 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | 107 KB |
| twin-flames3 | v0.8 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | 129 KB |
| twin-flames4 | v0.9 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | 129 KB |
| twin-flames5 | v0.10 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | 129 KB |
| pre-easy | v0.11 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 129 KB |

---

## ERL Ledger Progression

| Zip | Entries | Branches |
|-----|---------|----------|
| state1 | 6 | session_context, task_analysis, conversation_absorption_05_04 |
| state0 | 6 | session_context, task_analysis, conversation_absorption_05_04 |
| state2 | 6 | session_context, task_analysis, conversation_absorption_05_04 |
| wuwei-routing | 6 | session_context, task_analysis, conversation_absorption_05_04 |
| wuwei-routing_2 | 6 | session_context, task_analysis, conversation_absorption_05_04 |
| twin-flames | 6 | session_context, task_analysis, conversation_absorption_05_04 |
| twin-flames2 | 6 | session_context, task_analysis, conversation_absorption_05_04 |
| twin-flames3 | **25** | + twin_flame_evals (8), triad_session (3) |
| twin-flames4 | 25 | (same as v0.8) |
| twin-flames5 | 25 | (same as v0.8) |
| pre-easy | 25 | (same as v0.8) |

---

## Recommended Starting Points

**I just want the simplest possible setup**
→ `state1` + `npm install && node server.js`

**I want single-server with knowledge base pre-loaded**
→ `state0` — compressed knowledge base already in `notes/MCP_SERVER_v3_knowledge.md`

**I want dual-LLM but already have LM Studio + model running**
→ `twin-flames5` (v0.10) — `node launch.mjs`, cleanest dual-server startup

**I want dual-LLM and to run the multi-bot demos**
→ `twin-flames3` (v0.8) or any later version — `node _twin_demo.mjs` or `node _triad_demo.mjs --question "..."`

**I want a completely fresh machine setup**
→ `pre-easy` (v0.11) — `INSTALL.bat` or `bash install.sh`, handles everything including LM Studio + model download

---

*Generated from zip inspection — all sizes and timestamps derived from archive metadata and internal file content.*
