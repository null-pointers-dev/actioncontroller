-- Applied right after BullMQ's runMigrations() (server/db/setup.ts). Idempotent.
-- The web process enqueues jobs, the worker processes them: both need the BullMQ schema.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'bullmq') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA bullmq TO cp_web, cp_worker';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA bullmq TO cp_web, cp_worker';
        EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA bullmq TO cp_web, cp_worker';
        EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA bullmq TO cp_web, cp_worker';
    END IF;
END
$$;
