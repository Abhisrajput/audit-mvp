-- Expert Auditor 8A (spec §3): the auditor-entered engagement context, the scope coverage statement, and the judgment memos.
-- All three travel with the engagement's working state. NULL context and coverage, and an empty memos object, are
-- exactly what every engagement created before this migration has.
ALTER TABLE engagement_work
  ADD COLUMN context  jsonb,
  ADD COLUMN coverage jsonb,
  ADD COLUMN memos    jsonb NOT NULL DEFAULT '{}'::jsonb;
