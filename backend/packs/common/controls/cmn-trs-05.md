---
type: control
title: Independent price verification of mark-to-market
tags:
  - mark to market
  - valuation
  - price verification
  - month end
  - derivatives
  - MTM
sources:
  - ref: /clauses/coso-p13.md
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: CMN-TRS-05
  process_area: Treasury & commodity risk
  risk: Misstated profits or exposures from inaccurate valuations.
  risk_rating: Medium
  type: Detective
  nature: Manual
  frequency: Monthly
  clause_refs:
    - COSO-P13
  evidence_expected:
    - Month-end price verification files
    - Exchange / vendor price data
---
## Objective
Derivative and inventory valuations use independently sourced market prices.

## Test of design
- Confirm month-end prices are sourced by a function independent of trading.

## Test of effectiveness
- For sampled month-ends re-perform price verification against exchange or vendor data and inspect resolution of differences above threshold.

## Checklist
- Are month-end prices independently verified?
- Are differences above threshold investigated?

## Recommendation
Perform independent month-end price verification with documented investigation of differences.
