---
type: control
title: Three-way match before invoice payment
tags:
  - invoice
  - purchase order
  - goods receipt
  - three-way match
  - payments
sources:
  - ref: /clauses/coso-p10.md
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: CMN-P2P-02
  process_area: Procure to pay
  risk: Payment for goods not ordered or not received.
  risk_rating: Medium
  type: Preventive
  nature: Automated
  frequency: Per event
  clause_refs:
    - COSO-P10
  evidence_expected:
    - ERP configuration screenshots
    - Paid invoice listing
    - Override log
---
## Objective
Invoices are paid only when matched to an approved purchase order and goods receipt within tolerance.

## Test of design
- Inspect the ERP match configuration and tolerance settings.
- Confirm who can override a match block.

## Test of effectiveness
- Select a sample of paid invoices and agree each to PO and GRN within tolerance.
- Inspect overrides of match blocks for approval.

## Checklist
- Are match tolerances configured as per policy?
- Are match-block overrides approved?

## Recommendation
Restrict match-block overrides to authorised approvers and review overrides monthly.
