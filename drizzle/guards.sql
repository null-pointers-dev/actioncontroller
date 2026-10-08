-- =====================================================================
--  Database guards — applied automatically after every `drizzle-kit push`
--  or migrate by server/db/setup.ts. NOT a migration: every statement is
--  idempotent (CREATE OR REPLACE / IF NOT EXISTS / GRANT), so it is safe
--  to run on every deploy and every push.
--
--  Why this file exists: drizzle-kit manages tables, columns, constraints
--  and indexes (server/db/schema.ts) but not functions, triggers, roles or
--  grants. These are the invariants that must hold even if app code has a
--  bug (docs/design/01 §2). Verified by drizzle/checks/schema-checks.sql.
-- =====================================================================

-- ---------------------------------------------------------------- roles
DO $$
DECLARE r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['cp_web', 'cp_worker', 'cp_readonly'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        END IF;
    END LOOP;
END
$$;

-- ---------------------------------------------------------------- vocabularies

CREATE OR REPLACE FUNCTION cp.github_status_rank(p_status text, p_conclusion text)
RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
    SELECT (CASE
        WHEN p_status = 'requested'                                      THEN 1
        WHEN p_status IN ('queued', 'pending')                           THEN 2
        WHEN p_status IN ('waiting', 'in_progress')                      THEN 3
        WHEN p_status = 'completed' AND p_conclusion = 'action_required' THEN 3
        WHEN p_status = 'completed'                                      THEN 5
        ELSE 0
    END)::smallint
$$;

-- The run-request state machine. Must equal shared/phases.ts (unit test compares them).
CREATE OR REPLACE FUNCTION cp.phase_transition_allowed(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT p_from = p_to OR (p_from, p_to) IN (
        ('pending','awaiting_approval'), ('pending','waiting_for_slot'), ('pending','dispatching'),
        ('pending','rejected'), ('pending','cancelled'),
        ('awaiting_approval','waiting_for_slot'), ('awaiting_approval','dispatching'),
        ('awaiting_approval','rejected'), ('awaiting_approval','cancelled'),
        ('waiting_for_slot','dispatching'), ('waiting_for_slot','rejected'), ('waiting_for_slot','cancelled'),
        ('dispatching','verifying'), ('dispatching','dispatched'), ('dispatching','running'),
        ('dispatching','succeeded'), ('dispatching','failed'), ('dispatching','cancelled'),
        ('dispatching','cancelling'), ('dispatching','lost'),
        ('verifying','dispatching'), ('verifying','dispatched'), ('verifying','running'),
        ('verifying','succeeded'), ('verifying','failed'), ('verifying','cancelled'),
        ('verifying','cancelling'), ('verifying','lost'),
        ('dispatched','running'), ('dispatched','succeeded'), ('dispatched','failed'),
        ('dispatched','cancelled'), ('dispatched','cancelling'),
        ('running','succeeded'), ('running','failed'), ('running','cancelled'), ('running','cancelling'),
        ('cancelling','cancelled'), ('cancelling','succeeded'), ('cancelling','failed')
    )
$$;

-- ---------------------------------------------------------------- guard functions

-- resource_version moves on every meaningful change (optimistic locking).
CREATE OR REPLACE FUNCTION cp.bump_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    housekeeping constant text[] := ARRAY[
        'resource_version', 'updated_at', 'last_seen_at', 'last_seen_via', 'etag', 'status_rank',
        'runs_listed_until', 'last_synced_at', 'fetched_at', 'last_used_at'];
BEGIN
    IF (to_jsonb(NEW) - housekeeping) = (to_jsonb(OLD) - housekeeping) THEN
        RETURN NEW;
    END IF;
    NEW.resource_version := OLD.resource_version + 1;
    NEW.updated_at       := now();
    RETURN NEW;
END
$$;

-- WANTED is frozen after creation; a cancel can't be withdrawn.
CREATE OR REPLACE FUNCTION cp.protect_wanted()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.requested_by, NEW.workspace_id, NEW.workflow_id, NEW.ref, NEW.inputs, NEW.environment,
        NEW.concurrency_key, NEW.concurrency_policy, NEW.settings_snapshot,
        NEW.correlation_tag, NEW.idempotency_key, NEW.created_at)
       IS DISTINCT FROM
       (OLD.requested_by, OLD.workspace_id, OLD.workflow_id, OLD.ref, OLD.inputs, OLD.environment,
        OLD.concurrency_key, OLD.concurrency_policy, OLD.settings_snapshot,
        OLD.correlation_tag, OLD.idempotency_key, OLD.created_at) THEN
        RAISE EXCEPTION 'run_request %: WANTED fields are frozen after creation', OLD.id;
    END IF;
    IF OLD.cancel_requested AND NOT NEW.cancel_requested THEN
        RAISE EXCEPTION 'run_request %: a cancel request cannot be withdrawn', OLD.id;
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION cp.guard_phase_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT cp.phase_transition_allowed(OLD.phase, NEW.phase) THEN
        RAISE EXCEPTION 'run_request %: illegal phase transition % -> %', OLD.id, OLD.phase, NEW.phase;
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION cp.guard_forward_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF cp.github_status_rank(NEW.status, NEW.conclusion) < cp.github_status_rank(OLD.status, OLD.conclusion) THEN
        RAISE EXCEPTION '%: status may not move backwards (% -> %)', TG_TABLE_NAME, OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION cp.forbid_self_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM cp.run_requests WHERE id = NEW.run_request_id AND requested_by = NEW.approver_id) THEN
        RAISE EXCEPTION 'user % cannot approve their own run request %', NEW.approver_id, NEW.run_request_id;
    END IF;
    RETURN NEW;
