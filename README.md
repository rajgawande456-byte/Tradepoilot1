# TradePilot AI — Step 79 Production API Boundary

This is a dependency-free Node.js reference boundary for the production backend.

## Run
`node backend/src/server.mjs`

## Endpoints
- `GET /health` — service health only.
- `GET /api/v1/me` — intentionally returns `401` until real server authentication is connected.
- `GET /api/v1/market/snapshot` — intentionally returns `503` when no verified market-data provider is configured; it never invents a live quote.

## Production rules
- Put credentials only in server secret storage/environment.
- Set `ALLOWED_ORIGINS` to exact production origins.
- Replace the market-data adapter with a verified provider and validate timestamp/freshness/sequence before returning data.
- Add real authentication, database ownership checks, subscription entitlements, billing webhook verification and persistent rate limiting before production launch.
