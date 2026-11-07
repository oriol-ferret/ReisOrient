#!/usr/bin/env node
/**
 * Precalienta la memòria cau de mosaics del servidor: demana els mosaics de la zona de les rutes UNA vegada,
 * a ritme baix (el servidor els baixa d'OpenStreetMap i els desa). Fes-ho abans de l'esdeveniment, no durant.
 *
 *   node tools/warm-tiles.js --url http://localhost:8080 --maxzoom 17
 *   node tools/warm-tiles.js --dry            (només compta els mosaics, no demana res)
 *
 * Demana només la zona que el mapa permet veure (rutes + marge) i va d'un en un, amb una pausa entre peticions,
 * per respectar la política d'ús d'OSM. Es pot repetir: els que ja són a la cau no tornen a baixar-se.
 */
const fs = require('fs');
const path = require('path');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => { if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true; });
const BASE = (args.url || 'http://localhost:8080').replace(/\/$/, '');
const MIN_Z = Number(args.minzoom) || 13;
const MAX_Z = Number(args.maxzoom) || 17;
const GAP_MS = Number(args.gap) || 400;
const ROOT = path.join(__dirname, '..');

// Àrea de les rutes
let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
const walk = c => {
    if (typeof c[0] === 'number') { minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]); minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]); }
    else c.forEach(walk);
};
for (const f of fs.readdirSync(ROOT).filter(n => /^ruta.*\.geojson$/.test(n))) {
    const g = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const ft of (g.type === 'FeatureCollection' ? g.features : [g])) walk((ft.geometry || ft).coordinates);
}
if (minLat > maxLat) { console.error('No s\'han trobat rutes (ruta*.geojson)'); process.exit(1); }
// Zooms baixos (veure tot el poble): tota l'àrea permesa. Zooms alts (carrers): només l'entorn proper de les rutes;
// la resta d'aquests es baixa sota demanda. (MAP_PAD a index.html = 0,03 / 0,045)
const zoneFull = [minLat - 0.03, minLon - 0.045, maxLat + 0.03, maxLon + 0.045];
const zoneCore = [minLat - 0.012, minLon - 0.016, maxLat + 0.012, maxLon + 0.016];
const zone = zoneFull;
const CORE_FROM_Z = 17;

const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };

const list = [];
for (let z = MIN_Z; z <= MAX_Z; z++) {
    const zn = z >= CORE_FROM_Z ? zoneCore : zoneFull;
    for (let x = lon2x(zn[1], z); x <= lon2x(zn[3], z); x++) {
        for (let y = lat2y(zn[2], z); y <= lat2y(zn[0], z); y++) list.push([z, x, y]);
    }
}
console.log(`Zona: ${zone.map(v => v.toFixed(4)).join(', ')} — zooms ${MIN_Z}-${MAX_Z}: ${list.length} mosaics (~${(list.length * 0.4 / 60).toFixed(1)} min)`);
if (args.dry) process.exit(0);

(async () => {
    let ok = 0, miss = 0, fail = 0;
    for (let i = 0; i < list.length; i++) {
        const [z, x, y] = list[i];
        try {
            const r = await fetch(`${BASE}/tiles/${z}/${x}/${y}.png`);
            await r.arrayBuffer();
            if (r.ok) { ok++; if (r.headers.get('x-tile-cache') === 'miss') { miss++; await new Promise(res => setTimeout(res, GAP_MS)); } }
            else fail++;
        } catch (e) { fail++; }
        if ((i + 1) % 25 === 0 || i === list.length - 1) process.stdout.write(`\r${i + 1}/${list.length}  baixats d'OSM: ${miss}  ja en cau: ${ok - miss}  errors: ${fail}   `);
    }
    console.log('\nFet.');
})();
