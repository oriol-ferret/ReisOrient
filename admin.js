'use strict';
/**
 * API d'administració (/api/admin/*). Només funciona si hi ha ADMIN_KEY (o, si no, STATS_KEY).
 * Seguretat: accés amb clau (comparació de temps constant) -> sessió de 8 h en cookie HttpOnly + SameSite=Strict; límit
 * d'intents per IP; i, per modificar, la capçalera X-Requested-With (obliga el navegador a fer una comprovació prèvia CORS: un altre web no pot enviar-la).
 */
const crypto = require('crypto');

const SESSION_MS = 8 * 3600 * 1000;
const MAX_BODY = 2 * 1024 * 1024;

function create({ config, adminKey, limited, clientIp, safeEqual }) {
    const sessions = new Map(); // token -> caducitat

    const send = (res, code, obj, extra = {}) => {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extra });
        res.end(body);
    };
    const readJson = req => new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Petició massa gran.'), { code: 413 })); req.destroy(); } else chunks.push(c); });
        req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('JSON no vàlid.'), { code: 400 })); } });
        req.on('error', reject);
    });
    const cookieToken = req => (String(req.headers.cookie || '').match(/(?:^|;\s*)ro_admin=([a-f0-9]{48})/) || [])[1];
    const authed = req => {
        const t = cookieToken(req), exp = t && sessions.get(t);
        if (!exp) return false;
        if (Date.now() > exp) { sessions.delete(t); return false; }
        return true;
    };
    const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

    /** Retorna true si la ruta era d'admin (ja s'ha respost). */
    async function handle(req, res, pathname) {
        if (!pathname.startsWith('/api/admin/')) return false;
        if (!adminKey) { res.writeHead(404); res.end('Not Found'); return true; }
        const route = pathname.slice('/api/admin/'.length);
        try {
            if (route === 'login' && req.method === 'POST') {
                if (limited('adminlogin:' + clientIp(req), 8, 15 * 60000)) return send(res, 429, { error: 'Massa intents. Espera uns minuts.' }), true;
                const body = await readJson(req);
                if (!safeEqual(String(body.key || ''), adminKey)) {
                    await new Promise(r => setTimeout(r, 500)); // frena la força bruta
                    return send(res, 401, { error: 'Clau incorrecta.' }), true;
                }
                const now = Date.now();
                for (const [t, e] of sessions) if (e < now) sessions.delete(t);
                if (sessions.size > 50) sessions.delete(sessions.keys().next().value);
                const token = crypto.randomBytes(24).toString('hex');
                sessions.set(token, now + SESSION_MS);
                return send(res, 200, { ok: true }, { 'Set-Cookie': `ro_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}` }), true;
            }
            if (route === 'session' && req.method === 'GET') return send(res, 200, { authed: authed(req) }), true;
            if (!authed(req)) return send(res, 401, { error: 'Cal iniciar sessió.' }), true;
            if (req.method !== 'GET') {
                if (req.headers['x-requested-with'] !== 'admin') return send(res, 403, { error: 'Petició no permesa.' }), true;
            }
            if (route === 'logout' && req.method === 'POST') {
                const t = cookieToken(req); if (t) sessions.delete(t);
                return send(res, 200, { ok: true }, { 'Set-Cookie': 'ro_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }), true;
            }
            if (route === 'config' && req.method === 'GET') return send(res, 200, config.get()), true;

            let m;
            if (route === 'routes' && req.method === 'POST') return send(res, 200, config.addRoute(await readJson(req))), true;
            if (route === 'routes-order' && req.method === 'POST') { config.reorder((await readJson(req)).ids); return send(res, 200, { ok: true }), true; }
            if ((m = /^routes\/([a-z0-9-]{1,24})\/geojson$/.exec(route)) && req.method === 'GET') {
                const buf = config.readRoute(m[1]);
                if (!buf) return send(res, 404, { error: 'Aquesta ruta no té traçat.' }), true;
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(buf); return true;
            }
            if ((m = /^routes\/([a-z0-9-]{1,24})$/.exec(route))) {
                if (req.method === 'PATCH') return send(res, 200, config.updateRoute(m[1], await readJson(req))), true;
                if (req.method === 'DELETE') { config.deleteRoute(m[1]); return send(res, 200, { ok: true }), true; }
            }
            if (route === 'kings' && req.method === 'POST') { config.addKing(await readJson(req)); return send(res, 200, { ok: true }), true; }
            if ((m = /^kings\/([A-Za-z][\w-]{0,23})$/.exec(route))) {
                if (req.method === 'PATCH') { config.updateKing(m[1], await readJson(req)); return send(res, 200, { ok: true }), true; }
                if (req.method === 'DELETE') { config.deleteKing(m[1]); return send(res, 200, { ok: true }), true; }
            }
            return send(res, 404, { error: 'No trobat.' }), true;
        } catch (e) {
            return send(res, e.code === 413 || e.code === 400 ? e.code : 400, { error: e.message || 'Error.' }), true;
        }
    }
    return { handle };
}

module.exports = { create };
