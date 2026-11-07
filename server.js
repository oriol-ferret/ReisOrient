require('dotenv').config();
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const querystring = require('querystring');

// ============================================================
// Configuració (tot opcional via variables d'entorn)
// ============================================================
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const HISTORY_MS = (Number(process.env.HISTORY_HOURS) || 24) * 3600 * 1000; // historial màxim
const MAX_POINTS = Number(process.env.MAX_POINTS) || 20000;                 // punts màxims per rei
const MAX_STATE_POINTS = 900;   // punts per rei enviats en la càrrega inicial (es redueix si cal)
const MAX_KINGS = 20;            // dispositius diferents acceptats
const MAX_BODY = 4096;           // bytes màxims d'un ping
const PING_TOKEN = process.env.PING_TOKEN || ''; // si es defineix, els pings han d'incloure ?token=...

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// Dades en memòria: id -> [[timestampMs, lat, lng], ...] ordenat per temps
// ============================================================
const kings = new Map();
let version = 0;      // s'incrementa a cada canvi (invalida els snapshots)
let dirty = false;    // hi ha canvis pendents d'escriure a disc

function validPoint(p) {
    return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
}

function prune(arr) {
    const cutoff = Date.now() - HISTORY_MS;
    let i = 0;
    while (i < arr.length && arr[i][0] < cutoff) i++;
    if (arr.length - i > MAX_POINTS) i = arr.length - MAX_POINTS;
    if (i > 0) arr.splice(0, i);
}

function readDb(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? undefined : null; }
}

function loadFromDisk() {
    let raw = readDb(DATA_FILE);
    if (raw === null) { // existeix però està corrupte: es guarda a part (no se sobreescriu) i es prova la còpia
        const bad = `${DATA_FILE}.corrupt-${Date.now()}`;
        try { fs.renameSync(DATA_FILE, bad); console.error(`[DB] data.json corrupte, desat a ${bad}`); } catch (e) { /* res */ }
        raw = readDb(DATA_FILE + '.bak');
        if (raw) console.warn('[DB] Recuperat des de data.json.bak');
    }
    if (!raw || typeof raw !== 'object') return;
    if (raw.v === 2 && raw.kings) {
        for (const id of Object.keys(raw.kings)) kings.set(id, (raw.kings[id] || []).filter(validPoint));
    } else {
        // Format antic: { Rei: { p_123: { location: { coords, timestamp } } } }
        for (const id of Object.keys(raw)) {
            const pts = Object.values(raw[id] || {}).map(d => {
                const c = d && d.location && d.location.coords;
                return c ? [Date.parse(d.location.timestamp), Number(c.latitude), Number(c.longitude)] : null;
            }).filter(validPoint).sort((a, b) => a[0] - b[0]);
            kings.set(id, pts);
        }
    }
    for (const arr of kings.values()) prune(arr);
}
loadFromDisk();
console.log(`[DB] Reis en memòria: ${[...kings.keys()].join(', ') || 'cap (net)'}`);

function addPoint(id, ts, lat, lng) {
    let arr = kings.get(id);
    if (!arr) kings.set(id, arr = []);
    const p = [ts, lat, lng];
    if (!arr.length || ts >= arr[arr.length - 1][0]) arr.push(p);
    else { arr.push(p); arr.sort((a, b) => a[0] - b[0]); } // ping endarrerit (buffer offline)
    prune(arr);
    version++;
    dirty = true;
}

// Escriptura a disc: asíncrona, atòmica i com a màxim cada 5 s
let writing = false, lastBackup = 0;
async function persist() {
    if (!dirty || writing) return;
    writing = true;
    dirty = false;
    try {
        const tmp = DATA_FILE + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify({ v: 2, kings: Object.fromEntries(kings) }));
        if (Date.now() - lastBackup > 300000) { // còpia de seguretat cada 5 min del darrer fitxer bo
            lastBackup = Date.now();
            await fsp.copyFile(DATA_FILE, DATA_FILE + '.bak').catch(() => {});
        }
        await fsp.rename(tmp, DATA_FILE);
    } catch (e) {
        dirty = true;
        console.error('[DB] Error escrivint:', e.message);
    } finally {
        writing = false;
    }
}
setInterval(persist, 5000);

function flushSync() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify({ v: 2, kings: Object.fromEntries(kings) })); } catch (e) { /* res */ }
}

