# AngChat

**Repo → patch → proof.** AngChat is a repository-aware coding agent for the **Coding and Agentic Engineering** track. It uses NVIDIA Nemotron through Nebius Token Factory to inspect a selected codebase, make focused edits, and run the project’s configured checks. Each verification run writes a JSON receipt with the task, scripts, outcomes, durations, and output; agent-triggered receipts also record the provider and model used for that run. Judges can inspect concrete evidence instead of relying on an agent’s claim that a change works.

The repo remains in the selected workspace. File contents returned to the agent are sent to the configured model provider; verification scripts run locally. AngChat supports streaming, persistent sessions, Git status and diff inspection, workspace-bounded file tools, and local verification receipts. The project is MIT-licensed and uses the existing cross-platform Node.js stack. It also retains optional local GGUF inference, searchable memory, skills, and opt-in execution traces.

## Hackathon build

**Track:** Coding and Agentic Engineering.

**Problem:** coding agents can produce plausible patches without showing whether the repository’s own checks pass. AngChat makes verification a first-class step in the agent loop and saves the result as a reviewable artifact.

**Who it helps:** developers and small teams reviewing AI-assisted changes. They need the patch, the repository’s own check output, and a clear record of which model and task produced that evidence.

**How the demo works:** select a repository and ask AngChat to fix a failing behavior. It inspects the source, tests, and Git changes; records the failing baseline; makes a focused patch; runs the repository’s configured checks; and, when needed, iterates on related failures. The app shows each verification result as it happens. `verify_project` only selects the named `test`, `lint`, `typecheck`, and `build` scripts, then records actual output, exit status, duration, task, and provider/model in `.chat/receipts/`. Review the final Git diff beside that evidence.

