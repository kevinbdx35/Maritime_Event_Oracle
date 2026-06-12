export const EVENT_SCHEMA_VERSION = 'maritime-event/v1'

export type EventType =
  | 'PORT_ARRIVAL'
  | 'PORT_DEPARTURE'
  | 'ANCHORAGE_START'
  | 'ANCHORAGE_END'
  | 'AIS_GAP'
  | 'STS_TRANSFER'
  | 'AIS_ANOMALY'
  | 'CORRECTION'

export interface ConfidenceBreakdown {
  message_density: number        // 0-100
  kinematic_consistency: number  // 0-100
  transponder_history: number    // 0-100
  source_quality: number         // 0-100
  source_corroboration: number   // 0-100  (0=1 src, 80=2 srcs, 100=3+ srcs)
  weighted_score: number         // 0-100 final
}

export interface EvidenceWindow {
  positions_window: Array<{
    time: string
    lat: number
    lon: number
    sog: number
    cog: number
  }>
  sources: string[]                   // sources that contributed positions in window
  corroboration_sources: string[]     // independent sources that saw this MMSI in last 10 min
  window_start: string
  window_end: string
  message_count: number
  // STS_TRANSFER specific
  sts?: {
    partner_mmsi: string
    started_at: string
    duration_minutes: number
    distance_m: number
    in_anchorage: boolean
    partner_position: { lat: number; lon: number; time: string }
  }
  // AIS_ANOMALY specific
  anomaly?: {
    kind: 'impossible_jump' | 'source_divergence'
    distance_m: number
    interval_seconds: number
    implied_speed_knots?: number
    conflicting_sources?: string[]
    from: { lat: number; lon: number; time: string; source: string }
    to:   { lat: number; lon: number; time: string; source: string }
  }
}

export interface AnchorInfo {
  batchId: string
  merkleRoot: string
  txHash: string
  blockNumber: number
  proof: string[]
}

export interface MaritimeEvent {
  id: string                         // evt_<uuidv7>
  schema: typeof EVENT_SCHEMA_VERSION
  vessel: {
    mmsi: string
    imo?: string
    name?: string
  }
  event: EventType
  port: string                       // NLRTM
  timestamp: string                  // ISO-8601
  confidence: number                 // 0-100
  confidence_breakdown: ConfidenceBreakdown
  evidence: EvidenceWindow
  signature: string                  // "ed25519:<hex>"
  anchor: AnchorInfo | null          // null until anchored
  // AIS_GAP specific
  gap?: {
    started_at: string
    ended_at?: string
    duration_minutes?: number
    last_position_before?: { lat: number; lon: number }
    first_position_after?: { lat: number; lon: number }
  }
  // CORRECTION specific
  corrects?: string                  // id of original event
}

export interface VoyageSummary {
  id: string                         // voy_<uuidv7>
  schema: 'voyage-summary/v1'
  vessel: { mmsi: string; imo?: string; name?: string }
  port: string
  arrival_event_id: string
  departure_event_id: string
  period: { from: string; to: string }
  distance_nm: number                // geodesic cumulative nm
  speed_profile: {
    p50_knots: number
    p95_knots: number
    samples: number
  }
  time_breakdown: {
    total_hours: number
    underway_hours: number
    anchored_hours: number
    moored_hours: number
  }
  signature: string
  anchor: AnchorInfo | null
}
