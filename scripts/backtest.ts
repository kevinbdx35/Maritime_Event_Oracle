// Calibration backtest: compares detected PORT_ARRIVAL / PORT_DEPARTURE events
// against official port-call records (ground truth) and reports precision,
// recall and a confidence-calibration table.
//
// Ground truth source: Digitraffic Port Call API (Finnish Transport
// Infrastructure Agency, open data) — covers Finnish ports only, so the
// backtest runs on FI* events (Helsinki zone). ATA/ATD with source "Port"
// are the port authority's own actuals.
//
// Usage:
//   pnpm backtest                          # last 7 days, ±90 min, cargo+tanker
//   pnpm backtest -- --from 2026-06-01 --to 2026-06-12 --tolerance-min 60
//   pnpm backtest -- --all-ship-types     # include harbour craft (see below)
//   (the “--” is required for pnpm to forward flags to the script)
//
// By default only merchant vessels (AIS ship type 70-89, cargo + tanker) are
// scored: harbour traffic — Suomenlinna ferries, pilot boats, tugs — triggers
// genuine zone events but never files official port calls, so including it
// makes precision structurally unmeasurable (verified empirically: 2.5 %
// "precision" on the full population vs the same detector on merchants only).
//
// Reading the output:
//   precision  = matched events / detected events   (are our events real?)
//   recall     = matched calls  / official calls    (do we see everything?)
//   The calibration table shows the observed match rate per confidence
//   bucket — a well-calibrated 80 % bucket should match ~80 % of the time.

import { Pool } from 'pg'

interface Args { from: Date; to: Date; toleranceMin: number; merchantOnly: boolean }

function parseArgs(): Args {
  const get = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag)
    return i > -1 ? process.argv[i + 1] : undefined
  }
  const to = get('--to') ? new Date(get('--to')!) : new Date()
  const from = get('--from') ? new Date(get('--from')!) : new Date(to.getTime() - 7 * 86_400_000)
  const toleranceMin = parseInt(get('--tolerance-min') ?? '90')
  return { from, to, toleranceMin, merchantOnly: !process.argv.includes('--all-ship-types') }
}

interface DetectedEvent {
  id: string
  mmsi: string
  event_type: 'PORT_ARRIVAL' | 'PORT_DEPARTURE'
  port: string
  timestamp: Date
  confidence: number
  matched?: boolean
  deltaMin?: number
}

interface TruthRecord {
  mmsi: string
  port: string
  type: 'PORT_ARRIVAL' | 'PORT_DEPARTURE'
  time: Date
  matched?: boolean
}

async function fetchGroundTruth(locode: string, from: Date, to: Date): Promise<TruthRecord[]> {
  // `from` filters on portCallTimestamp (declaration time), which can precede
  // the actual arrival by days — widen the query window accordingly.
  const queryFrom = new Date(from.getTime() - 7 * 86_400_000).toISOString()
  const url = `https://meri.digitraffic.fi/api/port-call/v1/port-calls?locode=${locode}&from=${queryFrom}`
  const res = await fetch(url, {
    headers: { 'Digitraffic-User': process.env['DIGITRAFFIC_USER'] ?? 'gwagenn-backtest', 'Accept-Encoding': 'gzip' },
  })
  if (!res.ok) throw new Error(`Digitraffic ${res.status} for ${locode}`)
  const data = await res.json() as {
    portCalls: Array<{
      mmsi: number | null
      portToVisit: string
      portAreaDetails: Array<{ ata?: string | null; atd?: string | null; ataSource?: string; atdSource?: string }>
    }>
  }

  const truth: TruthRecord[] = []
  const inWindow = (t: Date) => t >= from && t <= to
  for (const call of data.portCalls) {
    if (!call.mmsi) continue
    const mmsi = String(call.mmsi)
    for (const area of call.portAreaDetails ?? []) {
      const ata = area.ata ? new Date(area.ata) : null
      const atd = area.atd ? new Date(area.atd) : null
      if (ata && inWindow(ata)) truth.push({ mmsi, port: call.portToVisit, type: 'PORT_ARRIVAL', time: ata })
      if (atd && inWindow(atd)) truth.push({ mmsi, port: call.portToVisit, type: 'PORT_DEPARTURE', time: atd })
    }
  }
  return truth
}