// ============================================================
// Snapshots precomputats (JSON + gzip + ETag), reconstruïts com a màxim cada 2 s
// ============================================================
function downsample(arr, max) {
    if (arr.length <= max) return arr;
    const step = arr.length / max, out = [];
    for (let i = 0; i < max - 1; i++) out.push(arr[Math.floor(i * step)]);
    out.push(arr[arr.length - 1]); // l'últim punt sempre hi és
    return out;
}

// Per a la xarxa: segons sencers i 5 decimals (~1 m). Redueix molt el pes comprimit sense canviar res visible.
const slim = ([ts, lat, lng]) => [Math.round(ts / 1000) * 1000, Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5];

const builders = {
    // Historial compacte per a la càrrega inicial: { kings: { Rei: [[ts,lat,lng],...] } }
    state: () => ({ kings: Object.fromEntries([...kings].map(([id, a]) => [id, downsample(a, MAX_STATE_POINTS).map(slim)])) }),
    // Només l'última posició de cada rei (resposta minúscula per al polling)
    latest: () => ({ kings: Object.fromEntries([...kings].filter(([, a]) => a.length).map(([id, a]) => [id, slim(a[a.length - 1])])) }),
    // Format antic, per compatibilitat amb /data.json
    legacy: () => {
        const out = {};
        for (const [id, a] of kings) {
            out[id] = {};
            for (const [ts, lat, lng] of a) {
                out[id]['p_' + ts] = { device_id: id, location: { coords: { latitude: lat, longitude: lng }, timestamp: new Date(ts).toISOString() } };
            }
        }
        return out;
    },
};

const snapCache = {};
function snapshot(name) {
    const c = snapCache[name], now = Date.now();
    if (c && (c.ver === version || now - c.at < 2000)) return c;
    const body = Buffer.from(JSON.stringify(builders[name]()));
    return (snapCache[name] = {
        ver: version, at: now, body, gz: zlib.gzipSync(body),
        etag: 'W/"' + crypto.createHash('md5').update(body).digest('hex').slice(0, 16) + '"',
    });
}

function sendBuf(req, res, snap, type, cacheControl) {
    const h = {
        'Content-Type': type, 'Cache-Control': cacheControl, 'ETag': snap.etag,
        'Access-Control-Allow-Origin': '*', 'Vary': 'Accept-Encoding',
    };
    if (snap.csp) h['Content-Security-Policy'] = snap.csp;
    if (req.headers['if-none-match'] === snap.etag) { res.writeHead(304, h); return res.end(); }
    if (snap.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        h['Content-Encoding'] = 'gzip';
        h['Content-Length'] = snap.gz.length;
        res.writeHead(200, h);
        return res.end(snap.gz);
    }
    h['Content-Length'] = snap.body.length;
    res.writeHead(200, h);
    res.end(snap.body);
}

// ============================================================
// Fitxers estàtics: només una llista permesa (mai .env, server.js, .git…)
// ============================================================
const MIMES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
    '.geojson': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4',
    '.webm': 'video/webm', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
const TEXTUAL = new Set(['.html', '.css', '.js', '.json', '.geojson', '.svg']);

function resolveStatic(p) {
    let decoded;
    try { decoded = decodeURIComponent(p); } catch (e) { return null; }
    if (decoded.includes('\0') || decoded.includes('..') || decoded.includes('\\')) return null;
    const ext = path.extname(decoded).toLowerCase();
    if (!MIMES[ext]) return null;
    const ok = /^\/index\.html$/.test(decoded)
        || /^\/[\w.-]+\.geojson$/.test(decoded)
        || /^\/vendor\/[\w\/.-]+$/.test(decoded)
        || (process.env.SERVE_PROMO === '1' && /^\/promo-video\/[\w\/.-]+$/.test(decoded));
    return ok ? { file: path.join(__dirname, decoded), ext } : null;
}

