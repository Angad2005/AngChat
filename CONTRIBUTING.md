# Contributing to AngChat

## Development

1. Install Node.js 18 or newer.
2. Run `npm install` from the repository root.
3. Start the app with `npm run dev`.
4. Open `http://localhost:3000`.
5. Run `npm test` and `npm run chat -- verify` before submitting changes.

The app starts in Mock mode without credentials. Copy `backend/.env.example` only when you need persistent local settings. Never commit secrets, user databases, model weights, or generated traces.

## Provider work

Provider-specific code belongs in `backend/providers.js`. Keep the browser provider-neutral. API keys must stay on the server and must never be returned by `/api/settings`.

## Pull requests

- Keep changes focused and portable across Windows, macOS, and Linux.
- Do not commit `.env` files, API keys, database files, or generated dependencies.
- Run `npm test` before opening a pull request.
- Update `Readme.md` when adding a user-visible capability.
- Keep verification scripts limited to the supported names in `.chat/config.json`.
- Run traces are opt-in and may contain private prompts and model responses; do not attach or publish them without reviewing and redacting them.
