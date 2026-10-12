---
type: control
title: Batch records are complete and reviewed by QA before release
tags:
  - batch record
  - BMR
  - release
  - QA review
  - signatures
sources:
  - ref: /clauses/21cfr211-188.md
  - ref: /clauses/21cfr211-192.md
  - ref: /clauses/schm-doc.md
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: PH-BR-01
  process_area: Production & batch release
  risk: Release of batches with undetected errors or missing data.
  risk_rating: High
  type: Preventive
  nature: Manual
  frequency: Per batch
  clause_refs:
    - 21CFR211.188
    - 21CFR211.192
    - SCHM-DOC
  evidence_expected:
    - Executed batch records
    - QA review checklists
    - Release certificates
---
## Objective
Every batch record is complete, reviewed and approved by QA before release.

## Test of design
- Inspect the batch record review SOP and release checklist.

## Test of effectiveness
- For sampled released batches confirm the batch record is complete, all entries signed and checked, and QA review completed before release.

## Checklist
- Are all critical steps signed by performer and checker?
- Was QA review completed before release?

## Recommendation
Use a release checklist that blocks release until batch record review is complete and discrepancies are resolved.
