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

    console.log(`[HTTP] ${req.method} ${pathname}`);

    // A. RECEPTOR TRACCAR (Soporta GET y POST)
    if (pathname === '/') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            // Combinamos query params de la URL y params del cuerpo del mensaje
            const combinedParams = { ...parsedUrl.query, ...querystring.parse(body) };
            
            // Si procesamos un ping con éxito, terminamos aquí
            if (handleTraccarPing(combinedParams, res)) return;

            // Si llegamos aquí y es '/' con GET, servimos index.html
            if (req.method === 'GET') {
                serveFile('/index.html', req, res);
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        return;
    }

    // B. SERVIDOR DE ARCHIVOS
    serveFile(pathname, req, res);
});

function serveFile(pathname, req, res) {
    let filePath;
    if (pathname === '/data.json') {
        filePath = DATA_FILE;
    } else {
        filePath = path.join(__dirname, pathname);
    }

    const ext = path.parse(pathname).ext;
    const mimeMap = {
        '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
        '.json': 'application/json', '.geojson': 'application/json',
        '.png': 'image/png', '.jpg': 'image/jpeg'
    };

    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404);
            return res.end("Not Found");
        }

        const headers = { 'Content-Type': mimeMap[ext] || 'text/plain' };
        if (pathname === '/data.json') {
            headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
            headers['Pragma'] = 'no-cache';
            headers['Expires'] = '0';
        }

        const acceptEncoding = req.headers['accept-encoding'] || '';
        if (acceptEncoding.includes('gzip') && ['.json', '.html', '.js', '.geojson', '.css'].includes(ext)) {
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
    });
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`===============================================`);
    console.log(`🚀 REISORIENT: RECEPTOR MULTI-PROTOCOLO`);
    console.log(`===============================================`);
    console.log(`🌍 Visor: http://0.0.0.0:${PORT}`);
    console.log(`📡 Receptor Traccar (GET/POST): ACTIVO ✅`);
    console.log(`📦 Persistencia: ${DATA_FILE}`);
    console.log(`===============================================`);
});
