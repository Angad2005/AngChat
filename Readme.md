# AngChat Harness

AngChat is a self-hosted chat harness for hosted APIs and local models. The browser UI uses a plain HTML/JavaScript frontend; an Express backend handles provider calls, in-process GGUF inference, an agent tool loop, SQLite chat history, account administration, and model-library operations.

## Run

Requirements: Node.js 18 or newer and npm.

```bash
npm install
cp backend/.env.example backend/.env
npm start
```

On Windows PowerShell, use `Copy-Item backend/.env.example backend/.env`. Open <http://localhost:3000>.

Chat and the model library work without an account. The first account created from **Sign in → Create the administrator account** becomes the administrator. Administrators can create additional accounts at `/admin`.

## Model inference

The harness can run a model in several ways:

1. **In-process GGUF:** activating a `.gguf` file loads it inside the Node process with optional `node-llama-cpp`. No extra server is required once that library is installed (`npm install` in `backend/` tries to add it).
2. **llama.cpp server:** if in-process inference is unavailable, activating a GGUF can spawn loopback-only `llama-server` when that binary is on `PATH` or `LLAMA_SERVER_PATH` is set.
3. **Ollama:** choose the Ollama provider (default `http://127.0.0.1:11434`) and set the Ollama model name.
4. **Hosted APIs:** OpenAI-compatible, Anthropic, or Google Gemini.
5. **Mock:** returns an explicit message that no model was called.

AngChat does not bundle llama.cpp binaries. Hugging Face Transformers folders need conversion to GGUF or a compatible external runtime.

The Model library page reports whether in-process inference is loaded, whether `llama-server` was found, and whether a managed runtime is running.

## Harness features

- Multi-turn chat: the last messages in the session are sent with each run, not only the latest prompt.
- Streaming: the UI reads server-sent events and can stop generation.
- Agent tools: App mode can read, list, and search the workspace. Code mode can also write files and run a timed shell command in the project directory. Secrets such as `backend/.env` and the SQLite database are blocked.
- Attachments: text, Markdown, CSV, JSON, XML, YAML, TOML, and log files up to 100 KB.

## Connect a provider

Open **Settings**, choose a provider, set its model ID and any required endpoint or key, save, then use **Test connection**. Provider, endpoint, generation, tool, and inference-engine settings are saved in SQLite. API keys stay in backend process memory and are never returned by the settings endpoint. To retain a key across server restarts, configure `LLM_API_KEY` in `backend/.env`.

| Provider | Endpoint |
| --- | --- |
| Local (in-process or OpenAI-compatible) | In-process ignores the URL; otherwise a `/v1` URL, default `http://127.0.0.1:8080/v1` |
| Ollama | Default `http://127.0.0.1:11434` |
| OpenAI-compatible API | Defaults to OpenAI's API; custom compatible endpoints are supported |
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
- Provider API keys and Hugging Face tokens are not stored in SQLite. Provider keys can be configured in `.env` to survive a restart.
- Workspace tools stay inside the project directory and skip secrets, `node_modules`, Git metadata, and model weights. Shell commands are timed out after 20 seconds.
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
  .env.example          Backend configuration template
  chat.db               Created at runtime; ignored by Git
models/                 Local model library; weights ignored by Git
public/
  First.html            Chat, model library, and settings pages
  Login.html            Working local sign-in and initial administrator setup
  Admin.html            Account administration and CSV export
```
