---
type: eval_case
title: PH-T1
description: Unreviewed audit trails make the control ineffective
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: PH-T1
  kind: testing
  input:
    controlId: PH-DI-01
    designAdequate: true
    observation: Audit trail review not documented for 5 of 20 HPLC sequences.
    evidenceRefs:
      - HPLC-SEQ-LIST-Q2
    sampleTested: 20
    exceptions: 5
  expected:
    conclusion: Ineffective
---
