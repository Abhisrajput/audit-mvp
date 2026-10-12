-- The document registry: every file the platform holds (evidence, SOPs, policies,
-- prior reports, regulations) with who may read it, plus its text in searchable chunks.
-- Documents are never deleted; retention is a flag.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id                text PRIMARY KEY,
  sha256            text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  filename          text NOT NULL,
  mime              text NOT NULL,
  size              bigint NOT NULL CHECK (size >= 0),
  kind              text NOT NULL CHECK (kind IN ('evidence', 'sop', 'policy', 'prior_report', 'regulation', 'okf_concept', 'other')),
  classification    text NOT NULL CHECK (classification IN ('internal', 'confidential', 'restricted')),
  engagement_id     text REFERENCES engagements (id),
  uploaded_by       text NOT NULL REFERENCES users (id),
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  retain_until      date,
  retention_expired boolean NOT NULL DEFAULT false,
  metadata          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX documents_scope_idx ON documents (engagement_id, uploaded_at);
CREATE INDEX documents_sha_idx ON documents (sha256);
CREATE TRIGGER documents_never_deleted BEFORE DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION reject_change();

CREATE TABLE document_text (
  document_id       text PRIMARY KEY REFERENCES documents (id),
  extractor         text NOT NULL,
  extractor_version text NOT NULL,
  text              text NOT NULL,
  pages             jsonb NOT NULL DEFAULT '[]',
  extracted_at      timestamptz NOT NULL DEFAULT now()
);

-- A chunk belongs to a document now, or to a knowledge-graph node later (plan 1E).
-- classification and engagement_id are copied from the parent so search filters in SQL.
CREATE TABLE chunks (
  id             text PRIMARY KEY,
  document_id    text REFERENCES documents (id),
  kg_node_id     text,
  ordinal        integer NOT NULL CHECK (ordinal >= 0),
  page           integer,
  text           text NOT NULL,
  tsv            tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  embedding      vector,
  classification text NOT NULL CHECK (classification IN ('internal', 'confidential', 'restricted')),
  engagement_id  text REFERENCES engagements (id),
  CHECK ((document_id IS NULL) <> (kg_node_id IS NULL)),
  UNIQUE (document_id, ordinal)
);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX chunks_scope_idx ON chunks (classification, engagement_id);
