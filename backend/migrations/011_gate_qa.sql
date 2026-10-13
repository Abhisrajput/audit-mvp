-- REQ-30: every workpaper is reviewed by the QA agent before its gate opens, and the review is shown to the signer.
-- A gate carries the QA report on exactly the content it opened on, so its signer always has one to read.
-- NOT VALID: Postgres does not check rows that already exist when this runs, so gates opened before it are left alone.
-- It does check every new row, and an old row that is updated later (a gate closed or superseded) must then conform.
-- Gates opened by the 2A executor already do: it required a matching QA report before opening one.
ALTER TABLE gates ADD CONSTRAINT gates_qa_report_current CHECK (
  jsonb_typeof(qa_report) = 'object'
  AND qa_report->>'subjectKey' = subject_key
  AND qa_report->>'subjectHash' = subject_hash
) NOT VALID;
