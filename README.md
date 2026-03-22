# Mineral Intelligence AI

SaaS platform for finding mineral ownership opportunities near drilling activity. Built for mineral buyers, landmen, and acquisition teams.

## Stack

- **Frontend:** Next.js 14 (App Router) + TypeScript
- **Backend:** FastAPI (Python)
- **Database:** Supabase (Postgres)

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Run the schema: in the SQL Editor, run the contents of `supabase/migrations/001_initial_schema.sql`.
3. Copy your project URL and anon/service key for env vars.

### 2. Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with SUPABASE_URL and SUPABASE_KEY
uvicorn app.main:app --reload --port 8000
```

API: http://localhost:8000  
Docs: http://localhost:8000/docs

### 3. Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local
# Set NEXT_PUBLIC_API_URL=http://localhost:8000 if needed
npm run dev
```

App: http://localhost:3000

## Pages

| Route        | Description                |
|-------------|----------------------------|
| `/login`    | Sign in                    |
| `/dashboard`| Overview and top leads     |
| `/documents`| Document list              |
| `/leads`    | Lead list with filters     |
| `/leads/[id]` | Lead detail              |
| `/alerts`   | Drilling permit alerts     |

## Auth note

Login uses Supabase Auth via the backend. Ensure Supabase Auth is enabled and you have at least one user (e.g. created in the Supabase dashboard) to sign in.

## API overview

- `POST /api/auth/login` — Login (email/password)
- `GET /api/leads` — List leads (optional `?status=`)
- `GET /api/leads/{id}` — Lead detail
- `GET /api/documents` — List documents
- `GET /api/alerts` — Drilling permit alerts
- Plus CRUD for owners, tracts, documents, ownership_history, drilling_permits (see `/docs`).
