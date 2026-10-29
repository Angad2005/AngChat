# Digital Brain

The current brain combines the SQLite FTS5 memory and skill indexes with optional Markdown context files:

- `MEMORY.md` — project facts and durable lessons
- `USER.md` — preferences for this local workspace
- `cookbooks/` — reusable human- and agent-readable procedures
- `skills/` — documentation for the current database-backed skills

Avoid putting API keys or other credentials in these files. Context is included in model requests when relevant.
