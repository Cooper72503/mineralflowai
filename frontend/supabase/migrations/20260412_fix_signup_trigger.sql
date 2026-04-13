-- Hotfix: make the subscription trigger exception-safe so it can NEVER abort signup.
-- Re-run this any time the trigger needs to be reset.

-- Drop and recreate the function with proper exception handling
CREATE OR REPLACE FUNCTION handle_new_user_subscription()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  BEGIN
    INSERT INTO subscriptions (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- Silently swallow — billing row creation must never block signup
    NULL;
  END;
  RETURN NEW;
END;
$$;

-- Only (re)create the trigger if the subscriptions table actually exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
  ) THEN
    DROP TRIGGER IF EXISTS on_auth_user_created_subscription ON auth.users;
    CREATE TRIGGER on_auth_user_created_subscription
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION handle_new_user_subscription();
  ELSE
    -- Subscriptions table not yet created — drop any stale trigger so signup works
    DROP TRIGGER IF EXISTS on_auth_user_created_subscription ON auth.users;
  END IF;
END;
$$;
