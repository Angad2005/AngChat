# Contributing to AngChat Harness

## Development

1. Install Node.js 18 or newer.
2. Copy `backend/.env.example` to `backend/.env`.
3. Run `npm install` from the repository root.
4. Start the app with `npm run dev`.
5. Open `http://localhost:3000`.

## Provider work

Provider-specific code belongs in `backend/providers.js`. Keep the browser provider-neutral. API keys must stay on the server and must never be returned by `/api/settings`.

## Pull requests

- Keep changes focused and portable across Windows, macOS, and Linux.
- Do not commit `.env` files, API keys, database files, or generated dependencies.
- Run `npm test` before opening a pull request.
- Update `Readme.md` when adding a user-visible capability.
