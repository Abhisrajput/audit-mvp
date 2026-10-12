---
type: control
title: Independent daily monitoring of positions against limits
tags:
  - position
  - limit
  - breach
  - middle office
  - monitoring
  - commodity
  - daily
  - exposure
sources:
  - ref: /clauses/coso-p10.md
  - ref: /clauses/coso-p16.md
generated:
  by: mvp-pack-migration
  at: 2026-10-11
verified: null
status: active
stale_after: 2027-10-11
x_audit:
  id: CMN-TRS-02
  process_area: Treasury & commodity risk
  risk: Limit breaches not detected or escalated, increasing exposure to price movements.
  risk_rating: High
  type: Detective
  nature: IT-dependent manual
  frequency: Daily
  clause_refs:
    - COSO-P10
    - COSO-P16
  evidence_expected:
    - Daily position vs limit reports
    - Breach escalation emails / log
---
## Objective
Open commodity and FX positions are monitored daily against limits by a function independent of trading.

## Test of design
- Confirm the middle office is independent of the front office and that breach escalation is defined.

## Test of effectiveness
- For sampled days inspect the daily position report, evidence of review and escalation of any breach.

## Checklist
- Was the daily position report reviewed by middle office?
- Were breaches escalated and approved per policy?

## Recommendation
Ensure independent daily limit monitoring with documented escalation and approval of every breach.
