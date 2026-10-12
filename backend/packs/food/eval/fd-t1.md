---
type: eval_case
title: FD-T1
description: Unsigned monitoring records make the control ineffective
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: FD-T1
  kind: testing
  input:
    controlId: FD-HACCP-03
    designAdequate: true
    observation: 4 of 20 roaster CCP temperature logs were unsigned.
    evidenceRefs:
      - CCP-LOG-ROAST-MAR
    sampleTested: 20
    exceptions: 4
  expected:
    conclusion: Ineffective
---
