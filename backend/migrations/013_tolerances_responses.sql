-- Expert internal auditor, plan 8B (spec docs/superpowers/specs/2026-10-21-expert-auditor-design.md §3.3).
-- Two person-made records live outside every workpaper hash, so recording one never stales an approved gate or
-- triggers a redraft cascade: a tolerance on a row would re-sign the RCM, and an approved finding is locked and
-- bound to its signatures, so a management response cannot live on it. Both are append-only; the latest row wins.

-- The exception rate a person accepts for one control. Keyed by control so it survives an RCM rebuild. None means 0.
CREATE TABLE test_tolerances (
  id              text PRIMARY KEY,
  engagement_id   text NOT NULL REFERENCES engagements (id),
  control_id      text NOT NULL,
  rate            numeric(4,3) NOT NULL CHECK (rate >= 0 AND rate <= 0.25),
  recorded_by     text NOT NULL REFERENCES users (id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  trail_bundle_id text NOT NULL
);
CREATE INDEX test_tolerances_by_control ON test_tolerances (engagement_id, control_id, recorded_at);
CREATE TRIGGER test_tolerances_append_only BEFORE UPDATE OR DELETE ON test_tolerances
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER test_tolerances_no_truncate BEFORE TRUNCATE ON test_tolerances
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Management's answer to a finding. A new answer is a new row; the history stays.
CREATE TABLE finding_responses (
  id              text PRIMARY KEY,
  engagement_id   text NOT NULL REFERENCES engagements (id),
  finding_id      text NOT NULL,
  response        text NOT NULL CHECK (response IN ('agree', 'partially_agree', 'disagree')),
  owner           text NOT NULL,
  due_date        date,
  action_plan     text NOT NULL DEFAULT '',
  recorded_by     text NOT NULL REFERENCES users (id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  trail_bundle_id text NOT NULL
);
CREATE INDEX finding_responses_by_finding ON finding_responses (engagement_id, finding_id, recorded_at);
CREATE TRIGGER finding_responses_append_only BEFORE UPDATE OR DELETE ON finding_responses
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER finding_responses_no_truncate BEFORE TRUNCATE ON finding_responses
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

GRANT SELECT, INSERT ON test_tolerances, finding_responses TO audit_api;
