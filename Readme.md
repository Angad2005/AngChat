# Chat Engineering Harness

Chat is a local-first engineering harness for hosted APIs and local models. The browser UI uses a plain HTML/JavaScript frontend; an Express backend handles provider calls, in-process GGUF inference, an agent tool loop, SQLite chat history and searchable memory, account administration, and model-library operations. Its Digital Brain lives under `.chat/brain/`: Markdown context files are loaded locally, while searchable memories and skills use SQLite FTS5. Existing root-level `MEMORY.md` and `USER.md` files remain readable for compatibility; new edits are stored in `.chat/brain/`.

The current implementation stays in the existing cross-platform Node.js stack. The repository is MIT-licensed and can be installed from source. Nebius Token Factory is available through its OpenAI-compatible API; select **Nebius Token Factory** in Settings, enter a model ID and API key, then test the connection. The project includes a usable local verification command, opt-in JSONL execution traces, and the local Digital Brain layout. Cloud bursting, Rust daemon/worktrees, ChromaDB/KùzuDB indexing, hardware profiling, shadow replay, and automated fine-tuning still require separate infrastructure and are not included.

## Run

Requirements: Node.js 18 or newer and npm. Run these commands from the repository root (`AngChat/`):

```bash
npm install
npm start
```

`npm start` launches the backend and serves the app at <http://localhost:3000>. Stop it with `Ctrl+C`. To restart the server automatically when backend files change, use `npm run dev` instead.

No `.env` file is required for a first run. The app starts with the `mock` provider, which does not call an AI model. To configure startup options or keep a provider API key across restarts, copy `backend/.env.example` to `backend/.env` and edit it:

```bash
cp backend/.env.example backend/.env
```

On Windows PowerShell, use `Copy-Item backend/.env.example backend/.env`. The file is read by the backend; for example, set `PORT` to change the listening port, or set `LLM_PROVIDER`, `LLM_MODEL`, and `LLM_API_KEY` for a provider. Keep `.env` private and do not commit it. Provider and generation settings can also be changed in the app's **Settings** page.

Useful root-level commands:

| Command | What it does |
| --- | --- |
| `npm install` | Installs the backend dependencies (including optional in-process GGUF support when available). |
| `npm start` | Starts the app normally. |
| `npm run dev` | Starts the app with Node's watch mode for backend development. |
| `npm test` | Runs backend syntax checks and tests. |
| `npm run chat -- --help` | Shows the local `chat` CLI commands. |
| `npm run chat --` | Starts the interactive terminal chat in App mode. |
| `npm run chat -- run --mode code` | Starts an interactive coding session with workspace tools. |
| `npm run chat -- verify` | Runs the verification scripts configured in `.chat/config.json`. |
| `npm run chat -- brain search "query"` | Searches local SQLite memory. |

After `npm install`, the CLI can also be run directly with `node bin/chat.js` (interactive) or `node bin/chat.js run --mode code`. It reads provider/model settings from the same local configuration as the web app, saves conversations to the same SQLite database, and starts in App mode unless `--mode code` or `--code` is specified. Enter `/help` inside the CLI for session, mode, tool, and project commands. Verification only runs named npm scripts from the project's package manifest; it does not execute remotely supplied command strings.

Chat and the model library work without an account. The first account created from **Sign in → Create the administrator account** becomes the administrator. Administrators can create additional accounts at `/admin`.

## Model inference

The harness can run a model in several ways:

1. **In-process GGUF:** activating a `.gguf` file loads it inside the Node process with optional `node-llama-cpp`. No extra server is required once that library is installed (`npm install` in `backend/` tries to add it).
2. **llama.cpp server:** if in-process inference is unavailable, activating a GGUF can spawn loopback-only `llama-server` when that binary is on `PATH` or `LLAMA_SERVER_PATH` is set.
3. **Ollama:** choose the Ollama provider (default `http://127.0.0.1:11434`) and set the Ollama model name.
4. **Hosted APIs:** OpenAI-compatible, Anthropic, or Google Gemini.
5. **Mock:** returns an explicit message that no model was called.

Chat does not bundle llama.cpp binaries. Hugging Face Transformers folders need conversion to GGUF or a compatible external runtime.

The Model library page reports whether in-process inference is loaded, whether `llama-server` was found, and whether a managed runtime is running.

## Harness features

