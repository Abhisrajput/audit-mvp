---
type: control
title: Vendor master changes are approved and independently reviewed
tags:
  - vendor
  - master data
  - bank details
  - procurement
  - payments
  - P2P
sources:
  - ref: /clauses/coso-p10.md
  - ref: /clauses/coso-p12.md
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: CMN-P2P-01
  process_area: Procure to pay
  risk: Fraudulent or erroneous payments through unauthorised changes to vendor bank details.
  risk_rating: High
  type: Preventive
  nature: IT-dependent manual
  frequency: Per event
  clause_refs:
    - COSO-P10
    - COSO-P12
  evidence_expected:
    - Vendor master change log
    - Approved change request forms
    - Call-back verification records
---
## Objective
Only authorised, validated changes are made to vendor master data, including bank details.

## Test of design
- Inspect the vendor master change SOP and confirm approval and call-back verification requirements.
- Confirm the ERP restricts vendor master maintenance to the master-data team.

## Test of effectiveness
- From the vendor master change log select a sample and inspect approval evidence and independent bank-detail call-back for each.
- Confirm the change log is complete by reconciling to ERP table change history.

## Checklist
- Is every vendor bank-detail change supported by an approved request?
- Was an independent call-back performed before the change took effect?

## Recommendation
Enforce approval and independent call-back for all vendor bank-detail changes, and review the ERP change log monthly.