**Hackathon model:** NVIDIA Nemotron 3.5 Lightning through Nebius Token Factory. The current model ID and Token Factory endpoint are prefilled by **Settings → Fill Nebius + Nemotron**. The model is served through Nebius’s OpenAI-compatible API; see the [Nebius Nemotron model page](https://nebius.com/services/token-factory/models/nvidia-nemotron-models-inference).

**Submission description draft:** *AngChat is a coding agent that turns repository tasks into inspectable, tested patches. NVIDIA Nemotron on Nebius Token Factory plans and edits code through workspace-bounded tools. After a change, AngChat runs the repository’s configured checks locally and saves a JSON verification receipt with the scripts, results, timings, and output. This gives developers a concrete signal to review alongside the final Git diff.*

**Three-minute demo outline:** show the selected repository and Nebius/Nemotron model; submit one small coding task; show the model’s file inspection and edits; run `verify_project`; open the receipt and compare it with the Git diff. Keep the demo on a real repository with a repeatable task and visible checks.

Three ready-to-use demo repositories, copy-ready prompts, and a timed video workflow are in [`demo-repos/README.md`](demo-repos/README.md). Each repo starts from a clean Git commit with an intentional failing check, so AngChat can produce a focused diff and verification receipt.

The [hackathon video script and submission checklist](HACKATHON-DEMO-SCRIPT.md) include the narration, screen actions, project description, and a factual summary of the work completed during the submission period.

**Submission items to complete:** publish the repository with this MIT license and setup guide, host a working demo URL, and upload a public YouTube demo of three minutes or less. Include the required track and project description in the submission form. Add honest feedback on Nebius Token Factory and NVIDIA Nemotron after trying the build. If this project predates the submission period, describe which AngChat workflow, verification feature, and Nebius/Nemotron integration were added during that period.

## Deploy to Cloudflare

The Cloudflare deployment runs the existing Node.js application in a **Cloudflare Container**, fronted by a Worker and a Durable Object. Deployment commands require Node.js 22 or newer, a Workers Paid account, a Docker-compatible engine for image builds, and a custom hostname protected by a Cloudflare Access self-hosted application. The Worker validates Access JWT signatures and audience on every request; it fails closed if Access is missing or misconfigured. Do not remove that gate: Code mode can edit files and run shell commands in the container.

1. Install dependencies and authenticate Wrangler:

   ```bash
   npm install
   npx wrangler login
   ```

2. Configure the secrets used by the Worker and container:

   ```bash
   openssl rand -hex 32 | npx wrangler secret put CHAT_GATE_SECRET
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
   npx wrangler secret put LLM_API_KEY
   ```

   `CHAT_GATE_SECRET` authenticates the Worker-to-container hop, and `SESSION_SECRET` signs app session cookies; keep both private and stable across deploys. `LLM_API_KEY` is optional if you configure the model from Settings instead. Set `LLM_PROVIDER`, `LLM_MODEL`, and `LLM_BASE_URL` in `wrangler.jsonc` to select the initial model; the example values use Nebius Token Factory.
3. Build and deploy the Worker and container image. Until Access is configured, the Worker fails closed and returns HTTP 503:

   ```bash
   npm run cloudflare:deploy
   ```

4. In Cloudflare Workers & Pages, attach the custom hostname to `angchat-demo`. Create a Cloudflare Access self-hosted application for that hostname and set its policy to allow only the intended demo users' email addresses. Copy the Access team domain and application AUD tag into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`, then redeploy. Use the Access-protected URL to test the app; direct requests without a valid Access JWT receive HTTP 401.

The Durable Object routes all requests to one `basic` (1/4 vCPU, 1 GiB RAM, 4 GB disk) container. Persisted session, agent-run, verification, settings, workspace, memory, skill, and account changes are streamed through to the app and then snapshot the writable container filesystem, including SQLite data and project changes. Snapshots have Cloudflare's documented 30-day retention; restoring refreshes that retention. This is suitable for a small demo, not a backup strategy: export important work separately, and test snapshot restoration before relying on it. The container needs outbound Internet access for hosted model APIs. Local GGUF model downloads and inference are not part of this deployment.

For local Worker/container development, run `npm run cloudflare:dev` with Docker available. The Worker intentionally requires an Access JWT, so validate the full login flow after deploying behind the configured Access application.

## Deploy to Render

The Render Blueprint in [`render.yaml`](render.yaml) deploys the Node.js app as a Docker web service with a persistent `/data` disk for the SQLite database, created skills, and editable project workspace. It uses one paid `1c-2g` instance because Render disks are single-instance and do not support zero-downtime deploys. The app process runs as the unprivileged `node` user; the container entrypoint prepares the disk and seeds the initial workspace only once.

1. Push this repository to a Git provider connected to Render, then create a new Blueprint from the repository and apply `render.yaml`. To use the preconfigured Nemotron model, set `LLM_API_KEY` in the service's **Environment** page. Alternatively, leave it unset and choose/configure a provider later in **Settings**.
2. After the service is live, open its `onrender.com` URL. Render generates `DEMO_BASIC_USER` and `DEMO_BASIC_PASSWORD`; find these values in the service's **Environment** page and share them only with trusted demo users. Basic Auth protects every app route except `/api/health`. Everyone using the shared credentials accesses the same app data and project workspace; this is a single-user demo, not a multi-tenant deployment. Keep the credentials private: Code mode can edit files and run shell commands in the persistent workspace.
3. Configure or rotate the model key from the Render service's **Environment** page (`LLM_API_KEY`), then redeploy. Provider, model, and project changes are saved in the persistent database/disk. The workspace starts as a copy of the app source and remains on `/data/workspace`; project paths outside `/data` are rejected so edits survive deploys.

Render's disk retains database and project changes across deploys, but the service is single-instance and briefly unavailable during redeploys. The disk is not a substitute for exporting important work or keeping a repository backup. The `1c-2g` service plan and persistent disk are paid Render resources.

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

For the hackathon build, set these values in `backend/.env`, or use the settings preset and enter your API key in the app:

```dotenv
LLM_PROVIDER=nebius
LLM_MODEL=nvidia/Nemotron-3_5-Lightning
LLM_BASE_URL=https://api.tokenfactory.nebius.com/v1
LLM_API_KEY=your_nebius_token_factory_key
```

Mock mode is useful for checking the interface but does not satisfy the hackathon model requirement. Use a real Nebius Token Factory key and confirm the connection in **Settings → Test connection** before recording the demo.

Choose the repository to demo in **Settings → Project files**. For a repeatable demo, start with a small task whose expected behavior is clear and whose `test` script runs locally. The code snippets the agent reads are sent to Nebius for inference; the verifier runs in the app process on the workspace machine.

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
4. **OpenAI-compatible local endpoints:** choose **Local (in-process or OpenAI-compatible)** for LM Studio, llama.cpp server, or another compatible endpoint. LM Studio's default server URL is `http://127.0.0.1:1234/v1`; set the model ID shown by LM Studio. If LM Studio server authentication is enabled, enter its API key in Settings or set `LLM_API_KEY` in `backend/.env`; Chat sends it as a Bearer token. Leave it blank when authentication is disabled. In-process GGUF inference does not send an API key.
5. **Hosted APIs:** choose OpenAI-compatible, Anthropic, or Google Gemini.
6. **Mock:** returns an explicit message that no model was called.

Chat does not bundle llama.cpp binaries. Hugging Face Transformers folders need conversion to GGUF or a compatible external runtime.

The Model library page reports whether in-process inference is loaded, whether `llama-server` was found, and whether a managed runtime is running.

## Harness features

- Multi-turn chat: the last messages in the session are sent with each run, not only the latest prompt.
- Streaming: the UI reads server-sent events and can stop generation.
- Agent tools: App mode can read, list, and search the workspace. Code mode can also write files and run a timed shell command in the project directory. Secrets such as `backend/.env` and the SQLite database are blocked.
- Project selection: type an absolute server-side directory or use **Browse folders** under **Settings → Project files** to navigate and select it. The project root is saved with private permissions in the ignored `.chat/workspace.local.json` file and used as the current directory and filesystem boundary for tools. `CHAT_WORKSPACE` overrides the saved path at startup.
- Claude Code-style tools in Code mode: `glob`, `grep`, `read_file`, `list_dir`, `edit_file`, `write_file`, `bash`, `git_status`, and `git_diff`. Each agent run can use up to 24 model/tool rounds (previously 12). Existing `search_files`, `patch_file`, and `run_command` names remain available. Editing rejects ambiguous matches; Git inspection is read-only.
- Local safety: the server binds to `127.0.0.1` by default, and project-backed agent runs and project-path changes reject non-loopback requests. Code-mode shell commands run with the backend process user's OS permissions; use only with trusted prompts and projects. Set `HOST` only when intentionally changing the listener address.
- Code mode also loads root `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, and `.github/copilot-instructions.md` files as project instructions when present.
- Attachments: text, Markdown, CSV, JSON, XML, YAML, TOML, and log files up to 100 KB.
- Local verification: `chat verify` runs configured `test`, `lint`, `typecheck`, and/or `build` package scripts and reports actual pass/fail results. The default configuration runs the project's tests.
- Privacy-first traces: run traces are off by default. Set `CHAT_CAPTURE_TRACES=1` to write local prompt/response records and tool names under `.chat/traces/`; generated trace files are ignored by Git.

## Connect a provider

Open **Settings**, choose a provider, set its model ID and any required endpoint or key, save, then use **Test connection**. Provider, endpoint, generation, tool, and inference-engine settings are saved in SQLite. API keys stay in backend process memory and are never returned by the settings endpoint. To load keys automatically at startup, put them in `backend/.env`: use `LLM_API_KEY` for the provider named by `LLM_PROVIDER`, or provider-specific names such as `OPENAI_API_KEY`, `NEBIUS_API_KEY`, `NINE_ROUTER_API_KEY`, `NVIDIA_NIM_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY`. If the configured provider is `mock` and exactly one provider-specific API key is present, AngChat selects that provider automatically at startup. The configured environment provider also replaces a previously saved `mock` selection. Provider-specific keys are picked up when switching providers in Settings.

If Settings has a local or Ollama provider selected and that endpoint is unavailable, AngChat automatically tries the hosted provider configured by `LLM_PROVIDER` in `backend/.env`, provided its API key is configured. A working local provider remains primary. NVIDIA NIM can be selected as **NVIDIA NIM** or configured with `LLM_PROVIDER=nvidia` (`Nvidia-nim` is accepted as an alias); the default endpoint is `https://integrate.api.nvidia.com/v1`.

| Provider | Endpoint |
| --- | --- |
| Local (in-process or OpenAI-compatible) | In-process ignores URL and key; otherwise a `/v1` URL (LM Studio default: `http://127.0.0.1:1234/v1`; llama.cpp default: `http://127.0.0.1:8080/v1`). Optional API keys are sent as Bearer tokens. |
| Ollama | Default `http://127.0.0.1:11434` |
| OpenAI-compatible API | Defaults to OpenAI's API; custom compatible endpoints are supported |
| Nebius Token Factory | OpenAI-compatible API, default `https://api.tokenfactory.nebius.com/v1` |
| 9Router | OpenAI-compatible API, default `http://localhost:20128/v1`; copy the API key and a model ID from the 9Router dashboard |
| NVIDIA NIM | OpenAI-compatible API, default `https://integrate.api.nvidia.com/v1` |
| Anthropic | Anthropic Messages API |
| Google Gemini | Gemini generateContent API |
| Mock | Returns an explicit message that no model was called |

To connect 9Router, start it and open its dashboard, copy an API key and a model ID from its provider/model list, then select **9Router** in AngChat **Settings**. The default endpoint is `http://localhost:20128/v1`; enter the copied model ID and key, save, and choose **Test connection**. To keep the key across restarts, set `LLM_PROVIDER=9router`, `LLM_MODEL`, `LLM_BASE_URL`, and `LLM_API_KEY` in `backend/.env`. The model key is sent to 9Router as an OpenAI-compatible Bearer token and is not returned by AngChat's settings API.

If AngChat is deployed separately (for example on Render or Cloudflare), `localhost` refers to the AngChat container, not the computer running 9Router. Set the base URL to a private/reachable 9Router address or secured tunnel endpoint that the deployment can access, and protect that endpoint and key appropriately.

## Add and run local models

The Model library page supports three ways to register a local model:

1. **Hugging Face download:** enter a repository ID, look up its `.gguf` files, choose a quantization, and download that file. A Hugging Face read token is only sent with the lookup and download requests and is not saved.
2. **Copy into the library:** copy a `.gguf` file or a Hugging Face model folder into the repository's `models/` directory, then choose **Scan models/ folder**.
3. **Use an existing path:** paste a file or model folder path that the backend process can read and select **Add path**.

Model weights in `models/` are ignored by Git. The library accepts GGUF files, GGUF folders, and Hugging Face folders containing `config.json`.

## Backend API

- `GET /api/health`
- `GET /api/harness/config`; `GET /api/harness/tools`
- `POST /api/verification/run`; `GET /api/verification/receipts`
- `GET, PUT /api/workspace` (loopback requests only; selects a local project directory)
- `GET /api/workspace/directories` (loopback requests only; lists folders for the project picker)
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
