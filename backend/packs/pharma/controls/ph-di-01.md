---
type: control
title: Audit trails are enabled and reviewed
tags:
  - audit trail
  - data integrity
  - ALCOA
  - HPLC
  - LIMS
  - chromatography
sources:
  - ref: /clauses/21cfr11-10-e.md
  - ref: /clauses/eugmp-a11-9.md
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: PH-DI-01
  process_area: Data integrity
  risk: Undetected data manipulation or deletion.
  risk_rating: High
  type: Detective
  nature: IT-dependent manual
  frequency: Per batch
  clause_refs:
    - 21CFR11.10(e)
    - EUGMP-A11-9
  evidence_expected:
    - Audit trail configuration evidence
    - Audit trail review records
    - System admin role list
---
## Objective
GMP-relevant changes in computerised systems are captured in audit trails that are reviewed.

## Test of design
- Confirm audit trails are enabled and cannot be disabled by users on HPLC/LIMS/MES; inspect the audit trail review SOP.

## Test of effectiveness
- For sampled analyses or batches confirm audit trail review was performed and documented before result approval.

## Checklist
- Are audit trails enabled on all GMP systems?
- Is audit trail review performed before release?

## Recommendation
Enable audit trails on all GMP systems and make audit trail review a documented step before result approval.
