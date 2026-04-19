const http = require('http');
const fs = require('fs');
const url = require('url');
const path = require('path');
const zlib = require('zlib');

// --- CONFIGURACIÓN ---
const PORT = 8080;
// Permitir definir una carpeta de datos persistente (ideal para Docker/EasyPanel)
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// Asegurar que la carpeta de datos existe
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- BASE DE DATOS LOCAL (EN MEMORIA + DISCO) ---
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

// --- SERVIDOR ÚNICO ---
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    let pathname = parsedUrl.pathname;

    // A. RECEPTOR TRACCAR (Directo a Memoria y Disco)
    if (pathname === '/' && parsedUrl.query.id && parsedUrl.query.lat && parsedUrl.query.lon) {
        const kingId = parsedUrl.query.id;
        const lat = parseFloat(parsedUrl.query.lat);
        const lon = parseFloat(parsedUrl.query.lon);
        
        const timestamp = parsedUrl.query.timestamp 
            ? parseInt(parsedUrl.query.timestamp) * 1000 
            : Date.now();

        if (!db[kingId]) db[kingId] = {};

        const pointId = "p_" + Date.now();

        db[kingId][pointId] = {
            device_id: kingId,
            location: {
                coords: {
                    latitude: lat,
                    longitude: lon
                },
                timestamp: new Date(timestamp).toISOString()
            }
        };

        const keys = Object.keys(db[kingId]);
        if (keys.length > 1500) {
            const keysToSort = keys.sort();
            delete db[kingId][keysToSort[0]];
        }

        saveLocalCache();
        console.log(`[TRACCAR] Ping ${kingId}: [${lat}, ${lon}] guardado.`);

        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        return res.end('OK');
    }

    // B. SERVIDOR DE ARCHIVOS (WEB) CON COMPRESIÓN GZIP
    if (pathname === '/') pathname = '/index.html';
    
    // CASO ESPECIAL: Si piden data.json, usamos la ruta absoluta de DATA_FILE
    // (Esto es vital para los volúmenes de EasyPanel)
    let filePath;
    if (pathname === '/data.json') {
        filePath = DATA_FILE;
    } else {
        filePath = path.join(__dirname, pathname);
    }

    const ext = path.parse(pathname).ext;
    const mimeMap = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.geojson': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg'
    };

    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404);
            return res.end("Not Found");
        }

        const mimeType = mimeMap[ext] || 'text/plain';
        const headers = { 'Content-Type': mimeType };

        // Cache-busting para data.json
        if (pathname === '/data.json') {
            headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
            headers['Pragma'] = 'no-cache';
            headers['Expires'] = '0';
        }

        // --- Lógica de Compresión Gzip ---
        const acceptEncoding = req.headers['accept-encoding'] || '';
        if (acceptEncoding.includes('gzip') && (ext === '.json' || ext === '.html' || ext === '.js' || ext === '.geojson' || ext === '.css')) {
            headers['Content-Encoding'] = 'gzip';
            res.writeHead(200, headers);
            const raw = fs.createReadStream(filePath);
            raw.pipe(zlib.createGzip()).pipe(res);
        } else {
            res.writeHead(200, headers);
            fs.createReadStream(filePath).pipe(res);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`===============================================`);
    console.log(`🚀 REISORIENT: SERVIDOR OPTIMIZADO PARA TRÁFICO`);
    console.log(`===============================================`);
    console.log(`🌍 Visor en línea en el puerto: ${PORT}`);
    console.log(`📡 Modo Compresión Gzip: ACTIVADO ✅`);
    console.log(`===============================================`);
});
