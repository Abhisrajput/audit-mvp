-- The knowledge graph compiled from the OKF bundles in backend/packs (spec §6).
-- kg_nodes is the live graph: one row per concept at the pack version last compiled,
-- updated in place by compile, never deleted (a concept that leaves its bundle is deprecated).
-- kg_node_versions is the append-only history: every concept at every compiled pack version.

CREATE TABLE kg_nodes (
  id             text PRIMARY KEY,                -- <pack>/<type>/<slug>
  type           text NOT NULL CHECK (type IN ('pack', 'regulation', 'clause', 'control', 'risk', 'eval_case')),
  pack_id        text NOT NULL,
  pack_version   text NOT NULL,
  concept_id     text NOT NULL,                   -- x_audit.id: the id engagements and findings store
  title          text NOT NULL,
  description    text,
  body           text NOT NULL,
  tags           jsonb NOT NULL DEFAULT '[]',
  sources        jsonb NOT NULL DEFAULT '[]',     -- OKF sources: [{ ref }], links and external URLs as written
  attrs          jsonb NOT NULL DEFAULT '{}',     -- x_audit
  generated      jsonb,
  verified_by    text,
  verified_role  text,
  verified_at    date,
  status         text NOT NULL CHECK (status IN ('active', 'deprecated')),
  stale_after    date,
  source_path    text NOT NULL,
  source_sha256  text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  classification text NOT NULL CHECK (classification IN ('internal', 'confidential', 'restricted')),
  compiled_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((verified_by IS NULL AND verified_role IS NULL AND verified_at IS NULL)
      OR (verified_by IS NOT NULL AND verified_role IS NOT NULL AND verified_at IS NOT NULL)),
  UNIQUE (type, concept_id)
);
CREATE INDEX kg_nodes_pack_idx ON kg_nodes (pack_id, type);
CREATE TRIGGER kg_nodes_never_deleted BEFORE DELETE ON kg_nodes
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER kg_nodes_no_truncate BEFORE TRUNCATE ON kg_nodes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TABLE kg_node_versions (
  node_id       text NOT NULL,
  pack_version  text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot      jsonb NOT NULL,
  compiled_at   timestamptz NOT NULL DEFAULT now(),
  compiled_by   text NOT NULL,
  PRIMARY KEY (node_id, pack_version)
);
CREATE TRIGGER kg_node_versions_append_only BEFORE UPDATE OR DELETE ON kg_node_versions
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER kg_node_versions_no_truncate BEFORE TRUNCATE ON kg_node_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Curated edges come from the bundles and are rewritten by compile; their approval is the merged pull request.
-- 'engagement' and 'proposed' edges arrive with later sub-projects.
CREATE TABLE kg_edges (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_id     text NOT NULL REFERENCES kg_nodes (id),
  to_id       text NOT NULL REFERENCES kg_nodes (id),
  rel         text NOT NULL CHECK (rel ~ '^[a-z][a-z_]*$'),
  origin      text NOT NULL CHECK (origin IN ('curated', 'engagement', 'proposed')),
  created_by  text NOT NULL,
  source_ref  jsonb,
  approved_by text,
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (origin <> 'curated' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  UNIQUE (from_id, to_id, rel, origin)
);
CREATE INDEX kg_edges_to_idx ON kg_edges (to_id, rel);

-- Knowledge-graph chunks belong to a node, one per ordinal.
ALTER TABLE chunks ADD CONSTRAINT chunks_kg_node_fk FOREIGN KEY (kg_node_id) REFERENCES kg_nodes (id);
CREATE UNIQUE INDEX chunks_kg_node_ordinal_idx ON chunks (kg_node_id, ordinal) WHERE kg_node_id IS NOT NULL;

-- Ruling carried from 1D: an embedding may be filled in once (sub-project 7 computes them);
-- nothing else about a document chunk may change. Same message shape as reject_change().
CREATE FUNCTION reject_chunk_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.embedding IS NULL AND NEW.embedding IS NOT NULL
     AND (to_jsonb(OLD) - 'embedding' - 'tsv') IS NOT DISTINCT FROM (to_jsonb(NEW) - 'embedding' - 'tsv') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'chunks is append-only: UPDATE rejected (only a missing embedding may be filled in)' USING ERRCODE = 'insufficient_privilege';
END
$$;
DROP TRIGGER chunks_document_update ON chunks;
CREATE TRIGGER chunks_document_update BEFORE UPDATE ON chunks
  FOR EACH ROW WHEN (OLD.document_id IS NOT NULL) EXECUTE FUNCTION reject_chunk_change();
