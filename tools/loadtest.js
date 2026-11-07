#!/usr/bin/env node
/**
 * Test de càrrega: simula N visitants arribant a la web (pàgina + actius + historial) i quedant-s'hi
 * (polling, latidos d'analítica, noms de carrer), amb els mòbils enviant posicions en paral·lel.
 *
 *   node tools/loadtest.js --spawn --clients 1000 --ramp 10 --session 90
 *
 *   --spawn          arrenca un servidor local amb dades de prova i un geocodificador fals (no toca OSM)
 *   --url <base>     prova un servidor ja desplegat (cuidado: genera molt trànsit; millor amb permís)
 *   --clients N      visitants (1000)        --ramp S    segons en què arriben tots (60; 5 = pic brusc)
 *   --session S      segons que es queda cada visitant (90)
 *   --port P         port del servidor local (8099)
 *
 * Mesura el servidor des d'una sola màquina: el generador de càrrega i el servidor competeixen per la CPU,
 * així que els resultats són un límit pessimista del que aguantaria el servidor sol.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { performance } = require('perf_hooks');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
    if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
});
const N = Number(args.clients) || 1000;
const RAMP = Number(args.ramp) || 60;
const SESSION = Number(args.session) || 90;
const PORT = Number(args.port) || 8099;
const STUB_PORT = PORT + 1;
const ROOT = path.join(__dirname, '..');
const BASE = new URL(args.url || `http://127.0.0.1:${PORT}`);
const TOKEN = 'loadtest';

// ---------------- Mètriques ----------------
const stats = {}; // tipus -> { ms: [], ok, err, bytes, errs: {} }
function rec(type, r, okStatuses = []) {
    const s = stats[type] ||= { ms: [], ok: 0, err: 0, bytes: 0, errs: {} };
    s.bytes += r.bytes || 0;
    if ((r.status >= 200 && r.status < 400) || okStatuses.includes(r.status)) { s.ok++; s.ms.push(r.ms); }
    else {
        s.err++;
        const k = r.err || `HTTP ${r.status}`;
        s.errs[k] = (s.errs[k] || 0) + 1;
    }
}
const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;

// ---------------- HTTP ----------------
const agent = new http.Agent({ keepAlive: true, maxSockets: 2000 });
function request(method, pth, { headers = {}, body, ip } = {}) {
    return new Promise(resolve => {
        const t0 = performance.now();
        let done = false;
        const finish = r => { if (!done) { done = true; resolve({ ms: performance.now() - t0, ...r }); } };
        const req = http.request({
            host: BASE.hostname, port: BASE.port, path: pth, method, agent, timeout: 10000,
            headers: { 'Accept-Encoding': 'gzip', 'X-Forwarded-For': ip || '198.51.100.1', ...headers },
        }, res => {
            let bytes = 0;
            res.on('data', c => { bytes += c.length; });
            res.on('end', () => finish({ status: res.statusCode, bytes, etag: res.headers.etag }));
            res.on('error', e => finish({ status: 0, err: e.code || e.message }));
        });
        req.on('timeout', () => { req.destroy(); finish({ status: 0, err: 'timeout' }); });
        req.on('error', e => finish({ status: 0, err: e.code || e.message }));
        if (body) req.write(body);
        req.end();
    });
}
const R = async (type, method, pth, opts) => { const r = await request(method, pth, opts); rec(type, r, (opts && opts.okStatuses) || []); return r; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- Servidor local de prova ----------------
const ROUTE_FILES = ['ruta_melcior', 'ruta_gaspar', 'ruta_baltasar', 'ruta_estrella', 'ruta_5', 'ruta_6', 'ruta_7'].map(f => `/${f}.geojson`);
const KINGS = ['Melcior', 'Gaspar', 'Baltasar', 'Estrella'];
let child = null, stub = null, dataDir = null;
const endPos = {}; // última posició sembrada de cada rei

function seedData(dir) {
    const out = { v: 2, kings: {} };
    const now = Date.now();
    KINGS.forEach((k, ki) => {
        let lat = 41.5845 + ki * 0.0004, lon = 2.3255 + ki * 0.0004;
        const pts = [];
        for (let i = 1800; i > 0; i--) { // ~2,5 h cada 5 s (el servidor en reduirà a 1500 per a la càrrega inicial)
            lat += 0.0000022; lon += 0.0000012 * Math.sin(i / 40);
            pts.push([now - i * 5000, lat, lon]);
        }
        endPos[k] = { lat, lon };
        out.kings[k] = pts;
    });
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(out));
}

async function startLocal() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-load-'));
    seedData(dataDir);
    const TILE_BODY = Buffer.alloc(18000, 7); // mosaic fals de ~18 KB (els reals d'OSM en fan 10-30)
    stub = http.createServer((req, res) => { // geocodificador i mosaics falsos: no s'envia res a OpenStreetMap
        if (req.url.startsWith('/tile/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(TILE_BODY); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ address: { road: 'Carrer de prova', village: 'La Roca del Vallès' } }));
    }).listen(STUB_PORT, '127.0.0.1');
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, PORT: String(PORT), DATA_PATH: dataDir, PING_TOKEN: TOKEN, GEOCODER_URL: `http://127.0.0.1:${STUB_PORT}/reverse`, TILE_UPSTREAM: `http://127.0.0.1:${STUB_PORT}/tile/{z}/{x}/{y}.png` },
    });
    for (let i = 0; i < 50; i++) {
        const r = await request('GET', '/health');
        if (r.status === 200) return child.pid;
        await sleep(200);
    }
    throw new Error('El servidor no ha arrencat');
}

function stopLocal() {
    try { if (child) child.kill(); } catch (e) { /* res */ }
    try { if (stub) stub.close(); } catch (e) { /* res */ }
    try { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* res */ }
}

