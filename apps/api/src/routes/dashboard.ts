import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { query } from '../db.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const geoJson = JSON.parse(
  readFileSync(join(__dir, '../../../../packages/core/src/geo/rotterdam.geojson'), 'utf8'),
)
const geoJsonFr = JSON.parse(
  readFileSync(join(__dir, '../../../../packages/core/src/geo/ports-fr.geojson'), 'utf8'),
)
const geoJsonBaltic = JSON.parse(
  readFileSync(join(__dir, '../../../../packages/core/src/geo/ports-baltic.geojson'), 'utf8'),
)

interface EventRow {
  id: string
  mmsi: string
  vessel_name: string | null
  event_type: string
  port: string
  timestamp: string
  confidence: number
  anchor_batch_id: string | null
  merkle_root: string | null
  tx_hash: string | null
  evidence: unknown
}

function fmtRow(r: EventRow) {
  const evidence = r.evidence as { corroboration_sources?: string[]; sources?: string[] } | null
  return {
    id:       r.id,
    mmsi:     r.mmsi,
    name:     r.vessel_name,
    type:     r.event_type,
    port:     r.port,
    ts:       r.timestamp,
    conf:     r.confidence,
    anchored: !!r.merkle_root,
    txHash:   r.tx_hash,
    corroborationSources: evidence?.corroboration_sources ?? evidence?.sources ?? [],
  }
}

const EVENT_QUERY = `
  SELECT e.id, e.mmsi, e.vessel_name, e.event_type, e.port,
         e.timestamp, e.confidence, e.anchor_batch_id, e.evidence,
         ab.merkle_root, ab.tx_hash
  FROM events e
  LEFT JOIN anchor_batches ab ON ab.id = e.anchor_batch_id
`

