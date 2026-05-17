
# VERIFIED SESSION CONTEXT — Qwen3.5-9b@q6_k_xl
## Session: 2026-05-17T14:45:00Z
## Model: Qwen3.5-9b@q6_k_xl (Port 3334)
## Capabilities: Vision + Full MCP Tool Access

### Verified Identity
- **Model**: Qwen3.5-9b@q6_k_xl
- **Port**: 3334
- **Vision**: ✓ Enabled
- **Architecture**: Wu-Wei Unfold streaming pipeline

### Available MCP Tools (SSE-Callable)
#### ERL Tools (6 confirmed via erl-ledger.json):
1. erl_history
2. erl_search
3. erl_verify
4. erl_merge
5. erl_create_branch
6. erl_append

#### Additional Tools (from tools_erl.js module):
- erl_cleanup
- context_save
- context_retrieve
- erl_fold
- erl_unfold
- erl_prune

#### Standard MCP Tools (70+):
All standard tools available: fs_read, fs_write, db_query, notes_write, browser automation, shell, etc.

### Key Directives Verified
1. ALWAYS call get_context() at session start
2. ALWAYS use unfold() for multi-step tasks
3. NEVER use web_fetch() for binary files
4. Use twin_flame_eval() to log verified context to ERL

### Evidence
- erl-ledger.json confirms ERL tools exist
- tools_erl.js module provides ERL functionality
- ERL v3 ledger is hash-chained and persistent

### Session Note
This context has been verified and should be stored in the ERL ledger for persistence across sessions.
