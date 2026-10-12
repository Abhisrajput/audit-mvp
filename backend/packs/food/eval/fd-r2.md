---
type: eval_case
title: FD-R2
description: Mock recall query finds recall clauses
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: FD-R2
  kind: retrieval
  input:
    query: mock recall not performed this year
  expected:
    clauseIds:
      - BRCGS-3.11
      - ISO22000-8.9.5
    k: 5
---
