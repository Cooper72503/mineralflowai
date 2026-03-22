-- App and RLS policies use `min_score`; 016 created `minimum_score`.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'alerts'
      AND column_name = 'minimum_score'
  ) THEN
    ALTER TABLE alerts RENAME COLUMN minimum_score TO min_score;
  END IF;
END $$;
