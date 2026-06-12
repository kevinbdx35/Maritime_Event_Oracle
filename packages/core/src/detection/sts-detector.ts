// STS (ship-to-ship transfer) detector: two vessels quasi-stationary within
// hailing distance of each other, outside any port zone, sustained for at
// least MIN_DURATION. Classic signature of cargo/fuel transfers at sea —
// a key signal for sanctions-evasion monitoring.
//
// Port zones are excluded (berthed vessels sit side by side legitimately);
// anchorage zones are NOT excluded — STS in anchorages is common and still
// reportable — but the detection is flagged with in_anchorage so consumers
// can weigh it.

import type { PositionRecord } from '../types/vessel.js'
import { isInPort, isInAnchorage, distanceMeters } from '../geo/index.js'

const STATIONARY_MAX_SOG_KN  = 0.8
const PAIRING_DISTANCE_M     = 300
const SEPARATION_DISTANCE_M  = 600       // hysteresis: pair ends only past this
const MIN_DURATION_MS        = 30 * 60_000
const POSITION_TTL_MS        = 10 * 60_000

export interface StsDetection {
  mmsi: string
  partnerMmsi: string
  startedAt: Date
  detectedAt: Date
  durationMinutes: number
  distanceM: number
  lat: number
  lon: number
  inAnchorage: boolean
  partnerPosition: { lat: number; lon: number; time: Date }
}

interface StationaryVessel {
  pos: PositionRecord
  since: Date          // first fix of the current stationary episode
}

interface PairState {
  startedAt: Date
  reported: boolean
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export class StsDetector {
  private stationary = new Map<string, StationaryVessel>()
  private pairs = new Map<string, PairState>()

  /** Feed every position; returns STS detections triggered by this update. */
  update(pos: PositionRecord): StsDetection[] {
    this.expireStale(pos.time)

    if (pos.sog > STATIONARY_MAX_SOG_KN) {
      this.forget(pos.mmsi)
      return []
    }

    const existing = this.stationary.get(pos.mmsi)
    this.stationary.set(pos.mmsi, { pos, since: existing?.since ?? pos.time })

    if (isInPort(pos.lat, pos.lon)) return []

    const detections: StsDetection[] = []
    for (const [otherMmsi, other] of this.stationary) {
      if (otherMmsi === pos.mmsi) continue
      if (isInPort(other.pos.lat, other.pos.lon)) continue

      const dist = distanceMeters(pos.lat, pos.lon, other.pos.lat, other.pos.lon)
      const key = pairKey(pos.mmsi, otherMmsi)
      const pair = this.pairs.get(key)

      if (dist > SEPARATION_DISTANCE_M) {
        this.pairs.delete(key)
        continue
      }
      if (dist > PAIRING_DISTANCE_M && !pair) continue

      if (!pair) {
        this.pairs.set(key, { startedAt: pos.time, reported: false })
        continue
      }

      const durationMs = pos.time.getTime() - pair.startedAt.getTime()
      if (!pair.reported && durationMs >= MIN_DURATION_MS) {
        pair.reported = true
        detections.push({
          mmsi: pos.mmsi,
          partnerMmsi: otherMmsi,
          startedAt: pair.startedAt,
          detectedAt: pos.time,
          durationMinutes: Math.round(durationMs / 60_000),
          distanceM: Math.round(dist),
          lat: pos.lat,
          lon: pos.lon,
          inAnchorage: isInAnchorage(pos.lat, pos.lon).inside,
          partnerPosition: { lat: other.pos.lat, lon: other.pos.lon, time: other.pos.time },
        })
      }
    }
    return detections
  }

  private forget(mmsi: string): void {
    this.stationary.delete(mmsi)
    for (const key of this.pairs.keys()) {
      const [a, b] = key.split('|')
      if (a === mmsi || b === mmsi) this.pairs.delete(key)
    }
  }

  private expireStale(now: Date): void {
    for (const [mmsi, v] of this.stationary) {
      if (now.getTime() - v.pos.time.getTime() > POSITION_TTL_MS) this.forget(mmsi)
    }
  }
}
