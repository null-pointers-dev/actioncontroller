-- =====================================================================
--  schema-checks.sql — executable proof of the database invariants.
--  Run automatically by `pnpm db:reset` (and `pnpm db:check`) right after the
--  schema push, guards and BullMQ migrations — on an EMPTY database.
--  One transaction, rolled back at the end: leaves no data behind.
--  Each check prints "ok ..."; the first failure raises "FAIL: ...".
-- =====================================================================

BEGIN;

CREATE SCHEMA cp_check;
GRANT USAGE ON SCHEMA cp_check TO PUBLIC;

CREATE FUNCTION cp_check.ok(p_cond boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_msg; END IF;
    RAISE NOTICE 'ok    %', p_msg;
END $$;

CREATE FUNCTION cp_check.rejects(p_sql text, p_expect text, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM ~* p_expect THEN
            RAISE NOTICE 'ok    %  [rejected: %]', p_msg, SQLERRM;
            RETURN;
        END IF;
        RAISE EXCEPTION 'FAIL: % (rejected for the WRONG reason: %)', p_msg, SQLERRM;
    END;
    RAISE EXCEPTION 'FAIL: % (the database accepted it)', p_msg;
END $$;

CREATE FUNCTION cp_check.id(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
    SELECT (CASE p
        WHEN 'admin'  THEN '00000000-0000-7000-8000-00000000000a'
        WHEN 'priya'  THEN '00000000-0000-7000-8000-000000000001'
        WHEN 'ravi'   THEN '00000000-0000-7000-8000-000000000002'
        WHEN 'meera'  THEN '00000000-0000-7000-8000-000000000003'
        WHEN 'ws'     THEN '00000000-0000-7000-8000-000000000100'
        WHEN 'req-1'  THEN '00000000-0000-7000-8000-000000000101'
        WHEN 'req-a'  THEN '00000000-0000-7000-8000-000000000102'
        WHEN 'req-b'  THEN '00000000-0000-7000-8000-000000000103'
        WHEN 'pat-a1' THEN '00000000-0000-7000-8000-000000000201'
        WHEN 'pat-a2' THEN '00000000-0000-7000-8000-000000000202'
        WHEN 'pat-b'  THEN '00000000-0000-7000-8000-000000000203'
        WHEN 'app'    THEN '00000000-0000-7000-8000-000000000204'
    END)::uuid
$$;

-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------
INSERT INTO auth.users (id, name, email, role, github_user_id, github_login, github_identity_source) VALUES
    (cp_check.id('admin'), 'Admin', 'admin@acme.test', 'admin', NULL,  NULL,       NULL),
    (cp_check.id('priya'), 'Priya', 'priya@acme.test', 'user',  50001, 'priya-gh', 'saml'),
    (cp_check.id('ravi'),  'Ravi',  'ravi@acme.test',  'user',  NULL,  NULL,       NULL),
    (cp_check.id('meera'), 'Meera', 'meera@acme.test', 'user',  NULL,  NULL,       NULL);

INSERT INTO cp.workspaces (id, github_repo_id, owner_login, repo_name, full_name, default_branch,
                           display_name, status, imported_by)
VALUES (cp_check.id('ws'), 4711, 'acme', 'payments-service', 'acme/payments-service', 'main',
        'Payments', 'active', cp_check.id('admin'));

INSERT INTO cp.github_credentials (id, label, kind, secret_ref, github_account_id, github_account_login,
                                   app_id, installation_id, rate_bucket, created_by) VALUES
    (cp_check.id('pat-a1'), 'bot-a token 1', 'fine_grained_pat', 'kv-pat-a1', 1001, 'bot-a', NULL, NULL, 'user:1001', cp_check.id('admin')),
    (cp_check.id('pat-a2'), 'bot-a token 2', 'fine_grained_pat', 'kv-pat-a2', 1001, 'bot-a', NULL, NULL, 'user:1001', cp_check.id('admin')),
    (cp_check.id('pat-b'),  'bot-b token',   'fine_grained_pat', 'kv-pat-b',  1002, 'bot-b', NULL, NULL, 'user:1002', cp_check.id('admin')),
    (cp_check.id('app'),    'acme app',      'github_app',       'kv-app',    NULL, NULL,    12,   777,  'installation:777', cp_check.id('admin'));

INSERT INTO cp.workspace_credentials (workspace_id, credential_id, can_dispatch) VALUES
    (cp_check.id('ws'), cp_check.id('pat-a1'), true),
    (cp_check.id('ws'), cp_check.id('pat-a2'), true),
    (cp_check.id('ws'), cp_check.id('pat-b'),  true),
    (cp_check.id('ws'), cp_check.id('app'),    false);

INSERT INTO cp.github_rate_buckets (rate_bucket, resource, limit_total, remaining, resets_at) VALUES
    ('user:1001',        'core', 5000, 10,   now() + interval '30 minutes'),
    ('user:1002',        'core', 5000, 4000, now() + interval '30 minutes'),
    ('installation:777', 'core', 5000, 9000, now() + interval '30 minutes');

INSERT INTO cp.workflows (id, workspace_id, path, name, gh_state, exposed, display_name,
                          concurrency_scope, concurrency_policy, approval_required, approval_environments) VALUES
    (8801, cp_check.id('ws'), '.github/workflows/deploy.yml',  'deploy',  'active', true,  'Deploy',
     'workflow_environment', 'forbid', true, ARRAY['production']),
    (8802, cp_check.id('ws'), '.github/workflows/nightly.yml', 'nightly', 'active', false, NULL,
     'none', 'allow', false, NULL);

INSERT INTO cp.run_requests (id, correlation_tag, idempotency_key, requested_by, workspace_id, workflow_id,
                             ref, inputs, environment)
VALUES (cp_check.id('req-1'), 'cp-aaaaaaaaaaa1', 'click-1', cp_check.id('priya'), cp_check.id('ws'), 8801,
        'main', '{"environment":"staging"}', 'staging');

-- =====================================================================
-- 1. Intent
-- =====================================================================
DO $$
DECLARE n int;
BEGIN
    INSERT INTO cp.run_requests (idempotency_key, requested_by, workspace_id, workflow_id, ref)
    VALUES ('click-1', cp_check.id('priya'), cp_check.id('ws'), 8801, 'main')
    ON CONFLICT (requested_by, idempotency_key) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM cp_check.ok(n = 0, '1.1  a double submit with the same idempotency key creates nothing');

    UPDATE cp.run_requests SET phase = 'dispatching', dispatch_attempts = 1
     WHERE id = cp_check.id('req-1') AND resource_version = 1;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM cp_check.ok(n = 1, '1.2  worker A claims the request at version 1');

    UPDATE cp.run_requests SET phase = 'dispatching', dispatch_attempts = 2
     WHERE id = cp_check.id('req-1') AND resource_version = 1;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM cp_check.ok(n = 0, '1.3  worker B with the stale version changes nothing');

    UPDATE cp.run_requests SET phase = 'dispatched', github_run_id = 9001, dispatched_with = cp_check.id('pat-b')
     WHERE id = cp_check.id('req-1');
    UPDATE cp.run_requests SET phase = 'running'   WHERE id = cp_check.id('req-1');
    UPDATE cp.run_requests SET phase = 'succeeded' WHERE id = cp_check.id('req-1');
    PERFORM cp_check.ok((SELECT phase FROM cp.run_requests WHERE id = cp_check.id('req-1')) = 'succeeded',
        '1.4  a legal path to succeeded is accepted, and the credential used is recorded');
END $$;

SELECT cp_check.rejects($$UPDATE cp.run_requests SET phase = 'running' WHERE id = cp_check.id('req-1')$$,
    'illegal phase transition', '1.5  a finished request cannot go back to running');
SELECT cp_check.rejects($$UPDATE cp.run_requests SET inputs = '{"environment":"production"}' WHERE id = cp_check.id('req-1')$$,
    'frozen', '1.6  submitted inputs cannot be changed');
UPDATE cp.run_requests SET cancel_requested = true, cancel_requested_by = cp_check.id('priya'), cancel_requested_at = now()
 WHERE id = cp_check.id('req-1');
SELECT cp_check.rejects($$UPDATE cp.run_requests SET cancel_requested = false WHERE id = cp_check.id('req-1')$$,
    'cannot be withdrawn', '1.7  a cancel cannot be withdrawn');

-- =====================================================================
-- 2. One active production deploy at a time
-- =====================================================================
INSERT INTO cp.run_requests (id, idempotency_key, requested_by, workspace_id, workflow_id, ref, environment,
                             concurrency_key, concurrency_policy) VALUES
    (cp_check.id('req-a'), 'click-a', cp_check.id('priya'), cp_check.id('ws'), 8801, 'main', 'production', '8801/production', 'forbid'),
    (cp_check.id('req-b'), 'click-b', cp_check.id('ravi'),  cp_check.id('ws'), 8801, 'main', 'production', '8801/production', 'forbid');
UPDATE cp.run_requests SET phase = 'dispatching' WHERE id = cp_check.id('req-a');
SELECT cp_check.rejects($$UPDATE cp.run_requests SET phase = 'dispatching' WHERE id = cp_check.id('req-b')$$,
    'one_active_per_slot', '2.1  a second production deploy cannot become active while the first is');

-- =====================================================================
-- 3. Mirror moves forward only
-- =====================================================================
INSERT INTO cp.workflow_runs (run_id, run_attempt, workspace_id, workflow_id, run_request_id, status,
                              gh_created_at, gh_updated_at, last_seen_via)
VALUES (9001, 1, cp_check.id('ws'), 8801, cp_check.id('req-1'), 'queued',
        '2026-10-07 10:00:00+00', '2026-10-07 10:00:01+00', 'webhook');
DO $$
BEGIN
    UPDATE cp.workflow_runs SET status = 'in_progress' WHERE run_id = 9001;
    UPDATE cp.workflow_runs SET status = 'waiting'     WHERE run_id = 9001;
    UPDATE cp.workflow_runs SET status = 'in_progress' WHERE run_id = 9001;
    UPDATE cp.workflow_runs SET status = 'completed', conclusion = 'success' WHERE run_id = 9001;
    PERFORM cp_check.ok((SELECT status_rank FROM cp.workflow_runs WHERE run_id = 9001) = 5,
        '3.1  in_progress <-> waiting allowed; completed rank computed by the database');
END $$;
SELECT cp_check.rejects($$UPDATE cp.workflow_runs SET status = 'in_progress', conclusion = NULL WHERE run_id = 9001$$,
    'may not move backwards', '3.2  a completed run cannot go back to in_progress');

-- =====================================================================
-- 4. Approvals
-- =====================================================================
INSERT INTO cp.approval_requests (run_request_id, workspace_id, min_approvals, expires_at)
VALUES (cp_check.id('req-b'), cp_check.id('ws'), 1, now() + interval '1 day');
SELECT cp_check.rejects(
    $$INSERT INTO cp.approval_decisions (run_request_id, approver_id, decision)
      VALUES (cp_check.id('req-b'), cp_check.id('ravi'), 'approve')$$,
    'cannot approve their own', '4.1  Ravi cannot approve his own request');
INSERT INTO cp.approval_decisions (run_request_id, approver_id, decision)
VALUES (cp_check.id('req-b'), cp_check.id('meera'), 'approve');
SELECT cp_check.rejects($$UPDATE cp.approval_decisions SET decision = 'deny'$$,
    'append-only', '4.2  a recorded vote cannot be edited');

-- =====================================================================
-- 5. Events
-- =====================================================================
INSERT INTO cp.events (type, version, subject, aggregate_type, aggregate_id, actor_kind, actor_id, workspace_id, data)
VALUES ('cp.run_request.created', 1, 'run-requests/x', 'run_request', 'x', 'user', 'priya', cp_check.id('ws'), '{}');
SELECT cp_check.ok(NOT EXISTS (SELECT 1 FROM cp.read_events('0'::xid8, 0, 1000) WHERE aggregate_id = 'x'),
    '5.1  an event is invisible to feed readers until its transaction commits');
SELECT cp_check.rejects($$UPDATE cp.events SET data = '{"x":1}' WHERE aggregate_id = 'x'$$,
    'append-only', '5.2  an emitted event cannot be edited');

-- =====================================================================
-- 6. Webhook inbox and retention
-- =====================================================================
DO $$
DECLARE n int;
BEGIN
    INSERT INTO cp.webhook_deliveries (delivery_guid, event_type, payload)
    VALUES ('11111111-1111-4111-8111-111111111111', 'workflow_run', '{}') ON CONFLICT DO NOTHING;
    INSERT INTO cp.webhook_deliveries (delivery_guid, event_type, payload)
    VALUES ('11111111-1111-4111-8111-111111111111', 'workflow_run', '{}') ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM cp_check.ok(n = 0, '6.1  the same GitHub delivery stored twice is a no-op (PK dedupe)');
END $$;

SELECT cp_check.rejects($$DELETE FROM cp.events WHERE aggregate_id = 'x'$$,
    'append-only', '6.2  events cannot be deleted by normal code');
DO $$
BEGIN
    PERFORM set_config('cp.retention_delete', 'on', true);
    DELETE FROM cp.events WHERE aggregate_id = 'x';
    PERFORM set_config('cp.retention_delete', 'off', true);
    PERFORM cp_check.ok(NOT EXISTS (SELECT 1 FROM cp.events WHERE aggregate_id = 'x'),
        '6.3  ... but the retention job (explicit flag) can');
END $$;

-- =====================================================================
-- 7. GitHub credential pool
-- =====================================================================
SELECT cp_check.rejects(
    $$INSERT INTO cp.github_credentials (label, kind, secret_ref, github_account_id, rate_bucket, created_by)
      VALUES ('wrong', 'classic_pat', 'kv-x', 1003, 'user:9999', cp_check.id('admin'))$$,
    'check constraint', '7.1  a token must sit in its OWNER''s rate bucket (limits are per account)');

DO $$
BEGIN
    PERFORM cp_check.ok(cp.pick_credential(cp_check.id('ws'), true) = cp_check.id('pat-b'),
        '7.2  dispatch picks the token whose ACCOUNT has the most budget left');
    PERFORM cp_check.ok(cp.pick_credential(cp_check.id('ws'), false) = cp_check.id('app'),
        '7.3  read-only calls may also use a credential that cannot dispatch');

    UPDATE cp.github_rate_buckets SET blocked_until = now() + interval '5 minutes' WHERE rate_bucket = 'user:1002';
    PERFORM cp_check.ok(cp.pick_credential(cp_check.id('ws'), true) IN (cp_check.id('pat-a1'), cp_check.id('pat-a2')),
        '7.4  a bucket hit by a secondary limit is skipped; the next account takes over');

    UPDATE cp.github_rate_buckets SET remaining = 0 WHERE rate_bucket = 'user:1001';
    PERFORM cp_check.ok(cp.pick_credential(cp_check.id('ws'), true) IS NULL,
        '7.5  two tokens of the SAME exhausted account give no extra capacity');

    UPDATE cp.github_rate_buckets SET blocked_until = NULL WHERE rate_bucket = 'user:1002';
    UPDATE cp.github_credentials SET expires_at = now() - interval '1 day' WHERE id = cp_check.id('pat-b');
    PERFORM cp_check.ok(cp.pick_credential(cp_check.id('ws'), true) IS NULL,
        '7.6  an expired token is never picked');

    UPDATE cp.github_rate_buckets SET resets_at = now() - interval '1 second' WHERE rate_bucket = 'user:1001';
    PERFORM cp_check.ok(cp.pick_credential(cp_check.id('ws'), true) IN (cp_check.id('pat-a1'), cp_check.id('pat-a2')),
        '7.7  once a bucket''s reset time passes, its tokens are usable again');
END $$;

-- =====================================================================
-- 8. Workspace rules
-- =====================================================================
SELECT cp_check.rejects($$UPDATE cp.workspaces SET visibility = 'public' WHERE id = cp_check.id('ws')$$,
    'check constraint', '8.1  a public workspace must say what everyone may do (public_role)');
UPDATE cp.workspaces SET visibility = 'public', public_role = 'viewer' WHERE id = cp_check.id('ws');
INSERT INTO cp.workspace_grants (workspace_id, subject_type, subject_id, role, can_approve, granted_by)
VALUES (cp_check.id('ws'), 'group', 'entra-group-release', 'operator', true, cp_check.id('admin'));
SELECT cp_check.rejects(
    $$INSERT INTO cp.workspace_grants (workspace_id, subject_type, subject_id, role, granted_by)
      VALUES (cp_check.id('ws'), 'group', 'entra-group-release', 'viewer', cp_check.id('admin'))$$,
    'duplicate key', '8.2  one grant per subject per workspace');

-- =====================================================================
-- 9. Process roles stay in their lane
-- =====================================================================
SET LOCAL ROLE cp_web;
SELECT cp_check.rejects($$UPDATE cp.run_requests SET phase = 'failed' WHERE id = cp_check.id('req-b')$$,
    'permission denied', '9.1  web cannot write progress');
SELECT cp_check.rejects($$UPDATE cp.workflow_runs SET status = 'completed' WHERE run_id = 9001$$,
    'permission denied', '9.2  web cannot write the GitHub mirror');
RESET ROLE;

SET LOCAL ROLE cp_worker;
SELECT cp_check.rejects($$UPDATE cp.workspaces SET visibility = 'private', public_role = NULL WHERE id = cp_check.id('ws')$$,
    'permission denied', '9.3  worker cannot change who sees a workspace');
SELECT cp_check.rejects($$DELETE FROM cp.workspace_grants$$,
    'permission denied', '9.4  worker cannot change grants');
SELECT cp_check.rejects($$UPDATE cp.run_requests SET inputs = '{}' WHERE id = cp_check.id('req-b')$$,
    'permission denied', '9.5  worker cannot touch WANTED columns');
RESET ROLE;

-- =====================================================================
-- 10. BullMQ lives in the same database and both processes can use it
-- =====================================================================
SELECT cp_check.ok(EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'bullmq'),
    '10.1 BullMQ schema exists (runMigrations ran)');
SELECT cp_check.ok(has_schema_privilege('cp_web', 'bullmq', 'USAGE') AND has_schema_privilege('cp_worker', 'bullmq', 'USAGE'),
    '10.2 web and worker roles can use the BullMQ schema');

DO $$ BEGIN RAISE NOTICE '=== ALL SCHEMA CHECKS PASSED — rolling back ==='; END $$;
ROLLBACK;
