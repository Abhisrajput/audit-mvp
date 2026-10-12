---
type: control
title: Unique user accounts and controlled access to GMP systems
tags:
  - user access
  - shared account
  - password
  - admin
  - data integrity
sources:
  - ref: /clauses/21cfr11-10-d.md
  - ref: /clauses/21cfr11-300.md
  - ref: /clauses/eugmp-a11-12.md
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: PH-DI-02
  process_area: Data integrity
  risk: Actions cannot be attributed to individuals, undermining data integrity.
  risk_rating: High
  type: Preventive
  nature: IT-dependent manual
  frequency: Quarterly
  clause_refs:
    - 21CFR11.10(d)
    - 21CFR11.300
    - EUGMP-A11-12
  evidence_expected:
    - User lists
    - Access request/removal records
    - Role matrices
---
## Objective
Each user has a unique account with role-appropriate access; no shared or generic accounts.

## Test of design
- Inspect user management SOP and role definitions for GMP systems.

## Test of effectiveness
- Obtain user lists for sampled systems; confirm no shared accounts, leavers removed, and admin rights segregated from users.

## Checklist
- Are there shared or generic accounts?
- Do analysts have admin rights?

## Recommendation
Remove shared accounts, segregate administrator rights and review access quarterly.
