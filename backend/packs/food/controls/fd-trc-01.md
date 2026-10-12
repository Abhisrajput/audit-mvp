---
type: control
title: Traceability records allow one-up/one-down trace within 24 hours
tags:
  - traceability
  - lot
  - KDE
  - mass balance
  - 24 hours
  - FSMA 204
sources:
  - ref: /clauses/21cfr1-1455.md
  - ref: /clauses/21cfr1-1315.md
  - ref: /clauses/brcgs-3-9.md
  - ref: /clauses/iso22000-8-3.md
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: FD-TRC-01
  process_area: Traceability & recall
  risk: Inability to scope a recall, broadening impact and regulatory exposure.
  risk_rating: High
  type: Detective
  nature: IT-dependent manual
  frequency: Per batch
  clause_refs:
    - 21CFR1.1455
    - 21CFR1.1315
    - BRCGS-3.9
    - ISO22000-8.3
  evidence_expected:
    - Traceability plan
    - Lot genealogy reports
    - Trace test results
---
## Objective
Lot-level records link incoming materials, production and dispatch and can be produced quickly.

## Test of design
- Inspect the traceability plan, lot code assignment and key data elements captured at receipt, transformation and shipping.

## Test of effectiveness
- Perform a trace exercise on sampled finished lots; time it and confirm full mass balance.

## Checklist
- Can the site trace forward and back within 24 hours?
- Is mass balance achieved?

## Recommendation
Capture lot-level key data elements at each step and test traceability against the 24-hour target.
