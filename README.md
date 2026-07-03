# HomeNex

AI-powered WhatsApp-native lead management for Indian real estate brokers.

**Every lead answered in 30 seconds. Even at 2 AM.**

## What's here

- **Frontend** (repo root) — mobile-first React demo app: dashboard, lead pipeline with BLTC scoring, a WhatsApp AI qualification simulation, a co-broking network exchange, and insights. Built with React + Vite + Tailwind CSS 4.
- **Backend** (`server/`) — lean Express server: Meta WhatsApp Business webhook (verification + signature check), OpenRouter-powered AI replies with Pune real-estate context, WhatsApp Cloud API send, and a small API the frontend can read real conversations from.

## Run locally

```bash
# Frontend
npm install
npm run dev          # http://localhost:5173

# Backend
cd server
npm install
cp .env.example .env # fill in your tokens
npm run dev          # http://localhost:8787
```

The Vite dev server proxies `/api/*` to the backend.

### Backend env vars (`server/.env`)

| Var | Purpose |
| --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification handshake with Meta |
| `WHATSAPP_APP_SECRET` | Verifies `X-Hub-Signature-256` on incoming webhooks |
| `WHATSAPP_ACCESS_TOKEN` | Sends replies via the WhatsApp Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | The business phone number that sends replies |
| `OPENROUTER_API_KEY` | AI replies (free models) via OpenRouter |
| `OPENROUTER_MODEL` | Defaults to `meta-llama/llama-3.3-70b-instruct:free` |

Missing credentials degrade gracefully: without WhatsApp tokens the server logs outbound messages instead of sending; without an OpenRouter key it sends a canned reply.

Test the AI loop without Meta:

```bash
curl -X POST localhost:8787/api/simulate \
  -H 'content-type: application/json' \
  -d '{"text":"Hi, looking for a 2BHK in Kharadi under 90 lakhs"}'
```

### Wiring up Meta

1. In your Meta app (WhatsApp > Configuration), set the webhook URL to `https://<your-host>/webhook` with your `WHATSAPP_VERIFY_TOKEN`.
2. Subscribe to the `messages` field.
3. Incoming buyer texts are qualified by the AI (BLTC: Budget, Location, Timeline, Configuration) and answered on WhatsApp automatically.

## Deploy

```bash
npm run build
npx wrangler pages deploy dist --project-name=homenex-demo
```
