---
type: control
title: Trade confirmations independently matched
tags:
  - trade
  - confirmation
  - counterparty
  - broker
  - back office
  - derivatives
sources:
  - ref: /clauses/coso-p10.md
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: CMN-TRS-03
  process_area: Treasury & commodity risk
  risk: Fictitious or mis-booked trades remaining undetected.
  risk_rating: High
  type: Detective
  nature: Manual
  frequency: Per event
  clause_refs:
    - COSO-P10
  evidence_expected:
    - Trade blotter
    - Counterparty / broker confirmations
    - Unmatched confirmation log
---
## Objective
Every derivative and physical trade is confirmed with the counterparty by a function independent of the dealer.

## Test of design
- Confirm back office receives confirmations directly from counterparties or brokers.

## Test of effectiveness
- Select a sample of trades and agree trade terms to independent counterparty confirmations; inspect follow-up of unmatched items.

## Checklist
- Is each sampled trade supported by a matched confirmation?
- Are unconfirmed trades chased and escalated?

## Recommendation
Match all confirmations independently and escalate unconfirmed trades past the agreed ageing.