END
$$;

-- Append-only. The retention job may delete old rows only after
-- `SET LOCAL cp.retention_delete = 'on'` (server/core/maintenance.ts).
CREATE OR REPLACE FUNCTION cp.append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('cp.retention_delete', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP;
END
$$;

-- ---------------------------------------------------------------- triggers (PostgreSQL 14+)

CREATE OR REPLACE TRIGGER a_protect_wanted     BEFORE UPDATE ON cp.run_requests FOR EACH ROW EXECUTE FUNCTION cp.protect_wanted();
CREATE OR REPLACE TRIGGER b_guard_phase        BEFORE UPDATE OF phase ON cp.run_requests FOR EACH ROW EXECUTE FUNCTION cp.guard_phase_transition();
CREATE OR REPLACE TRIGGER b_guard_forward_only BEFORE UPDATE ON cp.workflow_runs FOR EACH ROW EXECUTE FUNCTION cp.guard_forward_only();
CREATE OR REPLACE TRIGGER b_guard_forward_only BEFORE UPDATE ON cp.workflow_jobs FOR EACH ROW EXECUTE FUNCTION cp.guard_forward_only();
CREATE OR REPLACE TRIGGER a_no_self_approval   BEFORE INSERT ON cp.approval_decisions FOR EACH ROW EXECUTE FUNCTION cp.forbid_self_approval();
CREATE OR REPLACE TRIGGER a_append_only        BEFORE UPDATE OR DELETE ON cp.approval_decisions FOR EACH ROW EXECUTE FUNCTION cp.append_only();
CREATE OR REPLACE TRIGGER a_append_only        BEFORE UPDATE OR DELETE ON cp.events FOR EACH ROW EXECUTE FUNCTION cp.append_only();

CREATE OR REPLACE TRIGGER z_bump_version BEFORE UPDATE ON cp.github_credentials   FOR EACH ROW EXECUTE FUNCTION cp.bump_version();
CREATE OR REPLACE TRIGGER z_bump_version BEFORE UPDATE ON cp.workspaces           FOR EACH ROW EXECUTE FUNCTION cp.bump_version();
CREATE OR REPLACE TRIGGER z_bump_version BEFORE UPDATE ON cp.workflows            FOR EACH ROW EXECUTE FUNCTION cp.bump_version();
CREATE OR REPLACE TRIGGER z_bump_version BEFORE UPDATE ON cp.workflow_definitions FOR EACH ROW EXECUTE FUNCTION cp.bump_version();
CREATE OR REPLACE TRIGGER z_bump_version BEFORE UPDATE ON cp.run_requests         FOR EACH ROW EXECUTE FUNCTION cp.bump_version();
CREATE OR REPLACE TRIGGER z_bump_version BEFORE UPDATE ON cp.run_actions          FOR EACH ROW EXECUTE FUNCTION cp.bump_version();
CREATE OR REPLACE TRIGGER z_bump_version BEFORE UPDATE ON cp.approval_requests    FOR EACH ROW EXECUTE FUNCTION cp.bump_version();
CREATE OR REPLACE TRIGGER z_bump_version BEFORE UPDATE ON cp.workflow_runs        FOR EACH ROW EXECUTE FUNCTION cp.bump_version();
CREATE OR REPLACE TRIGGER z_bump_version BEFORE UPDATE ON cp.workflow_jobs        FOR EACH ROW EXECUTE FUNCTION cp.bump_version();

-- ---------------------------------------------------------------- query functions

-- Commit-safe event feed: a cursor (txid, seq) never skips an event.
DROP FUNCTION IF EXISTS cp.read_events(xid8, bigint, int);
CREATE FUNCTION cp.read_events(p_after_txid xid8, p_after_seq bigint, p_limit int)
RETURNS SETOF cp.events LANGUAGE sql STABLE AS $$
    SELECT * FROM cp.events
     WHERE (txid, seq) > (p_after_txid, p_after_seq)
       AND txid < pg_snapshot_xmin(pg_current_snapshot())
     ORDER BY txid, seq
     LIMIT p_limit
$$;

-- Best credential for a workspace: active, validated, bucket usable, most budget first.
CREATE OR REPLACE FUNCTION cp.pick_credential(p_workspace_id uuid, p_need_dispatch boolean, p_resource text DEFAULT 'core')
RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT c.id
      FROM cp.github_credentials c
      JOIN cp.workspace_credentials wc ON wc.credential_id = c.id AND wc.workspace_id = p_workspace_id
      LEFT JOIN cp.github_rate_buckets b ON b.rate_bucket = c.rate_bucket AND b.resource = p_resource
     WHERE c.status = 'active'
       AND (c.expires_at IS NULL OR c.expires_at > now())
       AND (NOT p_need_dispatch OR wc.can_dispatch)
       AND COALESCE(b.breaker_state, 'closed') <> 'open'
       AND (b.blocked_until IS NULL OR b.blocked_until < now())
       AND (b.remaining IS NULL OR b.remaining > 0 OR b.resets_at < now())
     ORDER BY CASE WHEN b.resets_at < now() THEN NULL ELSE b.remaining END DESC NULLS FIRST,
              c.priority, c.last_used_at NULLS FIRST
     LIMIT 1
$$;

-- ---------------------------------------------------------------- grants (process roles)

GRANT USAGE ON SCHEMA cp, auth TO cp_web, cp_worker, cp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA cp   TO cp_web, cp_worker, cp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO cp_web, cp_worker;

GRANT INSERT ON cp.events TO cp_web, cp_worker;

-- web: authentication, user intents, admin configuration, webhook inbox, GitHub reporting
GRANT INSERT, UPDATE, DELETE ON auth.users, auth.sessions, auth.accounts, auth.verifications TO cp_web;
GRANT INSERT, UPDATE, DELETE ON cp.directory_groups, cp.user_groups TO cp_web;
GRANT INSERT ON cp.run_requests, cp.run_actions, cp.approval_requests, cp.approval_decisions TO cp_web;
GRANT UPDATE (cancel_requested, cancel_requested_by, cancel_requested_at) ON cp.run_requests TO cp_web;
GRANT UPDATE (state, decided_at) ON cp.approval_requests TO cp_web;
GRANT INSERT ON cp.workspaces TO cp_web;
GRANT UPDATE (display_name, description, visibility, public_role, status, status_reason) ON cp.workspaces TO cp_web;
GRANT INSERT, UPDATE, DELETE ON cp.workspace_grants, cp.workspace_credentials TO cp_web;
GRANT INSERT ON cp.github_credentials TO cp_web;
GRANT UPDATE (label, status, priority, secret_ref, expires_at, last_used_at, last_error,
              consecutive_failures, github_account_login) ON cp.github_credentials TO cp_web;
GRANT INSERT, UPDATE ON cp.github_rate_buckets, cp.github_http_cache, cp.workflow_definitions TO cp_web;
GRANT UPDATE (exposed, display_name, description, category, icon, ui_schema, allowed_ref_patterns,
              approval_required, approval_environments, approval_min, approval_ttl,
              concurrency_scope, concurrency_policy) ON cp.workflows TO cp_web;
GRANT INSERT ON cp.webhook_deliveries TO cp_web;

-- worker: progress, mirror, discovery, pool bookkeeping, retention
GRANT UPDATE (github_login, github_avatar_url, github_synced_at, github_user_id, github_identity_source) ON auth.users TO cp_worker;
GRANT UPDATE (phase, phase_reason, phase_message, conditions, github_run_id, dispatched_with,
              dispatch_attempts, dispatch_sent_at, verify_until) ON cp.run_requests TO cp_worker;
GRANT UPDATE (phase, phase_reason, result_attempt) ON cp.run_actions TO cp_worker;
GRANT UPDATE (state, decided_at) ON cp.approval_requests TO cp_worker;
GRANT UPDATE (full_name, owner_login, repo_name, default_branch, status, status_reason, update_mode,
              github_hook_id, last_synced_at, runs_listed_until) ON cp.workspaces TO cp_worker;
GRANT UPDATE (can_dispatch, validated_at, last_error) ON cp.workspace_credentials TO cp_worker;
GRANT UPDATE (status, expires_at, last_used_at, last_error, consecutive_failures, github_account_login) ON cp.github_credentials TO cp_worker;
GRANT INSERT ON cp.workflows TO cp_worker;
GRANT UPDATE (path, name, gh_state) ON cp.workflows TO cp_worker;
GRANT INSERT, UPDATE ON cp.workflow_definitions, cp.workflow_runs, cp.workflow_jobs TO cp_worker;
GRANT INSERT, UPDATE, DELETE ON cp.github_rate_buckets, cp.github_http_cache TO cp_worker;
GRANT UPDATE, DELETE ON cp.webhook_deliveries TO cp_worker;
GRANT DELETE ON cp.events TO cp_worker; -- retention only (guarded by cp.append_only)
