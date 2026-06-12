import {
  AISMessageSchema,
  VesselStateMachine,
  GapDetector,
  StsDetector,
  AnomalyDetector,
  computeConfidence,
  signEvent,
  isInArea,
  portFor,
  VesselState,
  EVENT_SCHEMA_VERSION,
} from '@maritime/core'
import type { AISMessage, MaritimeEvent, PositionRecord } from '@maritime/core'
import {
  upsertVessel, insertPosition, insertEvent,
  saveVesselState, loadVesselStates,
} from './db/repository.js'
import { EventEmitter } from 'events'
import { corroborationTracker } from './corroboration.js'
import { openVoyage, closeVoyage } from './voyage.js'
import { flagStateFromMmsi } from '@maritime/core'

// EVT_SIGNING_KEY must be set in environment (64-hex Ed25519 private key)
const SIGNING_KEY = process.env['EVT_SIGNING_KEY'] ?? ''

// In-memory FSM registry
const machines = new Map<string, VesselStateMachine>()
const trackingSince = new Map<string, Date>()

const eventBus = new EventEmitter()
export { eventBus }

const gapDetector = new GapDetector(async (gap) => {
  const machine = machines.get(gap.mmsi)
  const state = machine?.currentState ?? VesselState.UNKNOWN

  const evt = buildEvent({
    mmsi: gap.mmsi,
    type: 'AIS_GAP',
    timestamp: new Date(),
    positions: [],
    gap: {
      started_at: gap.gapStartedAt.toISOString(),
      last_position_before: { lat: gap.lastKnownLat, lon: gap.lastKnownLon },
    },
  })

  await insertEvent(evt)
  eventBus.emit('event', evt)
  console.log(`[gap] AIS_GAP emitted for ${gap.mmsi}`)
})

const stsDetector     = new StsDetector()
const anomalyDetector = new AnomalyDetector()

export async function initProcessor(): Promise<void> {
  const states = await loadVesselStates()
  for (const [mmsi, { state, trackingSinceMinutes }] of states) {
    machines.set(mmsi, new VesselStateMachine(mmsi, state))
    trackingSince.set(mmsi, new Date(Date.now() - trackingSinceMinutes * 60_000))
  }
  console.log(`[processor] restored ${machines.size} vessel states`)
}

export async function processRaw(raw: unknown): Promise<void> {
  const parsed = AISMessageSchema.safeParse(raw)
  if (!parsed.success) return

  const msg = parsed.data
  await processMessage(msg)
}