// CSP: només recursos propis (els mosaics també passen pel nostre servidor). Els scripts/estils en línia es permeten per hash
// (calculat del propi fitxer), així cap script injectat s'executaria.
function buildCSP(rawHtml) {
    // El navegador normaliza CRLF -> LF dentro de <script>/<style> antes de comprobar el hash
    const html = rawHtml.replace(/\r\n?/g, '\n');
    const hashes = re => [...html.matchAll(re)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
    return [
        "default-src 'self'",
        `script-src 'self' ${hashes(/<script>([\s\S]*?)<\/script>/g)}`.trim(),
        `style-src 'self' ${hashes(/<style>([\s\S]*?)<\/style>/g)}`.trim(),
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; ');
}

const staticCache = new Map();
const staticInflight = new Map();
function loadStatic(file, ext) {
    const c = staticCache.get(file);
    if (c && Date.now() - c.at < 60000) return Promise.resolve(c);
    if (!staticInflight.has(file)) staticInflight.set(file, readStatic(file, ext).finally(() => staticInflight.delete(file)));
    return staticInflight.get(file);
}
async function readStatic(file, ext) {
    const body = await fsp.readFile(file);
    const entry = {
        at: Date.now(), body, ext,
        gz: TEXTUAL.has(ext) && body.length > 1024 ? zlib.gzipSync(body) : null,
        etag: 'W/"' + crypto.createHash('md5').update(body).digest('hex').slice(0, 16) + '"',
        csp: file === path.join(__dirname, 'index.html') ? buildCSP(body.toString('utf8')) : null,
    };
    staticCache.set(file, entry);
    return entry;
}

// ============================================================
// Receptor de pings (Traccar Client)
// ============================================================
function normalizeId(raw) {
    if (!raw || !/^[A-Za-z][\w-]{0,23}$/.test(raw)) return null;
    const id = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    return id === 'Melchor' ? 'Melcior' : id;
}

const safeEqual = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

const inBox = (lat, lon, [minLat, minLon, maxLat, maxLon]) => lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
const rejects = new Map(); // id -> rebutjos seguits (si n'hi ha molts, el "darrer punt" és el dolent: s'accepta)
const warnedAt = new Map();

// Descarta fixos GPS absurds (0,0, coordenades fora de zona, salts de centenars de km, precisió dolenta)
function plausible(id, ts, lat, lon, accuracy) {
    let why = null;
    if (!inBox(lat, lon, GEO_BBOX)) why = 'fora de zona';
    else if (Number.isFinite(accuracy) && accuracy > 150) why = `precisió ${accuracy} m`;
    else {
        const arr = kings.get(id), last = arr && arr[arr.length - 1];
        if (last && ts >= last[0]) {
            const d = haversine(last[1], last[2], lat, lon), dt = Math.max(1, (ts - last[0]) / 1000);
            if (d > 300 && d / dt > 40) why = `salt de ${Math.round(d)} m en ${Math.round(dt)} s`;
        }
    }
    if (!why) { rejects.delete(id); return true; }
    if (why.startsWith('salt')) {
        // Només els salts compten: si en vénen 3 de seguits, el "darrer punt" era el dolent i el nou és el bo
        const n = (rejects.get(id) || 0) + 1;
        if (n >= 3) { rejects.delete(id); return true; }
        rejects.set(id, n);
    }
    if (Date.now() - (warnedAt.get(id) || 0) > 10000) { warnedAt.set(id, Date.now()); console.warn(`[PING] ${id} descartat: ${why}`); }
    return false;
}

function handlePing(params, res) {
    const reply = (code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); res.end(text); };
    if (PING_TOKEN && !safeEqual(params.token || '', PING_TOKEN)) return reply(403, 'FORBIDDEN');

    const id = normalizeId(params.id || params.deviceid);
    const lat = Number(params.lat || params.latitude);
    const lon = Number(params.lon || params.longitude);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        console.warn(`[PING] invàlid id=${params.id} lat=${params.lat} lon=${params.lon}`);
        return reply(200, 'MISSING_FIELDS'); // 200 perquè l'app no entri en bucle de reintents
    }
    if (!kings.has(id) && kings.size >= MAX_KINGS) return reply(200, 'TOO_MANY_DEVICES');

    // Si el dispositiu envia l'hora real (pings en buffer sense cobertura) i és plausible, s'usa
    let ts = Date.now();
    let t = Number(params.timestamp);
    if (Number.isFinite(t) && t > 0) {
        if (t < 1e12) t *= 1000; // segons -> ms
        if (t <= ts + 60000 && t >= ts - HISTORY_MS) ts = t;
    }
    if (!plausible(id, ts, lat, lon, Number(params.accuracy))) return reply(200, 'OK'); // 200: l'app no ha de reintentar
    addPoint(id, ts, lat, lon);
    if (process.env.DEBUG) console.log(`[PING] ${id} ${lat},${lon}`);
    reply(200, 'OK');
}

