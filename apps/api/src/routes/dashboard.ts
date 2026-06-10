import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { query } from '../db.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const geoJson = JSON.parse(
  readFileSync(join(__dir, '../../../../packages/core/src/geo/rotterdam.geojson'), 'utf8'),
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

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (_req, reply) => {
    reply.type('text/html')
    return reply.send(DASHBOARD_HTML)
  })

  app.get('/api/geo/rotterdam', async () => geoJson)

  // Vessel detail — used by the dashboard panel (public route)
  app.get<{ Params: { mmsi: string } }>('/api/vessels/:mmsi', async (req, reply) => {
    const { mmsi } = req.params
    const [vesselRes, stateRes, eventsRes, voyRes] = await Promise.all([
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
    }
  })

  app.get('/api/live', async () => {
    const [vessels, stats] = await Promise.all([
      query(`
        SELECT DISTINCT ON (p.mmsi)
          p.mmsi, p.lat, p.lon, p.sog, p.cog, v.name, vs.state
        FROM positions p
        LEFT JOIN vessels v ON v.mmsi = p.mmsi
        LEFT JOIN vessel_states vs ON vs.mmsi = p.mmsi
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
    reply.raw.end()
  })
}

// ─── HTML ──────────────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maritime Event Oracle</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:     #0d1117;
    --bg2:    #161b22;
    --bg3:    #21262d;
    --border: #30363d;
    --text:   #e6edf3;
    --muted:  #8b949e;
    --teal:   #00d4aa;
    --orange: #ff8c00;
    --blue:   #4dabf7;
    --red:    #ff4444;
    --yellow: #e3b341;
    --mono:   'SF Mono','Cascadia Code','Consolas',monospace;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 13px; }

  #header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 16px; background: var(--bg2); border-bottom: 1px solid var(--border);
    height: 48px; flex-shrink: 0;
  }
  #header h1 { font-size: 14px; font-weight: 600; letter-spacing: .4px; }
  #header h1 em { color: var(--teal); font-style: normal; }
  #live-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--muted); margin-right: 6px; transition: background .3s;
  }
  #live-dot.on { background: var(--teal); box-shadow: 0 0 6px var(--teal); }
  #live-label { font-size: 11px; color: var(--muted); }

  body { display: flex; flex-direction: column; }
  #main { display: grid; grid-template-columns: 1fr 380px; flex: 1; min-height: 0; }
  #map-wrap { position: relative; }
  #map  { width: 100%; height: 100%; }

  #feed-panel { background: var(--bg2); border-left: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  #feed-hdr   { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); letter-spacing: 1px; text-transform: uppercase; flex-shrink: 0; }
  #evt-count  { color: var(--teal); font-weight: 700; }
  #feed-list  { overflow-y: auto; flex: 1; padding: 8px; }

  .card {
    background: var(--bg3); border: 1px solid var(--border); border-radius: 6px;
    padding: 10px 12px; margin-bottom: 6px;
    animation: fadeIn .25s ease;
  }
  .card:hover { border-color: var(--teal); }
  @keyframes fadeIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
  .r1 { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
  .r2 { display:flex; gap:8px; margin-bottom:3px; }
  .r3 { display:flex; justify-content:space-between; color:var(--muted); font-size:11px; }
  .etype { font-weight:700; font-size:12px; }
  .etype.PORT_ARRIVAL    { color:var(--teal);   }
  .etype.PORT_DEPARTURE  { color:var(--orange); }
  .etype.ANCHORAGE_START,.etype.ANCHORAGE_END { color:var(--blue);   }
  .etype.AIS_GAP         { color:var(--red);    }
  .badge { font-size:10px; padding:2px 6px; border-radius:10px; background:var(--bg); border:1px solid var(--border); }
  .badge.hi { border-color:var(--teal);   color:var(--teal);   }
  .badge.md { border-color:var(--yellow); color:var(--yellow); }
  .badge.lo { border-color:var(--red);    color:var(--red);    }
  .vname { font-weight:600; max-width:160px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
  .vname:hover { color:var(--teal); text-decoration:underline; }
  .mmsi  { color:var(--muted); }
  .chain { font-size:10px; color:var(--blue); }

  #footer {
    height: 40px; flex-shrink: 0; background: var(--bg2); border-top: 1px solid var(--border);
    display: flex; align-items: center; padding: 0 16px; gap: 32px; font-size: 11px; color: var(--muted);
  }
  #footer b { color: var(--text); font-weight: 600; }

  .src-multi  { font-size:10px; color:var(--teal); font-weight:600; }
  .src-single { font-size:10px; color:var(--muted); }

  .leaflet-container { background: #0a0f14; }
  .leaflet-popup-content-wrapper, .leaflet-popup-tip {
    background: var(--bg2); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; font-family: var(--mono); font-size: 12px; box-shadow: none;
  }

  /* ── Vessel panel ──────────────────────────────────────────────────────── */
  #vessel-panel {
    position: absolute; top: 0; left: 0; bottom: 0; z-index: 1000;
    width: 300px;
    background: var(--bg2); border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    transform: translateX(-100%);
    transition: transform .25s cubic-bezier(.4,0,.2,1);
    box-shadow: 4px 0 24px #0008;
    overflow: hidden;
  }
  #vessel-panel.open { transform: translateX(0); }

  #vp-photo {
    width: 100%; height: 170px; object-fit: cover; background: var(--bg3);
    flex-shrink: 0; display: block;
  }
  #vp-photo-wrap { position: relative; flex-shrink: 0; }
  #vp-close {
    position: absolute; top: 8px; right: 8px;
    background: #0009; border: 1px solid var(--border); color: var(--text);
    width: 28px; height: 28px; border-radius: 50%; cursor: pointer;
    font-size: 16px; line-height: 28px; text-align: center;
    transition: background .15s;
  }
  #vp-close:hover { background: var(--bg2); }

  #vp-body { padding: 14px 16px; overflow-y: auto; flex: 1; }

  #vp-name { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
  #vp-sub  { font-size: 11px; color: var(--muted); margin-bottom: 14px; letter-spacing: .3px; }

  .vp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .vp-field label { display: block; font-size: 10px; text-transform: uppercase;
    letter-spacing: 1px; color: var(--muted); margin-bottom: 3px; }
  .vp-field span  { font-size: 12px; font-weight: 600; }

  .state-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;
    border: 1px solid currentColor;
  }
  .state-MOORED    { color: var(--teal);   }
  .state-ANCHORED  { color: var(--blue);   }
  .state-AT_SEA    { color: var(--yellow); }
  .state-APPROACHING { color: var(--yellow); }
  .state-UNKNOWN   { color: var(--muted);  }

  #vp-events-hdr { font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--muted); margin-bottom: 8px; border-top: 1px solid var(--border); padding-top: 14px; }
  .vp-event { display: flex; justify-content: space-between; align-items: center;
    padding: 5px 0; border-bottom: 1px solid var(--bg3); font-size: 11px; }
  .vp-event:last-child { border-bottom: none; }
  .vp-event .ve-type { font-weight: 600; }
  .vp-event .ve-conf { color: var(--muted); }

  #vp-mt-link { display: block; margin-top: 16px; font-size: 11px; color: var(--blue);
    text-decoration: none; text-align: center; padding: 6px; border: 1px solid var(--border);
    border-radius: 4px; }
  #vp-mt-link:hover { background: var(--bg3); }

  #vp-loading { text-align: center; padding: 40px 0; color: var(--muted); font-size: 12px; }
  #vp-error   { color: var(--red); text-align: center; padding: 20px; font-size: 12px; }
</style>
</head>
<body>

<div id="header">
  <h1>Maritime Event Oracle &nbsp;·&nbsp; <em>NLRTM</em> Rotterdam</h1>
  <div><span id="live-dot"></span><span id="live-label">connecting…</span></div>
</div>

<div id="main">
  <div id="map-wrap">
    <div id="map"></div>

    <!-- Vessel info panel (slides in over the map) -->
    <div id="vessel-panel">
      <div id="vp-photo-wrap">
        <img id="vp-photo" alt="vessel photo"/>
        <button id="vp-close" onclick="closePanel()">✕</button>
      </div>
      <div id="vp-body">
        <div id="vp-loading">Loading…</div>
      </div>
    </div>
  </div>

  <div id="feed-panel">
    <div id="feed-hdr"><span>Live Events</span><span id="evt-count">0</span></div>
    <div id="feed-list"></div>
  </div>
</div>

<div id="footer">
  <span>Events today: <b id="s-today">—</b></span>
  <span>Active vessels (1h): <b id="s-vessels">—</b></span>
  <span>Last anchor: <b id="s-anchor">—</b></span>
</div>

<script>
const ICONS  = { PORT_ARRIVAL:'↓', PORT_DEPARTURE:'↑', ANCHORAGE_START:'⚓', ANCHORAGE_END:'⚓', AIS_GAP:'⚠' };
const ETYPE_COLOR = { PORT_ARRIVAL:'#00d4aa', PORT_DEPARTURE:'#ff8c00', ANCHORAGE_START:'#4dabf7', ANCHORAGE_END:'#4dabf7', AIS_GAP:'#ff4444' };

// AIS ship type → human label
function shipTypeLabel(t) {
  if (!t) return '—';
  if (t >= 70 && t <= 79) return '📦 Cargo';
  if (t >= 80 && t <= 89) return '🛢️ Tanker';
  if (t >= 60 && t <= 69) return '🛳️ Passenger';
  if (t === 30)            return '🎣 Fishing';
  if (t === 31 || t === 32) return '🔗 Towing';
  if (t === 35)            return '⚔️ Military';
  if (t === 36)            return '⛵ Sailing';
  if (t === 37)            return '🚤 Pleasure';
  if (t === 50)            return '🧭 Pilot';
  if (t === 51)            return '🆘 SAR';
  if (t === 52)            return '⚓ Tug';
  if (t === 55)            return '🚔 Law enforcement';
  if (t >= 90 && t <= 99) return '🚢 Other';
  return '🚢 Type ' + t;
}

// ISO alpha-2 → flag emoji
function flagEmoji(cc) {
  if (!cc) return '';
  const base = 0x1F1E6 - 65;
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c => base + c.charCodeAt(0)));
}

// ── Vessel panel ─────────────────────────────────────────────────────────────
const panel = document.getElementById('vessel-panel');
const vpBody = document.getElementById('vp-body');
const vpPhoto = document.getElementById('vp-photo');

const SHIP_PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 170">'
  + '<rect width="300" height="170" fill="#21262d"/>'
  + '<g fill="#30363d">'
  + '<path d="M80 110 L150 60 L220 110 Z"/>'
  + '<rect x="130" y="60" width="40" height="30"/>'
  + '<rect x="145" y="40" width="10" height="20"/>'
  + '<rect x="60" y="110" width="180" height="20" rx="4"/>'
  + '</g>'
  + '<text x="150" y="155" text-anchor="middle" font-size="11" fill="#8b949e" font-family="monospace">No photo available</text>'
  + '</svg>'
);

function closePanel() {
  panel.classList.remove('open');
}

function openVesselPanel(mmsi) {
  vpBody.innerHTML = '<div id="vp-loading">Loading…</div>';
  vpPhoto.src = SHIP_PLACEHOLDER;
  panel.classList.add('open');

  // Try MarineTraffic photo (informal but widely used)
  const photoUrl = 'https://photos.marinetraffic.com/ais/showphoto.aspx?mmsi=' + mmsi;
  vpPhoto.onerror = () => { vpPhoto.src = SHIP_PLACEHOLDER; vpPhoto.onerror = null; };
  vpPhoto.src = photoUrl;

  fetch('/api/vessels/' + mmsi)
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(v => renderVesselPanel(v))
    .catch(() => {
      vpBody.innerHTML = '<div id="vp-error">Could not load vessel data.</div>';
    });
}

function ago(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function renderVesselPanel(v) {
  const flag    = flagEmoji(v.flagState);
  const stCls   = 'state-badge state-' + (v.state || 'UNKNOWN');
  const stLabel = v.state || 'Unknown';

  const eventsHtml = (v.recentEvents || []).map(e => {
    const col = ETYPE_COLOR[e.event_type] || '#8b949e';
    const ts  = new Date(e.timestamp).toLocaleDateString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    return '<div class="vp-event">'
      + '<span class="ve-type" style="color:' + col + '">' + (ICONS[e.event_type]||'•') + ' ' + e.event_type.replace(/_/g,' ') + '</span>'
      + '<span class="ve-conf">' + Number(e.confidence).toFixed(0) + '% · ' + ts + '</span>'
      + '</div>';
  }).join('');

  const mtMmsi = v.mmsi.replace(/^0+/, '');
  const mtUrl  = 'https://www.marinetraffic.com/en/ais/details/ships/mmsi:' + v.mmsi;

  vpBody.innerHTML =
    '<div id="vp-name">' + flag + ' ' + (v.name || 'Unknown vessel') + '</div>'
    + '<div id="vp-sub">MMSI ' + v.mmsi + (v.imo ? ' · IMO ' + v.imo : '') + '</div>'
    + '<div class="vp-grid">'
    +   '<div class="vp-field"><label>Type</label><span>' + shipTypeLabel(v.shipType) + '</span></div>'
    +   '<div class="vp-field"><label>State</label><span class="' + stCls + '">' + stLabel + '</span></div>'
    +   '<div class="vp-field"><label>Flag</label><span>' + (flag ? flag + ' ' + (v.flagState||'') : '—') + '</span></div>'
    +   '<div class="vp-field"><label>Voyages</label><span>' + (v.voyageCount || '0') + '</span></div>'
    +   '<div class="vp-field"><label>First seen</label><span>' + ago(v.firstSeen) + '</span></div>'
    +   '<div class="vp-field"><label>Last seen</label><span>' + ago(v.lastSeen) + '</span></div>'
    + '</div>'
    + (eventsHtml ? '<div id="vp-events-hdr">Recent events</div>' + eventsHtml : '')
    + '<a id="vp-mt-link" href="' + mtUrl + '" target="_blank" rel="noopener">View on MarineTraffic ↗</a>';
}

// ── Map ──────────────────────────────────────────────────────────────────────
const map = L.map('map', { attributionControl: false }).setView([51.90, 4.10], 11);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(map);
L.control.attribution({ prefix: '© OpenStreetMap · CartoDB' }).addTo(map);

// Close panel when clicking the map (not a marker)
map.on('click', closePanel);

fetch('/api/geo/rotterdam').then(r => r.json()).then(geo => {
  L.geoJSON(geo, {
    style: f => f.properties.id === 'NLRTM'
      ? { color:'#00d4aa', fillColor:'#00d4aa', fillOpacity:.07, weight:1.5 }
      : { color:'#4dabf7', fillColor:'#4dabf7', fillOpacity:.10, weight:1 },
    onEachFeature: (f, l) => l.bindPopup('<b>' + f.properties.name + '</b><br><span style="color:#8b949e">' + f.properties.id + '</span>'),
  }).addTo(map);
});

// Vessel markers
const markers = {};

function mkIcon(state) {
  const c = state === 'MOORED' ? '#00d4aa' : state === 'ANCHORED' ? '#4dabf7'
          : (state === 'AT_SEA' || state === 'APPROACHING') ? '#e3b341' : '#8b949e';
  return L.divIcon({
    html: '<svg width="24" height="24" viewBox="-8 -8 16 16" xmlns="http://www.w3.org/2000/svg">'
        + '<polygon points="0,-7 5,4 0,2 -5,4" fill="' + c + '" stroke="#0d1117" stroke-width="0.8"/></svg>',
    className: '', iconSize: [24,24], iconAnchor: [12,12],
  });
}

function updateVessels(list) {
  const seen = new Set(list.map(v => v.mmsi));
  for (const v of list) {
    if (markers[v.mmsi]) {
      markers[v.mmsi].setLatLng([v.lat, v.lon]).setIcon(mkIcon(v.state));
    } else {
      const m = L.marker([v.lat, v.lon], { icon: mkIcon(v.state) }).addTo(map);
      m.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
        openVesselPanel(v.mmsi);
      });
      markers[v.mmsi] = m;
    }
    // Keep mmsi on marker for click handler closure update
    markers[v.mmsi]._mmsi = v.mmsi;
  }
  for (const m of Object.keys(markers)) {
    if (!seen.has(m)) { markers[m].remove(); delete markers[m]; }
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────
function agoShort(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  return s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s/60) + 'm ago' : Math.floor(s/3600) + 'h ago';
}

async function poll() {
  try {
    const d = await fetch('/api/live').then(r => r.json());
    updateVessels(d.vessels || []);
    document.getElementById('s-today').textContent   = d.stats?.today   ?? '0';
    document.getElementById('s-vessels').textContent = d.stats?.active_1h ?? '0';
    document.getElementById('s-anchor').textContent  = agoShort(d.stats?.last_anchor);
  } catch {}
}
poll(); setInterval(poll, 10000);

// ── SSE Feed ─────────────────────────────────────────────────────────────────
let total = 0;
const feedList = document.getElementById('feed-list');
const cntEl    = document.getElementById('evt-count');

function badgeClass(c) { return c >= 75 ? 'hi' : c >= 50 ? 'md' : 'lo'; }

function addEvent(e) {
  total++;
  cntEl.textContent = total;
  const ts   = new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false });
  const icon = ICONS[e.type] || '•';
  const conf = Number(e.conf).toFixed(1);
  const srcs = (e.corroborationSources || []);
  const srcTag = srcs.length >= 2
    ? '<span class="src-multi">◈ ' + srcs.join(' + ') + '</span>'
    : srcs.length === 1 ? '<span class="src-single">' + srcs[0] + '</span>' : '';

  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML =
    '<div class="r1">'
    + '<span class="etype ' + e.type + '">' + icon + ' ' + e.type.replace(/_/g,' ') + '</span>'
    + '<span class="badge ' + badgeClass(e.conf) + '">' + conf + '%</span>'
    + '</div>'
    + '<div class="r2">'
    + '<span class="vname" data-mmsi="' + e.mmsi + '">' + (e.name || 'Unknown') + '</span>'
    + '<span class="mmsi">' + e.mmsi + '</span>'
    + '</div>'
    + '<div class="r3">'
    + '<span>' + ts + ' · ' + e.port + '</span>'
    + '<span>'
    + (e.anchored ? '<span class="chain">⛓ &nbsp;</span>' : '')
    + srcTag
    + '</span>'
    + '</div>';

  // Click on vessel name → open panel
  el.querySelector('.vname').addEventListener('click', function() {
    openVesselPanel(this.dataset.mmsi);
  });

  feedList.insertBefore(el, feedList.firstChild);
  while (feedList.children.length > 100) feedList.removeChild(feedList.lastChild);
}

const dot   = document.getElementById('live-dot');
const label = document.getElementById('live-label');

(function connect() {
  const es = new EventSource('/stream/events');
  es.onopen    = () => { dot.className = 'on'; label.textContent = 'live'; };
  es.onmessage = e => { try { addEvent(JSON.parse(e.data)); } catch {} };
  es.onerror   = () => {
    dot.className = ''; label.textContent = 'reconnecting…';
    es.close(); setTimeout(connect, 3000);
  };
})();
<\/script>
</body>
</html>`