- Multi-turn chat: the last messages in the session are sent with each run, not only the latest prompt.
- Streaming: the UI reads server-sent events and can stop generation.
- Agent tools: App mode can read, list, and search the workspace. Code mode can also write files and run a timed shell command in the project directory. Secrets such as `backend/.env` and the SQLite database are blocked.
- Project selection: choose an absolute server-side directory under **Settings → Project files**. The project root is saved with private permissions in the ignored `.chat/workspace.local.json` file and used as the current directory and filesystem boundary for tools. `CHAT_WORKSPACE` overrides the saved path at startup.
- Claude Code-style tools in Code mode: `glob`, `grep`, `read_file`, `list_dir`, `edit_file`, `write_file`, `bash`, `git_status`, and `git_diff`. Existing `search_files`, `patch_file`, and `run_command` names remain available. Editing rejects ambiguous matches; Git inspection is read-only.
- Local safety: the server binds to `127.0.0.1` by default, and project-backed agent runs and project-path changes reject non-loopback requests. Code-mode shell commands run with the backend process user's OS permissions; use only with trusted prompts and projects. Set `HOST` only when intentionally changing the listener address.
- Code mode also loads root `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, and `.github/copilot-instructions.md` files as project instructions when present.
- Attachments: text, Markdown, CSV, JSON, XML, YAML, TOML, and log files up to 100 KB.
- Local verification: `chat verify` runs configured `test`, `lint`, `typecheck`, and/or `build` package scripts and reports actual pass/fail results. The default configuration runs the project's tests.
- Privacy-first traces: run traces are off by default. Set `CHAT_CAPTURE_TRACES=1` to write local prompt/response records and tool names under `.chat/traces/`; generated trace files are ignored by Git.

## Connect a provider

Open **Settings**, choose a provider, set its model ID and any required endpoint or key, save, then use **Test connection**. Provider, endpoint, generation, tool, and inference-engine settings are saved in SQLite. API keys stay in backend process memory and are never returned by the settings endpoint. To retain a key across server restarts, configure `LLM_API_KEY` in `backend/.env`.

| Provider | Endpoint |
| --- | --- |
| Local (in-process or OpenAI-compatible) | In-process ignores the URL; otherwise a `/v1` URL, default `http://127.0.0.1:8080/v1` |
| Ollama | Default `http://127.0.0.1:11434` |
| OpenAI-compatible API | Defaults to OpenAI's API; custom compatible endpoints are supported |
| Nebius Token Factory | OpenAI-compatible API, default `https://api.tokenfactory.nebius.com/v1` |
| Anthropic | Anthropic Messages API |
| Google Gemini | Gemini generateContent API |
| Mock | Returns an explicit message that no model was called |

## Add and run local models

The Model library page supports three ways to register a local model:

1. **Hugging Face download:** enter a repository ID, look up its `.gguf` files, choose a quantization, and download that file. A Hugging Face read token is only sent with the lookup and download requests and is not saved.
2. **Copy into the library:** copy a `.gguf` file or a Hugging Face model folder into the repository's `models/` directory, then choose **Scan models/ folder**.
3. **Use an existing path:** paste a file or model folder path that the backend process can read and select **Add path**.

Model weights in `models/` are ignored by Git. The library accepts GGUF files, GGUF folders, and Hugging Face folders containing `config.json`.

## Backend API

- `GET /api/health`
- `GET /api/harness/config`; `GET /api/harness/tools`
- `GET, PUT /api/workspace` (loopback requests only; selects a local project directory)
- `GET, PUT /api/settings`
- `POST /api/provider/test`
- `GET, POST /api/sessions`; `GET /api/sessions/:id/messages`; `PATCH, DELETE /api/sessions/:id`
- `POST /api/harness/run` (JSON or `stream: true` SSE)
- `GET /api/models`; `POST /api/models/import`, `/api/models/scan`, `/api/models/download`; `POST /api/models/:id/activate`, `/api/models/runtime/stop`; `DELETE /api/models/:id`
- `POST /api/huggingface/files`; `GET /api/models/download/:id`; `GET /api/models/runtime`
- `POST /api/login`, `/api/signup`, `/api/logout`
- Admin-only: `GET, POST /api/users`; `PUT, DELETE /api/users/:id`

## Data and security

- SQLite stores account records, sessions, messages, provider settings (without keys), and model-library metadata. Passwords are salted scrypt hashes; existing plaintext demo passwords are upgraded after a successful login.
- Local context files are written to `.chat/brain/`; memory and skill search stays in the local SQLite database. Opt-in `.chat/traces/*.jsonl` records are ignored by Git.
- Provider API keys and Hugging Face tokens are not stored in SQLite. Provider keys can be configured in `.env` to survive a restart.
- Workspace tools stay inside the project directory and skip secrets, `node_modules`, Git metadata, and model weights. Shell commands are timed out after 20 seconds.
- The project-path API accepts requests only from loopback clients. The path is canonicalized, symlinks are checked against the selected project boundary, and common credential files are blocked from file tools. Shell execution is intentionally available only in Code mode and remains a powerful local operation.
- The server defaults to port 3000 and binds to all network interfaces. Use it on a trusted network; place it behind HTTPS and appropriate access controls before exposing it publicly.

## Project layout

```text
backend/
  db.js                 SQLite connection
  index.js              HTTP API, sessions, account routes
  harness.js            Agent loop, streaming, session runs
  inference.js          In-process GGUF loading and completion
  tools.js              Workspace tools and sandboxing
  models.js             Model library, Hugging Face downloads, llama.cpp lifecycle
  providers.js          Hosted, Ollama, and local model adapters
  verification.js       Deterministic local npm-script verification gates
  traces.js             Opt-in local JSONL execution trace capture
  .env.example          Backend configuration template
  chat.db               Created at runtime; ignored by Git
.chat/
  config.json           Local verification script selection
  brain/                Markdown brain, cookbooks, and skill guidance
  traces/               Opt-in execution traces; ignored by Git
bin/
  chat.js               Local verification and brain-search CLI
models/                 Local model library; weights ignored by Git
public/
  First.html            Chat, model library, and settings pages
  Login.html            Working local sign-in and initial administrator setup
  Admin.html            Account administration and CSV export
```
