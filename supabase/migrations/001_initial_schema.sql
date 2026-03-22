-- Mineral Intelligence AI - Initial schema for Supabase Postgres

-- Owners (mineral owners)
CREATE TABLE IF NOT EXISTS owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Tracts (land/mineral tracts)
CREATE TABLE IF NOT EXISTS tracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  county TEXT,
  state TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Documents (uploaded deeds, etc.)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  tract_id UUID REFERENCES tracts(id) ON DELETE SET NULL,
  owner_id UUID REFERENCES owners(id) ON DELETE SET NULL,
  extraction_status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Ownership history (timeline of ownership per tract)
CREATE TABLE IF NOT EXISTS ownership_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tract_id UUID NOT NULL REFERENCES tracts(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  effective_date TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Drilling permits (for alerts)
CREATE TABLE IF NOT EXISTS drilling_permits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_number TEXT NOT NULL,
  tract_id UUID REFERENCES tracts(id) ON DELETE SET NULL,
  county TEXT,
  state TEXT,
  status TEXT DEFAULT 'active',
  permit_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Leads (scored opportunities)
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tract_id UUID REFERENCES tracts(id) ON DELETE SET NULL,
  owner_id UUID REFERENCES owners(id) ON DELETE SET NULL,
  score NUMERIC(5,2) DEFAULT 0,
  status TEXT DEFAULT 'new',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_documents_tract ON documents(tract_id);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_ownership_history_tract ON ownership_history(tract_id);
CREATE INDEX IF NOT EXISTS idx_drilling_permits_status ON drilling_permits(status);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

-- RLS can be enabled per table as needed; here we allow service role full access by default.
