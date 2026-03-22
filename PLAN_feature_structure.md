# Mineral Intelligence AI — Feature & Structure Plan

Next.js 14 + Supabase. Audience: mineral buyers, landmen, acquisition teams.

---

## 1. Site map

```
/                           → redirect to /login (or /dashboard if authenticated)
/login                      → sign in
/signup                     → sign up (optional for MVP)
/forgot-password            → password reset

/dashboard                  → overview, quick stats, recent activity
/documents                  → list uploads, upload new, filter by status
/documents/[id]             → single document detail + extraction result
/leads                      → lead list, search, filters, sort
/leads/[id]                 → lead detail (owner, tract, score, history, actions)
/alerts                     → drilling permit alerts list
/alerts/[id]                → single alert detail (optional)

/settings                   → profile, preferences (later phase)
```

**Route groups (optional for layout only):**
- `(auth)` — `/login`, `/signup`, `/forgot-password` (centered, no nav)
- `(dashboard)` — `/dashboard`, `/documents`, `/leads`, `/alerts` (shared sidebar + header)

---

## 2. Feature list

| Area | Feature | Description |
|------|---------|-------------|
| **Auth** | Login | Email/password sign in via Supabase Auth |
| **Auth** | Sign up | User registration (optional MVP) |
| **Auth** | Sign out | Clear session; middleware redirects to `/login` |
| **Auth** | Forgot password | Reset flow via Supabase |
| **Dashboard** | Overview | Summary cards (documents, leads, alerts), recent activity |
| **Documents** | Upload | Upload deed/PDF; store in Supabase Storage; create `documents` row |
| **Documents** | List | Table/list with filters (status, county, date), pagination |
| **Documents** | Detail | View document metadata + extraction result (when ready) |
| **Documents** | AI extraction | Backend/edge job: parse deed → owners, tracts, dates; update DB |
| **Ownership** | History timeline | Per-tract timeline of ownership (from ownership_history) |
| **Leads** | List & search | Search/filter leads by score, status, owner, tract, county |
| **Leads** | Detail | Lead profile: owner, tract, score, notes, ownership timeline, linked docs |
| **Leads** | Lead scoring | Logic to score leads (e.g. near drilling, ownership clarity); can be MVP rule-based |
| **Alerts** | Drilling permits | List permits (from drilling_permits); filter by county/state/status |
| **Alerts** | Alert detail | Permit + linked tracts/owners (optional) |
| **Export** | CSV export | Export leads (or search results) to CSV |

---

## 3. MVP features only

**Must-have for first usable release:**

- **Auth:** Login, sign out. (Sign up if you need self-serve; otherwise invite-only.)
- **Dashboard:** Single page with basic stats (e.g. document count, lead count) and “recent” list (documents or leads).
- **Documents:** Upload (file → Storage + `documents` row), list with status (e.g. pending/processed), and document detail page (metadata only is fine for MVP).
- **Documents – AI extraction (minimal):** One extraction path (e.g. “Process” button or webhook) that creates/updates `owners`, `tracts`, and optionally `ownership_history` from one document. Can be stub or simple parser first.
- **Leads:** List page with sort by score; lead detail page showing owner, tract, score, and link to document if any.
- **Lead scoring (simple):** At least one rule (e.g. “has tract + has owner + document processed” → score &gt; 0) so leads appear and are sortable.
- **Database:** Use existing tables: `owners`, `tracts`, `documents`, `ownership_history`, `drilling_permits`, `leads`. Add `profiles` (or use `auth.users`) for user-scoped data if you need multi-tenant later.

**Explicitly out of MVP:**

- Sign up / forgot password (unless required for launch).
- Full ownership history timeline UI (can show “from document” only).
- Drilling permit alerts (alerts page can be “coming soon” or static list).
- CSV export.
- Settings page.

---

## 4. Later-phase features

- **Auth:** Sign up, forgot password, email verification, OAuth (Google, etc.).
- **Documents:** Batch upload, document type selector, re-run extraction, confidence scores.
- **Ownership:** Full ownership history timeline per tract, merge/split history, source documents per entry.
- **Alerts:** Drilling permit ingestion (API or manual), alert rules (county, distance), notifications (email/in-app).
- **Leads:** Advanced filters, saved searches, bulk actions, lead scoring model v2 (e.g. ML or more rules).
- **Export:** CSV export for leads/search results, scheduled reports.
- **Settings:** Profile, org/team, API keys, notification preferences.
- **Multi-tenant:** `profiles` + RLS so data is scoped by `user_id` or `org_id`.

---

## 5. Suggested folder structure

Next.js 14 App Router, with route groups for auth vs app.

