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
| 🗺️ **Mapa en Directe** | Visor Leaflet amb mapa CARTO Voyager, centrat a Vilafranca del Penedès |
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
   - **URL del servidor**: `https://EL-TEU-DOMINI/`
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