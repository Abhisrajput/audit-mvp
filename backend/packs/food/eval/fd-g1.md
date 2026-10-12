---
type: eval_case
title: FD-G1
description: CCP monitoring finding cites Codex principle 4 and 21 CFR 117.145
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: FD-G1
  kind: gaps
  input:
    controlId: FD-HACCP-03
    designAdequate: true
    observation: 4 of 20 roaster CCP temperature logs were unsigned.
    evidenceRefs:
      - CCP-LOG-ROAST-MAR
    sampleTested: 20
    exceptions: 4
  expected:
    status: draft
    mustCite:
      - CODEX-HACCP-P4
      - 21CFR117.145
    rating: High
---
