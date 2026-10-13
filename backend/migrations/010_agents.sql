-- Agent orchestration, plan 2A (spec docs/superpowers/specs/2026-10-12-agent-orchestration-design.md §3).

-- Test plans drafted for each RCM row (spec §3.1). Auditors edit them; the agent drafts them.
ALTER TABLE engagement_work ADD COLUMN test_plans jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Every version of a workpaper that a gate or a signature can refer to. Append-only, like finding_revisions.
CREATE TABLE workpaper_revisions (
  engagement_id text NOT NULL REFERENCES engagements (id),
  kind          text NOT NULL CHECK (kind IN ('scope', 'rcm', 'test_plans', 'report')),
  revision      integer NOT NULL CHECK (revision > 0),
  content_hash  text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_id, kind, revision)
);
CREATE TRIGGER workpaper_revisions_append_only BEFORE UPDATE OR DELETE ON workpaper_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER workpaper_revisions_no_truncate BEFORE TRUNCATE ON workpaper_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- One supervisor run of an engagement. The worker that holds the lease is the only writer while it runs.
CREATE TABLE agent_runs (
  id               text PRIMARY KEY,
  engagement_id    text NOT NULL REFERENCES engagements (id),
  goal             text NOT NULL DEFAULT 'engagement' CHECK (goal IN ('engagement')),
  status           text NOT NULL CHECK (status IN ('running', 'runnable', 'waiting', 'needs_human', 'completed', 'cancelled', 'failed')),
  status_reason    text NOT NULL DEFAULT '',
  policy           text NOT NULL CHECK (policy IN ('llm', 'rules')),
  policy_version   text NOT NULL,
  budget           jsonb NOT NULL,
  spent            jsonb NOT NULL DEFAULT '{"steps":0,"tokensIn":0,"tokensOut":0,"costUsd":0}'::jsonb,
  started_by       text NOT NULL REFERENCES users (id),
  cancel_requested boolean NOT NULL DEFAULT false,
  pause_requested  boolean NOT NULL DEFAULT false,
  -- Someone changed the engagement while a worker held the run: its next release goes runnable, not waiting.
  wake_requested   boolean NOT NULL DEFAULT false,
  failure_streak   integer NOT NULL DEFAULT 0,
  conflict_streak  integer NOT NULL DEFAULT 0,
  wake_at          timestamptz,
  lease_owner      text,
  lease_until      timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz
);
CREATE UNIQUE INDEX agent_runs_one_active ON agent_runs (engagement_id) WHERE status NOT IN ('completed', 'cancelled', 'failed');
CREATE INDEX agent_runs_due ON agent_runs (status, updated_at);

CREATE FUNCTION lock_ended_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Agent run % is locked: DELETE rejected', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('completed', 'cancelled', 'failed') THEN
    RAISE EXCEPTION 'Agent run % is locked: it has %', OLD.id, OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agent_runs_lock_ended BEFORE UPDATE OR DELETE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION lock_ended_run();
CREATE TRIGGER agent_runs_no_truncate BEFORE TRUNCATE ON agent_runs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- What the run did, step by step: decisions, delegations, tool calls and QA reviews. Append-only.
CREATE TABLE agent_steps (
  run_id          text NOT NULL REFERENCES agent_runs (id),
  seq             integer NOT NULL CHECK (seq > 0),
  kind            text NOT NULL CHECK (kind IN ('decision', 'delegate', 'tool_call', 'qa')),
  agent           text NOT NULL,
  decision        jsonb NOT NULL,
  model           text,
  tokens_in       integer NOT NULL DEFAULT 0,
  tokens_out      integer NOT NULL DEFAULT 0,
  cost_usd        double precision NOT NULL DEFAULT 0,
  duration_ms     integer NOT NULL DEFAULT 0,
  trail_bundle_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
CREATE TRIGGER agent_steps_append_only BEFORE UPDATE OR DELETE ON agent_steps
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER agent_steps_no_truncate BEFORE TRUNCATE ON agent_steps
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- A human gate (spec §4.3): bound to the exact content and basis it was opened on, closed only by a signature.
CREATE TABLE gates (
  id            text PRIMARY KEY,
  seq           bigserial NOT NULL,
  engagement_id text NOT NULL REFERENCES engagements (id),
  run_id        text NOT NULL REFERENCES agent_runs (id),
  kind          text NOT NULL CHECK (kind IN ('scope', 'rcm', 'finding', 'report')),
  subject_key   text NOT NULL,
  subject_id    text NOT NULL,
  subject_hash  text NOT NULL,
  basis_hash    text NOT NULL,
  qa_report     jsonb NOT NULL,
  attempt       integer NOT NULL CHECK (attempt > 0),
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'approved', 'rejected', 'superseded')),
  signature_id  text,
  comment       text NOT NULL DEFAULT '',
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);
CREATE UNIQUE INDEX gates_one_open ON gates (engagement_id, subject_key) WHERE state = 'open';
CREATE INDEX gates_by_engagement ON gates (engagement_id, seq);

