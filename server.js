require('dotenv').config();
const http = require('http');
const fs = require('fs');
const url = require('url');
const path = require('path');
const querystring = require('querystring');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Carregar dades existents (persistència entre reinicis)
let db = {};
if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { db = {}; }
}
console.log(`[DB] Reis en memòria: ${Object.keys(db).join(', ') || 'Cap (net)'}`);

function refreshDB() {
    if (fs.existsSync(DATA_FILE)) {
        try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { db = {}; }
    }
}
refreshDB();

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    let pathname = parsedUrl.pathname;

    // Handle /tracker subpath and redirect to ensure trailing slash for relative frontend assets
    // (Only redirect browser visits; do not redirect Traccar client pings if they omit the trailing slash)
    if (pathname === '/tracker' && req.method !== 'POST' && !parsedUrl.query.id) {
        res.writeHead(301, { 'Location': '/tracker/' });
        return res.end();
    }
    if (pathname.startsWith('/tracker/')) {
        pathname = pathname.substring(8); // Strip '/tracker', keep the leading '/'
    }

    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/demo' || pathname === '/demo/') pathname = '/demo.html';

    // 1. HEALTH CHECK RAPIDO
    if (pathname === '/health' || req.method === 'HEAD') {
        res.writeHead(200);
        return res.end('OK');
    }

    // 2. RECEPTOR TRACCAR (Flexible y con Logs)
    if (req.method === 'POST' || (req.method === 'GET' && parsedUrl.query.id)) {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            const params = { ...parsedUrl.query, ...querystring.parse(body) };
            
            // Log de depuración para ver qué llega exactamente
            console.log(`[DEBUG] Datos recibidos: ${JSON.stringify(params)}`);

            // Mapeo flexible de nombres (id/deviceid, lat/latitude, lon/longitude)
            let id = params.id || params.deviceid;
            const lat = params.lat || params.latitude;
            const lon = params.lon || params.longitude;

            if (id && lat && lon) {
                // Normalizar ID: melchor -> Melcior (Català)
                id = id.charAt(0).toUpperCase() + id.slice(1).toLowerCase();
                if (id === "Melchor") id = "Melcior"; 
                
                refreshDB();
                if (!db[id]) db[id] = {};
                db[id]["p_" + Date.now()] = {
                    device_id: id,
                    location: {
                        coords: { latitude: parseFloat(lat), longitude: parseFloat(lon) },
                        timestamp: new Date().toISOString()
                    }
                };
                fs.writeFileSync(DATA_FILE, JSON.stringify(db));
                console.log(` ✅ GUARDADO: ${id} en [${lat}, ${lon}]`);
                res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                return res.end('OK');
            } else {
                console.log(` ⚠️ PING INVALIDO: Faltan campos (id:${id}, lat:${lat}, lon:${lon})`);
                res.writeHead(200); // Respondemos 200 para que la app no de error, pero avisamos en log
                return res.end('MISSING_FIELDS');
            }
        });
        return;
    }

    // 3. SERVIDOR DE ARCHIVOS
    const filePath = pathname === '/data.json' ? DATA_FILE : path.join(__dirname, pathname);
    const ext = path.parse(pathname).ext;
    const mimes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json' };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            return res.end('Not Found');
        }
        res.writeHead(200, { 
            'Content-Type': mimes[ext] || 'text/plain',
            'Cache-Control': (pathname === '/data.json' || ext === '.html') ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
});

process.on('SIGTERM', () => process.exit(0));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVIDOR DIAGNOSTICO EN PUERTO ${PORT}`);
});
