-- Evidence management, plan 3A (spec docs/superpowers/specs/2026-10-22-evidence-management-design.md §3.1).
-- Every attempt to turn a document's stored bytes into text is one row, so a document always has an extraction status
-- and a failed or retried attempt leaves its history. Append-only; the latest attempt wins.
CREATE TABLE document_extractions (
  id                serial PRIMARY KEY,
  document_id       text NOT NULL REFERENCES documents (id),
  attempt           integer NOT NULL CHECK (attempt >= 1),
  extractor         text NOT NULL,
  extractor_version text NOT NULL,
  status            text NOT NULL CHECK (status IN ('ok', 'no_text', 'failed', 'too_large', 'unsupported', 'client')),
  chars             integer NOT NULL DEFAULT 0 CHECK (chars >= 0),
  pages             integer CHECK (pages IS NULL OR pages >= 0),
  error             text,
  extracted_at      timestamptz NOT NULL DEFAULT now(),
  extracted_by      text NOT NULL REFERENCES users (id),
  UNIQUE (document_id, attempt)
);
CREATE TRIGGER document_extractions_append_only BEFORE UPDATE OR DELETE ON document_extractions
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER document_extractions_no_truncate BEFORE TRUNCATE ON document_extractions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

GRANT SELECT, INSERT ON document_extractions TO audit_api;
GRANT USAGE ON SEQUENCE document_extractions_id_seq TO audit_api;
