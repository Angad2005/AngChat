# Local model library

Copy `.gguf` model files or Hugging Face model folders here, then use **Scan models/ folder** in AngChat. Large weights and download staging files are ignored by Git.

The backend library also supports importing a path outside this folder. GGUF files can be loaded in-process with optional `node-llama-cpp`, or served by llama.cpp `llama-server`. Hugging Face Transformers folders need conversion to GGUF or a separate compatible runtime.

AngChat does not ship llama.cpp binaries. Install a build for your operating system and CPU/GPU from the [official llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases), then either:

- add `llama-server` to the `PATH` used to start AngChat; or
- set `LLAMA_SERVER_PATH` in `backend/.env` to the executable path and restart AngChat.

With the setting blank, AngChat searches `PATH` for `llama-server` (or `llama-server.exe` on Windows). Check **Model library → Local inference runtime** to see whether it was found. Model weights stay in this folder and are ignored by Git.
