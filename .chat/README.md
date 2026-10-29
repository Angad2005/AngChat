# Chat project state

This directory is the local-first project workspace for Chat. Keep reusable, non-secret project knowledge in `brain/`; personal context and run traces are local-only and ignored by Git.

## Current foundation

- `brain/MEMORY.md` and `brain/USER.md` are loaded into assistant context when present.
- Searchable memories and skill definitions are stored in the local SQLite database using FTS5.
- Nebius Token Factory is supported as an OpenAI-compatible provider.
- `chat verify` runs the configured, named verification scripts and emits measured pass/fail results.
- Run history and tool activity are persisted by the existing local backend.
- Execution traces can be enabled explicitly with `CHAT_CAPTURE_TRACES=1`; capture is off by default.

The current app does not yet create speculative worktrees, maintain a code property graph, run remote verification engines, or distill models. Those capabilities require separate local/cloud infrastructure and are not simulated here.