export async function processMessage(msg: AISMessage): Promise<void> {
  const { mmsi } = msg
  const time = new Date(msg.t)

  // Upsert vessel metadata (with flag state derived from MMSI)
  await upsertVessel(mmsi, msg.imo, msg.name, msg.shipType, flagStateFromMmsi(mmsi))

  const pos: PositionRecord = { mmsi, time, lat: msg.lat, lon: msg.lon, sog: msg.sog, cog: msg.cog, source: msg.source }
  if (msg.heading !== undefined) pos.heading = msg.heading

  // Persist position
  await insertPosition(pos)

  // Track first-seen
  if (!trackingSince.has(mmsi)) {
    trackingSince.set(mmsi, time)
  }

  // Record source for corroboration (before FSM so it's available when building event)
  corroborationTracker.record(mmsi, msg.source)

  // GAP detector: only watch vessels in the area
  if (isInArea(msg.lat, msg.lon)) {
    gapDetector.touch(mmsi, time, msg.lat, msg.lon)
  } else {
    gapDetector.untrack(mmsi)
  }

  // STS + spoofing detectors (independent of the FSM)
  const corroboration = corroborationTracker.getActiveSources(mmsi)

  for (const sts of stsDetector.update(pos)) {
    const evtInput: EventBuildInput = {
      mmsi, type: 'STS_TRANSFER', timestamp: sts.detectedAt,
      positions: [pos], corroborationSources: corroboration,
      sts: {
        partner_mmsi: sts.partnerMmsi,
        started_at: sts.startedAt.toISOString(),
        duration_minutes: sts.durationMinutes,
        distance_m: sts.distanceM,
        in_anchorage: sts.inAnchorage,
        partner_position: { lat: sts.partnerPosition.lat, lon: sts.partnerPosition.lon, time: sts.partnerPosition.time.toISOString() },
      },
    }
    if (msg.imo  !== undefined) evtInput.imo  = msg.imo
    if (msg.name !== undefined) evtInput.name = msg.name
    evtInput.confidence = computeConfidence({
      windowPositions: [pos], trackingAgeMinutes: sts.durationMinutes,
      source: msg.source, corroborationSources: corroboration,
    }).weighted_score
    const evt = buildEvent(evtInput)
    await insertEvent(evt)
    eventBus.emit('event', evt)
    console.log(`[sts] STS_TRANSFER ${mmsi} ↔ ${sts.partnerMmsi} (${sts.durationMinutes} min, ${sts.distanceM} m)`)
  }

  const anomaly = anomalyDetector.update(pos)
  if (anomaly) {
    const evtInput: EventBuildInput = {
      mmsi, type: 'AIS_ANOMALY', timestamp: anomaly.detectedAt,
      positions: [pos], corroborationSources: corroboration,
      anomaly: {
        kind: anomaly.kind,
        distance_m: anomaly.distanceM,
        interval_seconds: anomaly.intervalSeconds,
        ...(anomaly.impliedSpeedKnots !== undefined ? { implied_speed_knots: anomaly.impliedSpeedKnots } : {}),
        ...(anomaly.kind === 'source_divergence' ? { conflicting_sources: anomaly.sources } : {}),
        from: { lat: anomaly.from.lat, lon: anomaly.from.lon, time: anomaly.from.time.toISOString(), source: anomaly.from.source },
        to:   { lat: anomaly.to.lat,   lon: anomaly.to.lon,   time: anomaly.to.time.toISOString(),   source: anomaly.to.source },
      },
    }
    if (msg.imo  !== undefined) evtInput.imo  = msg.imo
    if (msg.name !== undefined) evtInput.name = msg.name
    const ageMin = (time.getTime() - (trackingSince.get(mmsi)?.getTime() ?? time.getTime())) / 60_000
    evtInput.confidence = computeConfidence({
      windowPositions: [pos], trackingAgeMinutes: ageMin,
      source: msg.source, corroborationSources: corroboration,
    }).weighted_score
    const evt = buildEvent(evtInput)
    await insertEvent(evt)
    eventBus.emit('event', evt)
    console.log(`[anomaly] AIS_ANOMALY ${anomaly.kind} for ${mmsi} (${anomaly.distanceM} m in ${anomaly.intervalSeconds}s)`)
  }

  // FSM update
  let machine = machines.get(mmsi)
  if (!machine) {
    machine = new VesselStateMachine(mmsi)
    machines.set(mmsi, machine)
  }

  const transition = machine.update(pos)

  if (transition) {
    const ageMinutes = (time.getTime() - (trackingSince.get(mmsi)?.getTime() ?? time.getTime())) / 60_000
    const corroborationSources = corroborationTracker.getActiveSources(mmsi)
    const breakdown = computeConfidence({
      windowPositions: transition.positions,
      trackingAgeMinutes: ageMinutes,
      source: msg.source,
      corroborationSources,
    })

    const evtInput: EventBuildInput = {
      mmsi, type: transition.eventType, timestamp: transition.timestamp,
      positions: transition.positions, confidence: breakdown.weighted_score,
      breakdown, corroborationSources,
    }
    if (msg.imo  !== undefined) evtInput.imo  = msg.imo
    if (msg.name !== undefined) evtInput.name = msg.name
    const evt = buildEvent(evtInput)

    await insertEvent(evt)
    await saveVesselState(mmsi, machine.currentState, trackingSince.get(mmsi))

    // Voyage lifecycle
    if (transition.eventType === 'PORT_ARRIVAL') {
      const voyParams: Parameters<typeof openVoyage>[0] = { mmsi, arrivalEventId: evt.id, arrivalTime: transition.timestamp, port: evt.port }
      if (msg.imo  !== undefined) voyParams.imo  = msg.imo
      if (msg.name !== undefined) voyParams.name = msg.name
      await openVoyage(voyParams)
    } else if (transition.eventType === 'PORT_DEPARTURE') {
      const voyParams: Parameters<typeof closeVoyage>[0] = { mmsi, departureEventId: evt.id, departureTime: transition.timestamp }
      if (msg.imo  !== undefined) voyParams.imo  = msg.imo
      if (msg.name !== undefined) voyParams.name = msg.name
      await closeVoyage(voyParams)
    }

    eventBus.emit('event', evt)

    console.log(`[fsm] ${mmsi} ${transition.fromState} → ${transition.toState} (${transition.eventType}, conf=${evt.confidence})`)
  }
}