```
frontend/
├── app/
│   ├── layout.tsx                    # Root layout (fonts, metadata, globals)
│   ├── page.tsx                      # "/" → redirect to login or dashboard
│   ├── globals.css
│   │
│   ├── (auth)/                       # Route group: auth layout (centered card, no sidebar)
│   │   ├── layout.tsx                # Auth layout wrapper
│   │   ├── login/
│   │   │   ├── page.tsx
│   │   │   └── LoginForm.tsx
│   │   ├── signup/
│   │   │   └── page.tsx
│   │   └── forgot-password/
│   │       └── page.tsx
│   │
│   ├── (dashboard)/                  # Route group: app shell (sidebar + header)
│   │   ├── layout.tsx                # Dashboard layout (nav, SignOutButton)
│   │   ├── dashboard/
│   │   │   └── page.tsx
│   │   ├── documents/
│   │   │   ├── layout.tsx            # Optional: documents-specific nav
│   │   │   ├── page.tsx              # List + upload
│   │   │   └── [id]/
│   │   │       └── page.tsx          # Document detail + extraction
│   │   ├── leads/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx              # Lead list + search
│   │   │   └── [id]/
│   │   │       └── page.tsx          # Lead detail
│   │   └── alerts/
│   │       ├── layout.tsx
│   │       ├── page.tsx              # Alerts list
│   │       └── [id]/
│   │           └── page.tsx          # Optional
│   │
│   └── components/                   # Shared UI (or move to components/)
│       └── SignOutButton.tsx
│
├── components/                       # Shared components (optional; can live under app/)
│   ├── ui/                           # Buttons, inputs, cards, table
│   ├── layout/                       # Sidebar, Header
│   └── features/                     # Feature-specific (LeadCard, DocumentTable, etc.)
│
├── lib/
│   ├── supabase/
│   │   ├── client.ts                 # Browser client
│   │   └── server.ts                 # Server client (cookies)
│   ├── api.ts                        # Fetch wrappers to your backend (if any)
│   └── utils.ts
│
├── hooks/                            # useLeads, useDocuments, useAuth, etc.
├── types/                            # Shared TS types (Lead, Document, Owner, Tract)
├── middleware.ts                     # Auth check; protect (dashboard) routes
└── .env.local
```

**Middleware:** Keep protecting `(dashboard)` routes: `/dashboard`, `/documents`, `/leads`, `/alerts` (and nested). Redirect unauthenticated users to `/login` with `?redirect=...`.

**Database (Supabase) — consolidate and RLS:**

- **Existing:** `owners`, `tracts`, `documents`, `ownership_history`, `drilling_permits`, `leads`.
- **Recommended additions:**
  - `profiles` — `id` (FK to `auth.users`), `email`, `display_name`, `created_at`, etc., for RLS and UI.
  - If multi-tenant: `org_id` or `user_id` on `documents`, `leads`, etc., and RLS policies.
- **Documents:** Align with one schema (e.g. `file_name`, `document_type`, `county`, `extraction_status`, `storage_path`); add `tract_id`/`owner_id` back if you link post-extraction, or keep extraction results in a separate `document_extractions` table.

---

## 6. Recommended build order

1. **Auth & shell**
   - Ensure login/sign out and middleware are solid.
   - Add `(auth)` and `(dashboard)` route groups; move existing dashboard pages under `(dashboard)` and use one dashboard layout (sidebar + header).

2. **Profiles & RLS**
   - Create `profiles` (sync from `auth.users` via trigger or on first login).
   - Add RLS policies on key tables (e.g. `documents`, `leads`) so rows are scoped by user/org when you’re ready.

3. **Dashboard**
   - Implement dashboard page: counts from `documents` and `leads`, plus “recent” list (e.g. latest 5–10 documents or leads).

4. **Documents**
   - Documents list (with `extraction_status`), upload to Storage + insert into `documents`.
   - Document detail page (metadata + `storage_path` / preview link).
   - Extraction pipeline: one path (button or job) that parses a document and creates/updates `owners`, `tracts`, and optionally `ownership_history`; set `extraction_status` to `processed` or `failed`.

5. **Leads**
   - Lead list with sort by score and simple filters (e.g. status).
   - Lead detail: owner, tract, score, notes, link to source document.
   - Lead scoring: implement minimal rule(s) and backfill/update `leads.score` (and link `tract_id`/`owner_id` from extraction).

6. **Ownership timeline (MVP slice)**
   - On lead or tract detail, show ownership history entries from `ownership_history` (e.g. list or simple timeline).

7. **Alerts (stub or static)**
   - Alerts page: list from `drilling_permits` (or “coming soon”) and optional detail route.

8. **Later**
   - Sign up, forgot password, CSV export, full ownership timeline UI, alert ingestion and notifications, settings.

Use this as the single source of truth for site map, features, MVP scope, later phases, folder structure, and build order. Adjust route groups and RLS to match whether you ship single-tenant first or multi-tenant from day one.
