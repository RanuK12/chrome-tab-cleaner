// ranukita-stealth.js — Anti-detección de bots
// Se inyecta en TODAS las páginas antes de que carguen scripts
// Oculta señales de automatización y simula un navegador humano real

(function() {
  'use strict';

  // 1. Ocultar webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. Ocultar que es automatizado
  delete navigator.__proto__.webdriver;

  // 3. Chrome runtime — simular extensiones normales (no automation)
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };
  }

  // 4. Plugins — simular plugins reales
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      return plugins;
    }
  });

  // 5. Languages — simular configuración real
  Object.defineProperty(navigator, 'languages', { get: () => ['es-AR', 'es', 'en-US', 'en', 'it'] });

  // 6. Platform
  Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });

  // 7. Hardware concurrency (no revelar que es VM)
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 10 });

  // 8. Device memory
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // 9. Ocultar automation flags en window
  const automationProps = ['_phantom', '__nightmare', '_selenium', 'callPhantom', '__phantomas',
    'Buffer', 'emit', 'spawn', 'domAutomation', 'domAutomationController', 'webdriver'];
  automationProps.forEach(prop => {
    if (prop in window) {
      try { delete window[prop]; } catch(e) {}
    }
  });

  // 10. WebGL — no revelar renderer sospechoso
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Apple Inc.';  // UNMASKED_VENDOR
    if (param === 37446) return 'Apple M4';     // UNMASKED_RENDERER
    return getParameter.call(this, param);
  };

  // 11. Permissions API — simular que notifications están "prompt" (no denied)
  const origQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(params) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: 'prompt', onchange: null });
    }
    return origQuery.call(this, params);
  };

  // 12. Canvas fingerprint — agregar ruido mínimo imperceptible
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type) {
    if (this.width > 16 && this.height > 16) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const style = ctx.fillStyle;
        ctx.fillStyle = 'rgba(0,0,1,0.003)';
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = style;
      }
    }
    return origToDataURL.call(this, type);
  };

  // 13. Ocultar headless Chrome signals
  Object.defineProperty(document, 'hidden', { get: () => false });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });

  // 14. Mouse/touch events — asegurar que existen (algunos bots no los tienen)
  if (!('ontouchstart' in window)) {
    // No agregar touch en desktop — es sospechoso
  }

})();
