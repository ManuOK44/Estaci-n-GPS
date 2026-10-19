# Estación GPS — primera versión funcional de pruebas

Incluye una página web para administrador y repartidor y un servidor Node.js sin dependencias externas. Permite crear códigos personales, iniciar/finalizar turnos, compartir geolocalización real **mientras el navegador permanece activo**, marcar Disponible/En servicio, consultar mapa y últimos recorridos y kilómetros aproximados.

## Ejecutar de forma local

Instala Node.js 20+ y, desde esta carpeta, ejecuta:

Mac / Linux: `ADMIN_PASSWORD='elige-una-clave-larga' node server.js`

Windows PowerShell: `$env:ADMIN_PASSWORD='elige-una-clave-larga'; node server.js`

Abre `http://localhost:3000` en el mismo equipo. Para probar GPS desde otro móvil necesitas **desplegar la app en un servidor HTTPS** con almacenamiento persistente y configurar un dominio. Los mapas requieren conexión a internet (Leaflet / OpenStreetMap).

## Limitaciones importantes

- **No funciona de forma fiable con la pantalla bloqueada o con el navegador en segundo plano.** Para eso se requiere una app nativa de iPhone/Android con permisos de localización durante el turno, sujeta a políticas de ambos sistemas.
- No está publicada ni conectada a tu GitHub. No modifica Estación Go.
- La base de datos de prueba se guarda en `data.json`. Para producción, usar base de datos gestionada, copias de seguridad, auditoría, controles de acceso, HTTPS, límites de solicitudes y gestión segura de secretos.
- Mantén los códigos privados; aparecen solo al crearlos. No publiques ni compartas `data.json`.
- La distancia estimada por GPS puede ser imprecisa. El historial no se purga automáticamente tras 30 días; la pantalla de repartidor solo muestra jornadas de ese periodo. Implementa política real de retención antes de usarlo en producción.
- Cada repartidor debe aceptar voluntariamente compartir ubicación durante su turno. Si retira el permiso del sistema, el rastreo se detiene aunque el turno aparezca activo; una ubicación antigua no se presenta como actual.