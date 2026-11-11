#!/usr/bin/env node
/**
 * Comprovacions abans de cada commit (sense dependències):
 *  1. Bloqueja fitxers que no s'han de pujar mai (.env, data.json, claus privades, còpies de seguretat).
 *  2. Busca secrets a les línies afegides (claus privades, tokens, contrasenyes, claus d'API).
 *  3. Comprova la sintaxi de server.js, tools/*.js i dels <script> en línia d'index.html.
 *  4. Executa `npm audit` de les dependències de producció (si hi ha xarxa; SKIP_AUDIT=1 per saltar-ho).
 *
 * Activació (un cop per clon):  npm run setup-hooks
 * Saltar-se-ho en un cas excepcional:  git commit --no-verify
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const errors = [];
const fail = m => errors.push(m);

const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n').filter(Boolean);
if (!staged.length) process.exit(0);

// 1. Fitxers prohibits
const FORBIDDEN = [
    [/(^|\/)\.env(\..*)?$/i, 'fitxer d\'entorn (.env)'],
    [/(^|\/)data\.json(\.bak)?$|(^|\/)stats\.json$/i, 'dades de producció'],
    [/\.(pem|key|p12|pfx|jks)$/i, 'clau o certificat privat'],
    [/(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/i, 'clau SSH'],
    [/(^|\/)node_modules\//, 'node_modules'],
    [/(^|\/)data\/tiles\//, 'memòria cau de mosaics'],
];
const ALLOWED_ENV = /(^|\/)\.env\.example$/i;
for (const f of staged) {
    for (const [re, why] of FORBIDDEN) if (re.test(f) && !ALLOWED_ENV.test(f)) fail(`${f}: no es pot pujar (${why})`);
}

// 2. Secrets a les línies afegides
const SECRET_PATTERNS = [
    [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'clau privada'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'clau d\'AWS'],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'token de GitHub'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'token de Slack'],
    [/\bsk-[A-Za-z0-9_-]{32,}\b/, 'clau d\'API (sk-…)'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, 'clau d\'API de Google'],
    [/\b(?:PING_TOKEN|STATS_KEY|API_KEY|SECRET|PASSWORD|PASSWD|TOKEN)\s*[:=]\s*['"]?(?!\s|['"]|process\.env|TU_|<|\$|your|xxx|change|example)[A-Za-z0-9+\/_-]{12,}/i, 'possible secret assignat'],
];
const diff = git('diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR');
let curFile = '';
for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { curFile = line.slice(6); continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (/^(package-lock\.json|vendor\/)/.test(curFile)) continue;
    const text = line.slice(1);
    for (const [re, why] of SECRET_PATTERNS) {
        if (re.test(text)) fail(`${curFile}: ${why} → ${text.trim().slice(0, 80)}${text.length > 80 ? '…' : ''}`);
    }
}

// 3. Sintaxi
const jsFiles = staged.filter(f => /^(server|statspage|config|admin|gps)\.js$|^tools\/.*\.js$/.test(f));
for (const f of jsFiles) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    if (r.status !== 0) fail(`${f}: error de sintaxi\n${(r.stderr || '').split('\n').slice(0, 6).join('\n')}`);
}
for (const page of ['index.html', 'admin.html'].filter(f => staged.includes(f))) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8').replace(/\r\n?/g, '\n');
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    if (!blocks.length) fail('index.html: no s\'ha trobat cap <script> en línia (el CSP per hash en depèn)');
    blocks.forEach((m, i) => {
        try { new vm.Script(m[1], { filename: `${page}<script#${i + 1}>` }); }
        catch (e) { fail(`${page}: error de sintaxi al <script> ${i + 1}: ${e.message}`); }
    });
    if (/<script[^>]+src=["']https?:/i.test(html) || /<link[^>]+href=["']https?:\/\/(?!tile\.openstreetmap)/i.test(html)) {
        fail(page + ': recursos externs (CDN). Tot ha d\'anar autoallotjat a vendor/ (el CSP els bloquejaria).');
    }
}

// 4. Dependències (només si han canviat o es demana)
const depsChanged = staged.some(f => /^package(-lock)?\.json$/.test(f));
if (process.env.SKIP_AUDIT !== '1' && depsChanged) {
    const r = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 30000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0 && !/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|offline|ECONNREFUSED/i.test(out) && !r.error) {
        fail('npm audit: vulnerabilitats greus a les dependències\n' + out.split('\n').slice(0, 12).join('\n'));
    }
}

if (errors.length) {
    console.error('\n✖ Pre-commit: el commit s\'ha aturat\n');
    errors.forEach(e => console.error('  • ' + e.replace(/\n/g, '\n    ')));
    console.error('\n  Corregeix-ho i torna-ho a provar. Només si és un fals positiu: git commit --no-verify\n');
    process.exit(1);
}
console.log(`✔ Pre-commit correcte (${staged.length} fitxers)`);
