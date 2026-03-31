const fs = require('fs');
const https = require('https');
const path = require('path');

// ============================================================================
// 👑 REIS ORIENT - FIREBASE CACHE WORKER
// Este script consulta a Firebase 1 vez por minuto y guarda las coordenadas
// en un archivo local (data.json). Evitando así que miles de clientes F5 
// saturen la base de datos simultánemente.
// 
// Para ejecutarlo en tu servidor (EasyPanel):
// node sync.js
// ============================================================================

const CONFIG = {
    // La URL de donde extraemos el historial filtrado de Traccar
    FIREBASE_URL: 'https://reisorient-5a6e7-default-rtdb.europe-west1.firebasedatabase.app/reyes/Melchor.json?orderBy="$key"&limitToLast=2000',
    OUTPUT_FILE: path.join(__dirname, 'data.json'),
    INTERVAL_MS: 60000 // 60 segundos por defecto (igual que el frontal)
};

function fetchFirebaseData() {
    console.log(`[${new Date().toISOString()}] Consultando a Firebase...`);
    
    https.get(CONFIG.FIREBASE_URL, (res) => {
        let data = '';

        // Recibir trozos de datos
        res.on('data', (chunk) => {
            data += chunk;
        });

        // La respuesta ha terminado de llegar
        res.on('end', () => {
            if (res.statusCode === 200) {
                // Guardar como caché local para que lo lea el index.html masivamente
                fs.writeFile(CONFIG.OUTPUT_FILE, data, (err) => {
                    if (err) {
                        console.error(`[ERROR] Falla al guardar localmente en ${CONFIG.OUTPUT_FILE}:`, err);
                    } else {
                        console.log(`[OK] Caché actualizado exitosamente. Resolviendo llamadas estáticas.`);
                    }
                });
            } else {
                console.error(`[ERROR] Firebase ha devuelto un estado HTTP ${res.statusCode} - ${data}`);
            }
        });

    }).on('error', (err) => {
        console.error(`[CRÍTICO] Error de Red conectando con Firebase:`, err.message);
    });
}

// 1. Ejecución inmediata al arrancar el worker
fetchFirebaseData();

// 2. Programar repetición en bucle infinito
setInterval(fetchFirebaseData, CONFIG.INTERVAL_MS);

console.log(`🚀 Rey Mago Sync Worker iniciado correctamente.`);
console.log(`🛡️  Protegiendo Firebase de ataques/F5 recargando el caché local cada ${CONFIG.INTERVAL_MS / 1000} segundos.`);