CREATE FUNCTION guard_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Gate % is locked: DELETE rejected', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.state <> 'open' THEN
    RAISE EXCEPTION 'Gate % is locked: it is already %', OLD.id, OLD.state USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.seq, NEW.engagement_id, NEW.run_id, NEW.kind, NEW.subject_key, NEW.subject_id, NEW.subject_hash,
      NEW.basis_hash, NEW.qa_report, NEW.attempt, NEW.opened_at)
     IS DISTINCT FROM (OLD.id, OLD.seq, OLD.engagement_id, OLD.run_id, OLD.kind, OLD.subject_key, OLD.subject_id, OLD.subject_hash,
      OLD.basis_hash, OLD.qa_report, OLD.attempt, OLD.opened_at) THEN
    RAISE EXCEPTION 'Gate % is locked: only its state, signature, comment and closing time change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state IN ('approved', 'rejected') AND NEW.signature_id IS NULL THEN
    RAISE EXCEPTION 'Gate % is locked: closing it needs a signature', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER gates_guard BEFORE UPDATE OR DELETE ON gates
  FOR EACH ROW EXECUTE FUNCTION guard_gate();
CREATE TRIGGER gates_no_truncate BEFORE TRUNCATE ON gates
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Signatures and signing requests cover a finding (as before) or a workpaper gate (scope, RCM, report; spec §3.2).
-- Existing rows keep their meaning: the defaults describe them.
ALTER TABLE signatures
  ADD COLUMN subject_kind text NOT NULL DEFAULT 'finding' CHECK (subject_kind IN ('finding', 'workpaper')),
  ADD COLUMN workpaper text CHECK (workpaper IN ('scope', 'rcm', 'report')),
  ADD COLUMN gate_id text,
  ALTER COLUMN finding_id DROP NOT NULL;
ALTER TABLE signatures ADD CONSTRAINT signatures_subject CHECK (
  (subject_kind = 'finding' AND finding_id IS NOT NULL AND workpaper IS NULL AND gate_id IS NULL)
  OR (subject_kind = 'workpaper' AND finding_id IS NULL AND workpaper IS NOT NULL AND gate_id IS NOT NULL AND meaning IN ('Approved', 'Rejected')));

ALTER TABLE sign_intents
  ADD COLUMN subject_kind text NOT NULL DEFAULT 'finding' CHECK (subject_kind IN ('finding', 'workpaper')),
  ADD COLUMN workpaper text CHECK (workpaper IN ('scope', 'rcm', 'report')),
  ADD COLUMN gate_id text,
  ALTER COLUMN finding_id DROP NOT NULL;
ALTER TABLE sign_intents ADD CONSTRAINT sign_intents_subject CHECK (
  (subject_kind = 'finding' AND finding_id IS NOT NULL AND workpaper IS NULL AND gate_id IS NULL)
  OR (subject_kind = 'workpaper' AND finding_id IS NULL AND workpaper IS NOT NULL AND gate_id IS NOT NULL AND action IN ('approve', 'reject')));

-- The API role (009): runs and gates change state in place; steps and revisions are written once.
GRANT SELECT, INSERT, UPDATE ON agent_runs, gates TO audit_api;
GRANT SELECT, INSERT ON agent_steps, workpaper_revisions TO audit_api;
GRANT USAGE ON SEQUENCE gates_seq_seq TO audit_api;