// ============================================================
// Analítiques pròpies i anònimes (sense tercers, sense desar IP ni user-agent)
// ============================================================
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const STATS_KEY = process.env.STATS_KEY || ''; // sense clau, /stats està desactivat
let stats = { hours: {}, days: {} };
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); stats.hours ||= {}; stats.days ||= {}; } catch (e) { /* nou */ }
const live = new Map();          // sessió (en memòria, només d'aquesta càrrega de pàgina) -> últim senyal
let seenHour = new Set(), seenHourKey = '';
let seenDay = new Set(), seenDayKey = '';
let statsDirty = false;
const hourKey = t => new Date(t).toISOString().slice(0, 13);

function hourBucket(now) {
    const k = hourKey(now);
    if (k !== seenHourKey) { seenHourKey = k; seenHour = new Set(); }
    return stats.hours[k] ||= { views: 0, active: 0, peak: 0, mobile: 0, desktop: 0, consentYes: 0, consentNo: 0, opens: {} };
}

function handleHit(req, res) {
    let body = '', size = 0;
    req.on('error', () => {});
    req.on('data', c => {
        size += c.length;
        if (size > 512) { req.destroy(); return; }
        body += c;
    });
    req.on('end', () => {
        res.writeHead(204);
        res.end();
        let e;
        try { e = JSON.parse(body); } catch (err) { return; }
        if (!e || !/^[\w-]{8,40}$/.test(e.s || '') || !['view', 'beat', 'open'].includes(e.t)) return;
        const now = Date.now();
        if (live.size < 100000) live.set(e.s, now);
        const b = hourBucket(now);
        if (!seenHour.has(e.s)) { seenHour.add(e.s); b.active++; }
        b.peak = Math.max(b.peak, live.size);
        if (e.t === 'view') {
            b.views++;
            if (/Mobi|Android|iPhone|iPad/i.test(req.headers['user-agent'] || '')) b.mobile++; else b.desktop++;
            if (e.c === 1) b.consentYes++; else if (e.c === 0) b.consentNo++;
        } else if (e.t === 'open' && /^[A-Za-z]{1,24}$/.test(e.k || '') && (Object.keys(b.opens).length < 30 || b.opens[e.k])) {
            b.opens[e.k] = (b.opens[e.k] || 0) + 1;
        }
        // Visitants únics per dia: només amb consentiment (cookie ro_vid)
        if (/^[0-9a-f]{16,32}$/.test(e.v || '')) {
            const dk = new Date(now).toISOString().slice(0, 10);
            if (dk !== seenDayKey) { seenDayKey = dk; seenDay = new Set(); }
            if (!seenDay.has(e.v)) { seenDay.add(e.v); (stats.days[dk] ||= { visitors: 0 }).visitors++; }
        }
        statsDirty = true;
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [sid, t] of live) if (now - t > 75000) live.delete(sid);
    const b = hourBucket(now);
    if (live.size > b.peak) { b.peak = live.size; statsDirty = true; }
    const cutoff = hourKey(now - 14 * 86400000);
    for (const k of Object.keys(stats.hours)) if (k < cutoff) delete stats.hours[k];
    if (statsDirty) {
        statsDirty = false;
        fsp.writeFile(STATS_FILE, JSON.stringify(stats)).catch(e => { statsDirty = true; console.error('[STATS]', e.message); });
    }
}, 30000);

