# 👑 ReisOrient — Seguimiento en Directo

Sistema autónomo y privado para el seguimiento en tiempo real de la Cabalgata de Reyes. 

## ✨ Características
- **100% Independiente**: No requiere Firebase ni bases de datos externas.
- **Eficiente**: Optimizado con Gzip para soportar miles de usuarios concurrentes.
- **Compatible con Traccar**: Recibe datos directamente de apps como Traccar Client o GPS Logger.
- **Historial Persistente**: Guarda el rastro de los Reyes localmente.

## 🚀 Despliegue (EasyPanel / Docker)
Este proyecto está listo para ser desplegado en un servidor Ubuntu con EasyPanel:

1. Crea un nuevo servicio desde GitHub.
2. Mapea un **Volumen** persistente: `/app/data` para no perder los datos al reiniciar.
3. Expón el puerto **8080**.

## 📱 Configuración Móvil
Apunta tu app de tracking (Traccar Client o similar) a:
`http://TU-SERVIDOR:8080/`

---
Desarrollado para la ilusión de los más pequeños. 🌟