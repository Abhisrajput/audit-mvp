-- 21 CFR Part 11 electronic signatures. A signature binds a person, a meaning
-- and a time to the exact content signed (its SHA-256). Signatures and the
-- revisions they refer to are never updated or deleted.

CREATE TABLE finding_revisions (
  engagement_id text NOT NULL,
  finding_id    text NOT NULL,
  revision      integer NOT NULL CHECK (revision > 0),
  content_hash  text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_id, finding_id, revision)
);
CREATE TRIGGER finding_revisions_append_only BEFORE UPDATE OR DELETE ON finding_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER finding_revisions_no_truncate BEFORE TRUNCATE ON finding_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TABLE signatures (
  id              text PRIMARY KEY,
  engagement_id   text NOT NULL REFERENCES engagements (id),
  finding_id      text NOT NULL,
  user_id         text NOT NULL,
  user_name       text NOT NULL,
  role            text NOT NULL,
  meaning         text NOT NULL CHECK (meaning IN ('Reviewed', 'Approved', 'Rejected')),
  comment         text NOT NULL DEFAULT '',
  content_hash    text NOT NULL,
  reauth_method   text NOT NULL CHECK (reauth_method IN ('oidc', 'dev', 'none')),
  reauth_at       timestamptz,
  intent_id       text,
  trail_bundle_id text NOT NULL,
  signed_at       timestamptz NOT NULL
);
CREATE INDEX signatures_by_finding ON signatures (engagement_id, finding_id, signed_at);
CREATE TRIGGER signatures_append_only BEFORE UPDATE OR DELETE ON signatures
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER signatures_no_truncate BEFORE TRUNCATE ON signatures
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- A signing request: what is about to be signed, by whom, and the one-time
-- OIDC values for its re-authentication. Single use, short-lived.
CREATE TABLE sign_intents (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users (id),
  engagement_id   text NOT NULL REFERENCES engagements (id),
  finding_id      text NOT NULL,
  action          text NOT NULL CHECK (action IN ('review', 'approve', 'reject')),
  comment         text NOT NULL DEFAULT '',
  content_hash    text NOT NULL,
  state           text NOT NULL UNIQUE,
  nonce           text NOT NULL,
  code_verifier   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'signed', 'failed')),
  failure_code    text,
  failure_message text,
  completed_at    timestamptz
);
