const http = require('http');
const fs = require('fs');
const url = require('url');
const path = require('path');
const querystring = require('querystring');

const PORT = 8080;
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = {};
if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { db = {}; }
}

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;

    // 1. RESPUESTA INSTANTÁNEA PARA EASYPANEL (HEALTH CHECK)
    if (pathname === '/health' || req.method === 'HEAD') {
        res.writeHead(200);
        return res.end('OK');
    }

    console.log(`[${req.method}] ${pathname}`);

    // 2. RECEPTOR TRACCAR
    if (pathname === '/index.html' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            const p = { ...parsedUrl.query, ...querystring.parse(body) };
            if (p.id && p.lat && p.lon) {
                if (!db[p.id]) db[p.id] = {};
                db[p.id]["p_" + Date.now()] = {
                    device_id: p.id,
                    location: {
                        coords: { latitude: parseFloat(p.lat), longitude: parseFloat(p.lon) },
                        timestamp: new Date().toISOString()
                    }
                };
                fs.writeFileSync(DATA_FILE, JSON.stringify(db));
                console.log(` ✅ [${new Date().toLocaleTimeString()}] Guardado: ${p.id} desde ${req.socket.remoteAddress}`);
                res.writeHead(200, { 'Connection': 'close', 'Content-Length': '0' });
                return res.end();
            }
            res.writeHead(400); res.end();
        });
        return;
    }

    // 3. SEGUIDOR DE ARCHIVOS (SIMPLIFICADO AL MÁXIMO)
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
            'Cache-Control': pathname === '/data.json' ? 'no-cache' : 'public, max-age=3600'
        });
        res.end(data);
    });
});

process.on('SIGTERM', () => process.exit(0));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVIDOR EN LINEA EN PUERTO ${PORT}`);
});
