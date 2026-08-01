# HomeNex — PROJECT_INFO

**AI-powered WhatsApp-native lead management for Indian real-estate brokers. Every lead answered in 30 seconds, even at 2 AM.**

Buyers only ever see WhatsApp. HomeNex is the broker's dashboard: every buyer who messages
the broker's WhatsApp Business number becomes a lead — answered by AI in seconds,
BLTC-qualified (Budget · Location · Timeline · Configuration), scored, and handed over when
it matters.

- **Repo:** https://github.com/r2st/HomeNex · branch `main`
- **Local path:** `Products/HomeNex`

## Tech stack

| Layer | Technology |
|---|---|
| Server | Node.js + Express — `server/` |
| Database | PostgreSQL via `pg` with pooling; versioned SQL migrations in `server/migrations/` run automatically on startup |
| Frontend | Vite SPA — `src/` (broker dashboard) and `admin/` (admin console) |
| LLM | OpenRouter — AI replies and structured BLTC extraction/scoring |
| Messaging | Meta WhatsApp Cloud API; one webhook (`POST /webhook`) verifies `X-Hub-Signature-256` and routes by `value.metadata.display_phone_number` |
| Tests | `node --test` |

**Multi-agent by design:** any number of brokers register with their own WhatsApp number.
A single Meta webhook serves all of them; each broker only ever sees their own leads,
conversations, stats and matches, and replies go out from their own number
(`phone_number_id` is learned from the first inbound webhook).

## Deploy location

| | |
|---|---|
| Host | Hetzner `89.167.8.178` — shared with Herald, GoSumo, TalentPing, Documedic, Knol |
| Code | `/opt/homenex` |
| Service | systemd unit `homenex` |
| Port | `3005` |
| Public URL | https://homenex.aiknol.com |
| Ingress | The box's shared Caddy container |
| Deploy script | `../../apprend_tech/ops/deploy-homenex-prod.sh` — **lives in the ops repo, not here** |

## SSH key

`keys/hetzner_deploy_ed25519` (+ `.pub`); host IP at `keys/hetzner_vps_ip`.

```bash
ssh -i keys/hetzner_deploy_ed25519 root@89.167.8.178
```

> Shared across five projects — see `~/projects/keys/KEYS_INDEX.md` §4.

## Environment variables

| Where | What |
|---|---|
| `.env` (gitignored) | Local dev — `PORT`, `ADMIN_PORT`, database URL, OpenRouter, WhatsApp |
| `keys/` (gitignored) | `openrouter-key`, `whatsapp_token` (Meta/WhatsApp Business API), `sendgrid.txt`, `Cloudfare_token.txt`, `Git_token.txt`, `hetzner_*` |
| Server | `/opt/homenex/.env` |

The webhook's `X-Hub-Signature-256` verification needs the Meta app secret configured, or
inbound messages are rejected.

## Key commands

```bash
npm install
npm run server                 # Express API — migrations run on startup
npm run dev                    # broker dashboard (Vite, :5173)
npm run dev:admin              # admin console (:5174)
npm run build && npm run build:admin
npm test                       # node --test 'src/lib/**/*.test.js'

# Data migration from the old SQLite store
node server/scripts/import-sqlite.js path/to/homenex.db

# Deploy
bash ../../apprend_tech/ops/deploy-homenex-prod.sh

# On the server
systemctl status homenex && journalctl -u homenex -f
```

## Related projects

- [`../HomeNex-demo`](../HomeNex-demo) — standalone interactive product tour (phone mockup, five annotated screens, no backend) → `homenex-demo.pages.dev`
- [`../homenex-site`](../homenex-site) — marketing/landing site
- [`../Herald`](../Herald), [`../GoSumo`](../GoSumo), [`../TalentPing`](../TalentPing), [`../Documedic`](../Documedic) — same box, **same SSH deploy key**
- `../../apprend_tech/ops` — holds this project's production deploy script
- `~/projects/PROJECT-INDEX.md`, `~/projects/keys/KEYS_INDEX.md` — estate-wide index
