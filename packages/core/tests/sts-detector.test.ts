import { describe, it, expect, beforeEach } from 'vitest'
import { StsDetector } from '../src/detection/sts-detector.js'
import type { PositionRecord } from '../src/types/vessel.js'

// Coordinates outside all zones (North Sea approach) — from state-machine tests
const SEA_LAT = 51.830
const SEA_LON = 3.500
// Inside the Rotterdam port polygon
const PORT_LAT = 51.900
const PORT_LON = 4.300
// Inside the Maasanker North anchorage
const ANCH_LAT = 51.990
const ANCH_LON = 3.870

// ~0.0015° latitude ≈ 167 m
const NEARBY = 0.0015

const T0 = new Date('2026-06-12T10:00:00Z').getTime()
const min = (n: number) => new Date(T0 + n * 60_000)

function pos(mmsi: string, time: Date, lat: number, lon: number, sog = 0.2): PositionRecord {
  return { mmsi, time, lat, lon, sog, cog: 0, source: 'test' }
}

describe('StsDetector', () => {
  let det: StsDetector
  beforeEach(() => { det = new StsDetector() })

  // Feed both vessels every 5 min (stays under the 10-min staleness TTL)
  function runPair(latA: number, lonA: number, latB: number, lonB: number, minutes: number) {
    const all = []
    for (let m = 0; m <= minutes; m += 5) {
      all.push(...det.update(pos('111111111', min(m), latA, lonA)))
      all.push(...det.update(pos('222222222', min(m), latB, lonB)))
    }
    return all
  }

  it('detects two vessels stationary side by side at sea for 30+ minutes', () => {
    const hits = runPair(SEA_LAT, SEA_LON, SEA_LAT + NEARBY, SEA_LON, 35)
    expect(hits).toHaveLength(1)
    const sts = hits[0]!
    expect([sts.mmsi, sts.partnerMmsi].sort()).toEqual(['111111111', '222222222'])
    expect(sts.durationMinutes).toBeGreaterThanOrEqual(30)
    expect(sts.distanceM).toBeLessThan(300)
    expect(sts.inAnchorage).toBe(false)
  })

  it('reports each pair episode only once', () => {
    runPair(SEA_LAT, SEA_LON, SEA_LAT + NEARBY, SEA_LON, 35)
    const more = runPair(SEA_LAT, SEA_LON, SEA_LAT + NEARBY, SEA_LON, 60)
    expect(more).toHaveLength(0)
  })

  it('does not fire before 30 minutes together', () => {
    const hits = runPair(SEA_LAT, SEA_LON, SEA_LAT + NEARBY, SEA_LON, 25)
    expect(hits).toHaveLength(0)
  })

  it('ignores vessels berthed inside a port zone', () => {
    const hits = runPair(PORT_LAT, PORT_LON, PORT_LAT + NEARBY, PORT_LON, 60)
    expect(hits).toHaveLength(0)
  })

  it('flags in_anchorage when the rendezvous happens in an anchorage', () => {
    const hits = runPair(ANCH_LAT, ANCH_LON, ANCH_LAT + NEARBY, ANCH_LON, 35)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.inAnchorage).toBe(true)
  })

  it('resets the pair when one vessel gets underway', () => {
    runPair(SEA_LAT, SEA_LON, SEA_LAT + NEARBY, SEA_LON, 20)
    // vessel B sails off at t+25
    det.update(pos('222222222', min(25), SEA_LAT + NEARBY, SEA_LON, 8.0))
    // both stationary again — episode must restart from zero
    const hits = []
    for (let m = 30; m <= 50; m += 5) {
      hits.push(...det.update(pos('111111111', min(m), SEA_LAT, SEA_LON)))
      hits.push(...det.update(pos('222222222', min(m), SEA_LAT + NEARBY, SEA_LON)))
    }
    expect(hits).toHaveLength(0)
  })

  it('ignores vessels far apart', () => {
    // ~1.1 km apart
    const hits = runPair(SEA_LAT, SEA_LON, SEA_LAT + 0.01, SEA_LON, 60)
    expect(hits).toHaveLength(0)
  })
})
