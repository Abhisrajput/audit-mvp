-- Evidence-based drafting 3B (spec §9.1): the agent's proposed test results, by RCM row id.
-- They travel with the engagement's working state but are never part of a workpaper hash. An empty object is
-- exactly what every engagement created before this migration has.
ALTER TABLE engagement_work
  ADD COLUMN test_drafts jsonb NOT NULL DEFAULT '{}'::jsonb;
