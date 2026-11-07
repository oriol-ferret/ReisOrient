# 👑 ReisOrient — Seguiment en Directe de la Cavalcada de Reis

[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker)](https://www.docker.com/)
[![Licència](https://img.shields.io/badge/Llicència-MIT-yellow.svg)](LICENSE)

Sistema autònom i privat per al seguiment en temps real de la Cavalcada de Reis Mags.
Permet als ciutadans veure en un mapa interactiu la posició exacta de cada Rei durant el recorregut.

---

## ✨ Característiques

| Funcionalitat | Detall |
|---|---|
| 🗺️ **Mapa en Directe** | Visor Leaflet amb mapa CARTO Voyager, centrat a La Roca del Vallès |
| 👑 **Multi-Rei** | Seguiment independent de Melcior, Gaspar, Baltasar i l'Estrella d'Orient |
| 🛤️ **Rastre del recorregut** | Línia de color degradat que mostra el camí ja recorregut per cada Rei |
| 📍 **Geolocalització inversa** | Mostra el nom del carrer actual de cada Rei via Nominatim/OSM |
| 📱 **Optimitzat per mòbil** | Refresc automàtic en tornar a la pestanya + botó manual amb cooldown |
| 📡 **Compatible Traccar** | Rep dades de Traccar Client, GPS Logger o qualsevol app OsmAnd-compatible |
| 💾 **Persistència local** | Dades guardades a `data/data.json` amb suport per volums Docker |
| 🔒 **100% Independent** | Sense Firebase, sense bases de dades externes, sense dependències de tercers |
| ⚡ **Lleuger** | Servidor Node.js pur (~100 línies), sense frameworks |

---

## 🏗️ Arquitectura

```
┌──────────────┐     HTTP POST      ┌─────────────────┐     Polling      ┌──────────────┐
│  Traccar App │ ──────────────────▶ │   server.js     │ ◀────────────── │  Navegador   │
│  (mòbil Rei) │  id, lat, lon      │   :8080         │  data.json      │  (ciutadans) │
└──────────────┘                     │                 │                  └──────────────┘
                                     │  ┌───────────┐  │
                                     │  │ data.json │  │  ◀── Volum persistent Docker
                                     │  └───────────┘  │
                                     └─────────────────┘
```

---

## 🚀 Desplegament (EasyPanel / Docker)

### Prerequisits
- Servidor amb Docker (Ubuntu 22.04+ recomanat)
- Compte a [EasyPanel](https://easypanel.io/) o accés SSH al servidor

### Passos

1. **Crea un nou servei** a EasyPanel des de GitHub (`oriol-ferret/ReisOrient`).
2. **Configura el volum persistent**: Monta `/app/data` per conservar les dades entre reinicis.
3. **Exposa el port** `8080` a la pestanya Networking.
4. **Fes Redeploy** i verifica als logs que el servidor arrenca correctament.

### Variables d'entorn (opcionals)

| Variable | Per defecte | Descripció |
|---|---|---|
| `DATA_PATH` | `/app/data` | Ruta on es guarden les dades |

---

## 📱 Configuració del Mòbil (Traccar Client)

1. Instal·la **Traccar Client** des de Google Play o App Store.
2. Configura:
   - **Identificador del dispositiu**: `Melcior`, `Gaspar`, `Baltasar` o `Estrella` (no importa majúscules).
   - **URL del servidor**: `https://mountainsolutions.es/tracker/` (molt important incloure la barra `/` al final).
   - **Freqüència**: `60` segons
   - **Distància**: `0` metres
3. **Important Android**: Desactiva l'optimització de bateria per a l'app Traccar per evitar que el sistema la tanqui en segon pla.

---

## 📂 Estructura del Projecte

```
ReisOrient/
├── server.js          # Servidor Node.js (receptor Traccar + servidor web)
├── index.html         # Frontend complet (mapa + lògica)
├── ruta.geojson       # (Opcional) Traçat de la ruta oficial
├── Dockerfile         # Configuració Docker
├── package.json       # Metadades del projecte
├── data/
│   └── data.json      # Base de dades local (auto-generat)
└── README.md
```

---

## 🗺️ Roadmap

- [x] Mapa en directe amb múltiples Reis
- [x] Rastre del recorregut amb degradat de color
- [x] Botó de refresc manual amb cooldown
- [x] Auto-refresc en tornar a la pestanya
- [x] Geolocalització inversa (nom del carrer)
- [ ] **Filtre per capes** — Poder ocultar/mostrar cada Rei individualment
- [ ] **Llegenda del mapa** — Indicador visual de colors per cada Rei
- [ ] **Comptador de distància** — Kilòmetres recorreguts per cada Rei
- [ ] **Mode fosc del mapa** — Tiles nocturns per a la cavalcada de nit
- [ ] **PWA** — Instal·lable com a app nativa al mòbil

---

## 🛠️ Desenvolupament Local

```bash
# Clonar el repositori
git clone https://github.com/oriol-ferret/ReisOrient.git
cd ReisOrient

# Instal·lar dependències
npm install

# Arrencar el servidor
node server.js

# Obrir al navegador
# http://localhost:8080
```

---

## 📄 Llicència

MIT — Desenvolupat amb il·lusió per fer brillar la nit de Reis. 🌟
## Configuració i seguretat (variables d'entorn)

| Variable | Per a què serveix |
|---|---|
| `PING_TOKEN` | **Recomanat.** Si es defineix, els pings han d'incloure `?token=...` (afegeix-ho a la URL del servidor a Traccar). Sense token, qualsevol pot enviar posicions falses. |
| `STATS_KEY` | Activa `/stats?key=...` (o capçalera `X-Stats-Key`) amb les estadístiques anònimes. Sense clau, desactivat. |
| `DATA_PATH` | Carpeta de dades. **Munta-hi un volum persistent**, o es perdran les posicions en redesplegar. |
| `HISTORY_HOURS` / `MAX_POINTS` | Historial conservat (24 h) i punts màxims per rei (20000). |
| `TRUST_PROXY_HOPS` | Quants proxies hi ha davant (1 per defecte; 2 amb CDN + proxy) per saber la IP real. |
| `GEO_BBOX` | `minLat,minLon,maxLat,maxLon` de la zona vàlida per als pings (per defecte Catalunya). |
| `NOMINATIM_EMAIL` | Contacte que demana la política d'OpenStreetMap per al nom dels carrers. |
| `SERVE_PROMO=1` | Serveix `/promo-video/` (desactivat per defecte). |

Altres: `/demo` mostra la simulació; `/health` per a les comprovacions de disponibilitat. El servidor descarta posicions
impossibles (fora de zona, salts de centenars de km, precisió dolenta) i fa còpia de seguretat de `data.json`.

### Test de càrrega

```bash
# 1000 visitants arribant en 10 s (pic brusc), cada un 60 s. Arrenca un servidor local de prova.
node tools/loadtest.js --spawn --clients 1000 --ramp 10 --session 60
```

Simula pàgina, actius, historial, polling, analítica i noms de carrer, amb els mòbils enviant posicions. No cal cap
dependència. No l'apuntis (`--url`) a producció sense avisar: genera molt trànsit.

### Mosaics del mapa (cau pròpia)

Els visitants no parlen mai amb OpenStreetMap: demanen `/tiles/z/x/y.png` al nostre servidor, que baixa cada mosaic
**una sola vegada**, el guarda (memòria + `DATA_PATH/tiles`, 7 dies) i el serveix a tothom. Només s'accepta la zona de
les rutes i els zooms 13-18. Cal mantenir l'atribució «© OpenStreetMap».

```bash
# Abans de l'esdeveniment, precalenta la cau (≈390 mosaics, ~3 min, ritme baix). Es pot repetir sense cost.
node tools/warm-tiles.js --url https://el-teu-domini --maxzoom 17
```

- `TILE_UPSTREAM`: URL font dels mosaics (per defecte OSM). Si canvies de proveïdor, comprova que permeti la cau.
- **Posa un CDN (p. ex. Cloudflare gratuït) davant**: els mosaics porten `s-maxage=7 dies`, així gairebé tot el trànsit
  d'imatges (≈430 KB per visitant nou) el serveix el CDN i no el teu servidor.
