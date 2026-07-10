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

### Database

- Connection: `DATABASE_URL` (see `server/.env.example`); pooled via `pg`.
- Migrations: plain SQL files in `server/migrations/`, applied in filename order at startup and
  tracked in `schema_migrations`. Add a new `NNN_description.sql` file to change the schema.
- Tests: `cd server && npm test` — needs a running PostgreSQL; each test file creates and drops
  its own scratch database (`PGTEST_URL=postgres://homenex:homenex@localhost:5433` to point at a
  non-default port).
- Migrating old data: `node server/scripts/import-sqlite.js [path/to/homenex.db]` copies an
  existing SQLite database into PostgreSQL (preserves ids, resets sequences).
