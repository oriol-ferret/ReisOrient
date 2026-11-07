'use strict';
/**
 * Configuració editable des de /admin: llista de reis (dispositius) i de rutes (nom, color, rei assignat, traçat GeoJSON).
 * Tot es desa al volum de dades (DATA_DIR/config.json i DATA_DIR/routes/<id>.geojson), no al codi: sobreviu als redesplegaments.
 * La primera vegada es crea amb les rutes que ja hi havia (ruta_*.geojson de l'arrel del projecte).
 */
const fs = require('fs');
const path = require('path');

const MAX_ROUTES = 40, MAX_KINGS = 20, MAX_POINTS = 20000, MAX_GEOJSON_BYTES = 1.5 * 1024 * 1024;

const DEFAULT_KINGS = [
    { id: 'Melcior', name: 'Rei Melcior', color: '#d4a017', icon: 'crown' },
    { id: 'Gaspar', name: 'Rei Gaspar', color: '#ab2330', icon: 'crown' },
    { id: 'Baltasar', name: 'Rei Baltasar', color: '#228b22', icon: 'crown' },
    { id: 'Estrella', name: "Estrella d'Orient", color: '#0e7490', icon: 'star' },
];
const DEFAULT_ROUTES = [
    { id: 'ruta1', name: 'Ruta 1', color: '#b8860b', tracker: 'Melcior', seed: 'ruta_melcior.geojson' },
    { id: 'ruta2', name: 'Ruta 2', color: '#ab2330', tracker: 'Gaspar', seed: 'ruta_gaspar.geojson' },
    { id: 'ruta3', name: 'Ruta 3', color: '#228b22', tracker: 'Baltasar', seed: 'ruta_baltasar.geojson' },
    { id: 'ruta4', name: 'Ruta 4', color: '#0e7490', tracker: 'Estrella', seed: 'ruta_estrella.geojson' },
];

const HEX = /^#[0-9a-f]{6}$/i;
const haversine = (la1, lo1, la2, lo2) => {
    const R = 6371000, r = Math.PI / 180;
    const a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
};
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
// Mateix criteri que els pings: primera lletra en majúscula i la resta en minúscula (el dispositiu "gaspar" és el rei "Gaspar")
const normalizeKingId = raw => (/^[A-Za-z][\w-]{0,23}$/.test(String(raw || '')) ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : null);

/**
 * Valida un GeoJSON i el normalitza a una FeatureCollection de LineString (coordenades [lon,lat] amb 6 decimals).
 * Només s'accepten línies: és el que fa servir el mapa per projectar la posició del rei sobre la ruta.
 */
function validateGeoJSON(input) {
    let data = input;
    if (typeof input === 'string') {
        if (Buffer.byteLength(input) > MAX_GEOJSON_BYTES) throw new Error('El fitxer és massa gran (màxim 1,5 MB).');
        try { data = JSON.parse(input); } catch (e) { throw new Error('No és un JSON vàlid.'); }
    }
    if (!data || typeof data !== 'object') throw new Error('El GeoJSON ha de ser un objecte.');
    const lines = [];
    const addGeom = g => {
        if (!g || typeof g !== 'object') return;
        if (g.type === 'LineString') lines.push(g.coordinates);
        else if (g.type === 'MultiLineString') (g.coordinates || []).forEach(c => lines.push(c));
        else if (g.type === 'GeometryCollection') (g.geometries || []).forEach(addGeom);
        else if (g.type === 'Point' || g.type === 'MultiPoint' || g.type === 'Polygon' || g.type === 'MultiPolygon') throw new Error(`La ruta ha de ser una línia (LineString), no un ${g.type}.`);
    };
    if (data.type === 'FeatureCollection') (data.features || []).forEach(f => addGeom(f && f.geometry));
    else if (data.type === 'Feature') addGeom(data.geometry);
    else addGeom(data);
    if (!lines.length) throw new Error('No s\'ha trobat cap línia (LineString) al GeoJSON.');

    let points = 0, length = 0, minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
    const features = lines.map(coords => {
        if (!Array.isArray(coords) || coords.length < 2) throw new Error('Cada línia necessita almenys 2 punts.');
        let prev = null;
        const out = coords.map(c => {
            if (!Array.isArray(c) || c.length < 2) throw new Error('Coordenada no vàlida.');
            const lon = Number(c[0]), lat = Number(c[1]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Hi ha coordenades fora de rang (ordre correcte: [longitud, latitud]).');
            points++;
            if (points > MAX_POINTS) throw new Error(`Massa punts (màxim ${MAX_POINTS}).`);
            if (prev) length += haversine(prev[1], prev[0], lat, lon);
            prev = [lon, lat];
            minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
            return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
        });
        return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: out } };
    });
    return { geojson: { type: 'FeatureCollection', features }, points, lengthKm: Math.round(length / 10) / 100, bbox: [minLat, minLon, maxLat, maxLon] };
}