const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function handleStats(req, res, query, pathname) {
    const given = Buffer.from(String(req.headers['x-stats-key'] || query.key || ''));
    const want = Buffer.from(STATS_KEY);
    if (!STATS_KEY || given.length !== want.length || !crypto.timingSafeEqual(given, want)) { res.writeHead(404); return res.end('Not Found'); }
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 24; i++) {
        const k = hourKey(now - i * 3600000);
        rows.push({ hour: k, ...(stats.hours[k] || { views: 0, active: 0, peak: 0, mobile: 0, desktop: 0, consentYes: 0, consentNo: 0, opens: {} }) });
    }
    const opens = {};
    let views = 0, mobile = 0, desktop = 0, yes = 0, no = 0, peak = 0;
    for (const r of rows) {
        views += r.views; mobile += r.mobile; desktop += r.desktop; yes += r.consentYes; no += r.consentNo; peak = Math.max(peak, r.peak);
        for (const k of Object.keys(r.opens)) opens[k] = (opens[k] || 0) + r.opens[k];
    }
    const summary = { liveNow: live.size, last24h: { views, peakConcurrent: peak, mobile, desktop, consentAccepted: yes, consentRejected: no, kingOpens: opens }, days: stats.days, hours: rows };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (pathname === '/stats.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(summary)); }
    const tr = rows.map(r => `<tr><td>${esc(r.hour)}</td><td>${r.views}</td><td>${r.active}</td><td>${r.peak}</td><td>${r.mobile}/${r.desktop}</td></tr>`).join('');
    const days = Object.entries(stats.days).sort().slice(-7).map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.visitors}</td></tr>`).join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Estadístiques</title>
<style>body{font:15px system-ui;max-width:720px;margin:24px auto;padding:0 16px}table{border-collapse:collapse;width:100%;margin:8px 0 24px}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:right}th:first-child,td:first-child{text-align:left}</style>
<h1>Estadístiques</h1>
<p><b>${live.size}</b> persones connectades ara · <b>${views}</b> visites 24 h · pic simultani <b>${peak}</b> · mòbil/ordinador ${mobile}/${desktop} · cookies acceptades/rebutjades ${yes}/${no}</p>
<p>Reis consultats (24 h): ${Object.entries(opens).map(([k, v]) => esc(k) + ' ' + v).join(' · ') || '—'}</p>
<h2>Per hora (UTC)</h2><table><tr><th>Hora</th><th>Visites</th><th>Sessions</th><th>Pic</th><th>Mòbil/PC</th></tr>${tr}</table>
<h2>Visitants únics (només amb cookie acceptada)</h2><table><tr><th>Dia</th><th>Visitants</th></tr>${days || '<tr><td>—</td><td></td></tr>'}</table>`);
}

// ============================================================
// Seguretat: cabeceres, límit de ritme per IP
// ============================================================
const SEC_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin', // OSM demana el Referer als mosaics
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=()',
};