// CPU i memòria del servidor (Windows: PowerShell; Linux/Mac: ps)
function procInfo(pid) {
    try {
        if (process.platform === 'win32') {
            const o = execSync(`powershell -NoProfile -Command "$p=Get-Process -Id ${pid}; \\"$($p.CPU) $($p.WorkingSet64)\\""`, { encoding: 'utf8' }).trim().split(' ');
            return { cpu: Number(o[0].replace(',', '.')), rss: Number(o[1]) };
        }
        const o = execSync(`ps -o cputime=,rss= -p ${pid}`, { encoding: 'utf8' }).trim().split(/\s+/);
        const [h, m, s] = o[0].split(':').map(Number);
        return { cpu: h * 3600 + m * 60 + s, rss: Number(o[1]) * 1024 };
    } catch (e) { return null; }
}

// ---------------- Visitant virtual ----------------
// Mosaics que carregaria un mòbil mirant el centre del mapa (z16, quadrícula 6x4)
const TILE_GRID = [];
for (let dx = -3; dx < 3; dx++) for (let dy = -2; dy < 2; dy++) TILE_GRID.push(`/tiles/16/${33191 + dx}/${24429 + dy}.png`);
const GEO_POINTS = Array.from({ length: 40 }, (_, i) => [(41.5830 + i * 0.0002).toFixed(4), (2.3230 + (i % 7) * 0.0003).toFixed(4)]);

async function visitor(id) {
    const ip = `198.51.${(id >> 8) & 255}.${(id & 255) || 1}`;
    const o = { ip };
    // Càrrega de la pàgina com la faria un navegador nou: HTML, després els actius en paral·lel, després l'historial
    await R('pàgina (html)', 'GET', '/', o);
    await Promise.all([
        R('actius (css/js/font)', 'GET', '/vendor/leaflet/leaflet.css', o),
        R('actius (css/js/font)', 'GET', '/vendor/leaflet/leaflet.js', o),
        R('actius (css/js/font)', 'GET', '/vendor/fonts/outfit-latin-wght-normal.woff2', o),
        R('actius (css/js/font)', 'GET', '/vendor/leaflet/images/layers.png', o),
        ...ROUTE_FILES.map(f => R('rutes (geojson)', 'GET', f, { ...o, okStatuses: [404] })), // 404 esperat: rutes encara no creades
    ]);
    const first = await R('historial (api/state)', 'GET', '/api/state', o);
    for (let i = 0; i < TILE_GRID.length; i += 6) { // un navegador té ~6 connexions per host
        await Promise.all(TILE_GRID.slice(i, i + 6).map(t => R('mosaics (tiles)', 'GET', t, o)));
    }
    R('analítica (api/hit)', 'POST', '/api/hit', { ...o, body: JSON.stringify({ t: 'view', s: 'load' + String(id).padStart(8, '0'), c: 0 }) });

    let etag = first.etag;
    const end = Date.now() + SESSION * 1000;
    const timers = [];
    const every = (ms, fn) => timers.push(setTimeout(async function tick() {
        if (Date.now() > end) return;
        await fn();
        timers.push(setTimeout(tick, ms * (0.85 + Math.random() * 0.3)));
    }, ms * Math.random()));

    every(10000, async () => { // polling com el navegador: amb ETag (si no ha canviat, 304)
        const r = await R('polling (api/latest)', 'GET', '/api/latest', { ...o, headers: etag ? { 'If-None-Match': etag } : {} });
        if (r.etag) etag = r.etag;
    });
    every(30000, () => R('analítica (api/hit)', 'POST', '/api/hit', { ...o, body: JSON.stringify({ t: 'beat', s: 'load' + String(id).padStart(8, '0') }) }));
    every(12000, () => { const g = GEO_POINTS[Math.floor(Math.random() * GEO_POINTS.length)]; return R('carrer (api/geocode)', 'GET', `/api/geocode?lat=${g[0]}&lon=${g[1]}`, o); });

    await sleep(Math.max(0, end - Date.now()) + 500);
    timers.forEach(clearTimeout);
}

