# zkLogin demo

Proves the elder's sign-in flow: Google account in, Sui address out, no
seed phrase at any point.

    npm start          # builds and serves on http://localhost:3000

Reads `GOOGLE_CLIENT_ID` and `NEXT_PUBLIC_ENOKI_API_KEY` from the repo
root `.env` and serves them at `/config.json`. Both are public values by
design. `ENOKI_PRIVATE_KEY` is deliberately never read here — it belongs
server-side only.

## Enoki portal setup (both are required)

`invalid_client_id` means one of these is missing:

1. **Settings -> Allowed Origins:** `http://localhost:3000`
   Origin only — no path, no trailing slash.
2. **Auth Providers -> Google:** the same client ID that is in `.env`.
   Enoki validates the `aud` claim against this list; having it in `.env`
   tells Enoki nothing.

## Gotcha that cost us an hour

The derived address is on `flow.$zkLoginState`, **not** on
`flow.getSession()`. The session carries the ephemeral keypair and JWT;
the address, salt and public key are set separately by
`handleAuthCallback`. Reading the wrong one looks exactly like a failed
login — "Signed out", no error.

Also: `handleAuthCallback()` returning `null` is normal. It returns the
OAuth `state` parameter, which this flow never sets.

Verified address (testnet):
`0x79127dc174faace8404c4be9d0ccdf882dc1ba1efc5195da05bbfa3fa759ea83`