const buckets = new Map();
function limited(key, max, windowMs = 60000) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    return ++b.n > max;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
    if (buckets.size > 100000) buckets.clear();
}, 60000);
// Darrere d'un proxy la IP real arriba a X-Forwarded-For; sense proxy, a l'adreça del socket
// X-Forwarded-For només es creu si la connexió arriba d'un proxy local/privat, i es pren l'entrada que ha
// afegit el nostre proxy (no la primera, que la controla el client). Amb CDN + proxy: TRUST_PROXY_HOPS=2.
const TRUST_HOPS = Math.max(1, Number(process.env.TRUST_PROXY_HOPS) || 1);
const PRIVATE_IP = /^(::ffff:)?(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^(::1|f[cd][0-9a-f]{2}:)/i;
function clientIp(req) {
    const sock = req.socket.remoteAddress || '?';
    const xff = req.headers['x-forwarded-for'];
    if (!xff || !PRIVATE_IP.test(sock)) return sock;
    const parts = String(xff).split(',').map(x => x.trim()).filter(Boolean);
    return parts[Math.max(0, parts.length - TRUST_HOPS)] || sock;
}

// ============================================================
// Geocodificació inversa (nom del carrer) amb memòria cau i cua d'1 petició/s cap a Nominatim
// ============================================================
const GEO_URL = process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org/reverse';
const GEO_UA = `ReisOrient/1.0 (+https://github.com/oriol-ferret/ReisOrient${process.env.NOMINATIM_EMAIL ? '; ' + process.env.NOMINATIM_EMAIL : ''})`;
const GEO_BBOX = (process.env.GEO_BBOX || '40.4,0.1,42.9,3.4').split(',').map(Number); // minLat,minLon,maxLat,maxLon
// Zona permesa: l'entorn de les rutes (+~600 m). Així l'endpoint no serveix de proxy obert a tot el món.
let GEO_ZONE = GEO_BBOX;
try {
    let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
    const walk = c => {
        if (typeof c[0] === 'number') { minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]); minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]); }
        else c.forEach(walk);
    };
    const feats = g => g.type === 'FeatureCollection' ? g.features : [g];
    for (const f of fs.readdirSync(__dirname).filter(n => /^ruta.*\.geojson$/.test(n))) {
        for (const ft of feats(JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')))) walk((ft.geometry || ft).coordinates);
    }
    if (minLat <= maxLat) GEO_ZONE = [minLat - 0.006, minLon - 0.008, maxLat + 0.006, maxLon + 0.008];
} catch (e) { /* es fa servir GEO_BBOX */ }

const geoCache = new Map();
const geoInflight = new Map();
let geoChain = Promise.resolve(), geoQueued = 0, geoLastAt = 0;

function geocode(lat, lon) {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const c = geoCache.get(key);
    if (c && Date.now() - c.at < 86400000) return Promise.resolve(c.street);
    if (geoInflight.has(key)) return geoInflight.get(key);
    if (geoQueued >= 15) return Promise.resolve(undefined); // saturat: el client ho reintenta
    geoQueued++;
    const p = geoChain = geoChain.then(async () => {
        const wait = geoLastAt + 1100 - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        geoLastAt = Date.now();
        try {
            const r = await fetch(`${GEO_URL}?format=jsonv2&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=18&addressdetails=1`,
                { headers: { 'User-Agent': GEO_UA, 'Accept-Language': 'ca' }, signal: AbortSignal.timeout(5000) });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const d = await r.json(), a = d.address || {};
            const road = a.road || a.pedestrian || a.footway || a.path || '';
            const place = a.suburb || a.village || a.town || a.city || '';
            const street = road ? road + (place ? `, ${place}` : '') : (d.display_name ? d.display_name.split(',')[0] : null);
            geoCache.set(key, { street, at: Date.now() });
            if (geoCache.size > 5000) geoCache.delete(geoCache.keys().next().value);
            return street;
        } catch (e) {
            return undefined;
        } finally {
            geoQueued--;
            geoInflight.delete(key);
        }
    });
    geoInflight.set(key, p);
    return p;
}

async function handleGeocode(req, res, query) {
    const lat = Number(query.lat), lon = Number(query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inBox(lat, lon, GEO_ZONE)) {
        res.writeHead(400); return res.end();
    }
    const ip = clientIp(req), cached = geoCache.get(`${lat.toFixed(4)},${lon.toFixed(4)}`);
    if (limited('geo:' + ip, 3000)) { res.writeHead(429); return res.end(); }
    // Només les consultes que no són a la memòria cau arriben a Nominatim: aquestes tenen un límit baix per IP
    if (!(cached && Date.now() - cached.at < 86400000) && limited('geomiss:' + ip, 30)) { res.writeHead(429); return res.end(); }
    // Si Nominatim va lent, no es deixa el client esperant: es respon sense carrer (no-store) i la cerca continua
    // en segon pla per omplir la memòria cau; el client ho reintenta al cap de 12 s.
    const street = await Promise.race([geocode(lat, lon), new Promise(r => setTimeout(r, 2500, undefined))]);
    res.writeHead(200, {
        'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
        'Cache-Control': street === undefined ? 'no-store' : 'public, max-age=3600, s-maxage=3600',
    });
    res.end(JSON.stringify({ street: street === undefined ? null : street }));
}

// ============================================================
// Mosaics del mapa: proxy amb memòria cau (només el servidor parla amb OpenStreetMap)
// ============================================================
// Els visitants demanen /tiles/z/x/y.png. Cada mosaic es baixa UNA vegada d'OSM i es guarda a memòria i a disc;
// la resta de visitants el reben de la cau. Així OSM veu centenars de peticions, no milers, i no coneix cap visitant.
// Política d'OSM: User-Agent propi, cau d'almenys 7 dies i volum baix. Cal mantenir l'atribució "© OpenStreetMap".
const TILE_UPSTREAM = process.env.TILE_UPSTREAM || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_DIR = path.join(DATA_DIR, 'tiles');
const TILE_TTL = 7 * 86400 * 1000;
const TILE_MIN_Z = 13, TILE_MAX_Z = 18;
const TILE_UA = `ReisOrient/1.0 (+https://github.com/oriol-ferret/ReisOrient${process.env.NOMINATIM_EMAIL ? '; ' + process.env.NOMINATIM_EMAIL : ''})`;
// Zona de mosaics: les rutes + 0,032° N/S i 0,047° E/O (~3,5 km). Ha de contenir l'àrea que el client deixa veure
// (MAP_PAD a index.html: 0,03 / 0,045). Fora, 404: l'endpoint no és un proxy obert de tot el món.
const TILE_ZONE = [GEO_ZONE[0] - 0.026, GEO_ZONE[1] - 0.039, GEO_ZONE[2] + 0.026, GEO_ZONE[3] + 0.039];
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
// PROVA TEMPORAL: TILE_UNLIMITED=1 desactiva el límit de zona i zoom (qualsevol lloc del món). Treure la variable per tornar-hi.
const TILE_UNLIMITED = process.env.TILE_UNLIMITED === '1';
function tileAllowed(z, x, y) {
    if (TILE_UNLIMITED) return z >= 0 && z <= 19 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
    return z >= TILE_MIN_Z && z <= TILE_MAX_Z
        && x >= lon2x(TILE_ZONE[1], z) && x <= lon2x(TILE_ZONE[3], z)
        && y >= lat2y(TILE_ZONE[2], z) && y <= lat2y(TILE_ZONE[0], z);
}

const tileMem = new Map();      // clau -> { buf, at }   (LRU senzill: els més recents al final)
const tileInflight = new Map(); // clau -> Promise<Buffer|null>
let tileActive = 0;
const tileWaiters = [];
const tileSlot = async () => { if (tileActive >= 2) await new Promise(r => tileWaiters.push(r)); tileActive++; };
const tileRelease = () => { tileActive--; const w = tileWaiters.shift(); if (w) w(); };

function memPut(key, buf) {
    tileMem.delete(key);
    tileMem.set(key, { buf, at: Date.now() });
    if (tileMem.size > 600) tileMem.delete(tileMem.keys().next().value);
}

// Retorna { buf, hit } o null. hit=false vol dir que s'ha hagut de baixar d'OSM.
async function getTile(z, x, y, ip) {
    const key = `${z}/${x}/${y}`;
    const m = tileMem.get(key);
    if (m && Date.now() - m.at < TILE_TTL) { tileMem.delete(key); tileMem.set(key, m); return { buf: m.buf, hit: true }; }

    const file = path.join(TILE_DIR, String(z), String(x), `${y}.png`);
    let stale = null;
    try {
        const st = await fsp.stat(file);
        const buf = await fsp.readFile(file);
        if (Date.now() - st.mtimeMs < TILE_TTL) { memPut(key, buf); return { buf, hit: true }; }
        stale = buf; // caducat: s'intenta renovar, però serveix si OSM falla
    } catch (e) { /* no és a disc */ }

    // Les baixades noves ja estan acotades (zona finita, 2 concurrents). Aquest límit només frena abusos evidents;
    // ha de ser alt perquè una pantalla gran amb la cau freda en necessita desenes per nivell de zoom.
    if (limited('tile:' + ip, 1200)) return { buf: stale, hit: false, limited: !stale };
    if (tileInflight.has(key)) return { buf: await tileInflight.get(key), hit: false };
    const p = (async () => {
        await tileSlot();
        try {
            const r = await fetch(TILE_UPSTREAM.replace('{z}', z).replace('{x}', x).replace('{y}', y),
                { headers: { 'User-Agent': TILE_UA }, signal: AbortSignal.timeout(8000) });
            const type = r.headers.get('content-type') || '';
            if (!r.ok || !type.startsWith('image/')) throw new Error('HTTP ' + r.status);
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length < 50 || buf.length > 500000) throw new Error('mida estranya');
            memPut(key, buf);
            fsp.mkdir(path.dirname(file), { recursive: true })
                .then(() => fsp.writeFile(file + '.tmp', buf)).then(() => fsp.rename(file + '.tmp', file)).catch(() => {});
            return buf;
        } catch (e) {
            if (!stale) console.warn(`[TILE] ${key}: ${e.message}`);
            return stale; // si hi ha còpia vella, millor que res
        } finally {
            tileRelease();
            tileInflight.delete(key);
        }
    })();
    tileInflight.set(key, p);
    return { buf: await p, hit: false };
}

