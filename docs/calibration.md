# Confidence calibration — methodology & first results

## Why

An explainable confidence score is an assertion; a **calibrated** score is a
product. This backtest measures our detected events against official port
authority records, so we can publish "X % of our PORT_ARRIVAL events are
confirmed by the port authority" instead of asking clients to trust the score.

## Ground truth

**Digitraffic Port Call API** (Finnish Transport Infrastructure Agency, open
data): every commercial call at a Finnish port files arrival/departure
declarations; `portAreaDetails[].ata/.atd` with source `Port` are the port
authority's own actual times. Finland only — which is why the backtest scores
the Gulf of Finland zone (FIHEL), not Rotterdam (the Port of Rotterdam API
requires a commercial agreement; same harness, different fetcher, when we get
access).

## Method

`pnpm backtest` (see `scripts/backtest.ts`):

1. Load detected `PORT_ARRIVAL` / `PORT_DEPARTURE` events for FI* ports.
2. **Clamp the scoring window to actual ingestion coverage** — recall against
   days the ingestor wasn't running measures uptime, not the detector.
3. Restrict to merchant vessels (AIS ship type 70–89) by default, and exclude
   vessels that never appear in the port-call registry ("out of universe":
   Suomenlinna ferries, pilot boats, tugs — they trigger genuine zone events
   but never file port calls, making precision structurally unmeasurable).
4. Greedy nearest-in-time matching, same MMSI + port + direction, ±90 min
   tolerance (absorbs pilotage time between zone entry and berth ATA).
5. Report precision / recall / median Δt per event type, plus the match rate
   per confidence bucket (a well-calibrated 80 % bucket matches ~80 %).

## First results (2026-06-12)

One day of Gulf of Finland ingestion (2026-06-11). Findings:

- **The full-population numbers are meaningless**: 43/48 FIHEL events came
  from harbour craft that never file port calls (2.5 % apparent precision).
  Hence the merchant-only default and the out-of-universe exclusion.
- **Merchant recall is ~0 % (0/23 arrivals)**: with a single day of coverage,
  sparse Vuosaari traffic (~650 positions/day) and the ≥ 2-source consensus
  gate, the FSM rarely accumulates enough in-zone positions to fire on the
  vessels that matter commercially. This is the headline finding: **Gulf of
  Finland coverage is not yet dense enough to certify Helsinki port calls.**

## Next steps

1. Let the ingestor run continuously for ≥ 2 weeks, re-run.
2. If merchant recall stays low, investigate consensus-gate fallbacks and FSM
   hysteresis parameters against Vuosaari traffic specifically.
3. Once recall is healthy, publish the calibration table in the README and
   re-run weekly (CI cron) so the published numbers stay honest.
