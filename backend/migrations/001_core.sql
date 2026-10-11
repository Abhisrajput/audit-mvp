-- Core persistence for engagements, findings, the audit trail and eval runs.
-- The engine's working output stays JSONB; anything later sub-projects query
-- across engagements or must protect with constraints gets real columns.

CREATE TABLE engagements (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  entity          text NOT NULL,
  site            text NOT NULL,
  period_from     text NOT NULL,
  period_to       text NOT NULL,
  audit_type      text NOT NULL,
  scope_statement text NOT NULL,
  pack_ids        jsonb NOT NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  stage           text NOT NULL CHECK (stage IN ('planning', 'rcm', 'fieldwork', 'findings', 'reporting')),
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE engagement_work (
  engagement_id text PRIMARY KEY REFERENCES engagements (id),
  scope         jsonb NOT NULL DEFAULT '[]',
  rcm           jsonb NOT NULL DEFAULT '[]',
  test_inputs   jsonb NOT NULL DEFAULT '{}',
  test_results  jsonb NOT NULL DEFAULT '{}',
  report        jsonb
);

CREATE TABLE findings (
  seq           bigserial NOT NULL UNIQUE,
  engagement_id text NOT NULL REFERENCES engagements (id),
  id            text NOT NULL,
  row_id        text NOT NULL,
  control_id    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('draft', 'blocked', 'reviewed', 'approved', 'rejected')),
  rating        text NOT NULL CHECK (rating IN ('High', 'Medium', 'Low')),
  data          jsonb NOT NULL,
  superseded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_id, id)
);
CREATE INDEX findings_live_idx ON findings (engagement_id, seq) WHERE superseded_at IS NULL;

-- body is the exact JSON of the sealed bundle; hashes are recomputed from it.
CREATE TABLE trail (
  seq           bigint PRIMARY KEY CHECK (seq > 0),
  id            text NOT NULL UNIQUE,
  engagement_id text,
  module_id     text NOT NULL,
  actor         text NOT NULL,
  prev_hash     text NOT NULL,
  hash          text NOT NULL UNIQUE,
  body          text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trail_engagement_idx ON trail (engagement_id, seq);

CREATE TABLE eval_runs (
  id   text PRIMARY KEY,
  at   timestamptz NOT NULL,
  body jsonb NOT NULL
);

CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER trail_append_only BEFORE UPDATE OR DELETE ON trail
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER trail_no_truncate BEFORE TRUNCATE ON trail
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE FUNCTION lock_approved_finding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'Approved finding % is locked: % rejected', OLD.id, TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER findings_lock_approved BEFORE UPDATE OR DELETE ON findings
  FOR EACH ROW EXECUTE FUNCTION lock_approved_finding();