let _evtCounter = 0
function nextId(): string {
  // UUIDv7-style: timestamp prefix + counter + random
  const ts = Date.now().toString(16).padStart(12, '0')
  const rnd = Math.random().toString(16).slice(2, 10)
  const seq = (++_evtCounter).toString(16).padStart(4, '0')
  return `evt_${ts}${seq}${rnd}`
}

interface EventBuildInput {
  mmsi: string
  imo?: string
  name?: string
  type: MaritimeEvent['event']
  timestamp: Date
  positions: PositionRecord[]
  confidence?: number
  breakdown?: MaritimeEvent['confidence_breakdown']
  gap?: MaritimeEvent['gap']
  sts?: MaritimeEvent['evidence']['sts']
  anomaly?: MaritimeEvent['evidence']['anomaly']
  corroborationSources?: string[]
}

function buildEvent(input: EventBuildInput): MaritimeEvent {
  const { breakdown } = input
  const safeBreakdown = breakdown ?? {
    message_density: 0,
    kinematic_consistency: 0,
    transponder_history: 0,
    source_quality: 0,
    source_corroboration: 0,
    weighted_score: input.confidence ?? 0,
  }

  const vessel: MaritimeEvent['vessel'] = { mmsi: input.mmsi }
  if (input.imo  !== undefined) vessel.imo  = input.imo
  if (input.name !== undefined) vessel.name = input.name

  // Resolve port from the position window, scanning backwards — departure
  // windows may end outside the zone. NLRTM fallback for gap/anchorage events.
  let port: string | null = null
  for (let i = input.positions.length - 1; i >= 0 && port === null; i--) {
    port = portFor(input.positions[i]!.lat, input.positions[i]!.lon)
  }

  const evt: MaritimeEvent = {
    id: nextId(),
    schema: EVENT_SCHEMA_VERSION,
    vessel,
    event: input.type,
    port: port ?? 'NLRTM',
    timestamp: input.timestamp.toISOString(),
    confidence: input.confidence ?? safeBreakdown.weighted_score,
    confidence_breakdown: safeBreakdown,
    evidence: {
      positions_window: input.positions.map(p => ({
        time: p.time.toISOString(),
        lat: p.lat, lon: p.lon,
        sog: p.sog, cog: p.cog,
      })),
      sources: [...new Set(input.positions.map(p => p.source))],
      corroboration_sources: input.corroborationSources ?? [],
      window_start: input.positions[0]?.time.toISOString() ?? input.timestamp.toISOString(),
      window_end: input.positions[input.positions.length - 1]?.time.toISOString() ?? input.timestamp.toISOString(),
      message_count: input.positions.length,
    },
    signature: '',
    anchor: null,
  }
  if (input.gap !== undefined) evt.gap = input.gap
  if (input.sts !== undefined) evt.evidence.sts = input.sts
  if (input.anomaly !== undefined) evt.evidence.anomaly = input.anomaly

  // Sign over the event without the signature field itself
  const { signature: _, ...toSign } = evt
  evt.signature = SIGNING_KEY ? signEvent(toSign, SIGNING_KEY) : 'ed25519:unsigned'

  return evt
}
