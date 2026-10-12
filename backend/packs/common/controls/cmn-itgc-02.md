---
type: control
title: Segregation of duties enforced in ERP
tags:
  - segregation of duties
  - SoD
  - conflict
  - ERP
  - roles
sources:
  - ref: /clauses/coso-p10.md
  - ref: /clauses/coso-p11.md
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: CMN-ITGC-02
  process_area: IT general controls
  risk: Fraud or error going undetected because one person controls a transaction end to end.
  risk_rating: High
  type: Preventive
  nature: IT-dependent manual
  frequency: Quarterly
  clause_refs:
    - COSO-P10
    - COSO-P11
  evidence_expected:
    - SoD rule set
    - SoD conflict reports
    - Mitigating control evidence
---
## Objective
Incompatible duties (e.g. create vendor and post payment) are not held by one user without mitigation.

## Test of design
- Inspect the SoD rule set and confirm it covers key incompatible duties.

## Test of effectiveness
- Run or inspect the SoD conflict report for sampled quarters and verify conflicts are removed or have documented mitigating controls.

## Checklist
- Are SoD conflicts identified and either removed or mitigated?

## Recommendation
Remediate SoD conflicts or document and operate mitigating controls; review quarterly.