function matchEvents(events: DetectedEvent[], truth: TruthRecord[], toleranceMs: number): void {
  // Greedy nearest-in-time matching, one truth record per event
  for (const evt of events) {
    let best: TruthRecord | null = null
    let bestDelta = Infinity
    for (const t of truth) {
      if (t.matched || t.mmsi !== evt.mmsi || t.type !== evt.event_type || t.port !== evt.port) continue
      const delta = Math.abs(t.time.getTime() - evt.timestamp.getTime())
      if (delta <= toleranceMs && delta < bestDelta) { best = t; bestDelta = delta }
    }
    if (best) {
      best.matched = true
      evt.matched = true
      evt.deltaMin = Math.round(bestDelta / 60_000)
    }
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1)}%`
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

async function main(): Promise<void> {
  const { from, to, toleranceMin, merchantOnly } = parseArgs()
  const pool = new Pool({
    host: process.env['DB_HOST'] ?? 'localhost',
    port: parseInt(process.env['DB_PORT'] ?? '5432'),
    database: process.env['DB_NAME'] ?? 'maritime',
    user: process.env['DB_USER'] ?? 'maritime',
    password: process.env['DB_PASSWORD'] ?? 'maritime_dev',
  })

  // Clamp the scoring window to actual ingestion coverage — recall against
  // days we never observed measures our uptime, not the detector.
  const cov = await pool.query<{ lo: Date | null; hi: Date | null }>(
    `SELECT MIN(time) AS lo, MAX(time) AS hi FROM positions
     WHERE lat > 59.0 AND lon > 23.0 AND time BETWEEN $1 AND $2`,
    [from, to],
  )
  const lo = cov.rows[0]?.lo
  const hi = cov.rows[0]?.hi
  if (!lo || !hi) {
    console.log(`\nNo Gulf of Finland positions between ${from.toISOString()} and ${to.toISOString()} — nothing to score.`)
    await pool.end()
    return
  }
  const scoreFrom = lo > from ? lo : from
  const scoreTo   = hi < to ? hi : to

  const { rows } = await pool.query<DetectedEvent>(
    `SELECT e.id, e.mmsi, e.event_type, e.port, e.timestamp, e.confidence
     FROM events e
     LEFT JOIN vessels v ON v.mmsi = e.mmsi
     WHERE e.event_type IN ('PORT_ARRIVAL','PORT_DEPARTURE')
       AND e.port LIKE 'FI%'
       AND e.timestamp BETWEEN $1 AND $2
       ${merchantOnly ? 'AND v.ship_type BETWEEN 70 AND 89' : ''}
     ORDER BY e.timestamp`,
    [scoreFrom, scoreTo],
  )
  await pool.end()

  const events = rows.map(r => ({ ...r, timestamp: new Date(r.timestamp) }))
  const locodes = [...new Set(events.map(e => e.port))]
  console.log(`\nRequested window: ${from.toISOString()} → ${to.toISOString()}`)
  console.log(`Scored window   : ${scoreFrom.toISOString()} → ${scoreTo.toISOString()} (clamped to ingestion coverage)`)
  console.log(`Tolerance       : ±${toleranceMin} min`)
  console.log(`Population      : ${merchantOnly ? 'merchant vessels (AIS type 70-89)' : 'all ship types'}`)
  console.log(`Detected events : ${events.length} (ports: ${locodes.join(', ') || '—'})`)

  if (!events.length) {
    console.log('\nNo FI* port events in window — let the ingestor run on the Gulf of Finland zone first.')
    return
  }

  const truth: TruthRecord[] = []
  for (const locode of locodes) {
    const t = await fetchGroundTruth(locode, scoreFrom, scoreTo)
    console.log(`Ground truth    : ${t.length} official ATA/ATD for ${locode}`)
    truth.push(...t)
  }

  // Vessels that never file port calls (harbour craft, fishing, pleasure)
  // make precision unmeasurable — report them separately.
  const truthMmsis = new Set(truth.map(t => t.mmsi))
  const outOfUniverse = events.filter(e => !truthMmsis.has(e.mmsi))
  if (outOfUniverse.length) {
    console.log(`Out of universe : ${outOfUniverse.length}/${events.length} events from vessels with no port-call record at all (excluded from precision)`)
  }

  matchEvents(events, truth, toleranceMin * 60_000)

  console.log('\n── Results ─────────────────────────────────────────')
  for (const type of ['PORT_ARRIVAL', 'PORT_DEPARTURE'] as const) {
    const evts = events.filter(e => e.event_type === type && truthMmsis.has(e.mmsi))
    const tru  = truth.filter(t => t.type === type)
    const matched = evts.filter(e => e.matched)
    const deltas = matched.map(e => e.deltaMin!)
    console.log(`\n${type}`)
    console.log(`  precision : ${pct(matched.length, evts.length)}  (${matched.length}/${evts.length} events confirmed by port authority)`)
    console.log(`  recall    : ${pct(tru.filter(t => t.matched).length, tru.length)}  (${tru.filter(t => t.matched).length}/${tru.length} official calls detected)`)
    console.log(`  median Δt : ${median(deltas) ?? '—'} min`)
  }

  console.log('\n── Confidence calibration ──────────────────────────')
  const buckets: Array<[number, number]> = [[0, 50], [50, 65], [65, 80], [80, 101]]
  for (const [lo, hi] of buckets) {
    const inB = events.filter(e => e.confidence >= lo && e.confidence < hi)
    const ok  = inB.filter(e => e.matched)
    console.log(`  conf ${String(lo).padStart(2)}–${hi > 100 ? 100 : hi}  : ${pct(ok.length, inB.length).padStart(6)}  match rate (${ok.length}/${inB.length})`)
  }
  console.log('\nA bucket is well calibrated when its match rate ≈ its confidence range.')
  console.log('Caveats: AIS zone-entry vs berth ATA differ by pilotage time; tolerance absorbs this.\n')
}

main().catch(e => { console.error(e); process.exit(1) })
