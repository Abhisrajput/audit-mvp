---
type: eval_case
title: PH-G1
description: Audit trail finding cites 21 CFR 11.10(e)
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: PH-G1
  kind: gaps
  input:
    controlId: PH-DI-01
    designAdequate: true
    observation: Audit trail review not documented for 5 of 20 HPLC sequences.
    evidenceRefs:
      - HPLC-SEQ-LIST-Q2
    sampleTested: 20
    exceptions: 5
  expected:
    status: draft
    mustCite:
      - 21CFR11.10(e)
      - EUGMP-A11-9
    rating: High
---
