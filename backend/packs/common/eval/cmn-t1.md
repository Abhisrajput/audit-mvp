---
type: eval_case
title: CMN-T1
description: Limit breach not escalated is ineffective
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: CMN-T1
  kind: testing
  input:
    controlId: CMN-TRS-02
    designAdequate: true
    observation: On 2 of 30 days the coffee position exceeded the volume limit and the breach was not escalated.
    evidenceRefs:
      - DPR-2026-03
    sampleTested: 30
    exceptions: 2
  expected:
    conclusion: Ineffective
---
