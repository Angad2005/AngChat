# AngChat Harness

AngChat is a self-hosted chat harness for hosted APIs and local models. The browser UI uses a plain HTML/JavaScript frontend; an Express backend handles provider calls, SQLite chat history, account administration, and model-library operations.

## Run

Requirements: Node.js 18 or newer and npm.

```bash
npm install
cp backend/.env.example backend/.env
npm start
```

On Windows PowerShell, use `Copy-Item backend/.env.example backend/.env`. Open <http://localhost:3000>.

Chat and the model library work without an account. The first account created from **Sign in → Create the administrator account** becomes the administrator. Administrators can create additional accounts at `/admin`.

## Connect a provider

Open **Settings**, choose a provider, set its model ID and any required endpoint or key, save, then use **Test connection**. Provider, endpoint, and generation settings are saved in SQLite. API keys stay in backend process memory and are never returned by the settings endpoint. To retain a key across server restarts, configure `LLM_API_KEY` in `backend/.env`.

Available providers:

| Provider | Endpoint |
| --- | --- |
| Local OpenAI-compatible | Local server URL ending in `/v1`; defaults to `http://127.0.0.1:8080/v1` |
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

For automatic GGUF inference, install a llama.cpp build that includes `llama-server` from the [official release page](https://github.com/ggml-org/llama.cpp/releases) or build it for your machine. Add `llama-server` to `PATH`, or set `LLAMA_SERVER_PATH` in `backend/.env` to the executable path, then restart AngChat. AngChat discovers the executable on `PATH` when the setting is blank. Activating a GGUF then starts a loopback-only server for that model, and the selected AngChat-managed model is resumed after an AngChat restart.

AngChat does not bundle llama.cpp. Its binaries vary by operating system, CPU/GPU backend, and hardware, and are maintained separately from this project. Keeping the runtime optional avoids shipping the wrong build and lets users install only the backend they can run. The Model library page reports whether AngChat can find `llama-server` and whether its managed server is running.

Alternatively, start your own runtime (for example, an OpenAI-compatible local server) and set its `/v1` URL in Settings. Activating a model selects it in AngChat; it does not claim to load weights into an external runtime. Hugging Face Transformers folders require a compatible external runtime unless you convert them to GGUF and use llama.cpp.

The local model route calls `/chat/completions` on the configured OpenAI-compatible endpoint. Mock mode is opt-in and never pretends to return a real model answer.

## Chats and attachments

Sessions and messages are saved to `backend/chat.db`. Text, Markdown, CSV, JSON, XML, YAML, TOML, and log files up to 100 KB can be attached to a prompt. The attachment text is sent to the selected provider and stored with the conversation.

App and Code modes adjust the system instructions. Code mode does not itself provide filesystem, shell, or repository tools; attach relevant files when you need the model to use project context.

## Backend API

- `GET /api/health`
- `GET, PUT /api/settings`
- `POST /api/provider/test`
- `GET, POST /api/sessions`; `GET /api/sessions/:id/messages`; `PATCH, DELETE /api/sessions/:id`
- `POST /api/harness/run`
- `GET /api/models`; `POST /api/models/import`, `/api/models/scan`, `/api/models/download`; `POST /api/models/:id/activate`, `/api/models/runtime/stop`; `DELETE /api/models/:id`
- `POST /api/huggingface/files`; `GET /api/models/download/:id`; `GET /api/models/runtime`
- `POST /api/login`, `/api/signup`, `/api/logout`
- Admin-only: `GET, POST /api/users`; `PUT, DELETE /api/users/:id`

## Data and security

- SQLite stores account records, sessions, messages, provider settings (without keys), and model-library metadata. Passwords are salted scrypt hashes; existing plaintext demo passwords are upgraded after a successful login.
- Provider API keys and Hugging Face tokens are not stored in SQLite. Provider keys can be configured in `.env` to survive a restart.
- The server defaults to port 3000 and binds to all network interfaces. Use it on a trusted network; place it behind HTTPS and appropriate access controls before exposing it publicly.
- Account management is intended for a trusted, self-hosted instance. Add an established authentication and authorization layer before public deployment.

## Project layout

```text
backend/
  db.js                 SQLite connection
  index.js              HTTP API, sessions, account routes
  models.js             Model library, Hugging Face downloads, llama.cpp lifecycle
  providers.js          Hosted and local model adapters
  .env.example          Backend configuration template
  chat.db               Created at runtime; ignored by Git
  models/                 Local model library; weights ignored by Git
public/
  First.html            Chat, model library, and settings pages
  Login.html             Working local sign-in and initial administrator setup
  Admin.html             Account administration and CSV export
```
