const http = require('http');
const fs = require('fs');
const url = require('url');
const path = require('path');
const zlib = require('zlib');
const querystring = require('querystring');

// --- CONFIGURACIÓN ---
const PORT = 8080;
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- BASE DE DATOS LOCAL ---
let db = {};

function loadLocalCache() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf8');
            if (content) db = JSON.parse(content);
            console.log(`[DB] Base de datos cargada. Reyes en memoria: ${Object.keys(db).join(', ') || 'Ninguno'}`);
        }
    } catch (e) {
        console.error("[ERROR] No se pudo cargar data.json:", e.message);
        db = {};
    }
}

function saveLocalCache() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error("[ERROR] No se pudo guardar data.json:", e.message);
    }
}

loadLocalCache();

// --- PROCESADOR DE PINGS TRACCAR ---
function handleTraccarPing(params, res) {
    const { id, lat, lon, timestamp: tsQuery } = params;
    
    if (id && lat && lon) {
        if (!db[id]) db[id] = {};
        
        const timestamp = tsQuery ? parseInt(tsQuery) * 1000 : Date.now();
        const pointId = "p_" + Date.now();

        db[id][pointId] = {
            device_id: id,
            location: {
                coords: { latitude: parseFloat(lat), longitude: parseFloat(lon) },
                timestamp: new Date(timestamp).toISOString()
            }
        };

        const keys = Object.keys(db[id]);
        if (keys.length > 1500) {
            const keysToSort = keys.sort();
            delete db[id][keysToSort[0]];
        }

        saveLocalCache();
        console.log(`[TRACCAR] ✅ Recibido ${id}: [${lat}, ${lon}]`);
        
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('OK');
        return true;
    }
    return false;
}

// --- SERVIDOR ---
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // A. EXCLUSIVO EASYPANEL: Respueta rápida de salud
    if (pathname === '/health' || (pathname === '/' && req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('OK');
    }

    console.log(`[HTTP] ${req.method} ${pathname}`);

    // B. RECEPTOR TRACCAR (Soporta GET y POST)
    if (pathname === '/') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            const combinedParams = { ...parsedUrl.query, ...querystring.parse(body) };
            if (handleTraccarPing(combinedParams, res)) return;

            // Si es un GET normal a /, servimos el mapa
            if (req.method === 'GET') {
                serveFile('/index.html', req, res);
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        return;
    }

    // C. SERVIDOR DE ARCHIVOS
    serveFile(pathname, req, res);
});

// Cache en memoria para archivos críticos (Velocidad extrema para Health Checks)
const fileCache = {};

function serveFile(pathname, req, res) {
    let filePath = pathname === '/data.json' ? DATA_FILE : path.join(__dirname, pathname);
    const ext = path.parse(pathname).ext;
    
    // Si es data.json o no está en caché, leemos de disco
    if (pathname === '/data.json' || !fileCache[pathname]) {
        fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) {
                res.writeHead(404);
                return res.end("Not Found");
            }

            const mimeMap = {
                '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.geojson': 'application/json',
                '.png': 'image/png', '.jpg': 'image/jpeg'
            };

            const headers = { 'Content-Type': mimeMap[ext] || 'text/plain' };
            if (pathname === '/data.json') {
                headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
                headers['Pragma'] = 'no-cache';
                headers['Expires'] = '0';
            }

            const acceptEncoding = req.headers['accept-encoding'] || '';
            const shouldGzip = acceptEncoding.includes('gzip') && ['.json', '.html', '.js', '.geojson', '.css'].includes(ext);

            if (shouldGzip) {
                headers['Content-Encoding'] = 'gzip';
                res.writeHead(200, headers);
                const raw = fs.createReadStream(filePath);
                const gzip = zlib.createGzip();
                raw.on('error', () => res.end());
                gzip.on('error', () => res.end());
                raw.pipe(gzip).pipe(res);
            } else {
                res.writeHead(200, headers);
                const raw = fs.createReadStream(filePath);
                raw.on('error', () => res.end());
                raw.pipe(res);
            }

            // Cacheamos archivos estáticos (excepto data.json)
            if (pathname !== '/data.json' && stat.size < 1000000) {
                fs.readFile(filePath, (err, data) => {
                    if (!err) fileCache[pathname] = data;
                });
            }
        });
    } else {
        // Servir desde memoria (instantáneo)
        const mimeMap = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.geojson': 'application/json' };
        res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'text/plain' });
        res.end(fileCache[pathname]);
    }
}

// Cierre limpio para evitar errores de npm/EasyPanel
process.on('SIGTERM', () => {
    console.log('[SYSTEM] SIGTERM recibido. Cerrando servidor...');
    server.close(() => {
        process.exit(0);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`===============================================`);
    console.log(`🚀 REISORIENT: RECEPTOR MULTI-PROTOCOLO`);
    console.log(`===============================================`);
    console.log(`🌍 Visor: http://0.0.0.0:${PORT}`);
    console.log(`📡 Receptor Traccar (GET/POST): ACTIVO ✅`);
    console.log(`📦 Persistencia: ${DATA_FILE}`);
    console.log(`===============================================`);
});
