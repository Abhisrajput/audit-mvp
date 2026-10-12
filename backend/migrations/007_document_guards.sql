-- The registry is evidence: a document, its text, its chunks and the record of who uploaded
-- which bytes never change once written. The one exception is the retention flag.
-- Errors use the same wording and SQLSTATE as reject_change() (001), so callers see one shape.

CREATE FUNCTION reject_document_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(OLD) - 'retention_expired') IS DISTINCT FROM (to_jsonb(NEW) - 'retention_expired') THEN
    RAISE EXCEPTION 'documents is append-only: UPDATE rejected (only retention_expired may change)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER documents_only_retention_changes BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION reject_document_change();
CREATE TRIGGER documents_no_truncate BEFORE TRUNCATE ON documents
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER document_text_append_only BEFORE UPDATE OR DELETE ON document_text
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER document_text_no_truncate BEFORE TRUNCATE ON document_text
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Document chunks are fixed; knowledge-graph chunks (plan 1E, document_id IS NULL) get their own rules there.
-- Note for 1E: this also freezes chunks.embedding on document chunks, so an embedding backfill needs a ruling.
CREATE TRIGGER chunks_document_update BEFORE UPDATE ON chunks
  FOR EACH ROW WHEN (OLD.document_id IS NOT NULL) EXECUTE FUNCTION reject_change();
CREATE TRIGGER chunks_document_delete BEFORE DELETE ON chunks
  FOR EACH ROW WHEN (OLD.document_id IS NOT NULL) EXECUTE FUNCTION reject_change();
CREATE TRIGGER chunks_no_truncate BEFORE TRUNCATE ON chunks
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER blob_uploads_append_only BEFORE UPDATE OR DELETE ON blob_uploads
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER blob_uploads_no_truncate BEFORE TRUNCATE ON blob_uploads
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
