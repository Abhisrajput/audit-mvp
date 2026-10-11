-- People and their sign-in sessions. Users are never deleted, only deactivated,
-- so every trail entry keeps resolving to a person.

CREATE TABLE users (
  id            text PRIMARY KEY,
  issuer        text NOT NULL,
  subject       text NOT NULL,
  name          text NOT NULL,
  email         text,
  role          text CHECK (role IN ('auditor', 'audit_manager', 'cae', 'admin', 'viewer')),
  role_source   text NOT NULL DEFAULT 'idp' CHECK (role_source IN ('idp', 'admin')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (issuer, subject)
);

CREATE TRIGGER users_never_deleted BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION reject_change();

-- id is the SHA-256 of the session cookie value; the raw token is never stored.
CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id),
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX sessions_live_by_user ON sessions (user_id) WHERE revoked_at IS NULL;