// Each SSE connection costs one DB query every 3 s — cap per client
const SSE_MAX_PER_IP = parseInt(process.env['SSE_MAX_PER_IP'] ?? '4')
const sseConnections = new Map<string, number>()

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (_req, reply) => {
    reply.type('text/html')
    return reply.send(DASHBOARD_HTML)
  })

  app.get('/api/geo/rotterdam', async () => geoJson)
  app.get('/api/geo/ports-fr', async () => geoJsonFr)
  app.get('/api/geo/ports-baltic', async () => geoJsonBaltic)

  // Vessel detail — used by the dashboard panel (public route)
  app.get<{ Params: { mmsi: string } }>('/api/vessels/:mmsi', async (req, reply) => {
    const { mmsi } = req.params
    const [vesselRes, stateRes, eventsRes, voyRes, srcRes] = await Promise.all([
      query<{
        mmsi: string; imo: string | null; name: string | null
        ship_type: number | null; flag_state: string | null
        first_seen: string; last_seen: string
      }>('SELECT mmsi, imo, name, ship_type, flag_state, first_seen, last_seen FROM vessels WHERE mmsi = $1', [mmsi]),
      query<{ state: string }>('SELECT state FROM vessel_states WHERE mmsi = $1', [mmsi]),
      query<{ event_type: string; timestamp: string; confidence: number }>(
        'SELECT event_type, timestamp, confidence FROM events WHERE mmsi = $1 ORDER BY timestamp DESC LIMIT 8', [mmsi],
      ),
      query<{ n: string }>('SELECT COUNT(*) AS n FROM voyages WHERE mmsi = $1 AND period_to IS NOT NULL', [mmsi]),
      query<{ sources: string[] | null }>(
        // 5-min window — must match the consensus gate's corroboration window
        "SELECT array_agg(DISTINCT source) AS sources FROM positions WHERE mmsi = $1 AND time > NOW() - INTERVAL '5 minutes'", [mmsi],
      ),
    ])

    const vessel = vesselRes.rows[0]
    if (!vessel) return reply.code(404).send({ error: 'Vessel not found' })

    return {
      mmsi:         vessel.mmsi,
      imo:          vessel.imo,
      name:         vessel.name,
      shipType:     vessel.ship_type,
      flagState:    vessel.flag_state,
      firstSeen:    vessel.first_seen,
      lastSeen:     vessel.last_seen,
      state:        stateRes.rows[0]?.state ?? null,
      recentEvents: eventsRes.rows,
      voyageCount:  parseInt(voyRes.rows[0]?.n ?? '0'),
      sources:      srcRes.rows[0]?.sources ?? [],
    }
  })

  // Vessel track — last 6 h, bucketed to ~2-min resolution (max ~180 points)
  app.get<{ Params: { mmsi: string } }>('/api/vessels/:mmsi/track', async (req) => {
    const res = await query<{ t: string; lat: number; lon: number; sog: number }>(
      `SELECT time_bucket('2 minutes', time) AS t,
              avg(lat)::float AS lat, avg(lon)::float AS lon, max(sog)::float AS sog
       FROM positions
       WHERE mmsi = $1 AND time > NOW() - INTERVAL '6 hours'
       GROUP BY t ORDER BY t ASC`,
      [req.params.mmsi],
    )
    return { mmsi: req.params.mmsi, points: res.rows }
  })

  // Event detail — used by the dashboard event modal (public route)
  app.get<{ Params: { id: string } }>('/api/events/:id', async (req, reply) => {
    const res = await query<{
      id: string; mmsi: string; imo: string | null; vessel_name: string | null
      event_type: string; port: string; timestamp: string; confidence: number
      confidence_breakdown: unknown; evidence: unknown; signature: string
      anchor_batch_id: string | null; merkle_proof: string[] | null
      merkle_root: string | null; tx_hash: string | null
    }>(
      `SELECT e.id, e.mmsi, e.imo, e.vessel_name, e.event_type, e.port,
              e.timestamp, e.confidence, e.confidence_breakdown, e.evidence,
              e.signature, e.anchor_batch_id, e.merkle_proof,
              ab.merkle_root, ab.tx_hash
       FROM events e
       LEFT JOIN anchor_batches ab ON ab.id = e.anchor_batch_id
       WHERE e.id = $1`,
      [req.params.id],
    )
    const r = res.rows[0]
    if (!r) return reply.code(404).send({ error: 'Event not found' })
    return {
      id: r.id,
      type: r.event_type,
      vessel: { mmsi: r.mmsi, imo: r.imo, name: r.vessel_name },
      port: r.port,
      ts: r.timestamp,
      confidence: r.confidence,
      breakdown: r.confidence_breakdown,
      evidence: r.evidence,
      signature: r.signature,
      anchor: r.anchor_batch_id
        ? { batchId: r.anchor_batch_id, merkleRoot: r.merkle_root, txHash: r.tx_hash, proof: r.merkle_proof ?? [] }
        : null,
    }
  })

  app.get('/api/live', async () => {
    const [vessels, stats] = await Promise.all([
      query(`
        SELECT DISTINCT ON (p.mmsi)
          p.mmsi, p.lat, p.lon, p.sog, p.cog, v.name, vs.state, src.sources
        FROM positions p
        LEFT JOIN vessels v ON v.mmsi = p.mmsi
        LEFT JOIN vessel_states vs ON vs.mmsi = p.mmsi
        LEFT JOIN (
          -- 5-min window — must match the consensus gate's corroboration window
          SELECT mmsi, array_agg(DISTINCT source) AS sources
          FROM positions
          WHERE time > NOW() - INTERVAL '5 minutes'
          GROUP BY mmsi
        ) src ON src.mmsi = p.mmsi
        WHERE p.time > NOW() - INTERVAL '2 hours'
        ORDER BY p.mmsi, p.time DESC
      `),
      query(`
        SELECT
          COUNT(*)                FILTER (WHERE e.timestamp > NOW() - INTERVAL '24h') AS today,
          COUNT(DISTINCT e.mmsi)  FILTER (WHERE e.timestamp > NOW() - INTERVAL '1h')  AS active_1h,
          MAX(ab.confirmed_at)    AS last_anchor
        FROM events e
        LEFT JOIN anchor_batches ab ON ab.id = e.anchor_batch_id
      `),
    ])
    return { vessels: vessels.rows, stats: stats.rows[0] }
  })

  app.get('/stream/events', async (req, reply) => {
    const ip = req.ip
    const active = sseConnections.get(ip) ?? 0
    if (active >= SSE_MAX_PER_IP) {
      return reply.code(429).send({ error: 'Too many concurrent event streams', maxPerIp: SSE_MAX_PER_IP })
    }
    sseConnections.set(ip, active + 1)

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })

    const initial = await query<EventRow>(
      `${EVENT_QUERY} ORDER BY e.id DESC LIMIT 20`,
    )
    const rows = initial.rows.reverse()
    for (const row of rows) {
      reply.raw.write(`data: ${JSON.stringify(fmtRow(row))}\n\n`)
    }
    const nowHex = Date.now().toString(16)
    let lastId = rows.length > 0 ? rows[rows.length - 1]!.id : `evt_${nowHex}`

    const timer = setInterval(async () => {
      try {
        const res = await query<EventRow>(
          `${EVENT_QUERY} WHERE e.id > $1 ORDER BY e.id ASC LIMIT 50`,
          [lastId],
        )
        for (const row of res.rows) {
          reply.raw.write(`data: ${JSON.stringify(fmtRow(row))}\n\n`)
          lastId = row.id
        }
      } catch { /* db gone — will retry */ }
    }, 3000)

    await new Promise<void>(resolve => req.raw.on('close', resolve))
    clearInterval(timer)
    const remaining = (sseConnections.get(ip) ?? 1) - 1
    if (remaining <= 0) sseConnections.delete(ip)
    else sseConnections.set(ip, remaining)
    reply.raw.end()
  })
}

// ─── HTML ──────────────────────────────────────────────────────────────────
// Single-page Leaflet app — lives in dashboard.html next to this file
const DASHBOARD_HTML = readFileSync(join(__dir, 'dashboard.html'), 'utf8')
