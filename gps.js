'use strict';
/**
 * Filtre de posicions GPS dels reis (sense dependències, es pot provar a part).
 *
 * Problema: el GPS d'un mòbil entre edificis fa «salts» falsos (de cop 100-300 m més enllà, i al ping següent torna
 * a prop d'on era). Una cavalcada va a peu (~0,6 m/s), així que un salt així és gairebé sempre un error.
 *
 * Estratègia:
 *  1. Rebuig directe: fora de zona, precisió dolenta, hora absurda.
 *  2. Un punt «sospitós» (massa lluny i massa ràpid respecte de l'últim bo) NO es publica de seguida: queda en espera.
 *     - Si el ping següent torna a prop de l'últim bo → el sospitós era un salt fals i es descarta.
 *     - Si el ping següent confirma la nova posició (és a prop del sospitós) → era un moviment real i s'accepten tots dos.
 *     - Si n'arriben uns quants de sospitosos seguits i coherents entre ells → l'últim bo era el dolent: s'accepta el nou.
 *  Cost: només els salts reals (p. ex. el rei puja a un cotxe) es veuen un ping més tard. La resta, a l'instant.
 */

const env = (name, def) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : def; };
const OPTS = {
    maxAccuracy: env('GPS_MAX_ACCURACY', 60),   // m: fixos amb pitjor precisió es descarten
    jumpMeters: env('GPS_JUMP_M', 40),          // m: per sota d'això mai és un salt (soroll normal del GPS)
    suspectSpeed: env('GPS_SUSPECT_SPEED', 3),  // m/s: més ràpid que això (una cavalcada va a ~0,6) és sospitós
    maxSpeed: env('GPS_MAX_SPEED', 20),         // m/s: més ràpid que això és impossible (s'exigeix confirmació igualment)
    confirmPings: 3,                            // sospitosos coherents seguits per donar per bo un canvi de lloc
};

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Punts: [ts, lat, lng] (com a server.js). acc: precisió en m (opcional).
const dist = (a, b) => haversine(a[1], a[2], b[1], b[2]);

/** És un salt sospitós anar de a a b? (marge segons la precisió informada pel mòbil) */
function isJump(a, b, acc, opts = OPTS) {
    const d = dist(a, b), dt = Math.max(1, (b[0] - a[0]) / 1000);
    const slack = Math.max(opts.jumpMeters, 2 * (Number.isFinite(acc) ? acc : 0));
    return d > slack && d / dt > opts.suspectSpeed;
}

/**
 * Crea un filtre amb estat per rei.
 *  check(id, point, acc, last) → { accept: [punts a afegir], drop: motiu|null }
 *  `last` és l'últim punt acceptat d'aquest rei (o null).
 */
function createFilter(opts = OPTS) {
    const pending = new Map(); // id -> { pts: [[ts,lat,lng,acc]...] } punts sospitosos en espera

    function check(id, p, acc, last) {
        if (Number.isFinite(acc) && acc > opts.maxAccuracy) return { accept: [], drop: `precisió ${Math.round(acc)} m` };
        if (!last) { pending.delete(id); return { accept: [p], drop: null }; }

        // Els pings endarrerits (buffer sense cobertura) els tracta qui crida (checkLate): aquí només en ordre
        if (p[0] <= last[0]) return { accept: [], drop: 'duplicat o fora d\'ordre' };

        const pend = pending.get(id);
        if (pend) {
            const ref = pend.pts[pend.pts.length - 1];
            if (!isJump(last, p, acc, opts)) {
                // Ha tornat a prop de l'últim bo: els punts en espera eren salts falsos
                pending.delete(id);
                return { accept: [p], drop: `salt fals descartat (${pend.pts.length} punt${pend.pts.length > 1 ? 's' : ''})` };
            }
            if (!isJump(ref, p, acc, opts)) {
                // Coherent amb el punt en espera: era un moviment real
                pending.delete(id);
                return { accept: [...pend.pts.map(x => x.slice(0, 3)), p], drop: null };
            }
            // Un altre salt, lluny de tot: es guarda; si se n'acumulen massa, es reinicia des del més recent
            pend.pts.push([...p, acc]);
            if (pend.pts.length >= opts.confirmPings) {
                pending.delete(id);
                return { accept: [p], drop: 'reinici de posició després de diversos salts' };
            }
            return { accept: [], drop: 'en espera de confirmació' };
        }

        if (isJump(last, p, acc, opts)) {
            pending.set(id, { pts: [[...p, acc]] });
            return { accept: [], drop: 'en espera de confirmació' };
        }
        return { accept: [p], drop: null };
    }

    return { check, reset: id => (id ? pending.delete(id) : pending.clear()), pendingOf: id => pending.get(id) };
}

/**
 * Ping endarrerit (el mòbil n'envia de guardats quan recupera cobertura): s'accepta si és coherent amb el punt que té
 * just abans en el temps. Retorna el motiu de rebuig o null.
 */
function checkLate(arr, p, acc, opts = OPTS) {
    if (Number.isFinite(acc) && acc > opts.maxAccuracy) return `precisió ${Math.round(acc)} m`;
    let i = arr.length - 1;
    while (i >= 0 && arr[i][0] > p[0]) i--;
    if (i >= 0 && arr[i][0] === p[0]) return 'duplicat';
    const prev = i >= 0 ? arr[i] : null, next = arr[i + 1];
    for (const n of [prev, next]) {
        if (!n) continue;
        const d = dist(n, p), dt = Math.max(1, Math.abs(p[0] - n[0]) / 1000);
        if (d > opts.jumpMeters && d / dt > opts.suspectSpeed) return `endarrerit incoherent (${Math.round(d)} m en ${Math.round(dt)} s)`;
    }
    return null;
}

/**
 * Neteja un historial ja desat: treu els punts aïllats que fan anada i tornada ràpida (A → B lluny → C a prop d'A).
 * Una cavalcada a peu no pot anar i tornar 40+ m a més de 3 m/s, així que no esborra recorreguts reals.
 */
function despike(arr, opts = OPTS) {
    if (arr.length < 3) return arr;
    const out = [arr[0]];
    for (let i = 1; i < arr.length - 1; i++) {
        const a = out[out.length - 1], b = arr[i], c = arr[i + 1];
        // Mateix criteri que en directe: b és un salt des d'a, però c torna a ser coherent amb a → b era fals
        if (isJump(a, b, 0, opts) && !isJump(a, c, 0, opts) && dist(a, c) < dist(a, b)) continue;
        out.push(b);
    }
    out.push(arr[arr.length - 1]);
    return out;
}

module.exports = { createFilter, checkLate, despike, haversine, isJump, OPTS };
