# HomeNex

AI-powered WhatsApp-native lead management for Indian real estate brokers.

**Every lead answered in 30 seconds. Even at 2 AM.**

Buyers only ever see WhatsApp. HomeNex is the broker's dashboard: every buyer who messages your
WhatsApp Business number becomes a lead — answered by AI in seconds, BLTC-qualified
(Budget · Location · Timeline · Configuration), scored, and handed to you when it matters.

**Multi-agent.** Any number of brokers register with their own WhatsApp number (name + number +
password — one screen). The single Meta webhook receives messages for every number and routes each
one to the agent whose business number received it (`value.metadata.display_phone_number`). Each
agent only ever sees their own leads, conversations, stats and matches; AI replies go out from that
agent's number (`phone_number_id` is learned from the first inbound webhook).

## Architecture

- **`server/`** — Node.js + Express, PostgreSQL persistence (`pg` with connection pooling;
  versioned SQL migrations in `server/migrations/` run automatically on startup).
  - `POST /webhook` — real Meta WhatsApp Business webhook: verifies `X-Hub-Signature-256`,
    stores the inbound message, generates an AI reply via OpenRouter, sends it back over the
    WhatsApp Cloud API, then runs a structured BLTC extraction that scores the lead.
  - Dashboard API: leads, conversations, live stats, activity, co-broking board — all read from PostgreSQL.
  - CRM schema: contacts, leads (pipelines/stages), properties, site visits, follow-ups,
    commissions, message templates, audit logs. All money is stored in paise (integers);
    every agent-owned table carries `agent_id` for multi-tenancy.
  - `POST /api/leads/:id/reply` — agent sends a real WhatsApp message from the dashboard.
  - `POST /api/leads/:id/ai` — take over a chat from the AI / hand it back.
  - Serves the built dashboard (`dist/`) so one process hosts everything.
- **Root** — the broker dashboard (React + Vite + Tailwind 4): Today, Leads, Inbox, Network, Insights.
  All tabs poll the real API; there is no mock data.

## Run

```bash
# 0. PostgreSQL (Docker)
docker compose up -d   # postgres:16 on localhost:5432 (POSTGRES_PORT=5433 to override)

# 1. Backend (Node 24+)
cd server
npm install
cp .env.example .env   # fill in real tokens (see below)
npm run dev            # http://localhost:8787

# 2. Dashboard (dev)
npm install
npm run dev            # http://localhost:5173, proxies /api to :8787

# Production: build once, then the backend serves everything
npm run build && npm run server
```

### `server/.env`

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (defaults to the docker-compose database) |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification handshake with Meta |
| `WHATSAPP_APP_SECRET` | Verifies `X-Hub-Signature-256` on incoming webhooks |
| `WHATSAPP_ACCESS_TOKEN` | Sends replies via the WhatsApp Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | The business phone number that sends replies |
| `OPENROUTER_API_KEY` | AI replies + BLTC extraction/scoring via OpenRouter |
| `OPENROUTER_MODEL` | Defaults to `meta-llama/llama-3.3-70b-instruct:free` |

Missing credentials fail loudly: the dashboard shows a setup banner, sends return errors,
and AI replies are skipped. Nothing is faked.

#### Production settings

`SESSION_SECRET` is **fatal** under `NODE_ENV=production` — the server refuses to start
without it, because the fallback is regenerated on every restart and would log every agent
out on each deploy. The rest have working defaults; `server/.env.example` carries the full
commentary on each.

| Var | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs session tokens. ≥16 chars — `openssl rand -hex 32`. **Required in production.** |
| `PUBLIC_BASE_URL` | Public origin, used to build absolute media links (WhatsApp fetches those URLs itself) |
| `CORS_ORIGIN` | Comma-separated allowlist, or `*`. Off by default — the dashboard is served same-origin |
| `HSTS_MAX_AGE` | HSTS lifetime in seconds, sent only over TLS. Defaults to `31536000`; `0` disables |
| `PG_POOL_SIZE` | Postgres pool size. This box shares its PostgreSQL with the other services on it |
| `AUTH_RATE_LIMIT` / `UPLOAD_RATE_LIMIT` | Per-minute ceilings (default 20 per IP, 60 per agent) |
| `LOG_REQUESTS` | `0` silences the access log |
| `STATS_CACHE_MS` | `/api/stats` counter cache; `0` disables |

`GET /healthz` is the load-balancer probe: no auth, no outbound calls, `200` while it can
reach PostgreSQL and `503` when it cannot, so an orchestrator can pull the node out of
rotation rather than keep sending it traffic. (Richer WhatsApp/AI status lives behind auth
on `/api/health`.) `SIGTERM`/`SIGINT` shut the process down gracefully — background jobs
stopped, listener closed, pool drained — with a 10-second force-exit backstop so a hung
connection can never block a deploy.

### Go live with Meta

1. Host the server on a public HTTPS URL (VPS + reverse proxy, or a tunnel while testing:
   `cloudflared tunnel --url http://localhost:8787`).
2. In your Meta app (WhatsApp → Configuration) set the webhook URL to
   `https://<your-host>/webhook` with your `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`.
3. Message your business number from any phone: the lead appears in the dashboard, the AI
   replies on WhatsApp, and the lead is scored after every message.

### Test the pipeline before wiring Meta

```bash
curl -X POST localhost:8787/api/simulate \
  -H 'content-type: application/json' \
  -d '{"from":"9198xxxxxx","name":"Test Buyer","text":"Looking for a 2BHK in Kharadi under 90 lakhs"}'
```

This pushes a message through the identical pipeline (PostgreSQL + OpenRouter), skipping only the
outbound WhatsApp send. The lead appears in the dashboard immediately. To reset all data:
`docker compose down -v && docker compose up -d`.

### Tests and coverage

Two suites, two gates. `npm test` runs both without measuring; the coverage scripts are the
gated ones, and both fail the build rather than printing a number nobody reads.

- `npm run test:coverage` — the server suite, gated at **100% lines and functions**. Branches
  are deliberately not gated: an unreachable arm of a `??` is not a hole in the tests.
- `npm run test:ui:coverage` — the UI suite (dashboard + admin), gated at **96% lines, 85%
  functions**.

The UI gate measures production code only — `*.test.js(x)` and the `src/test/` harness are
excluded, and so is `server/`, which the UI suite pulls in through `money.js` but does not test
and the server gate already owns. Measuring a suite's own test files inflates lines (every
assertion is a covered line) while deflating functions (a helper defined for one case is an
uncovered function everywhere else), so including them moves the number in both directions at
once and it stops meaning anything.

The two thresholds are ratchets set just under what the suite actually achieves, not aspirations
— raise them when coverage rises, and never lower one to make a red build green.

### Database

- Connection: `DATABASE_URL` (see `server/.env.example`); pooled via `pg`.
- Migrations: plain SQL files in `server/migrations/`, applied in filename order at startup and
  tracked in `schema_migrations`. Add a new `NNN_description.sql` file to change the schema.
- Tests: `cd server && npm test` — needs a running PostgreSQL; each test file creates and drops
  its own scratch database (`PGTEST_URL=postgres://homenex:homenex@localhost:5433` to point at a
  non-default port).
- Migrating old data: `node server/scripts/import-sqlite.js [path/to/homenex.db]` copies an
  existing SQLite database into PostgreSQL (preserves ids, resets sequences).
