# Ranukita Bridge v0.3.0 Ultra — Extensión de Navegación y Depuración Profunda

Esta es la versión unificada, optimizada y completa de **Ranukita Bridge**, combinando:
1. **La base operativa de Mac mini v0.2.5**: automatización humana completa (`see2`, `act`, `click_text`, `fill_form`, `type_human`, `scroll`, `hover`, `key`, `inspect`, `upload`, `survey_*`, `oopif_*`, `cdp_*`, `eval`).
2. **La suite de depuración profunda v0.3.0 (`rk_debug.js`)**:
   - `tabs_info`: telemetría exhaustiva de todas las pestañas (id, título, url limpia, discarded, audible, siteAccess, restricted).
   - `console_start` / `console_read` / `console_stop`: captura en tiempo real de logs y excepciones CDP por pestaña.
   - `net_errors`: monitoreo de errores de red (`ERR_*` y HTTP ≥ 400 vía `webRequest`).
   - `tab_reload_discarded`: recarga segura y aislada de pestañas descartadas por Chrome en segundo plano sin robar foco.
   - `guard_check`: detección proactiva de captchas (reCAPTCHA, hCaptcha, Turnstile, Cloudflare challenge) y rate limits antes de ejecutar acciones.
   - `log_read` / `log_clear`: ring buffer de 1.000 eventos estructurados con redacción automática de secretos y tokens (`rkRedact`).
3. **Protección Zero Focus Theft (`x_tab_policy.js`)**:
   - Nunca activa ventanas del frente ni interrumpe a Emilio mientras trabaja.
   - Acciones dirigidas estrictamente por `tabId` numérico.
4. **Núcleo X Bridge (`x_unfollow_core.js`)**:
   - Clicks CDP de confianza para unfollow / confirmación sin falsos positivos ni bloqueos.

---

## 🚀 Cómo Cargarla en Google Chrome

1. Abrí Google Chrome y andá a:
   ```text
   chrome://extensions/
   ```
2. Activá el interruptor **"Modo de desarrollador"** (arriba a la derecha).
3. Si tenés una versión anterior de Ranukita cargada:
   - Hacé clic en el icono de recargar (flecha circular) sobre la tarjeta existente, O
   - Hacé clic en **"Cargar descomprimida"** (arriba a la izquierda) y seleccioná esta carpeta:
     ```text
     /Users/emilioranucoli/Downloads/ranukita-extension-v0.2.5-macmini
     ```
4. **Permiso Crítico**:
   - En la tarjeta de **Ranukita Bridge**, hacé clic en **"Detalles"**.
   - Verificá que **"Acceso al sitio"** esté configurado en **"En todos los sitios"** (*On all sites*).
5. Hacé clic en el icono del rompecabezas en la barra de herramientas de Chrome y fijá el icono de Ranukita. Al abrir el popup verás:
   ```text
   ✓ Server ok · 1 ext conectada(s)
   ```

---

## 🛠️ Acciones de Depuración Disponibles (WebSocket / HTTP :9224)

| Acción | Parámetros | Qué hace |
| :--- | :--- | :--- |
| `tabs_info` | `{discardedOnly?, activeOnly?, urlContains?}` | Lista detallada de pestañas con estado de memoria y permisos. |
| `site_access` | `{tabId}` | Comprueba si la extensión tiene permiso de inyección en ese dominio. |
| `tab_reload_discarded`| `{tabId, timeoutMs?}` | Recarga SOLO esa pestaña si Chrome la descargó de RAM. |
| `guard_check` | `{tabId}` | Analiza si la página tiene un captcha, aviso de bot o rate limit. |
| `console_start` | `{tabId, network?: bool}` | Inicia la captura de `console.log`, excepciones y requests CDP. |
| `console_read` | `{tabId, minLevel?, limit?}` | Lee los logs capturados de la consola. |
| `console_stop` | `{tabId}` | Detiene la captura CDP y libera el debugger. |
| `net_errors` | `{tabId?, minLevel?, limit?}` | Muestra los fallos de red (HTTP 4xx, 5xx, DNS errors). |
| `log_read` | `{kind?, tabId?, limit?}` | Lee el historial de eventos del ring buffer de la extensión. |
| `debug_info` | `{}` | Estado general del bridge, versión y capacidades activas. |

---

## 🧪 Pruebas Unitarias

La extensión incluye su propia suite de pruebas en Node.js (sin necesidad de abrir Chrome):
```bash
node --check *.js
node --test tests/*.test.js
```
Resultado: **19/19 tests pasados (100% OK)**.
