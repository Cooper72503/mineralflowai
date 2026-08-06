# MineralFlow AI

Automated due diligence for Texas oil & gas mineral and working-interest acquisitions. Given a well API number, lease number, operator name, or legal description, the platform queries every applicable public record source at the Texas Railroad Commission (TRRC), synthesizes them with an AI agent, and returns a structured due diligence report (PDF, Excel, CSV exports, and a JSON manifest) with engineering, economic, and risk analysis — every field traceable to its source record, with gaps disclosed rather than guessed.

## Stack

- **Frontend:** Next.js 14 (App Router) + TypeScript — `frontend/`
- **Worker:** Node/TypeScript background worker that runs the retrieval + AI agent — `worker/`
- **Database & Auth:** Supabase (Postgres)
- **AI:** Anthropic Claude
- **Payments:** Stripe
- **Email:** Resend

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Run the migrations in `supabase/migrations/` against your project (via the SQL Editor or `supabase db push`).
3. Copy your project URL, anon key, and service role key for the env vars below.

### 2. Frontend

```bash
cd frontend
npm install
# Create .env.local with at least:
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
#   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_BASIC_PRICE_ID, STRIPE_PRO_PRICE_ID (billing)
#   RESEND_API_KEY, RESEND_FROM_EMAIL (transactional email)
#   TRRC_EWA_PROXY_SECRET (internal proxy auth between frontend and worker)
#   EIA_API_KEY (optional — live oil/gas pricing; falls back to a static price deck if unset)
npm run dev
```

App: http://localhost:3000

### 3. Worker

The worker polls Supabase for pending due diligence runs, retrieves TRRC records, and drives the Claude agent that assembles each report.

```bash
cd worker
npm install
# Create .env with at least:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
#   MAX_CONCURRENT, POLL_INTERVAL_MS (optional — tuning knobs, sensible defaults if unset)
npm start
```

In production the worker runs as a standalone process (PM2) on its own host, independent of the Vercel-deployed frontend.

## Key routes

| Route                 | Description                                  |
|------------------------|-----------------------------------------------|
| `/dashboard`           | Tool launcher                                 |
| `/trrc-due-diligence`  | Run a due diligence report and view results   |
| `/settings`            | Account settings                              |
| `/billing`             | Subscription and billing                      |

## Testing

```bash
cd frontend && npm test   # vitest
cd worker && npm test     # vitest
```
