-- The API's database role (plan 1A carry-over (a), REQ-20). The API logs in as a member of audit_api;
-- migrations and pack compiles keep the owner login. audit_api owns nothing, so it can neither alter nor drop a
-- table or its append-only triggers, and it holds no DELETE, TRUNCATE or TRIGGER privilege anywhere.
-- Nothing is granted by default: a table added later is unreachable to the API until its migration grants it
-- (tests/db-roles.test.ts fails until the table is classified there). Append-only tables get SELECT, INSERT only.
--
-- Roles are cluster-wide. Creating the API login (cli create-api-login) needs a login with CREATEROLE (an administrator);
-- if the migrating login can't create roles, an administrator creates audit_api (NOLOGIN) beforehand.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_api') THEN
    CREATE ROLE audit_api NOLOGIN;
  END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM audit_api;
GRANT USAGE ON SCHEMA public TO audit_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO audit_api;

-- Working state the API changes in place (never deletes: users, findings and documents have their own guards).
GRANT INSERT, UPDATE ON engagements, engagement_work, findings, users, sessions, sign_intents TO audit_api;

-- The record: written once, never changed by the API.
GRANT INSERT ON trail, signatures, finding_revisions, documents, document_text, chunks, blob_uploads, eval_runs TO audit_api;

-- findings.seq is a bigserial: inserting a finding draws from its sequence.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO audit_api;

-- kg_nodes, kg_node_versions, kg_edges and schema_migrations stay read-only: packs:compile and migrate run as the owner.
