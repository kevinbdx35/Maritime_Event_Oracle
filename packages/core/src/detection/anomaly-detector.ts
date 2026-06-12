// AIS anomaly detector — two spoofing signatures:
//
// 1. impossible_jump: consecutive positions FROM THE SAME SOURCE imply a
//    speed no vessel can sustain. Same-source only, so multi-source timing
//    skew cannot fake a teleport.
// 2. source_divergence: two sources report the same MMSI at widely
//    different locations within a short window — one of them is wrong
//    (spoofed transmission, MMSI cloning, or feed corruption).
//
// One anomaly per (mmsi, kind) per debounce window, so a persistently bad
// feed produces a signal, not a flood.

import type { PositionRecord } from '../types/vessel.js'
import { distanceMeters } from '../geo/index.js'

const MAX_PLAUSIBLE_SPEED_KN = 60
const MIN_JUMP_DISTANCE_M    = 2_000     // ignore GPS jitter at berth
const MAX_JUMP_INTERVAL_MS   = 30 * 60_000 // beyond this a jump is just a data gap
const DIVERGENCE_WINDOW_MS   = 2 * 60_000
const DIVERGENCE_DISTANCE_M  = 5_000
const DEBOUNCE_MS            = 30 * 60_000
const METERS_PER_NM          = 1_852

export type AnomalyKind = 'impossible_jump' | 'source_divergence'

export interface AnomalyDetection {
  mmsi: string
  kind: AnomalyKind
  detectedAt: Date
  distanceM: number
  intervalSeconds: number
  impliedSpeedKnots?: number
  sources: string[]
  from: { lat: number; lon: number; time: Date; source: string }
  to:   { lat: number; lon: number; time: Date; source: string }
}

export class AnomalyDetector {
  // mmsi → source → last position from that source
  private lastBySource = new Map<string, Map<string, PositionRecord>>()
  // `${mmsi}|${kind}` → last report time (ms)
  private reportedAt = new Map<string, number>()

  /** Feed every position; returns at most one anomaly per update. */
  update(pos: PositionRecord): AnomalyDetection | null {
    let bySource = this.lastBySource.get(pos.mmsi)
    if (!bySource) {
      bySource = new Map()
      this.lastBySource.set(pos.mmsi, bySource)
    }

    const detection = this.checkJump(pos, bySource) ?? this.checkDivergence(pos, bySource)
    bySource.set(pos.source, pos)
    return detection
  }

  private checkJump(pos: PositionRecord, bySource: Map<string, PositionRecord>): AnomalyDetection | null {
    const prev = bySource.get(pos.source)
    if (!prev) return null

    const dtMs = pos.time.getTime() - prev.time.getTime()
    if (dtMs <= 0 || dtMs > MAX_JUMP_INTERVAL_MS) return null

    const dist = distanceMeters(prev.lat, prev.lon, pos.lat, pos.lon)
    if (dist < MIN_JUMP_DISTANCE_M) return null

    const impliedKn = (dist / METERS_PER_NM) / (dtMs / 3_600_000)
    if (impliedKn <= MAX_PLAUSIBLE_SPEED_KN) return null
    if (this.debounced(pos.mmsi, 'impossible_jump', pos.time)) return null

    return {
      mmsi: pos.mmsi,
      kind: 'impossible_jump',
      detectedAt: pos.time,
      distanceM: Math.round(dist),
      intervalSeconds: Math.round(dtMs / 1000),
      impliedSpeedKnots: Math.round(impliedKn * 10) / 10,
      sources: [pos.source],
      from: { lat: prev.lat, lon: prev.lon, time: prev.time, source: prev.source },
      to:   { lat: pos.lat,  lon: pos.lon,  time: pos.time,  source: pos.source },
    }
  }

  private checkDivergence(pos: PositionRecord, bySource: Map<string, PositionRecord>): AnomalyDetection | null {
    for (const [source, other] of bySource) {
      if (source === pos.source) continue
      const dtMs = Math.abs(pos.time.getTime() - other.time.getTime())
      if (dtMs > DIVERGENCE_WINDOW_MS) continue

      const dist = distanceMeters(other.lat, other.lon, pos.lat, pos.lon)
      if (dist < DIVERGENCE_DISTANCE_M) continue
      if (this.debounced(pos.mmsi, 'source_divergence', pos.time)) return null

      return {
        mmsi: pos.mmsi,
        kind: 'source_divergence',
        detectedAt: pos.time,
        distanceM: Math.round(dist),
        intervalSeconds: Math.round(dtMs / 1000),
        sources: [other.source, pos.source],
        from: { lat: other.lat, lon: other.lon, time: other.time, source: other.source },
        to:   { lat: pos.lat,   lon: pos.lon,   time: pos.time,   source: pos.source },
      }
    }
    return null
  }

  private debounced(mmsi: string, kind: AnomalyKind, now: Date): boolean {
    const key = `${mmsi}|${kind}`
    const last = this.reportedAt.get(key)
    if (last !== undefined && now.getTime() - last < DEBOUNCE_MS) return true
    this.reportedAt.set(key, now.getTime())
    return false
  }
}
