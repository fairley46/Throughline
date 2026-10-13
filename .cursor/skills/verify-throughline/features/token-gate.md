# Token gate

`/model.json` requires the process access token. Requests without it get HTTP 403. The HTML shell itself is not gated.

## Sub-features

- `gate-allow` returns 200 for `/model.json?token=<token>`.
- `gate-deny` returns 403 for `/model.json` with no token.

## How to get to it (user POV)

- Start `pnpm run dashboard` and use or omit the `?token=` from the printed URL.
- Call `/model.json` directly with curl.

## Driving it with curl

Preconditions:

- Dashboard is listening on `127.0.0.1:4317` with `THROUGHLINE_ACCESS_TOKEN=verifytoken`.

- **Allow.** `curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:4317/model.json?token=verifytoken'` → `200`.
- **Deny.** `curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:4317/model.json'` → `403`.
- **Proof.** Capture both status codes in the verification log or doctor output.

## Gotchas

- The root HTML page returns 200 even without a token. Assert on `/model.json`, not `/`.
- Token is per process. Restarting the server without the env override mints a new random token.
