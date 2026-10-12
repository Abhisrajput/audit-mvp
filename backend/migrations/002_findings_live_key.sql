-- A finding id may be reused once its earlier row has been superseded: only live rows must be unique.
ALTER TABLE findings DROP CONSTRAINT findings_pkey;
ALTER TABLE findings ADD PRIMARY KEY (seq);
CREATE UNIQUE INDEX findings_live_id ON findings (engagement_id, id) WHERE superseded_at IS NULL;