// Mòbils dels reis enviant posicions cada 5 s durant tot el test
function devices(stopAt) {
    KINGS.forEach((k, i) => {
        let { lat, lon } = endPos[k] || { lat: 41.5845, lon: 2.3255 };
        const loop = async () => {
            if (Date.now() > stopAt) return;
            lat += 0.000003; lon += 0.000001;
            const body = `id=${k}&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&timestamp=${Math.floor(Date.now() / 1000)}&token=${TOKEN}`;
            await R('pings dels mòbils', 'POST', '/', { ip: `203.0.113.${i + 1}`, body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            setTimeout(loop, 5000);
        };
        loop();
    });
}

// ---------------- Execució ----------------
(async () => {
    let pid = null;
    if (args.spawn) pid = await startLocal();
    console.log(`Prova: ${N} visitants, arriben en ${RAMP} s, es queden ${SESSION} s cada un → ${BASE.origin}${pid ? ' (servidor local)' : ''}\n`);

    const t0 = Date.now();
    const p0 = pid ? procInfo(pid) : null;
    let peakRss = p0 ? p0.rss : 0;
    const mon = pid ? setInterval(() => { const p = procInfo(pid); if (p) peakRss = Math.max(peakRss, p.rss); }, 3000) : null;
    devices(t0 + (RAMP + SESSION + 5) * 1000);

    const all = [];
    for (let i = 0; i < N; i++) {
        all.push(sleep((i / N) * RAMP * 1000).then(() => visitor(i + 1)));
    }
    await Promise.all(all);
    await sleep(6000); // deixa acabar els mòbils
    if (mon) clearInterval(mon);

    const secs = (Date.now() - t0) / 1000;
    const p1 = pid ? procInfo(pid) : null;
    let total = 0, totalBytes = 0, totalErr = 0;
    const rows = Object.entries(stats).map(([type, s]) => {
        s.ms.sort((a, b) => a - b);
        total += s.ok + s.err; totalBytes += s.bytes; totalErr += s.err;
        return { type, n: s.ok + s.err, err: s.err, p50: pct(s.ms, 0.5), p95: pct(s.ms, 0.95), p99: pct(s.ms, 0.99), max: s.ms[s.ms.length - 1] || 0, mb: s.bytes / 1e6, errs: s.errs };
    });
    const f = v => v.toFixed(0).padStart(6);
    console.log('tipus'.padEnd(26) + '  peticions   errors   p50ms  p95ms  p99ms  maxms      MB');
    for (const r of rows) {
        console.log(r.type.padEnd(26) + String(r.n).padStart(11) + String(r.err).padStart(9) + f(r.p50) + ' ' + f(r.p95) + ' ' + f(r.p99) + ' ' + f(r.max) + r.mb.toFixed(1).padStart(8));
        for (const [k, v] of Object.entries(r.errs)) console.log(`    ↳ ${v}× ${k}`);
    }
    console.log(`\nTotal: ${total} peticions en ${secs.toFixed(0)} s (${(total / secs).toFixed(0)} req/s de mitjana), ${(totalBytes / 1e6).toFixed(0)} MB enviats, ${totalErr} errors (${(100 * totalErr / total).toFixed(2)} %)`);
    if (p0 && p1) {
        const cores = os.cpus().length;
        console.log(`Servidor: CPU mitjana ${(100 * (p1.cpu - p0.cpu) / secs).toFixed(0)} % d'un nucli (${cores} nuclis a la màquina), memòria final ${(p1.rss / 1e6).toFixed(0)} MB, pic ${(peakRss / 1e6).toFixed(0)} MB`);
    }
    const latest = rows.find(r => r.type.startsWith('polling'));
    const ok = totalErr / total < 0.01 && (!latest || latest.p95 < 500);
    console.log(`\nResultat: ${ok ? 'APROVAT (errors < 1 % i polling p95 < 500 ms)' : 'NO APROVAT — revisa els errors i latències de dalt'}`);
    stopLocal();
    process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); stopLocal(); process.exit(2); });

process.on('SIGINT', () => { stopLocal(); process.exit(130); });