// Àrea que cobreixen les rutes d'una configuració (per limitar el geocodificador i els mosaics)
function bboxOf(cfg) {
    let b = null;
    for (const r of cfg.routes || []) if (r.hasGeo && r.bbox) b = b ? [Math.min(b[0], r.bbox[0]), Math.min(b[1], r.bbox[1]), Math.max(b[2], r.bbox[2]), Math.max(b[3], r.bbox[3])] : [...r.bbox];
    return b;
}

function create({ dataDir, rootDir, onChange }) {
    const FILE = path.join(dataDir, 'config.json');
    const ROUTES_DIR = path.join(dataDir, 'routes');
    fs.mkdirSync(ROUTES_DIR, { recursive: true });
    let cfg = null;

    const writeAtomic = (file, text) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); };
    const routeFile = id => path.join(ROUTES_DIR, id + '.geojson');

    function save() {
        cfg.version = (cfg.version || 0) + 1;
        cfg.updated = new Date().toISOString();
        try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, FILE + '.bak'); } catch (e) { /* res */ }
        writeAtomic(FILE, JSON.stringify(cfg, null, 1));
        if (onChange) onChange(cfg);
    }

    function seed() {
        cfg = { version: 0, kings: DEFAULT_KINGS.map(k => ({ ...k })), routes: [] };
        for (const d of DEFAULT_ROUTES) {
            const r = { id: d.id, name: d.name, color: d.color, tracker: d.tracker, enabled: true, hasGeo: false, points: 0, lengthKm: 0, bbox: null };
            try {
                const v = validateGeoJSON(fs.readFileSync(path.join(rootDir, d.seed), 'utf8'));
                writeAtomic(routeFile(d.id), JSON.stringify(v.geojson));
                Object.assign(r, { hasGeo: true, points: v.points, lengthKm: v.lengthKm, bbox: v.bbox });
            } catch (e) { console.warn(`[CONFIG] no s'ha pogut importar ${d.seed}: ${e.message}`); }
            cfg.routes.push(r);
        }
        save();
    }

    function load() {
        try { cfg = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
        catch (e) {
            if (e.code === 'ENOENT') return seed();
            console.warn('[CONFIG] config.json il·legible; es prova la còpia .bak');
            try { cfg = JSON.parse(fs.readFileSync(FILE + '.bak', 'utf8')); } catch (e2) { return seed(); }
        }
        cfg.kings = Array.isArray(cfg.kings) ? cfg.kings : [];
        cfg.routes = Array.isArray(cfg.routes) ? cfg.routes : [];
        if (onChange) onChange(cfg);
    }

    const kingExists = id => cfg.kings.some(k => k.id === id);
    const findRoute = id => cfg.routes.find(r => r.id === id);
    const slug = name => cleanText(name, 40).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'ruta';
    const uniqueId = base => { let id = base, n = 2; while (findRoute(id)) id = `${base.slice(0, 20)}-${n++}`; return id; };

    function checkRouteFields(body, current) {
        const out = {};
        if ('name' in body || !current) { out.name = cleanText(body.name, 40); if (!out.name) throw new Error('Cal un nom per a la ruta.'); }
        if ('color' in body || !current) { out.color = String(body.color || ''); if (!HEX.test(out.color)) throw new Error('El color ha de ser un hexadecimal com #ab2330.'); }
        if ('tracker' in body || !current) {
            const t = body.tracker ? String(body.tracker) : null;
            if (t && !kingExists(t)) throw new Error('El rei assignat no existeix.');
            if (t && cfg.routes.some(r => r.tracker === t && (!current || r.id !== current.id))) throw new Error('Aquest rei ja té una altra ruta assignada.');
            out.tracker = t;
        }
        if ('enabled' in body) out.enabled = !!body.enabled;
        return out;
    }

    function applyGeo(route, geoInput) {
        const v = validateGeoJSON(geoInput);
        writeAtomic(routeFile(route.id), JSON.stringify(v.geojson));
        Object.assign(route, { hasGeo: true, points: v.points, lengthKm: v.lengthKm, bbox: v.bbox });
    }

    load();

    return {
        get: () => cfg,
        // Només el que necessita el navegador (rutes actives, sense camps interns)
        publicConfig() {
            return {
                version: cfg.version,
                kings: cfg.kings.map(k => ({ id: k.id, name: k.name, color: k.color, icon: k.icon === 'star' ? 'star' : 'crown' })),
                routes: cfg.routes.filter(r => r.enabled !== false).map(r => ({ id: r.id, name: r.name, color: r.color, tracker: r.tracker || null, hasGeo: !!r.hasGeo })),
            };
        },
        readRoute(id) { return /^[a-z0-9-]{1,24}$/.test(id) && findRoute(id) && findRoute(id).hasGeo ? fs.readFileSync(routeFile(id)) : null; },
        // Àrea que cobreixen totes les rutes (per limitar el geocodificador i els mosaics)
        bbox() {
            let b = null;
            for (const r of cfg.routes) if (r.hasGeo && r.bbox) b = b ? [Math.min(b[0], r.bbox[0]), Math.min(b[1], r.bbox[1]), Math.max(b[2], r.bbox[2]), Math.max(b[3], r.bbox[3])] : [...r.bbox];
            return b;
        },
        addRoute(body) {
            if (cfg.routes.length >= MAX_ROUTES) throw new Error('Has arribat al màxim de rutes.');
            const f = checkRouteFields(body, null);
            const r = { id: uniqueId(slug(f.name)), ...f, enabled: f.enabled !== false, hasGeo: false, points: 0, lengthKm: 0, bbox: null };
            if (body.geojson) applyGeo(r, body.geojson);
            cfg.routes.push(r); save(); return r;
        },
        updateRoute(id, body) {
            const r = findRoute(id); if (!r) throw new Error('Ruta inexistent.');
            Object.assign(r, checkRouteFields(body, r));
            if (body.geojson) applyGeo(r, body.geojson);
            save(); return r;
        },
        deleteRoute(id) {
            const i = cfg.routes.findIndex(r => r.id === id); if (i < 0) throw new Error('Ruta inexistent.');
            cfg.routes.splice(i, 1);
            try { fs.renameSync(routeFile(id), routeFile(id) + '.deleted'); } catch (e) { /* res */ } // es conserva una còpia per si cal recuperar-la
            save();
        },
        reorder(ids) {
            if (!Array.isArray(ids) || ids.length !== cfg.routes.length || new Set(ids).size !== ids.length || !ids.every(findRoute)) throw new Error('Ordre no vàlid.');
            cfg.routes = ids.map(findRoute); save();
        },
        addKing(body) {
            if (cfg.kings.length >= MAX_KINGS) throw new Error('Has arribat al màxim de reis.');
            const id = normalizeKingId(body.id);
            if (!id) throw new Error('L\'identificador ha de començar amb una lletra i només tenir lletres, números, - o _ (màx. 24).');
            if (kingExists(id)) throw new Error('Aquest identificador ja existeix.');
            const name = cleanText(body.name, 40); if (!name) throw new Error('Cal un nom.');
            if (!HEX.test(String(body.color || ''))) throw new Error('Color no vàlid.');
            cfg.kings.push({ id, name, color: body.color, icon: body.icon === 'star' ? 'star' : 'crown' }); save();
        },
        updateKing(id, body) {
            const k = cfg.kings.find(x => x.id === id); if (!k) throw new Error('Rei inexistent.');
            if ('name' in body) { const n = cleanText(body.name, 40); if (!n) throw new Error('Cal un nom.'); k.name = n; }
            if ('color' in body) { if (!HEX.test(String(body.color))) throw new Error('Color no vàlid.'); k.color = body.color; }
            if ('icon' in body) k.icon = body.icon === 'star' ? 'star' : 'crown';
            save();
        },
        deleteKing(id) {
            if (!kingExists(id)) throw new Error('Rei inexistent.');
            if (cfg.routes.some(r => r.tracker === id)) throw new Error('Aquest rei té una ruta assignada: treu-li primer l\'assignació.');
            cfg.kings = cfg.kings.filter(k => k.id !== id); save();
        },
    };
}

module.exports = { create, validateGeoJSON, normalizeKingId, bboxOf };
