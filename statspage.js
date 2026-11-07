'use strict';
/**
 * Pàgina d'estadístiques (/stats): pestanyes «Ara», «Comparar» i «Resum», i descàrregues CSV/JSON.
 * Només llegeix les dades (stats, live, recent, lastPing) que li passa server.js; no desa res.
 */
const TZ = 'Europe/Madrid';
const fmtHM = new Intl.DateTimeFormat('ca-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtHMS = new Intl.DateTimeFormat('ca-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtDM = new Intl.DateTimeFormat('ca-ES', { timeZone: TZ, day: '2-digit', month: '2-digit' });
const fmtParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
const fmtLong = new Intl.DateTimeFormat('ca-ES', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const RANGES = { '1h': 60, '3h': 180, '6h': 360, '24h': 1440, '48h': 2880 };
const COLORS = { a: '#6b1d3a', b: '#d4a017' };

const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (o, f) => (o && o[f]) || 0;
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
const topList = (obj, n = 12) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
const merge = (target, src) => { for (const [k, v] of Object.entries(src || {})) target[k] = (target[k] || 0) + v; return target; };
const q = v => encodeURIComponent(v || '');

// Data i hora de Madrid d'un instant
function madridParts(ts) {
    const o = {};
    for (const p of fmtParts.formatToParts(new Date(ts))) o[p.type] = p.value;
    return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 };
}

// Agrupa les hores guardades (UTC) per dia de Madrid
function byMadridDay(stats) {
    const days = {};
    for (const [key, h] of Object.entries(stats.hours)) {
        const ts = Date.parse(key + ':00:00Z');
        if (!Number.isFinite(ts)) continue;
        const { date, hour } = madridParts(ts);
        const d = days[date] ||= { date, views: 0, active: 0, beats: 0, mobile: 0, desktop: 0, yes: 0, no: 0, errors: 0, homes: 0, favs: 0, peak: 0, peakHour: 0, opens: {}, lang: {}, pings: {}, hv: Array(24).fill(0), hp: Array(24).fill(0) };
        d.views += num(h, 'views'); d.active += num(h, 'active'); d.beats += num(h, 'beats'); d.mobile += num(h, 'mobile'); d.desktop += num(h, 'desktop');
        d.yes += num(h, 'consentYes'); d.no += num(h, 'consentNo'); d.errors += num(h, 'errors'); d.homes += num(h, 'homes'); d.favs += num(h, 'favs');
        d.hv[hour] += num(h, 'views'); d.hp[hour] = Math.max(d.hp[hour], num(h, 'peak'));
        if (num(h, 'peak') > d.peak) { d.peak = num(h, 'peak'); d.peakHour = hour; }
        merge(d.opens, h.opens); merge(d.lang, h.lang); merge(d.pings, h.pings);
    }
    return days;
}

// ---------- Gràfiques SVG (sense dependències ni JS al navegador) ----------
function axisGrid(W, H, L, R, T, B, nice) {
    const y = v => T + (H - T - B) * (1 - v / nice);
    let g = '';
    for (let k = 0; k <= 4; k++) {
        const v = nice * k / 4, yy = y(v);
        g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#ececec"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#777">${Math.round(v)}</text>`;
    }
    return { g, y };
}
const niceMax = max => (max <= 4 ? 4 : Math.ceil(max / 4) * 4);

function chartSVG(pts, key, color, kind, minutes) {
    const W = 860, H = 190, L = 34, R = 8, T = 10, B = 22;
    const nice = niceMax(Math.max(1, ...pts.map(p => p[key])));
    const x = i => L + (pts.length <= 1 ? 0 : i * (W - L - R) / (pts.length - 1));
    const { g: grid, y } = axisGrid(W, H, L, R, T, B, nice);
    const bw = Math.max(1, (W - L - R) / pts.length - 1);
    let g = grid;
    const ticks = 6;
    for (let k = 0; k < ticks; k++) {
        const i = Math.round(k * (pts.length - 1) / (ticks - 1));
        const d = new Date(pts[i].t);
        const label = minutes > 360 ? `${fmtDM.format(d)} ${fmtHM.format(d)}` : fmtHM.format(d);
        g += `<text x="${x(i)}" y="${H - 6}" text-anchor="${k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle'}" font-size="10" fill="#777">${esc(label)}</text>`;
    }
    let shape;
    if (kind === 'bars') {
        shape = pts.map((p, i) => p[key] ? `<rect x="${x(i) - bw / 2}" y="${y(p[key])}" width="${bw}" height="${y(0) - y(p[key])}" fill="${color}" rx="1"/>` : '').join('');
    } else {
        const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
        shape = `<path d="${line}L${x(pts.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z" fill="${color}" fill-opacity=".16"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
    }
    const hits = pts.map((p, i) => {
        const d = new Date(p.t);
        return `<rect x="${x(i) - bw / 2 - 0.5}" y="${T}" width="${bw + 1}" height="${H - T - B}" fill="transparent"><title>${esc(fmtDM.format(d) + ' ' + fmtHM.format(d) + ' · ' + p[key])}</title></rect>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" style="display:block">${g}${shape}${hits}</svg>`;
}

// 24 hores de Madrid amb una o dues sèries (per comparar dos dies)
function hoursSVG(series) {
    const W = 860, H = 210, L = 34, R = 8, T = 10, B = 22;
    const nice = niceMax(Math.max(1, ...series.flatMap(s => s.vals)));
    const x = i => L + i * (W - L - R) / 23;
    const { g: grid, y } = axisGrid(W, H, L, R, T, B, nice);
    let g = grid;
    for (let h = 0; h < 24; h += 3) g += `<text x="${x(h)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#777">${String(h).padStart(2, '0')}h</text>`;
    const lines = series.map(s => {
        const d = s.vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
        const dots = s.vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(s.name + ' · ' + String(i).padStart(2, '0') + 'h · ' + v)}</title></circle>`).join('');
        return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round"/>${dots}`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" style="display:block">${g}${lines}</svg>`;
}

// Sèrie per minuts (agrupada si el rang és llarg)
function minuteSeries(stats, now, minutes) {
    const step = Math.max(1, Math.ceil(minutes / 180));
    const out = [];
    const startMin = Math.floor(now / 60000) - minutes + 1;
    for (let i = 0; i < minutes; i += step) {
        let v = 0, p = 0;
        for (let j = i; j < Math.min(i + step, minutes); j++) {
            const m = stats.minutes[new Date((startMin + j) * 60000).toISOString().slice(0, 16)];
            if (m) { v += m[0]; p = Math.max(p, m[1]); }
        }
        out.push({ t: (startMin + i) * 60000, v, p });
    }
    return { pts: out, step };
}

const listHTML = (obj, empty = '—') => {
    const t = topList(obj);
    return t.length ? t.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('') : `<tr><td class="muted">${esc(empty)}</td><td></td></tr>`;
};
const kpi = (label, value, sub) => `<div class="k"><div class="kv">${value}</div><div class="kl">${esc(label)}</div>${sub ? `<div class="ks">${sub}</div>` : ''}</div>`;

// ---------- Pàgina ----------
const CSS = `
:root{--ink:#202124;--mut:#5f6368;--line:#e6e6e6;--bg:#f7f5f2;--card:#fff;--wine:#6b1d3a;--gold:#d4a017}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
header.top{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid var(--line)}
.wrap{max-width:980px;margin:0 auto;padding:0 16px}
.bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 0}
.bar h1{font-size:1.1rem;margin:0;color:var(--wine)}
nav.tabs{display:flex;gap:4px;margin-left:auto}
nav.tabs a{padding:7px 14px;border-radius:18px;text-decoration:none;color:var(--mut);font-weight:600;font-size:.9rem}
nav.tabs a.on{background:var(--wine);color:#fff}
main{padding:18px 0 60px}
h2{font-size:1.02rem;margin:26px 0 8px}
.sub{color:var(--mut);font-size:.82rem;margin:0 0 6px}.muted{color:#80868b;font-size:.82rem}
.kg{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.k{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kv{font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums}.kl{font-size:.8rem;color:var(--mut)}.ks{font-size:.74rem;color:#80868b;margin-top:2px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.pills{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px}
.pills a{padding:4px 12px;border:1px solid #d5d5d5;border-radius:16px;text-decoration:none;color:#444;font-size:.84rem;background:#fff}
.pills a.on{background:var(--wine);color:#fff;border-color:var(--wine)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
td,th{border-bottom:1px solid #eee;padding:6px 8px;text-align:right;font-size:.88rem}th:first-child,td:first-child{text-align:left}th{color:var(--mut);font-weight:600;white-space:nowrap}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px}
.two>div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:2px 12px 8px}
.two h2{margin:12px 0 4px}
form.cmp{display:flex;gap:10px;flex-wrap:wrap;align-items:center;background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 12px}
select,button.btn,a.btn{font:inherit;font-size:.9rem;padding:6px 10px;border:1px solid #cfcfcf;border-radius:8px;background:#fff;color:var(--ink);text-decoration:none;cursor:pointer}
button.btn.pri{background:var(--wine);color:#fff;border-color:var(--wine)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.up{color:#1e7e34}.down{color:#b3261e}
.note{background:#fff8e1;border:1px solid #f0dc9a;border-radius:10px;padding:8px 12px;margin:6px 0;font-size:.88rem}
.good{background:#eaf6ec;border-color:#b9dcc0}.bad{background:#fdecea;border-color:#f1b9b3}
ul.rv{padding-left:18px;margin:6px 0}ul.rv li{margin:5px 0}
@media print{header.top nav,.noprint,.pills,form.cmp{display:none!important}body{background:#fff}.card,.k,.two>div{break-inside:avoid}}
`;

function shell(tab, keyQuery, extraHead, body) {
    const t = (id, label) => `<a href="?${keyQuery}tab=${id}"${tab === id ? ' class="on"' : ''}>${label}</a>`;
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Estadístiques · Cavalcada</title><style>${CSS}</style>
<header class="top"><div class="wrap"><div class="bar"><h1>Estadístiques</h1><nav class="tabs">${t('live', 'Ara')}${t('compare', 'Comparar')}${t('review', 'Resum')}</nav></div></div></header>
<main><div class="wrap">${extraHead}${body}</div></main>`;
}

function renderLive(c) {
    const { stats, live, recent, lastPing, now, query, keyQuery } = c;
    const range = RANGES[query.range] ? query.range : '6h';
    const minutes = RANGES[range];
    const { pts, step } = minuteSeries(stats, now, minutes);
    const days = byMadridDay(stats);
    const last24 = []; for (let i = 0; i < 24; i++) { const k = new Date(now - i * 3600000).toISOString().slice(0, 13); last24.push({ k, ts: Date.parse(k + ':00:00Z'), ...(stats.hours[k] || {}) }); }
    const sum = f => last24.reduce((a, r) => a + num(r, f), 0);
    const views = sum('views'), mobile = sum('mobile'), desktop = sum('desktop'), yes = sum('consentYes'), no = sum('consentNo'), sessions = sum('active'), beats = sum('beats');
    const errors = sum('errors'), homes = sum('homes'), favs = sum('favs'), peak = Math.max(0, ...last24.map(r => num(r, 'peak')));
    const opens = {}, langs = {}, countries = {}, pings = {};
    last24.forEach(r => { merge(opens, r.opens); merge(langs, r.lang); merge(countries, r.cc); merge(pings, r.pings); });
    const avgMin = sessions ? Math.round(beats * 0.5 / sessions * 10) / 10 : 0;
    let peakAt = null; for (const p of pts) if (p.p > 0 && (!peakAt || p.p > peakAt.p)) peakAt = p;
    const lastDays = Object.entries(stats.days).sort().slice(-14);
    const refs = {}; for (const [, d] of lastDays) merge(refs, d.ref);
    const nowMin = stats.minutes[new Date(now).toISOString().slice(0, 16)];
    const pills = Object.keys(RANGES).map(r => `<a href="?${keyQuery}tab=live&range=${r}"${r === range ? ' class="on"' : ''}>${r}</a>`).join('');

    const recentRows = recent.slice(-25).reverse().map(r => `<tr><td>${esc(fmtDM.format(new Date(r.t)))} ${esc(fmtHMS.format(new Date(r.t)))}</td><td>${r.dev === 'm' ? 'mòbil' : 'ordinador'}</td><td>${esc(r.lang || '—')}</td><td>${esc(r.cc || '—')}</td><td>${esc(r.src || r.ref || '—')}</td></tr>`).join('');
    const pingRows = Object.entries(pings).length ? Object.entries(pings).sort().map(([id, n]) => {
        const last = lastPing.get(id);
        const ago = last ? Math.round((now - last) / 60000) : null;
        return `<tr><td>${esc(id)}</td><td>${n}</td><td>${last ? esc(fmtHMS.format(new Date(last))) : '—'}</td><td class="${ago != null && ago > 5 ? 'down' : ''}">${ago == null ? '—' : ago + ' min'}</td></tr>`;
    }).join('') : '<tr><td class="muted">Cap ping rebut a les últimes 24 h</td><td></td><td></td><td></td></tr>';
    const hourRows = last24.map(r => `<tr><td>${esc(fmtDM.format(new Date(r.ts)))} ${esc(fmtHM.format(new Date(r.ts)))}</td><td>${num(r, 'views')}</td><td>${num(r, 'active')}</td><td>${num(r, 'peak')}</td><td>${num(r, 'mobile')}/${num(r, 'desktop')}</td><td>${num(r, 'errors')}</td></tr>`).join('');
    const dayRows = lastDays.map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.anon || 0}</td><td>${v.visitors || 0}</td><td>${v.views || 0}</td><td>${esc(topList(v.homes, 8).map(([a, n]) => a + ' ' + n).join(' · ') || '—')}</td></tr>`).join('');
    const upMin = Math.round(process.uptime() / 60), rss = Math.round(process.memoryUsage().rss / 1048576);

    return `<p class="sub">Hores de Madrid · actualitzat ${esc(fmtHMS.format(new Date(now)))} · servidor engegat fa ${upMin} min (${rss} MB) · <a href="?${keyQuery}tab=live&range=${range}">refrescar</a></p>
<div class="kg">
${kpi('Connectats ara', live.size, nowMin ? 'visites aquest minut: ' + nowMin[0] : '')}${kpi('Pic simultani (24 h)', peak, peakAt ? 'a les ' + esc(fmtHM.format(new Date(peakAt.t))) : '')}${kpi('Visites (24 h)', views)}${kpi('Sessions (24 h)', sessions)}
${kpi('Minuts per sessió', '~' + avgMin)}${kpi('Mòbil', pct(mobile, mobile + desktop) + '%', mobile + ' mòbil / ' + desktop + ' PC')}${kpi('Cookies acceptades', pct(yes, yes + no) + '%', yes + ' sí / ' + no + ' no')}${kpi('Cases marcades', homes, views ? pct(homes, views) + '% de les visites' : '')}${kpi('Reis seguits', favs)}${kpi('Errors del navegador', errors)}
</div>
<h2>Persones connectades</h2><div class="pills">${pills}</div>
<div class="card">${chartSVG(pts, 'p', COLORS.a, 'area', minutes)}<div class="muted">Pic de persones connectades${step > 1 ? ' (agrupat cada ' + step + ' min)' : ' cada minut'}. Passa el cursor per veure l'hora exacta.</div></div>
<h2>Visites noves</h2>
<div class="card">${chartSVG(pts, 'v', COLORS.b, 'bars', minutes)}<div class="muted">Pàgines obertes${step > 1 ? ' cada ' + step + ' min' : ' per minut'}.</div></div>
<h2>Últimes visites (hora exacta)</h2>
<div class="card"><table><tr><th>Hora</th><th>Dispositiu</th><th>Idioma</th><th>País</th><th>Origen</th></tr>${recentRows || '<tr><td class="muted">Encara cap visita des que ha arrencat el servidor</td><td></td><td></td><td></td><td></td></tr>'}</table>
<div class="muted">Només a memòria (es perd en reiniciar) i sense IP: hora, dispositiu, idioma i, amb Cloudflare, el país.</div></div>
<div class="two">
<div><h2>Idiomes</h2><table>${listHTML(langs)}</table></div>
<div><h2>Països</h2><table>${listHTML(countries, 'Cal Cloudflare davant per veure\'ls')}</table></div>
<div><h2>Reis consultats</h2><table>${listHTML(opens)}</table></div>
<div><h2>Webs d'origen (14 dies)</h2><table>${listHTML(refs, 'Només visites directes')}</table></div>
</div>
<h2>Senyal dels mòbils dels reis (24 h)</h2>
<div class="card"><table><tr><th>Rei</th><th>Pings</th><th>Últim ping</th><th>Fa</th></tr>${pingRows}</table><div class="muted">Un «fa» en vermell vol dir més de 5 minuts sense senyal des del darrer reinici del servidor.</div></div>
<h2>Per hora</h2><div class="card"><table><tr><th>Hora</th><th>Visites</th><th>Sessions</th><th>Pic</th><th>Mòbil/PC</th><th>Errors</th></tr>${hourRows}</table></div>
<h2>Per dia (UTC)</h2><div class="card"><table><tr><th>Dia</th><th>Únics (sense cookie)</th><th>Amb cookie</th><th>Visites</th><th>Cases per ruta</th></tr>${dayRows || '<tr><td class="muted">—</td><td></td><td></td><td></td><td></td></tr>'}</table></div>
<h2>Descàrregues</h2>
<p><a class="btn" href="stats.csv?${keyQuery}kind=minutes&range=${range}">CSV per minuts (${range})</a> <a class="btn" href="stats.csv?${keyQuery}kind=hours">CSV per hores</a> <a class="btn" href="stats.csv?${keyQuery}kind=days">CSV per dies</a> <a class="btn" href="stats.json?${keyQuery}">JSON complet</a></p>`;
}

function dayLabel(date) { return fmtLong.format(new Date(date + 'T12:00:00Z')); }
const delta = (a, b) => {
    if (!b && !a) return '';
    if (!b) return '<span class="up">nou</span>';
    const d = Math.round((a - b) / b * 100);
    return `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d}%</span>`;
};

function renderCompare(c) {
    const { stats, query, keyQuery } = c;
    const days = byMadridDay(stats);
    const dates = Object.keys(days).filter(d => days[d].views > 0).sort();
    if (!dates.length) return '<div class="card"><p class="muted">Encara no hi ha dies amb visites per comparar.</p></div>';
    const b = days[query.b] ? query.b : dates[dates.length - 1];
    const a = days[query.a] ? query.a : (dates[dates.length - 2] || dates[dates.length - 1]);
    const metric = query.m === 'peak' ? 'peak' : 'views';
    const A = days[a], B = days[b];
    const opt = sel => dates.map(d => `<option value="${d}"${d === sel ? ' selected' : ''}>${esc(dayLabel(d))} (${d})</option>`).join('');
    const mPills = [['views', 'Visites per hora'], ['peak', 'Pic de connectats per hora']].map(([m, l]) => `<a href="?${keyQuery}tab=compare&a=${a}&b=${b}&m=${m}"${m === metric ? ' class="on"' : ''}>${l}</a>`).join('');
    const key = metric === 'peak' ? 'hp' : 'hv';
    const row = (label, fa, fb, fmt = v => v) => `<tr><td>${esc(label)}</td><td>${fmt(fa)}</td><td>${fmt(fb)}</td><td>${typeof fa === 'number' && typeof fb === 'number' ? delta(fb, fa) : ''}</td></tr>`;
    const av = d => (d.active ? Math.round(d.beats * 0.5 / d.active * 10) / 10 : 0);
    const topHour = d => { let h = 0; d.hv.forEach((v, i) => { if (v > d.hv[h]) h = i; }); return String(h).padStart(2, '0') + 'h'; };
    const kingOpen = d => topList(d.opens, 3).map(([k, v]) => k + ' ' + v).join(' · ') || '—';
    return `<form class="cmp noprint" method="get"><input type="hidden" name="key" value="${esc(query.key || '')}"><input type="hidden" name="tab" value="compare"><input type="hidden" name="m" value="${metric}">
<span class="dot" style="background:${COLORS.a}"></span><select name="a">${opt(a)}</select> <b>contra</b> <span class="dot" style="background:${COLORS.b}"></span><select name="b">${opt(b)}</select>
<button class="btn pri" type="submit">Comparar</button></form>
<h2>Hora per hora</h2><div class="pills">${mPills}</div>
<div class="card">${hoursSVG([{ name: dayLabel(a), color: COLORS.a, vals: A[key] }, { name: dayLabel(b), color: COLORS.b, vals: B[key] }])}
<div class="muted"><span class="dot" style="background:${COLORS.a}"></span>${esc(dayLabel(a))} &nbsp; <span class="dot" style="background:${COLORS.b}"></span>${esc(dayLabel(b))} · hores de Madrid</div></div>
<h2>Resum</h2><div class="card"><table><tr><th></th><th>${esc(dayLabel(a))}</th><th>${esc(dayLabel(b))}</th><th>Canvi</th></tr>
${row('Visites', A.views, B.views)}${row('Pic de connectats', A.peak, B.peak, v => v)}${row('Hora amb més visites', topHour(A), topHour(B))}${row('Minuts per sessió', av(A), av(B), v => '~' + v)}
${row('Mòbil (%)', pct(A.mobile, A.mobile + A.desktop), pct(B.mobile, B.mobile + B.desktop), v => v + '%')}${row('Cookies acceptades (%)', pct(A.yes, A.yes + A.no), pct(B.yes, B.yes + B.no), v => v + '%')}
${row('Cases marcades', A.homes, B.homes)}${row('Reis seguits', A.favs, B.favs)}${row('Errors del navegador', A.errors, B.errors)}${row('Reis més consultats', kingOpen(A), kingOpen(B))}</table></div>`;
}

function renderReview(c) {
    const { stats, query, keyQuery } = c;
    const days = byMadridDay(stats);
    const dates = Object.keys(days).filter(d => days[d].views > 0).sort();
    if (!dates.length) return '<div class="card"><p class="muted">Encara no hi ha dades per fer el resum.</p></div>';
    const to = dates.includes(query.to) ? query.to : dates[dates.length - 1];
    const from = dates.includes(query.from) ? query.from : (dates.length > 3 ? dates[dates.length - 3] : dates[0]);
    const sel = dates.filter(d => d >= from && d <= to);
    const T = { views: 0, active: 0, beats: 0, mobile: 0, desktop: 0, yes: 0, no: 0, errors: 0, homes: 0, favs: 0, opens: {}, lang: {}, pings: {}, hv: Array(24).fill(0) };
    let peak = 0, peakDate = '', peakHour = 0;
    for (const d of sel) {
        const x = days[d];
        for (const f of ['views', 'active', 'beats', 'mobile', 'desktop', 'yes', 'no', 'errors', 'homes', 'favs']) T[f] += x[f];
        merge(T.opens, x.opens); merge(T.lang, x.lang); merge(T.pings, x.pings);
        x.hv.forEach((v, i) => { T.hv[i] += v; });
        if (x.peak > peak) { peak = x.peak; peakDate = d; peakHour = x.peakHour; }
    }
    // Pic exacte al minut (només mentre es conserven els minuts)
    let exact = null;
    for (const [k, m] of Object.entries(stats.minutes)) {
        const ts = Date.parse(k + ':00Z'); const { date } = madridParts(ts);
        if (date >= from && date <= to && (!exact || m[1] > exact.p)) exact = { p: m[1], ts };
    }
    const uniques = Object.entries(stats.days).reduce((s, [d, v]) => (d >= from && d <= to ? s + (v.anon || 0) : s), 0);
    const homesBy = {}; for (const [d, v] of Object.entries(stats.days)) if (d >= from && d <= to) merge(homesBy, v.homes);
    const srcBy = {}; for (const [d, v] of Object.entries(stats.days)) if (d >= from && d <= to) merge(srcBy, v.src);
    const avgMin = T.active ? Math.round(T.beats * 0.5 / T.active * 10) / 10 : 0;
    const busiest = T.hv.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(x => x[1] > 0);
    const optf = sel0 => dates.map(d => `<option value="${d}"${d === sel0 ? ' selected' : ''}>${esc(dayLabel(d))} (${d})</option>`).join('');

    const pts = []; // observacions automàtiques
    pts.push(`<li>Hi ha hagut <b>${T.views}</b> visites${uniques ? ` de <b>${uniques}</b> persones diferents (comptades sense cookies)` : ''} entre ${esc(dayLabel(from))} i ${esc(dayLabel(to))}.</li>`);
    if (peak) pts.push(`<li>El <b>pic simultani</b> va ser de <b>${exact ? exact.p : peak}</b> persones${exact ? ` a les <b>${esc(fmtHM.format(new Date(exact.ts)))}</b> del ${esc(fmtDM.format(new Date(exact.ts)))}` : ` el ${esc(dayLabel(peakDate))} a les ${String(peakHour).padStart(2, '0')}h`}.</li>`);
    if (busiest.length) pts.push(`<li>Les hores amb més visites: ${busiest.map(([h, v]) => `<b>${String(h).padStart(2, '0')}h</b> (${v})`).join(', ')}.</li>`);
    pts.push(`<li>Cada sessió va durar uns <b>${avgMin} min</b> de mitjana; el <b>${pct(T.mobile, T.mobile + T.desktop)}%</b> va entrar des del mòbil.</li>`);
    if (T.homes) pts.push(`<li>Es va marcar casa <b>${T.homes}</b> cops (${pct(T.homes, T.views)}% de les visites)${topList(homesBy, 1).length ? `; la ruta amb més demanda: <b>${esc(topList(homesBy, 1)[0][0])}</b>` : ''}.</li>`);
    if (topList(T.opens, 1).length) pts.push(`<li>El rei més consultat: <b>${esc(topList(T.opens, 1)[0][0])}</b> (${topList(T.opens, 1)[0][1]}); ${T.favs} cops es va seguir un rei.</li>`);
    if (T.yes + T.no > 0) pts.push(`<li>El <b>${pct(T.yes, T.yes + T.no)}%</b> de qui va decidir va acceptar les cookies.</li>`);
    const flags = [];
    if (T.errors > 0) flags.push(`<div class="note bad">S'han registrat <b>${T.errors}</b> errors del navegador. Convé revisar-ho abans de l'any vinent.</div>`);
    else flags.push('<div class="note good">Cap error del navegador registrat en aquest període.</div>');
    const pingEntries = Object.entries(T.pings);
    if (pingEntries.length) flags.push(`<div class="note">Pings rebuts: ${pingEntries.sort().map(([k, v]) => `${esc(k)} <b>${v}</b>`).join(' · ')}. Si un rei té molts menys que els altres, el seu mòbil va perdre senyal.</div>`);
    else flags.push('<div class="note">No hi ha pings dels mòbils dels reis en aquest període.</div>');

    return `<form class="cmp noprint" method="get"><input type="hidden" name="key" value="${esc(query.key || '')}"><input type="hidden" name="tab" value="review">
Del <select name="from">${optf(from)}</select> al <select name="to">${optf(to)}</select> <button class="btn pri" type="submit">Calcular</button> <button class="btn" type="button" onclick="print()">Imprimir / PDF</button></form>
<h2>Resum per a la review</h2><div class="card"><ul class="rv">${pts.join('')}</ul></div>
<h2>Visites per hora del dia (suma del període)</h2><div class="card">${hoursSVG([{ name: 'Visites', color: COLORS.a, vals: T.hv }])}<div class="muted">Hores de Madrid.</div></div>
<h2>Observacions</h2>${flags.join('')}
<div class="two">
<div><h2>Reis consultats</h2><table>${listHTML(T.opens)}</table></div>
<div><h2>Cases per ruta</h2><table>${listHTML(homesBy, 'Cap casa marcada')}</table></div>
<div><h2>Origen (?src=)</h2><table>${listHTML(srcBy, 'Cap')}</table></div>
<div><h2>Idiomes</h2><table>${listHTML(T.lang)}</table></div>
</div>
<p class="muted">Les dades es conserven: minuts 30 dies, hores 180 dies, dies 2 anys. Descarrega-les a «Ara → Descàrregues».</p>`;
}

function csvFor(c) {
    const { stats, query, now } = c;
    const kind = ['minutes', 'hours', 'days'].includes(query.kind) ? query.kind : 'minutes';
    if (kind === 'hours') {
        const rows = ['hora_utc,hora_madrid,visites,sessions,pic,mobil,pc,cookies_si,cookies_no,cases,seguits,errors,pings'];
        for (const [k, h] of Object.entries(stats.hours).sort()) {
            const ts = Date.parse(k + ':00:00Z');
            rows.push([k, `${fmtDM.format(new Date(ts))} ${fmtHM.format(new Date(ts))}`, num(h, 'views'), num(h, 'active'), num(h, 'peak'), num(h, 'mobile'), num(h, 'desktop'), num(h, 'consentYes'), num(h, 'consentNo'), num(h, 'homes'), num(h, 'favs'), num(h, 'errors'), Object.values(h.pings || {}).reduce((a, b) => a + b, 0)].join(','));
        }
        return rows.join('\n');
    }
    if (kind === 'days') {
        const rows = ['dia_utc,visitants_unics_sense_cookie,visitants_amb_cookie,visites,cases_per_ruta,origen'];
        for (const [d, v] of Object.entries(stats.days).sort()) {
            rows.push([d, v.anon || 0, v.visitors || 0, v.views || 0, `"${topList(v.homes, 20).map(([a, n]) => a + ':' + n).join(' ')}"`, `"${topList(v.src, 20).map(([a, n]) => a + ':' + n).join(' ')}"`].join(','));
        }
        return rows.join('\n');
    }
    const minutes = RANGES[query.range] || 360;
    const { pts } = minuteSeries(stats, now, minutes);
    return ['hora_madrid,visites,pic_connectats', ...pts.map(p => `${fmtDM.format(new Date(p.t))} ${fmtHM.format(new Date(p.t))},${p.v},${p.p}`)].join('\n');
}

/** Retorna { status, headers, body } (la clau ja s'ha validat a server.js). */
function render(c) {
    const { pathname, query, stats, live, now } = c;
    c.keyQuery = query.key ? `key=${q(query.key)}&` : '';
    const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
    if (pathname === '/stats.csv') {
        return { status: 200, headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="estadistiques.csv"' }, body: csvFor(c) };
    }
    if (pathname === '/stats.json') {
        const { pts } = minuteSeries(stats, now, 360);
        return { status: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ liveNow: live.size, server: { uptimeMin: Math.round(process.uptime() / 60), rssMB: Math.round(process.memoryUsage().rss / 1048576) }, days: stats.days, hours: stats.hours, minutes: stats.minutes, last6h: pts }) };
    }
    const tab = ['live', 'compare', 'review'].includes(query.tab) ? query.tab : 'live';
    const body = tab === 'compare' ? renderCompare(c) : tab === 'review' ? renderReview(c) : renderLive(c);
    return { status: 200, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' }, body: shell(tab, c.keyQuery, '', body) };
}

module.exports = { render };
