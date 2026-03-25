-- Drill difficulty / regional geology snapshot (denormalized; also in structured_data JSONB).

ALTER TABLE document_extractions
  ADD COLUMN IF NOT EXISTS estimated_formation TEXT,
  ADD COLUMN IF NOT EXISTS estimated_depth_min INTEGER,
  ADD COLUMN IF NOT EXISTS estimated_depth_max INTEGER,
  ADD COLUMN IF NOT EXISTS drill_difficulty TEXT,
  ADD COLUMN IF NOT EXISTS drill_difficulty_score INTEGER,
  ADD COLUMN IF NOT EXISTS drill_difficulty_reason TEXT;
