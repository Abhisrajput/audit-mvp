---
type: eval_case
title: CMN-G1
description: Hedge documentation exception cites IFRS 9 6.4.1
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: CMN-G1
  kind: gaps
  input:
    controlId: CMN-TRS-04
    designAdequate: true
    observation: 3 hedge relationships were documented after the designation date.
    evidenceRefs:
      - HEDGE-FILES-H1
    sampleTested: 10
    exceptions: 3
  expected:
    status: draft
    mustCite:
      - IFRS9-6.4.1
---
