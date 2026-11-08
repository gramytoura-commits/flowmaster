# Flow Runner

## Coolify deployment

Deploy the repository's Dockerfile, expose container port 3000, and mount a persistent volume at `/app/data`. Set runtime `BROWSERLESS_TOKEN` and `APP_ORIGIN` (the exact public origin, including `https://`). The container binds to `0.0.0.0`; direct local runs still bind to loopback. `/health` provides a readiness check.

Enable Coolify HTTP Basic Authentication before exposing the app. Authentication is enforced by the proxy; do not publish container port 3000 directly. Keep API keys in Coolify runtime secrets, not build arguments or the repository.

Start with `node server.js`, then open http://127.0.0.1:3000. Set `PORT` to change the port. The server binds to this computer only. It runs registered Node scripts without a shell, with at most three concurrent runs and a ten-minute timeout.

The interface lets you choose a flow, fill its variables, inspect without submitting, review output, and stop a run. History survives restarts; runs active during a restart become `interrupted`.

## Configuration

The Browserless key is in the ignored `.env` file as `BROWSERLESS_TOKEN`. An existing environment variable takes priority. Install Playwright with `npm install` on other computers; this checkout can also use the bundled Codex Playwright runtime.

Run Inbox directly in PowerShell:

```powershell
$env:INBOX_USERNAME="yourname"
node flows/inbox.js
# Inspect without registering:
node flows/inbox.js --inspect
```

API runs write credentials to `data/runs/<run-id>/inbox-credentials.json`. Credentials are not served by the API. The original `inbox-credentials.json` is preserved at the project root. Direct command-line runs continue to use that root file; move it if registering a different username directly.

## API

- `GET /api/flows` — registered flows and input definitions.
- `POST /api/runs` — launch a flow; returns HTTP 202 and the run.
- `GET /api/runs` — run history and output.
- `GET /api/runs/<id>` — status and output of one run.
- `POST /api/runs/<id>/cancel` — stop a running flow.

```powershell
$body = @{ flowId = "inbox"; variables = @{ INBOX_USERNAME = "yourname" }; inspect = $true } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3000/api/runs -Method Post -ContentType application/json -Body $body
```

Statuses: `running`, `succeeded`, `failed`, `cancelled`, `timed_out`, `interrupted`. A succeeded process means the script exited zero; inspect runs do not create accounts. Logs are limited to the latest 100,000 characters. Local API clients need no authentication; cross-origin browser requests are rejected.

## Add a flow

1. Put a Node script in `flows/`.
2. Add a definition to `flows/registry.json` with a unique `id`, `name`, `description`, `script`, and `fields` array.
3. Each field has `name` (environment variable), `label`, and optional `required`, `pattern`, `secret`, and `placeholder`. Set `supportsInspect: true` only if the script handles `--inspect`.
4. Read inputs from `process.env`, write progress with `console.log`, use `process.env.FLOW_OUTPUT_DIR` for output files, and exit nonzero on failure. Do not log secrets.
5. Restart the server. The new flow appears automatically in the interface.

Run checks with `node --test test/server.test.js`. These use a local fixture and do not register real accounts.


## EmailBot integration
Set `EMAILBOT_INTEGRATION_KEY` to a random secret of at least 32 characters to enable backend-only integration endpoints. Keep Coolify proxy Basic Auth on public HTTPS. EmailBot additionally sends `X-Emailbot-Key`, numeric `X-Emailbot-Owner` and a stable `X-Emailbot-Request` when starting an Inbox run. Service run listing, status, cancellation, recovery and credential results are scoped to that owner.

`GET /api/emailbot/capabilities` advertises version 1. `GET /api/emailbot/requests/<request-id>` recovers an existing run. `GET /api/runs/<id>/result` returns credentials only for a succeeded, non-inspect Inbox run with a matching, regular `inbox-credentials.json` file whose status is exactly `registered`. These routes require the integration secret; public proxy credentials alone are insufficient. Credentials are never added to ordinary run metadata. The integration key is removed from child-process environments. Repeated owner/request IDs return the same run rather than starting signup again.

EmailBot's separate `FLOWMASTER.md` contains deployment order, required proxy credentials and the inbox.eu IMAP password activation caveat. Node tests use fake scripts and never create real mailboxes. Run `node --test test/*.test.js` to include the integration tests.