async function handleTile(req, res, z, x, y) {
    if (!tileAllowed(z, x, y)) { res.writeHead(404); return res.end(); }
    const t = await getTile(z, x, y, clientIp(req));
    if (!t || !t.buf) {
        res.writeHead(t && t.limited ? 429 : 502, { 'Cache-Control': 'no-store' });
        return res.end();
    }
    res.writeHead(200, {
        'Content-Type': 'image/png', 'Content-Length': t.buf.length, 'X-Tile-Cache': t.hit ? 'hit' : 'miss',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(t.buf);
}

// ============================================================
// Servidor HTTP
// ============================================================
async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    let pathname = u.pathname;
    const query = Object.fromEntries(u.searchParams);
    for (const k in SEC_HEADERS) res.setHeader(k, SEC_HEADERS[k]);
    if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');

    // /tracker (sense barra) -> /tracker/ només per a navegadors, no per als pings de Traccar
    if (pathname === '/tracker' && req.method !== 'POST' && !query.id) {
        res.writeHead(301, { Location: '/tracker/' });
        return res.end();
    }
    if (pathname.startsWith('/tracker/')) pathname = pathname.substring(8);
    if (pathname === '/') pathname = '/index.html';
    // /demo és la mateixa interfície en mode simulació (el client la detecta pel camí). Sense barra final,
    // perquè les URL relatives (api/…, rutes) funcionin igual.
    if (pathname === '/demo/') { res.writeHead(301, { Location: '../demo' }); return res.end(); }
    if (pathname === '/demo') pathname = '/index.html';

    if (pathname === '/health' || req.method === 'HEAD') {
        res.writeHead(200);
        return res.end('OK');
    }

    // Analítiques
    if (pathname === '/api/hit' && req.method === 'POST') {
        if (limited('hit:' + clientIp(req), 1500)) { res.writeHead(204); return res.end(); }
        return handleHit(req, res);
    }
    if (pathname === '/stats' || pathname === '/stats.json') return handleStats(req, res, query, pathname);

    // Pings
    if ((req.method === 'POST' || (req.method === 'GET' && query.id)) && limited('ping:' + clientIp(req), 300)) {
        res.writeHead(429); return res.end();
    }
    if (req.method === 'POST' || (req.method === 'GET' && query.id)) {
        let body = '', size = 0;
        req.on('error', () => {});
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) { res.writeHead(413); res.end(); req.destroy(); return; }
            body += c;
        });
        req.on('end', () => {
            if (res.writableEnded) return;
            try { handlePing({ ...query, ...querystring.parse(body) }, res); }
            catch (e) { console.error('[PING] error', e); res.writeHead(500); res.end(); }
        });
        return;
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }

    if (pathname === '/api/geocode') return handleGeocode(req, res, query);

    // API de dades (cacheable per navegador i CDN)
    if (pathname === '/api/state') return sendBuf(req, res, snapshot('state'), 'application/json', 'public, max-age=10, s-maxage=10, stale-while-revalidate=30');
    if (pathname === '/api/latest') return sendBuf(req, res, snapshot('latest'), 'application/json', 'public, max-age=4, s-maxage=4, stale-while-revalidate=10');
    if (pathname === '/data.json') return sendBuf(req, res, snapshot('legacy'), 'application/json', 'public, max-age=10, s-maxage=10');

    // Mosaics del mapa (proxy amb cau)
    const tm = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(pathname);
    if (tm) return handleTile(req, res, Number(tm[1]), Number(tm[2]), Number(tm[3]));

    // Estàtics
    const target = resolveStatic(pathname);
    if (!target) { res.writeHead(404); return res.end('Not Found'); }
    let f;
    try { f = await loadStatic(target.file, target.ext); }
    catch (e) { res.writeHead(404); return res.end('Not Found'); }
    const cc = target.ext === '.html' ? 'no-cache' : 'public, max-age=300';
    sendBuf(req, res, f, MIMES[target.ext], cc);
}

const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
        console.error('[HTTP] error', e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
    });
});
server.keepAliveTimeout = 65000;   // per sobre del timeout típic d'un proxy invers
server.headersTimeout = 20000;
server.requestTimeout = 20000;
server.on('clientError', (err, socket) => socket.destroy());

process.on('uncaughtException', e => console.error('[FATAL]', e));
process.on('unhandledRejection', e => console.error('[FATAL]', e));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    flushSync();
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch (e) { /* res */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref(); // no esperar connexions keep-alive
});

if (!PING_TOKEN) console.warn('[SEGURETAT] PING_TOKEN no definit: qualsevol pot enviar posicions falses. Defineix PING_TOKEN i afegeix ?token=... a la URL de Traccar.');
if (!STATS_KEY) console.log('[INFO] STATS_KEY no definit: /stats desactivat.');
try { fs.accessSync(DATA_DIR, fs.constants.W_OK); } catch (e) { console.error(`[DB] ${DATA_DIR} no és escrivible: les posicions NO es desaran entre reinicis.`); }

server.listen(PORT, '0.0.0.0', () => console.log(`Servidor escoltant al port ${PORT}`));
