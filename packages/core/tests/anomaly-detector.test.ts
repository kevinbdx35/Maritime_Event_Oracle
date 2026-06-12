import { describe, it, expect, beforeEach } from 'vitest'
import { AnomalyDetector } from '../src/detection/anomaly-detector.js'
import type { PositionRecord } from '../src/types/vessel.js'

const T0 = new Date('2026-06-12T10:00:00Z').getTime()
const min = (n: number) => new Date(T0 + n * 60_000)

function pos(time: Date, lat: number, lon: number, source = 'aisstream'): PositionRecord {
  return { mmsi: '111111111', time, lat, lon, sog: 10, cog: 0, source }
}

describe('AnomalyDetector — impossible_jump', () => {
  let det: AnomalyDetector
  beforeEach(() => { det = new AnomalyDetector() })

  it('flags a same-source teleport (15 km in 5 min ≈ 97 kn)', () => {
    expect(det.update(pos(min(0), 52.0, 3.0))).toBeNull()
    const a = det.update(pos(min(5), 52.135, 3.0)) // ~15 km north
    expect(a).not.toBeNull()
    expect(a!.kind).toBe('impossible_jump')
    expect(a!.impliedSpeedKnots).toBeGreaterThan(60)
    expect(a!.sources).toEqual(['aisstream'])
  })

  it('accepts plausible fast movement (~30 kn)', () => {
    det.update(pos(min(0), 52.0, 3.0))
    // ~4.6 km in 5 min ≈ 30 kn
    expect(det.update(pos(min(5), 52.0417, 3.0))).toBeNull()
  })

  it('ignores cross-source interleaving for the jump check', () => {
    det.update(pos(min(0), 52.0, 3.0, 'aisstream'))
    // different source far away within 2 min → divergence, NOT a jump
    const a = det.update(pos(min(1), 52.135, 3.0, 'digitraffic'))
    expect(a?.kind).toBe('source_divergence')
  })

  it('debounces repeated jumps for the same vessel', () => {
    det.update(pos(min(0), 52.0, 3.0))
    expect(det.update(pos(min(5), 52.135, 3.0))).not.toBeNull()
    expect(det.update(pos(min(10), 52.0, 3.0))).toBeNull() // jumped back — debounced
  })

  it('treats a long silence then distant position as a gap, not a jump', () => {
    det.update(pos(min(0), 52.0, 3.0))
    expect(det.update(pos(min(45), 52.3, 3.0))).toBeNull() // 45 min > jump window
  })
})

describe('AnomalyDetector — source_divergence', () => {
  let det: AnomalyDetector
  beforeEach(() => { det = new AnomalyDetector() })

  it('flags two sources reporting the same MMSI 13 km apart within 2 min', () => {
    det.update(pos(min(0), 52.0, 3.0, 'aisstream'))
    const a = det.update(pos(min(1), 52.0, 3.2, 'aishub')) // ~13.7 km east
    expect(a).not.toBeNull()
    expect(a!.kind).toBe('source_divergence')
    expect(a!.sources.sort()).toEqual(['aishub', 'aisstream'])
    expect(a!.distanceM).toBeGreaterThan(5000)
  })

  it('accepts small cross-source offsets', () => {
    det.update(pos(min(0), 52.0, 3.0, 'aisstream'))
    expect(det.update(pos(min(1), 52.005, 3.0, 'aishub'))).toBeNull() // ~550 m
  })

  it('ignores stale positions from the other source', () => {
    det.update(pos(min(0), 52.0, 3.0, 'aisstream'))
    expect(det.update(pos(min(10), 52.0, 3.2, 'aishub'))).toBeNull() // 10 min apart
  })
})
