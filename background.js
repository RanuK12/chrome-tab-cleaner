// Ranukita Bridge v0.3.0 (base 0.2.4/0.2.5 del Mac mini) — + depuración: tabs_info, consola, net_errors, logs, no_site_access, tab_discarded, no_tab, guard captcha_or_warning, x_unfollow_step.
// Ver README-NEW-ACTIONS.md. Compatible hacia atrás: las acciones existentes siguen igual (list_tabs/ping solo suman campos).
importScripts("rk_debug.js", "x_tab_policy.js", "x_unfollow_core.js");
const RK_VERSION = "0.3.0";
const RK_CAPS = ["tabs_info", "site_access", "tab_reload_discarded", "guard_check", "console_start", "console_stop", "console_read", "net_errors", "log_read", "log_clear", "debug_info", "captcha_guard", "reload_if_discarded", "x_unfollow_step"];

// Ranukita Bridge — background service worker v2
// Conecta vía WebSocket a un server local (port 9223) y ejecuta acciones en el Chrome REAL.
//
// v2 — pensamiento humano:
//   - see2:        numbered overlay + AX-style catalog (role, text, bbox, state, shadow DOM, iframes)
//   - act:         acción unificada por índice (click/fill/type_human/hover/select/submit)
//   - click_text:  busca por texto visible (substring fuzzy)
//   - key:         eventos de teclado (Enter, Tab, Escape, arrows, combos)
//   - type_human:  tipea con delay aleatorio por tecla
//   - hover:       mouse hover sobre selector/índice
//   - scroll:      px o "into" un selector
//   - select_option: <select> por value o label
//   - wait_idle:   espera sin mutaciones DOM por N ms
//   - inspect:     metadata profunda de un elemento

const SERVER_WS = "ws://127.0.0.1:9223/ws";
let ws = null;
let reconnectTimer = null;
// TAB OBJETIVO PEGAJOSO (fix 07-04): con VARIAS ventanas de Chrome abiertas, query({active,currentWindow})
// es AMBIGUO desde el service worker -> `navigate` cargaba una pagina en un tab, pero eval/screenshot/
// see2/click operaban sobre el tab activo de OTRA ventana -> el bot miraba la pagina equivocada y "no
// encontraba el input" (caso Flow: navego a Flow pero screenshot mostraba Fiverr). Ahora navigate/new_tab
// fijan este tab y resolveTabId lo prefiere (si sigue vivo) para que toda la secuencia caiga en la MISMA
// pagina. Un cmd.tabId explicito siempre gana; si el tab pegajoso murio, cae al activo.
let TARGET_TAB = null;
let attachedTabs = new Set();

// Registro de últimos elementos numerados por tab (para act/click_index)
const tabRegistries = new Map(); // tabId -> { stamp, elements: [{idx, selector, role, text, bbox, ...}] }

chrome.alarms.create("ranukita-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ranukita-keepalive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    else try { ws.send(JSON.stringify({ type: "ping" })); } catch (e) {}
  }
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

function log(...args) { console.log("[ranukita-ext]", ...args); }

/** Id de la cuenta de X logueada en este perfil (cookie twid, formato "u=123456"). */
async function xUserId() {
  try {
    const c = await chrome.cookies.get({ url: "https://x.com", name: "twid" });
    if (!c || !c.value) return null;
    const m = decodeURIComponent(c.value).match(/\d+/);
    return m ? m[0] : null;
  } catch (e) {
    log("no se pudo leer twid:", e.message);
    return null;
  }
}

function connect() {
  log("connecting to", SERVER_WS);
  try { ws = new WebSocket(SERVER_WS); }
  catch (e) { log("ws err:", e.message); scheduleReconnect(); return; }
  ws.onopen = async () => {
    log("ws open");
    ws.send(JSON.stringify({
      type: "hello", ext: "ranukita-bridge", version: RK_VERSION, ext_version: RK_VERSION, caps: RK_CAPS,
      // Qué cuenta de X tiene logueado ESTE perfil de Chrome. Sin esto el server elegía un
      // cliente cualquiera entre los perfiles abiertos y los tweets podían salir por la
      // cuenta equivocada. Es el id numérico de la cuenta, no un token de sesión.
      xuser: await xUserId(),
    }));
  };
  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    try {
      const reply = await handleCommand(msg);
      ws.send(JSON.stringify({ id: msg.id, ...reply }));
    } catch (err) {
      log("handleCommand error", err);
      try {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: err.message || String(err) }));
      } catch (e) {}
    }
  };
  ws.onclose = () => { log("ws closed"); scheduleReconnect(); };
  ws.onerror = (e) => log("ws error", e);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers DOM (se inyectan via executeScript)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Función que corre en la página: catalogar todos los elementos interactivos,
 * incl shadow DOM y same-origin iframes. Pintar overlay con números.
 * Devolver lista con {idx, role, text, bbox, ...}.
 */
function pageBuildCatalog(maxElements = 80) {
  // Limpieza de overlays previos Y stamps viejos
  document.querySelectorAll('[data-ranukita-tag], [data-ranukita-box]').forEach(el => el.remove());
  document.querySelectorAll('[data-ranukita-idx]').forEach(el => el.removeAttribute('data-ranukita-idx'));

  const elements = [];
  let idx = 0;

  // Inyectar CSS para los tags numerados
  let style = document.getElementById('__ranukita_style');
  if (!style) {
    style = document.createElement('style');
    style.id = '__ranukita_style';
    style.textContent = `
      [data-ranukita-tag] {
        position: absolute; z-index: 2147483647;
        background: #ff3b30; color: #fff; font: bold 12px/16px -apple-system,sans-serif;
        padding: 1px 5px; border-radius: 3px;
        box-shadow: 0 0 0 2px rgba(255,59,48,0.4);
        pointer-events: none; user-select: none;
      }
      [data-ranukita-box] {
        position: absolute; z-index: 2147483646;
        border: 2px solid rgba(255,59,48,0.55);
        pointer-events: none;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  const isInteractive = (el) => {
    const tag = el.tagName;
    if (['BUTTON','A','INPUT','TEXTAREA','SELECT','LABEL'].includes(tag)) return true;
    const role = el.getAttribute('role');
    if (['button','link','checkbox','radio','tab','menuitem','option','combobox','switch','textbox','listbox','searchbox','menuitemcheckbox','menuitemradio'].includes(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.isContentEditable) return true;
    // Elementos con tabindex >=0 son enfocables
    const ti = el.getAttribute('tabindex');
    if (ti !== null && parseInt(ti, 10) >= 0) return true;
    return false;
  };

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.top > window.innerHeight) return false;
    if (r.right < 0 || r.left > window.innerWidth) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  };

  const getText = (el) => {
    return (el.innerText || el.value || el.getAttribute('aria-label')
            || el.getAttribute('placeholder') || el.title || el.alt || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  };

  const getRole = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') return `input:${el.type || 'text'}`;
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'label') return 'label';
    if (el.isContentEditable) return 'editable';
    return tag;
  };

  const isUniqueSelector = (sel, target) => {
    try {
      const nodes = document.querySelectorAll(sel);
      return nodes.length === 1 && nodes[0] === target;
    } catch (e) { return false; }
  };

  const buildSelector = (el) => {
    // 1) id si es único
    if (el.id) {
      const s = `#${CSS.escape(el.id)}`;
      if (isUniqueSelector(s, el)) return s;
    }
    // 2) data-testid si es único
    if (el.dataset.testid) {
      const s = `[data-testid="${CSS.escape(el.dataset.testid)}"]`;
      if (isUniqueSelector(s, el)) return s;
    }
    // 3) name + atributos discriminantes (type, value) — clave para radios/checkboxes
    if (el.name) {
      const tag = el.tagName.toLowerCase();
      const base = `${tag}[name="${CSS.escape(el.name)}"]`;
      if (isUniqueSelector(base, el)) return base;
      // Discriminar por value (radio/checkbox/option)
      if (el.value !== undefined && el.value !== '') {
        const s = `${base}[value="${CSS.escape(String(el.value))}"]`;
        if (isUniqueSelector(s, el)) return s;
      }
      // Discriminar por type
      if (el.type) {
        const s = `${base}[type="${el.type}"]`;
        if (isUniqueSelector(s, el)) return s;
      }
    }
    // 4) path con :nth-of-type contando desde el padre más cercano con id
    const path = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && path.length < 8) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur)+1})`;
      }
      path.unshift(part);
      if (cur.id) { path[0] = `#${CSS.escape(cur.id)}` + (path[0].includes(':') ? path[0].slice(cur.tagName.length) : ''); break; }
      cur = cur.parentElement;
      if (!cur || cur === document.body) {
        if (cur === document.body) path.unshift('body');
        break;
      }
    }
    const sel = path.join(' > ');
    return isUniqueSelector(sel, el) ? sel : sel; // devolvemos igual; el caller puede usar bbox fallback
  };

  const labelFor = (el) => {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return lab.innerText.trim().slice(0, 80);
    }
    const parentLabel = el.closest('label');
    if (parentLabel) return parentLabel.innerText.trim().slice(0, 80);
    const aria = el.getAttribute('aria-labelledby');
    if (aria) {
      const labeller = document.getElementById(aria);
      if (labeller) return labeller.innerText.trim().slice(0, 80);
    }
    return '';
  };

  const paintTag = (el, n) => {
    const r = el.getBoundingClientRect();
    const tag = document.createElement('div');
    tag.dataset.ranukitaTag = String(n);
    tag.textContent = n;
    tag.style.left = `${r.left + window.scrollX}px`;
    tag.style.top  = `${Math.max(0, r.top + window.scrollY - 16)}px`;
    document.body.appendChild(tag);
    const box = document.createElement('div');
    box.dataset.ranukitaBox = String(n);
    box.style.left = `${r.left + window.scrollX}px`;
    box.style.top  = `${r.top + window.scrollY}px`;
    box.style.width  = `${r.width}px`;
    box.style.height = `${r.height}px`;
    document.body.appendChild(box);
  };

  // Walk DOM + shadow DOM. Iframes same-origin se procesan después (devuelven contenido propio).
  const walk = (root, source = 'doc') => {
    const queue = [root];
    while (queue.length && idx < maxElements) {
      const node = queue.shift();
      if (!node) continue;

      // Encolar shadow root si tiene
      if (node.shadowRoot) queue.push(node.shadowRoot);

      const children = node.children || [];
      for (const c of children) {
        // Saltar nuestros propios overlays
        if (c.dataset && (c.dataset.ranukitaTag || c.dataset.ranukitaBox)) continue;
        if (isInteractive(c) && isVisible(c)) {
          idx++;
          // Stamp único: garantiza que pageAct encuentre EXACTAMENTE este elemento
          // sobreviva re-renders / scroll / cambios de layout.
          c.setAttribute('data-ranukita-idx', String(idx));
          const r = c.getBoundingClientRect();
          const entry = {
            idx, role: getRole(c), text: getText(c),
            label: labelFor(c),
            tag: c.tagName.toLowerCase(),
            type: c.type || null,
            name: c.name || null,
            id: c.id || null,
            placeholder: c.placeholder || null,
            value: (c.value !== undefined) ? String(c.value).slice(0, 100) : null,
            checked: c.checked || false,
            disabled: c.disabled || false,
            selected: c.selected || false,
            href: c.href || null,
            bbox: { x: Math.round(r.left), y: Math.round(r.top),
                    w: Math.round(r.width), h: Math.round(r.height) },
            selector: `[data-ranukita-idx="${idx}"]`,
            css_selector_fallback: buildSelector(c),
            source,
          };
          elements.push(entry);
          paintTag(c, idx);
        }
        queue.push(c);
        if (c.shadowRoot) queue.push(c.shadowRoot);
      }
    }
  };

  walk(document.body, 'doc');

  // Iframes same-origin
  try {
    for (const ifr of document.querySelectorAll('iframe')) {
      try {
        const doc = ifr.contentDocument;
        if (doc) walk(doc.body, `iframe:${ifr.src || '(blank)'}`);
      } catch (e) { /* cross-origin */ }
    }
  } catch (e) {}

  return {
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight,
                scrollX: window.scrollX, scrollY: window.scrollY,
                docH: document.documentElement.scrollHeight },
    elements,
  };
}

/** Limpia los overlays. */
function pageClearOverlay() {
  document.querySelectorAll('[data-ranukita-tag], [data-ranukita-box]').forEach(el => el.remove());
  return true;
}

/** Acción unificada: ejecuta sobre el elemento indicado por selector o por bbox center. */
function pageAct(args) {
  const { type, selector, bbox, value, delayMs, key, modifiers } = args;

  // Prioridad:
  // 1) selector (preferentemente data-ranukita-idx, único y estable)
  // 2) shadow DOM walk
  // 3) bbox hit-test (last resort)
  let el = null;

  if (selector) {
    try { el = document.querySelector(selector); } catch (e) {}
    if (!el) {
      const all = document.querySelectorAll('*');
      for (const x of all) {
        if (x.shadowRoot) {
          try { el = x.shadowRoot.querySelector(selector); if (el) break; } catch (e) {}
        }
      }
    }
  }

  if (!el && bbox) {
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    let hit = document.elementFromPoint(cx, cy);
    while (hit && hit !== document.body) {
      const tag = hit.tagName;
      const role = hit.getAttribute && hit.getAttribute('role');
      if (['BUTTON','A','INPUT','TEXTAREA','SELECT','LABEL'].includes(tag) ||
          ['button','link','checkbox','radio','tab','menuitem','option'].includes(role) ||
          (hit.hasAttribute && hit.hasAttribute('onclick'))) {
        el = hit; break;
      }
      hit = hit.parentElement;
    }
    if (!el) el = document.elementFromPoint(cx, cy);
  }

  if (!el) return { ok: false, error: "elemento no encontrado" };

  const setNativeValue = (target, val) => {
    const proto = target.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(target, val); else target.value = val;
  };

  const dispatch = (target, evtName, init = {}) => {
    target.dispatchEvent(new Event(evtName, { bubbles: true, ...init }));
  };

  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}

  switch (type) {
    case 'click': {
      try { el.focus({ preventScroll: true }); } catch (e) {}
      // Dispatch mouseover/mousedown/mouseup/click para sitios que escuchan a mano
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window,
                     clientX: r.left + r.width/2, clientY: r.top + r.height/2, button: 0 };
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return { ok: true, text: (el.innerText || el.value || '').slice(0,100) };
    }
    case 'fill': {
      try { el.focus({ preventScroll: true }); } catch (e) {}
      if (el.isContentEditable) {
        el.textContent = value;
        dispatch(el, 'input');
        return { ok: true };
      }
      setNativeValue(el, value);
      dispatch(el, 'input');
      dispatch(el, 'change');
      return { ok: true };
    }
    case 'clear': {
      try { el.focus({ preventScroll: true }); } catch (e) {}
      setNativeValue(el, '');
      dispatch(el, 'input');
      dispatch(el, 'change');
      return { ok: true };
    }
    case 'hover': {
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window,
                     clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mouseenter', opts));
      el.dispatchEvent(new MouseEvent('mousemove', opts));
      return { ok: true };
    }
    case 'submit': {
      const form = el.tagName === 'FORM' ? el : el.closest('form');
      if (!form) return { ok: false, error: 'no form' };
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return { ok: true };
    }
    case 'select_option': {
      if (el.tagName !== 'SELECT') return { ok: false, error: 'no es <select>' };
      let matched = false;
      for (const opt of el.options) {
        if (opt.value === value || opt.text.trim() === value) {
          el.value = opt.value;
          matched = true;
          break;
        }
      }
      if (!matched) return { ok: false, error: `option no encontrada: ${value}` };
      dispatch(el, 'input');
      dispatch(el, 'change');
      return { ok: true };
    }
    case 'check': {
      if (el.type !== 'checkbox' && el.type !== 'radio') return { ok:false, error:'no es checkbox/radio' };
      if (el.checked !== Boolean(value)) el.click();
      return { ok: true, checked: el.checked };
    }
    default:
      return { ok: false, error: `tipo desconocido: ${type}` };
  }
}

/** Tipeo humano: emite keydown/keypress/keyup por carácter con delay (no se puede esperar dentro
 *  de scripting.executeScript chain de Promise — devolvemos rápido y dejamos el setTimeout). */
function pageTypeHuman(args) {
  const { selector, value, baseDelay = 35, bbox } = args;
  let el = null;
  if (selector) {
    try { el = document.querySelector(selector); } catch (e) {}
  }
  if (!el && bbox) {
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    let hit = document.elementFromPoint(cx, cy);
    while (hit && hit !== document.body) {
      if (['INPUT','TEXTAREA'].includes(hit.tagName) || hit.isContentEditable || (hit.getAttribute && hit.getAttribute('role') === 'textbox')) {
        el = hit;
        break;
      }
      hit = hit.parentElement;
    }
  }
  if (!el) el = document.activeElement;

  // Si el elemento es un contenedor (p. ej. div con clase input o form-group), buscar el input adentro
  if (el && !(['INPUT','TEXTAREA'].includes(el.tagName) || el.isContentEditable || (el.getAttribute && el.getAttribute('role') === 'textbox'))) {
    const child = el.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"]');
    if (child) el = child;
  }

  // Si el activeElement sigue siendo body o no editable, buscar el primer input/textarea visible en la página
  if (!el || (!['INPUT','TEXTAREA'].includes(el.tagName) && !el.isContentEditable && (el.getAttribute && el.getAttribute('role') !== 'textbox'))) {
    const visibleInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), [contenteditable="true"], [role="textbox"]')).filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });
    if (visibleInputs.length >= 1) {
      el = visibleInputs[0];
    } else {
      return { ok: false, error: 'no input/textarea/editable element encontrado (hacé click primero con act/click_text en el campo o revisá con see2)' };
    }
  }

  try { el.focus({ preventScroll: true }); } catch (e) {}

  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  let buf = el.isContentEditable ? (el.textContent || '') : (el.value || '');
  let i = 0;
  const step = () => {
    if (i >= value.length) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const ch = value[i++];
    buf += ch;
    if (el.isContentEditable) el.textContent = buf;
    else if (setter) setter.call(el, buf);
    else el.value = buf;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    const jitter = baseDelay + Math.random() * baseDelay;
    setTimeout(step, jitter);
  };
  step();
  return { ok: true, scheduled: value.length };
}

/** Emitir una tecla (Enter/Tab/Escape/Arrow*). */
function pageKey(args) {
  const { selector, key, modifiers = {} } = args;
  const el = selector ? document.querySelector(selector) : document.activeElement;
  if (!el) return { ok: false, error: 'no element' };
  try { el.focus({ preventScroll: true }); } catch (e) {}
  const init = {
    key, code: key, bubbles: true, cancelable: true,
    ctrlKey: !!modifiers.ctrl, shiftKey: !!modifiers.shift,
    altKey: !!modifiers.alt, metaKey: !!modifiers.meta,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true };
}

/** Click por texto fuzzy: substring case-insensitive, prioriza match exacto. */
function pageClickText(args) {
  const { text, role, occurrence = 0 } = args;
  if (!text || !text.trim()) return { ok: false, error: 'falta texto para click_text' };
  const needle = text.toLowerCase().trim();

  const isInteract = (el) => {
    const t = el.tagName;
    if (['BUTTON','A','INPUT','TEXTAREA','SELECT','LABEL','SUMMARY','DETAILS','OPTION'].includes(t)) return true;
    const r = (el.getAttribute('role') || '').toLowerCase();
    if (['button','link','tab','menuitem','menuitemcheckbox','menuitemradio','option','checkbox','radio','switch'].includes(r)) return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('data-action') || el.hasAttribute('href')) return true;
    try {
      const cs = window.getComputedStyle(el);
      if (cs && cs.cursor === 'pointer') return true;
    } catch (e) {}
    if (el.getAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
    return false;
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };

  const candidates = [];
  const reqRole = role ? role.toLowerCase().trim() : null;

  // Pasada 1: elementos interactivos directos
  document.querySelectorAll('*').forEach(el => {
    if (!visible(el)) return;
    const inner = (el.innerText || el.textContent || '').trim();
    const val = (el.value || '').trim();
    const aria = (el.getAttribute('aria-label') || '').trim();
    const title = (el.title || '').trim();
    const place = (el.placeholder || '').trim();
    const alt = (el.getAttribute('alt') || '').trim();

    const haystack = `${inner} ${val} ${aria} ${title} ${place} ${alt}`.toLowerCase();
    if (!haystack.includes(needle)) return;

    const elRole = (el.getAttribute('role') || el.tagName.toLowerCase()).toLowerCase();
    const roleMatches = !reqRole || elRole === reqRole ||
      ((reqRole === 'button' || reqRole === 'link') && ['button','link','a'].includes(elRole));

    if (isInteract(el) && roleMatches) {
      const exact = (inner.toLowerCase() === needle || val.toLowerCase() === needle || aria.toLowerCase() === needle);
      candidates.push({ el, exact, len: haystack.length, isDirect: true });
    }
  });

  // Pasada 2: Si no hubo candidatos con filtro de rol o interactable estricto, buscar en hojas del DOM
  if (!candidates.length) {
    document.querySelectorAll('*').forEach(el => {
      if (!visible(el)) return;
      if (el.children.length > 5) return; // evitar containers gigantes tipo <body> o <main>
      const directText = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '').toLowerCase().trim();
      if (!directText.includes(needle)) return;

      // Buscar si el elemento o algún ancestro cercano es interactivo
      let clickable = el;
      let curr = el;
      let depth = 0;
      while (curr && curr !== document.body && depth < 5) {
        if (isInteract(curr)) {
          clickable = curr;
          break;
        }
        curr = curr.parentElement;
        depth++;
      }

      const exact = directText === needle;
      candidates.push({ el: clickable, exact, len: directText.length, isDirect: false });
    });
  }

  if (!candidates.length) return { ok: false, error: `no encuentro elementos con texto "${text}"` };

  // Ordenar: primero coincidencia exacta, luego menor longitud de texto
  candidates.sort((a,b) => (b.exact - a.exact) || (a.len - b.len));
  const target = candidates[Math.min(occurrence, candidates.length - 1)].el;

  try { target.focus({ preventScroll: true }); } catch (e) {}
  target.scrollIntoView({ block: 'center', inline: 'center' });

  const r = target.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2, clientY: r.top + r.height/2, button: 0 };
  try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
  target.dispatchEvent(new MouseEvent('mouseover', opts));
  target.dispatchEvent(new MouseEvent('mousedown', opts));
  try { target.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
  target.dispatchEvent(new MouseEvent('mouseup', opts));
  target.click();

  return { ok: true, matchedText: (target.innerText || target.value || target.getAttribute('aria-label') || '').slice(0, 100), candidates: candidates.length };
}

/** Scroll: por px o into un selector. */
function pageScroll(args) {
  const { selector, dx = 0, dy = 0, behavior = 'auto' } = args;
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: 'selector not found' };
    el.scrollIntoView({ block: 'center', behavior });
    return { ok: true, scrolledTo: selector };
  }
  window.scrollBy({ left: dx, top: dy, behavior });
  return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY };
}

/** Esperar a que no haya mutaciones DOM por idleMs ms. Timeout total maxMs. */
function pageWaitIdle(args) {
  const { idleMs = 600, maxMs = 8000 } = args;
  return new Promise((resolve) => {
    let lastMut = Date.now();
    const start = Date.now();
    const obs = new MutationObserver(() => { lastMut = Date.now(); });
    obs.observe(document.documentElement, { childList: true, subtree: true,
                                             attributes: true, characterData: true });
    const tick = () => {
      const now = Date.now();
      if (now - lastMut >= idleMs) {
        obs.disconnect();
        return resolve({ ok: true, idleAfter: now - start });
      }
      if (now - start >= maxMs) {
        obs.disconnect();
        return resolve({ ok: true, timedOut: true, total: now - start });
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** Inspeccionar elemento: dump completo (atributos, computed style relevante, eventos). */
function pageInspect(args) {
  const el = document.querySelector(args.selector);
  if (!el) return { ok: false, error: 'not found' };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || '').slice(0, 500),
    html: el.outerHTML.slice(0, 600),
    bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    style: {
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      position: cs.position, pointerEvents: cs.pointerEvents, zIndex: cs.zIndex,
    },
    attrs: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
    disabled: el.disabled || false,
    visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
  };
}

/** Detecta tarjetas de jobs en la página de Clickworker.
 * Estrategias:
 * 1) Instant Job cards (carousel con Survey + €X.XX + Xmin) -> scrollIntoView
 * 2) Partner portal cards (BitLabs, CPX, etc.) en la sección Partner Platform
 * Devuelve JSON array de {text, x, y, w, h, kind}
 */
function pageDetectJobs() {
  try {
    const seen = new Set();
    const out = [];

    // 1) Instant Job survey cards — tienen .instant_job_type_badge
    // Primero hacer scroll al section header "Instant Jobs" si existe
    const instantHeader = Array.from(document.querySelectorAll('h2, h3, h4, [class*="section"], [class*="header"], strong, b'))
      .find(function(el) { return (el.innerText || '').toLowerCase().includes('instant job'); });
    if (instantHeader) {
      instantHeader.scrollIntoView({ block: 'center', behavior: 'instant' });
    }

    document.querySelectorAll('.instant_job_type_badge').forEach(function(badge) {
      // Subir al card container
      let card = badge;
      for (let i = 0; i < 8 && card; i++) {
        const cls = (card.className || '').toString();
        if (cls.includes('card') || cls.includes('item') || cls.includes('job')) break;
        card = card.parentElement;
      }
      if (!card) return;
      card.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const rect = card.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 40) return;
      if (rect.top < -50 || rect.top > window.innerHeight + 50) return; // solo visibles
      const key = Math.round(rect.x / 30) + ',' + Math.round(rect.y / 30);
      if (seen.has(key)) return;
      seen.add(key);
      const text = (card.innerText || '').trim().substring(0, 200);
      out.push({
        text: text,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        kind: 'instant'
      });
    });

    // 2) Partner portal cards - en la sección "Partner Platform"
    const PARTNER_NAMES = ['bitlabs', 'cpx research', 'inbrain', 'tapresearch', 'polltastic', 'prime', 'adgate', 'theorem', 'mychips', 'gametastic'];
    
    // Intentar hacer scroll al header de Partner Platform
    const partnerHeader = Array.from(document.querySelectorAll('h2, h3, h4, [class*="section"], [class*="header"]'))
      .find(function(el) { return (el.innerText || '').toLowerCase().includes('partner'); });
    if (partnerHeader) {
      partnerHeader.scrollIntoView({ block: 'start', behavior: 'instant' });
    }

    document.querySelectorAll('.card, [class*="card"], [class*="job-card"]').forEach(function(card) {
      const rect = card.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 50) return;
      if (rect.top < -200 || rect.top > window.innerHeight + 200) return;
      const text = (card.innerText || '').toLowerCase();
      if (!PARTNER_NAMES.some(function(p) { return text.includes(p); })) return;
      const key = Math.round(rect.x / 30) + ',' + Math.round(rect.y / 30);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        text: (card.innerText || '').trim().substring(0, 200),
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        kind: 'portal'
      });
    });

    return JSON.stringify(out);
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

/** Detecta survey cards DENTRO del offer wall de BitLabs u otros portales.
 * Busca elementos con reward (€/$/pts) + tiempo + botón clickable.
 */
function pageDetectOfferSurveys() {
  try {
    const out = [];
    const seen = new Set();

    // FIX: filtrar elementos que claramente son chrome de la página
    // (header con balance, footer, navigation, etc.) — NO son surveys reales
    const HEADER_NOISE = [
      'account balance', 'hello emilio', 'clickworker id', 'payable',
      'your user menu', 'copyright', 'data protection', 'general terms',
      'about us', 'sitemap', 'contact', 'time left:', 'work item #'
    ];

    // Estrategia 1: contenedores con reward+tiempo visibles
    const allEls = Array.from(document.querySelectorAll('div, li, article, section, a, button'));
    allEls.forEach(function(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 40) return;
      if (rect.top < 0 || rect.top > window.innerHeight + 200) return;
      const text = (el.innerText || '').trim();
      if (!text) return;
      const textLower = text.toLowerCase();
      // FIX: skip chrome de página
      if (HEADER_NOISE.some(function(n){return textLower.indexOf(n) !== -1;})) return;
      // FIX: skip elementos con texto enorme (es body completo, no card)
      if (text.length > 250) return;
      // Debe tener reward AND time (los dos) — un card de survey real tiene ambos
      const hasReward = /[€$£¥]\s*[0-9]+|[0-9]+\s*(eur|usd|pts|points|coins|credits)/i.test(text);
      const hasTime = /[0-9]+\s*(min|minutes|mins|m\b)/i.test(text);
      // FIX: AND en lugar de OR — un card real tiene los DOS
      if (!hasReward || !hasTime) return;
      // Solo el elemento más pequeño que contenga ambos (más específico)
      const key = Math.round(rect.x) + ',' + Math.round(rect.y) + ',' + Math.round(rect.width);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        text: text.substring(0, 150),
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      });
    });

    // Ordenar por tamaño (más pequeños = más específicos)
    out.sort(function(a, b) { return (a.w * a.h) - (b.w * b.h); });

    // Dedupe: eliminar si está 90% contenido dentro de otro ya en lista
    const deduped = [];
    out.forEach(function(el) {
      const dominated = deduped.some(function(d) {
        return Math.abs(d.x - el.x) < d.w * 0.4 && Math.abs(d.y - el.y) < d.h * 0.4 && d.w * d.h < el.w * el.h * 4;
      });
      if (!dominated) deduped.push(el);
    });

    return JSON.stringify(deduped.slice(0, 20));
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

function pageDetectQuestions() {
  try {
    const out = [];
    // FIX: ampliar selector para incluir CUSTOM radios/checkboxes (BitLabs/Qualtrics
    // suelen usar divs con role=radio o icon clickeables, no <input> nativos).
    let containers = Array.from(document.querySelectorAll(
      'form, [role="form"], fieldset, .question, [class*="question"], ' +
      '[role="radiogroup"], [class*="answer-list"], [class*="answers"]'));
    if (containers.length === 0) {
      const hasInputs = document.querySelector(
        'input[type="radio"], input[type="checkbox"], textarea, ' +
        'input[type="text"], input[type="email"], select, ' +
        '[role="radio"], [role="checkbox"]');
      if (hasInputs) {
        containers = [document.body];
      }
    }
    containers.forEach(function(c){
      const lbl = c.querySelector('label, legend, h1, h2, h3, h4, p, [class*="label"], [class*="title"], [class*="header"]');
      const qText = (lbl ? lbl.innerText : c.innerText.substring(0, 200)).trim();
      if (!qText) return;
      const radios = c.querySelectorAll('input[type="radio"]');
      const checks = c.querySelectorAll('input[type="checkbox"]');
      const texts = c.querySelectorAll('input[type="text"], input[type="email"], input:not([type])');
      const tareas = c.querySelectorAll('textarea');
      const selects = c.querySelectorAll('select');
      // CUSTOM elements (no <input>): role=radio, role=checkbox, divs clickeables
      // que parecen options de una pregunta.
      const customRadios = c.querySelectorAll(
        '[role="radio"], li[class*="option"], div[class*="option"][onclick], ' +
        'button[class*="option"], li[class*="answer"], div[class*="answer"][onclick]');
      const customChecks = c.querySelectorAll('[role="checkbox"]');

      let kind = null, options = [], target = null;
      if (radios.length > 0) {
        kind = 'radio';
        radios.forEach(function(r){
          const labEl = r.closest('label') || r.nextElementSibling || document.querySelector('label[for="' + r.id + '"]') || r;
          const lab = labEl.innerText || r.value;
          const rect = labEl.getBoundingClientRect();
          options.push({
            text: (lab||'').trim(),
            x: Math.round(rect.x), y: Math.round(rect.y),
            w: Math.round(rect.width), h: Math.round(rect.height)
          });
        });
        target = radios[0];
      } else if (checks.length > 0) {
        kind = 'checkbox';
        checks.forEach(function(r){
          const labEl = r.closest('label') || r.nextElementSibling || document.querySelector('label[for="' + r.id + '"]') || r;
          const lab = labEl.innerText || r.value;
          const rect = labEl.getBoundingClientRect();
          options.push({
            text: (lab||'').trim(),
            x: Math.round(rect.x), y: Math.round(rect.y),
            w: Math.round(rect.width), h: Math.round(rect.height)
          });
        });
        target = checks[0];
      } else if (customRadios.length > 0 || customChecks.length > 0) {
        // CUSTOM elements (BitLabs/Qualtrics style)
        kind = customRadios.length > 0 ? 'radio_custom' : 'checkbox_custom';
        const items = customRadios.length > 0 ? customRadios : customChecks;
        items.forEach(function(r){
          const txt = (r.innerText || r.getAttribute('aria-label') || '').trim();
          if (!txt || txt.length > 200) return;
          const rect = r.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) return;
          options.push({
            text: txt,
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
            w: Math.round(rect.width), h: Math.round(rect.height)
          });
        });
        target = items[0];
      } else if (tareas.length > 0) {
        kind = 'textarea';
        target = tareas[0];
      } else if (texts.length > 0) {
        kind = 'text';
        target = texts[0];
      } else if (selects.length > 0) {
        kind = 'select';
        const sel = selects[0];
        Array.from(sel.options).forEach(function(o){ options.push({text: o.text, value: o.value}); });
        target = sel;
      }
      if (kind && target && options.length > 0) {
        const r = target.getBoundingClientRect();
        out.push({
          q: qText.substring(0, 400),
          kind: kind,
          options: options.slice(0, 40),
          tx: Math.round(r.x + r.width / 2),
          ty: Math.round(r.y + r.height / 2)
        });
      } else if (kind && target && kind === 'select') {
        // select sin options array es weird pero válido
        const r = target.getBoundingClientRect();
        out.push({q: qText.substring(0,400), kind, options, tx: Math.round(r.x+r.width/2), ty: Math.round(r.y+r.height/2)});
      } else if (kind && target && (kind === 'text' || kind === 'textarea')) {
        const r = target.getBoundingClientRect();
        out.push({q: qText.substring(0,400), kind, options: [], tx: Math.round(r.x+r.width/2), ty: Math.round(r.y+r.height/2)});
      }
    });
    return JSON.stringify(out);
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

function pageDetectBitlabsSurveys() {
  try {
    const out = [];
    Array.from(document.querySelectorAll("div, button, a, [role='button']"))
    .map(function(el) {
      return {
        el: el,
        text: (el.innerText || "").trim(),
        rect: el.getBoundingClientRect()
      };
    })
    .filter(function(x) {
      return x.text && 
        /[\$\u20AC\u00A3\u00A5]|^[0-9]+(\.[0-9]+)?\s*(eur|usd|points|xp|coins)/i.test(x.text) &&
        x.rect.width > 30 && 
        x.rect.height > 20;
    })
    .forEach(function(x) {
      out.push({
        text: x.text.substring(0, 100),
        x: Math.round(x.rect.x + x.rect.width / 2),
        y: Math.round(x.rect.y + x.rect.height / 2),
        w: Math.round(x.rect.width),
        h: Math.round(x.rect.height)
      });
    });
    return JSON.stringify(out);
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}


// ──────────────────────────────────────────────────────────────────────────────
// Command handler
// ──────────────────────────────────────────────────────────────────────────────

async function rkBaseHandleCommand(cmd) {
  try {
    switch (cmd.action) {
      // ─── existentes (compat) ───────────────────────────────────────────────
      case "ping": return { ok: true, pong: true };
      // Con qué cuenta de X está logueado este perfil. El server lo usa para rutear.
      case "xuser": return { ok: true, xuser: await xUserId() };
      case "reload": {
        setTimeout(() => { chrome.runtime.reload(); }, 100);
        return { ok: true, reloaded: true };
      }

      case "list_tabs": {
        const tabs = await chrome.tabs.query({});
        return { ok: true, tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId, status: t.status, discarded: !!t.discarded })) };
      }

      case "x_unfollow_step": {
        if (cmd.tabId === undefined || cmd.tabId === null || cmd.tabId === "") return { ok: false, status: "bad_input", stop: true, detail: "tabId obligatorio" };
        const tabId = Number(cmd.tabId);
        let tab;
        try { tab = await chrome.tabs.get(tabId); } catch (e) { return { ok: false, status: "bad_input", stop: true, detail: "tab inexistente" }; }
        if (typeof isXUrl === "function" && !isXUrl(tab.url)) return { ok: false, status: "bad_input", stop: true, detail: "la pestaña no es de X" };
        const env = {
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          rand: (lo, hi) => lo + Math.random() * (hi - lo),
          tabUrl: () => tab.url,
          navigate: async (url) => {
            const same = (tab.url || "").replace(/[?#].*$/, "").toLowerCase() === url.toLowerCase();
            if (typeof isXUrl === "function" && !isXUrl(url)) throw new Error("destino no es X");
            if (same) await chrome.tabs.reload(tabId);
            else await chrome.tabs.update(tabId, { url, active: false });
          },
          waitLoaded: async (ms) => {
            const end = Date.now() + ms;
            await new Promise((r) => setTimeout(r, 500));
            while (Date.now() < end) {
              tab = await chrome.tabs.get(tabId);
              if (tab.status === "complete") return;
              await new Promise((r) => setTimeout(r, 300));
            }
          },
          snapshot: async (o) => {
            const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: xSnapshotInPage, args: [o] });
            return r ? r.result : null;
          },
          click: async (x, y) => {
            await ensureDebugger(tabId);
            const target = { tabId };
            try { await chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true }); } catch (e) {}
            const ev = (type, extra) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", Object.assign({ type, x, y }, extra));
            await ev("mouseMoved", { button: "none", buttons: 0 });
            await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
            await ev("mousePressed", { button: "left", buttons: 1, clickCount: 1 });
            await new Promise((r) => setTimeout(r, 40 + Math.random() * 70));
            await ev("mouseReleased", { button: "left", buttons: 0, clickCount: 1 });
          },
        };
        try {
          if (typeof runUnfollowStep === "function") {
            return await runUnfollowStep(env, cmd);
          }
          return { ok: false, error: "x_unfollow_core no disponible" };
        } catch (e) {
          return { ok: false, status: "error", stop: true, detail: String(e && e.message ? e.message : e) };
        }
      }

      case "read_text": {
        const tabId = await resolveTabId(cmd.tabId);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.body ? document.body.innerText : (document.documentElement ? document.documentElement.innerText : "")
        });
        const tabInfo = await chrome.tabs.get(tabId);
        return { ok: true, text: res && res.result ? res.result : "", title: tabInfo.title, url: tabInfo.url };
      }

      case "quick_eval": {
        const tabId = await resolveTabId(cmd.tabId);
        const expr = cmd.js || "";
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (code) => {
            try { return { ok: true, val: eval(code) }; }
            catch (e) { return { ok: false, err: String(e) }; }
          },
          args: [expr]
        });
        return { ok: true, result: res && res.result ? res.result : null };
      }

      case "cdp_eval": {
        const tabId = await resolveTabId(cmd.tabId);
        try {
          if (!attachedTabs.has(tabId)) {
            try { await chrome.debugger.attach({ tabId }, "1.3"); attachedTabs.add(tabId); }
            catch (err) {
              if (String(err).includes("already attached")) attachedTabs.add(tabId);
              else throw err;
            }
          }
          const ev = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: cmd.expr || "document.body.innerText",
            returnByValue: true,
            awaitPromise: true
          });
          if (ev && ev.exceptionDetails) {
            return { ok: false, error: ev.exceptionDetails.text || "exception" };
          }
          return { ok: true, result: ev && ev.result ? ev.result.value : null };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      }

      case "navigate": {
        let tab;
        let targetId = cmd.tabId;
        if (!targetId) {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          targetId = active && active.id;
        }
        if (targetId) {
          // Attach + Page.enable ANTES de salir: si la página tiene beforeunload
          // ("¿Desea abandonar el sitio?"), el handler global lo acepta solo en vez de
          // colgar al bot esperando un click manual.
          try { await ensureDebugger(targetId); } catch (e) {}
          tab = await chrome.tabs.update(targetId, { url: cmd.url });
        } else {
          tab = await chrome.tabs.create({ url: cmd.url, active: true });
        }
        await waitForTabComplete(tab.id, 30000);
        const fresh = await chrome.tabs.get(tab.id);
        TARGET_TAB = fresh.id;   // fijar: las acciones siguientes caen en ESTA pagina
        const freshUrl = (fresh.url || "").toLowerCase();
        if (freshUrl.startsWith("chrome-error://") || freshUrl.startsWith("chrome://net-error/") || freshUrl.includes("chromewebdata")) {
          return {
            ok: false,
            error: `page_load_error: No se pudo cargar '${cmd.url}'. El dominio no resolvió (error de DNS) o el servidor está caído. La pestaña quedó en página de error (${fresh.url}). No intentes interactuar aquí; navegá a otra URL o usá web_search.`,
            tabId: fresh.id,
            url: fresh.url,
            title: fresh.title
          };
        }
        return { ok: true, tabId: fresh.id, url: fresh.url, title: fresh.title };
      }

      case "new_tab": {
        const tab = await chrome.tabs.create({ url: cmd.url, active: cmd.active !== false });
        await waitForTabComplete(tab.id, 30000);
        TARGET_TAB = tab.id;
        const fresh = await chrome.tabs.get(tab.id);
        const freshUrl = (fresh.url || "").toLowerCase();
        if (freshUrl.startsWith("chrome-error://") || freshUrl.startsWith("chrome://net-error/") || freshUrl.includes("chromewebdata")) {
          return {
            ok: false,
            error: `page_load_error: No se pudo cargar '${cmd.url}'. Error de red o DNS (página de error de Chrome). Navegá a otra URL o usá web_search.`,
            tabId: fresh.id,
            url: fresh.url
          };
        }
        return { ok: true, tabId: tab.id, url: tab.url };
      }

      case "close_tab": {
        const tabId = await resolveTabId(cmd.tabId);
        if (!tabId) return { ok: false, error: "no tab found to close" };
        // cerrar un tab también puede disparar beforeunload -> attach antes para auto-aceptar
        try { await ensureDebugger(tabId); } catch (e) {}
        try {
          await chrome.tabs.remove(tabId);
          if (TARGET_TAB === tabId) TARGET_TAB = null;
          return { ok: true, closedTabId: tabId };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      }

      case "screenshot": {
        const tabId = await resolveTabId(cmd.tabId);
        const tab = await chrome.tabs.get(tabId);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        return { ok: true, dataUrl, tabId };
      }

      case "set_files": {
        // SUBIR ARCHIVOS sin el diálogo del SO (la pared del file-chooser). Usa CDP
        // DOM.setFileInputFiles sobre el <input type=file>. cmd.selector = selector del input
        // (default input[type=file]); cmd.files = ARRAY de rutas ABSOLUTAS locales.
        const tabId = await resolveTabId(cmd.tabId);
        await ensureDebugger(tabId);
        try {
          const sel = cmd.selector || "input[type=file]";
          const files = cmd.files || [];
          const ev = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate",
            { expression: `document.querySelector(${JSON.stringify(sel)})`, returnByValue: false });
          const objectId = ev && ev.result && ev.result.objectId;
          if (!objectId) return { ok: false, error: "file input no encontrado: " + sel };
          await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", { files, objectId });
          // disparar change/input para que el front (React) registre los archivos
          await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression:
            `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(e){e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('input',{bubbles:true}));}return 1;})()` });
          return { ok: true, set: files.length, selector: sel };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }

      case "eval": {
        const tabId = await resolveTabId(cmd.tabId);
        const expr = cmd.js.trim();
        const hasStatements = /(?:^|;\s*|\n\s*)(const|let|var|function|return|throw|try|if|for|while|switch)\s/.test(expr)
                            || expr.includes(";");
        const isAsyncExpr = /await\s/.test(expr);
        let wrapped;
        if (hasStatements || isAsyncExpr) {
          if (expr.includes("return")) {
            wrapped = `(async () => { return await (${expr}); })()`;
          } else {
            wrapped = `(async () => { ${expr} })()`;
          }
        }
        else if (expr.startsWith("{")) wrapped = `(${expr})`;
        else wrapped = `(${expr})`;

        // CDP PRIMERO. `new Function`/`eval` desde executeScript los bloquea el CSP de la página:
        // en x.com, instagram.com y cualquier sitio con script-src estricto los DOS caminos fallan
        // y esto devolvía "eval failed on all frames" siempre. Runtime.evaluate corre en el
        // protocolo de debug, fuera del alcance del CSP.
        try {
          await ensureDebugger(tabId);
          const ev = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: wrapped, returnByValue: true, awaitPromise: true, userGesture: true
          });
          if (ev && ev.exceptionDetails) {
            const d = ev.exceptionDetails;
            const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text;
            return { ok: false, error: "JS: " + String(msg).slice(0, 300) };
          }
          if (ev && ev.result && ev.result.type !== "undefined") {
            return { ok: true, result: ev.result.value };
          }
          if (ev && ev.result) return { ok: true, result: null };
        } catch (e) {
          // sin debugger (tab del devtools, chrome://, otro cliente ya attachado) -> seguimos abajo
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: "MAIN",
          func: async (code) => {
            try {
              // Use Function constructor instead of eval to bypass CSP in some contexts
              const fn = new Function('return (' + code + ')');
              const res = await fn();
              return { ok: true, res: res };
            } catch (e) {
              // fallback: try direct eval
              try {
                const res2 = await eval(code);
                return { ok: true, res: res2 };
              } catch (e2) {
                return { ok: false, error: e2.message };
              }
            }
          },
          args: [wrapped]
        });
        
        let best = null;
        for (const r of results) {
          const val = r.result;
          if (val && val.ok) {
            if (typeof val.res === 'string' && val.res.startsWith('[') && val.res !== '[]') {
              return { ok: true, result: val.res };
            }
            if (!best || (typeof val.res === 'string' && val.res !== '[]' && val.res !== '""')) {
              best = val;
            }
          }
        }
        if (best) return { ok: true, result: best.res };
        return { ok: false, error: "eval failed on all frames" };
      }

      case "detect_questions": {
        // FIX: world:"MAIN" + allFrames:true para penetrar iframe BitLabs
        // cross-origin. Sin world:MAIN ejecuta en isolated world que NO ve
        // el DOM real del page/iframe.
        const tabId = await resolveTabId(cmd.tabId);
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          func: pageDetectQuestions
        });
        // Merge results de TODOS los frames (no solo el primero)
        const merged = [];
        for (const r of results) {
          const val = r.result;
          if (val && typeof val === 'string' && val.startsWith('[') && val !== '[]') {
            try {
              const items = JSON.parse(val);
              for (const item of items) merged.push(item);
            } catch (e) {}
          }
        }
        return { ok: true, result: JSON.stringify(merged) };
      }

      case "detect_surveys": {
        const tabId = await resolveTabId(cmd.tabId);
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          func: pageDetectBitlabsSurveys
        });
        for (const r of results) {
          const val = r.result;
          if (val && typeof val === 'string' && val.startsWith('[') && val !== '[]') {
            return { ok: true, result: val };
          }
        }
        return { ok: true, result: "[]" };
      }

      case "detect_jobs": {
        const tabId = await resolveTabId(cmd.tabId);
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: "MAIN",
          func: pageDetectJobs,
        });
        for (const r of results) {
          const val = r.result;
          if (val && typeof val === 'string' && val.startsWith('[') && val !== '[]') {
            return { ok: true, result: val };
          }
        }
        return { ok: true, result: "[]" };
      }

      case "survey_click_start": {
        // Click botón Start/Empezar/Comenzar/Continuar DENTRO de cualquier frame
        // (top OR iframe BitLabs). element.click() native.
        const tabId = await resolveTabId(cmd.tabId);
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          func: function() {
            const kw = ["start", "empezar", "comenzar", "continuar", "begin",
                        "launch", "continue", "next", "siguiente", "go",
                        "accept", "aceptar", "proceed"];
            const els = Array.from(document.querySelectorAll(
              "a, button, [role=button], input[type=submit], input[type=button], " +
              "div[onclick], span[onclick]"));
            for (const el of els) {
              const t = (el.innerText || el.value || "").trim().toLowerCase();
              if (!t || t.length > 50) continue;
              const matches = kw.some(k => t === k || t.startsWith(k + " ") ||
                                            t.endsWith(" " + k));
              if (!matches) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 20 || r.height < 15) continue;
              if (el.offsetParent === null) continue;
              el.scrollIntoView({block: "center", behavior: "instant"});
              try { el.click(); return JSON.stringify({ok:true, text:t, frame:location.href.substring(0,80)}); }
              catch (e) { return JSON.stringify({ok:false, error:e.message}); }
            }
            return JSON.stringify({ok:false, error:"no_match"});
          }
        });
        for (const r of results) {
          const val = r.result;
          if (val && typeof val === 'string') {
            try {
              const parsed = JSON.parse(val);
              if (parsed.ok) return { ok: true, result: val };
            } catch (e) {}
          }
        }
        return { ok: false, error: "no start button in any frame" };
      }

      case "survey_apply_select_oopif": {
        // OOPIF-aware: usa chrome.debugger.getTargets() (extension API, no
        // browser-level) para listar OOPIFs, después attach + Runtime.evaluate.
        const tabId = await resolveTabId(cmd.tabId);
        await ensureDebugger(tabId);
        try {
          const targetInfos = await chrome.debugger.getTargets();
          const survey_hosts = ["bitlabs.ai", "opinaia.com", "qualtrics.com",
                                 "cint.com", "tapresearch.com", "cpx-research",
                                 "research.net", "questionpro"];
          const oopifs = targetInfos.filter(t =>
                          (t.type === "iframe" || t.type === "other" || t.type === "page") &&
                          t.tabId === tabId &&
                          survey_hosts.some(h => (t.url || "").includes(h)));
          if (!oopifs.length) {
            return { ok: false, error: "no OOPIF survey iframe found", targets: targetInfos.length };
          }
          // Try each OOPIF
          const answer = cmd.answer || "";
          for (const oopif of oopifs) {
            try {
              await chrome.debugger.attach({ targetId: oopif.targetId }, "1.3");
            } catch (e) {
              // Ya attached, OK
            }
            const evalJs = `(function(){
              const sels = Array.from(document.querySelectorAll("select"));
              for (const sel of sels) {
                if (sel.offsetParent === null) continue;
                const opts = Array.from(sel.options);
                const ansLow = ${JSON.stringify(answer.toLowerCase())};
                const match = opts.find(o => (o.text||"").trim().toLowerCase() === ansLow) ||
                              opts.find(o => (o.text||"").toLowerCase().includes(ansLow)) ||
                              opts.find(o => ansLow.includes((o.text||"").toLowerCase().trim()));
                if (!match) continue;
                sel.scrollIntoView({block: "center"});
                sel.value = match.value;
                sel.dispatchEvent(new Event("change", {bubbles: true}));
                sel.dispatchEvent(new Event("input", {bubbles: true}));
                return JSON.stringify({ok:true, picked: match.text, value: match.value});
              }
              // Si no es select, prueba radio buttons / checkboxes con label match
              const inputs = Array.from(document.querySelectorAll("input[type=radio], input[type=checkbox]"));
              for (const inp of inputs) {
                const labEl = inp.closest("label") || inp.nextElementSibling ||
                             document.querySelector("label[for='"+inp.id+"']");
                if (!labEl) continue;
                const labTxt = (labEl.innerText || "").trim().toLowerCase();
                const ansLow = ${JSON.stringify(answer.toLowerCase())};
                if (labTxt === ansLow || labTxt.includes(ansLow) || ansLow.includes(labTxt)) {
                  inp.scrollIntoView({block:"center"});
                  inp.click();
                  return JSON.stringify({ok:true, picked: labTxt, kind: inp.type});
                }
              }
              return JSON.stringify({ok:false, error:"no_match_in_oopif"});
            })()`;
            const res = await chrome.debugger.sendCommand(
              { targetId: oopif.targetId }, "Runtime.evaluate",
              { expression: evalJs, returnByValue: true });
            const val = res.result && res.result.value;
            if (val && typeof val === 'string') {
              try {
                const parsed = JSON.parse(val);
                if (parsed.ok) return { ok: true, result: val, oopif: oopif.url.substring(0,80) };
              } catch (e) {}
            }
          }
          return { ok: false, error: "no oopif had matching select/radio" };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      case "survey_click_in_oopif": {
        // Click botón Next/Submit/Empezar dentro del OOPIF survey.
        const tabId = await resolveTabId(cmd.tabId);
        await ensureDebugger(tabId);
        try {
          const targetInfos = await chrome.debugger.getTargets();
          const survey_hosts = ["bitlabs.ai", "opinaia.com", "qualtrics.com",
                                 "cint.com", "tapresearch.com", "research.net"];
          const oopifs = targetInfos.filter(t =>
                          (t.type === "iframe" || t.type === "other") &&
                          t.tabId === tabId &&
                          survey_hosts.some(h => (t.url || "").includes(h)));
          if (!oopifs.length) return { ok: false, error: "no OOPIF found" };
          const kw_default = ["next", "siguiente", "submit", "enviar", "continuar",
                              "continue", "finish", "finalizar", "start", "empezar",
                              "comenzar", "send"];
          const kw = cmd.keywords || kw_default;
          for (const oopif of oopifs) {
            try { await chrome.debugger.attach({ targetId: oopif.targetId }, "1.3"); }
            catch (e) {}
            const evalJs = `(function(){
              const kws = ${JSON.stringify(kw)};
              const els = Array.from(document.querySelectorAll("a, button, [role=button], input[type=submit], input[type=button], div[onclick]"));
              for (const el of els) {
                const t = ((el.innerText || el.value || "").trim()).toLowerCase();
                if (!t || t.length > 50) continue;
                if (!kws.some(k => t === k || t.startsWith(k+" ") || t.endsWith(" "+k))) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 15 || r.height < 10) continue;
                if (el.offsetParent === null) continue;
                el.scrollIntoView({block:"center"});
                try { el.click(); return JSON.stringify({ok:true, text:t}); }
                catch (e) { return JSON.stringify({ok:false, error:e.message}); }
              }
              return JSON.stringify({ok:false, error:"no_match"});
            })()`;
            const res = await chrome.debugger.sendCommand(
              { targetId: oopif.targetId }, "Runtime.evaluate",
              { expression: evalJs, returnByValue: true });
            const val = res.result && res.result.value;
            if (val && typeof val === 'string') {
              try {
                const parsed = JSON.parse(val);
                if (parsed.ok) return { ok: true, result: val, oopif: oopif.url.substring(0,80) };
              } catch (e) {}
            }
          }
          return { ok: false, error: "no oopif had matching button" };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      case "detect_questions_oopif": {
        // Detect preguntas dentro de OOPIF survey vía chrome.debugger.
        const tabId = await resolveTabId(cmd.tabId);
        await ensureDebugger(tabId);
        try {
          const targetInfos = await chrome.debugger.getTargets();
          const survey_hosts = ["bitlabs.ai", "opinaia.com", "qualtrics.com",
                                 "cint.com", "tapresearch.com", "research.net"];
          const oopifs = targetInfos.filter(t =>
                          (t.type === "iframe" || t.type === "other") &&
                          t.tabId === tabId &&
                          survey_hosts.some(h => (t.url || "").includes(h)));
          const merged = [];
          for (const oopif of oopifs) {
            try { await chrome.debugger.attach({ targetId: oopif.targetId }, "1.3"); }
            catch (e) {}
            // Reusa pageDetectQuestions stringified
            const fnStr = pageDetectQuestions.toString();
            const evalJs = `(${fnStr})()`;
            try {
              const res = await chrome.debugger.sendCommand(
                { targetId: oopif.targetId }, "Runtime.evaluate",
                { expression: evalJs, returnByValue: true });
              const val = res.result && res.result.value;
              if (val && typeof val === 'string' && val.startsWith('[') && val !== '[]') {
                try {
                  const items = JSON.parse(val);
                  for (const item of items) {
                    item._oopif_url = oopif.url.substring(0,80);
                    merged.push(item);
                  }
                } catch (e) {}
              }
            } catch (e) {}
          }
          return { ok: true, result: JSON.stringify(merged), oopifs_checked: oopifs.length };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      case "survey_apply_select": {
        // Aplica respuesta a un <select> DENTRO del frame que lo tenga.
        // Busca select cuya option text incluya cmd.answer y selecciona.
        const tabId = await resolveTabId(cmd.tabId);
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          func: function(answer) {
            const sels = Array.from(document.querySelectorAll("select"));
            for (const sel of sels) {
              if (sel.offsetParent === null) continue;
              const opts = Array.from(sel.options);
              const ansLow = (answer || "").trim().toLowerCase();
              const match = opts.find(o => (o.text || "").trim().toLowerCase() === ansLow) ||
                            opts.find(o => (o.text || "").toLowerCase().includes(ansLow)) ||
                            opts.find(o => ansLow.includes((o.text || "").toLowerCase().trim()));
              if (!match) continue;
              sel.scrollIntoView({block: "center", behavior: "instant"});
              sel.value = match.value;
              sel.dispatchEvent(new Event('change', {bubbles: true}));
              sel.dispatchEvent(new Event('input', {bubbles: true}));
              return JSON.stringify({ok:true, picked: match.text, value: match.value});
            }
            return JSON.stringify({ok:false, error:"no_select_with_option"});
          },
          args: [cmd.answer || ""]
        });
        for (const r of results) {
          const val = r.result;
          if (val && typeof val === 'string') {
            try {
              const parsed = JSON.parse(val);
              if (parsed.ok) return { ok: true, result: val };
            } catch (e) {}
          }
        }
        return { ok: false, error: "no select matched answer" };
      }

      case "click_best_offer_survey": {
        // Click el mejor card de offer wall (mayor €/min) DENTRO del iframe.
        // Usa element.click() native en el iframe para evitar coords mismatch
        // entre iframe DOM y top viewport.
        const tabId = await resolveTabId(cmd.tabId);
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          func: function() {
            const HEADER_NOISE = ['account balance', 'hello emilio',
              'clickworker id', 'payable', 'your user menu', 'copyright',
              'time left:', 'work item #'];
            const cards = [];
            const allEls = Array.from(document.querySelectorAll('div, li, article, section, a, button'));
            for (const el of allEls) {
              const rect = el.getBoundingClientRect();
              if (rect.width < 80 || rect.height < 40) continue;
              const text = (el.innerText || '').trim();
              if (!text || text.length > 250) continue;
              const tl = text.toLowerCase();
              if (HEADER_NOISE.some(n => tl.indexOf(n) !== -1)) continue;
              const rewardMatch = text.match(/[€$£]\s*([0-9]+[.,]?[0-9]*)|([0-9]+[.,]?[0-9]*)\s*(eur|usd|pts|points|coins|credits)/i);
              const timeMatch = text.match(/([0-9]+)\s*(min|minutes|mins|m\b)/i);
              if (!rewardMatch || !timeMatch) continue;
              const rewardStr = rewardMatch[1] || rewardMatch[2] || "0";
              const reward = parseFloat(rewardStr.replace(',', '.'));
              const mins = parseInt(timeMatch[1]) || 10;
              if (reward < 0.05 || mins > 60) continue;
              cards.push({el, reward, mins, eff: reward / Math.max(1, mins)});
            }
            if (!cards.length) return JSON.stringify({ok:false, error:'no_cards'});
            cards.sort((a, b) => b.eff - a.eff);
            const best = cards[0];
            best.el.scrollIntoView({block: 'center', behavior: 'instant'});
            // Click native (trusted en context del iframe)
            try {
              best.el.click();
              return JSON.stringify({ok:true, reward:best.reward, mins:best.mins, eff:best.eff});
            } catch (e) {
              return JSON.stringify({ok:false, error:e.message});
            }
          }
        });
        for (const r of results) {
          const val = r.result;
          if (val && typeof val === 'string') {
            try {
              const parsed = JSON.parse(val);
              if (parsed.ok) return { ok: true, result: val };
            } catch (e) {}
          }
        }
        return { ok: false, error: 'no frame had clickable cards' };
      }

      case "detect_offer_surveys": {
        // FIX: allFrames:true — entrar a iframes BitLabs/CPX/opinaia
        // Antes era false → solo top frame → nunca veía surveys reales
        const tabId = await resolveTabId(cmd.tabId);
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          func: pageDetectOfferSurveys,
        });
        // Merge resultados de todos los frames
        const merged = [];
        for (const r of results) {
          const val = r.result;
          if (val && typeof val === 'string' && val.startsWith('[') && val !== '[]') {
            try {
              const items = JSON.parse(val);
              for (const item of items) merged.push(item);
            } catch (e) {}
          }
        }
        return { ok: true, result: JSON.stringify(merged.slice(0, 20)) };
      }

      case "click": {
        const tabId = await resolveTabId(cmd.tabId);
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true }, world: "MAIN",
          func: (selector) => {
            const el = document.querySelector(selector);
            if (!el) return { ok: false };
            el.scrollIntoView({ block: "center" });
            el.click();
            return { ok: true, text: (el.innerText || el.value || "").slice(0, 100) };
          },
          args: [cmd.selector],
        });
        const success = results.find(r => r.result && r.result.ok);
        if (success) return success.result;
        return { ok: false, error: "selector not found in any frame" };
      }

      case "fill": {
        const tabId = await resolveTabId(cmd.tabId);
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true }, world: "MAIN",
          func: (selector, value) => {
            const el = document.querySelector(selector);
            if (!el) return { ok: false };
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
                        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
            if (setter) setter.call(el, value); else el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          },
          args: [cmd.selector, cmd.value],
        });
        const success = results.find(r => r.result && r.result.ok);
        if (success) return success.result;
        return { ok: false, error: "selector not found in any frame" };
      }

      case "fill_form": {
        const tabId = await resolveTabId(cmd.tabId);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: (fields) => {
            const results = {};
            for (const [sel, val] of Object.entries(fields)) {
              const el = document.querySelector(sel);
              if (!el) { results[sel] = { ok: false, error: "not found" }; continue; }
              const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
              if (setter) setter.call(el, val); else el.value = val;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              results[sel] = { ok: true };
            }
            return { ok: true, results };
          },
          args: [cmd.fields],
        });
        return res.result;
      }

      case "see": {
        // legacy see (compat) — usar see2 para versión nueva
        const tabId = await resolveTabId(cmd.tabId);
        const tab = await chrome.tabs.get(tabId);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: () => {
            const visible = el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < window.innerHeight;
            };
            const out = { url: location.href, title: document.title, buttons: [], inputs: [], links: [], file_inputs: [] };
            document.querySelectorAll('button, [role=button], input[type=submit]').forEach(b => {
              if (!visible(b)) return;
              out.buttons.push({
                text: (b.innerText || b.value || b.getAttribute("aria-label") || "").trim().slice(0, 80),
                selector: b.id ? `#${b.id}` : (b.dataset.testid ? `[data-testid="${b.dataset.testid}"]` : null),
              });
            });
            document.querySelectorAll('input:not([type=submit]):not([type=hidden]), textarea, select').forEach(i => {
              const type = i.type || "text";
              // Los file inputs casi siempre están OCULTOS (un botón lindo los dispara). Antes
              // se filtraban por visible() y el agente no los veía -> clickeaba el botón y se
              // abría el Finder. Ahora los incluimos SIEMPRE para poder cargarlos directo.
              if (!visible(i) && type !== "file") return;
              const o = { type, name: i.name || "", id: i.id || "", placeholder: i.placeholder || "", label: (document.querySelector(`label[for="${i.id}"]`)?.innerText || "").trim().slice(0, 60), selector: i.id ? `#${i.id}` : (i.name ? `[name="${i.name}"]` : (type === "file" ? "input[type=file]" : "")) };
              (type === "file" ? out.file_inputs : out.inputs).push(o);
            });
            document.querySelectorAll('a[href]').forEach(a => {
              if (visible(a)) out.links.push({ text: a.innerText.trim().slice(0, 50), href: a.href });
            });
            out.buttons = out.buttons.slice(0, 30);
            out.inputs = out.inputs.slice(0, 30);
            out.links = out.links.slice(0, 20);
            return out;
          },
        });
        return { ok: true, screenshot_dataUrl: dataUrl, ...res.result };
      }

      case "upload": {
        // Dos modos (cmd.files = [rutas absolutas]):
        //  A) directo: cmd.selector apunta al <input type=file> (aunque esté oculto).
        //  B) click:   cmd.clickSelector apunta al BOTÓN lindo de subir. Dejamos los archivos
        //     staged, lo clickeamos (trusted), la página abre el selector -> lo interceptamos
        //     (Finder NO se abre) y cargamos los archivos solos. Este es el caso Gumroad.
        const tabId = await resolveTabId(cmd.tabId);
        await ensureDebugger(tabId);
        const files = cmd.files || [];

        // Modo A: input directo por selector (sirve para inputs ocultos también).
        if (cmd.selector) {
          const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
          const { nodeIds } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelectorAll", { nodeId: root.nodeId, selector: cmd.selector });
          if (nodeIds && nodeIds.length) {
            await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", { nodeId: nodeIds[0], files });
            return { ok: true, mode: "directo", files };
          }
          if (!cmd.clickSelector) return { ok: false, error: "file input no encontrado por selector" };
        }

        // Modo B: stage + click trusted en el botón -> el chooser interceptado los carga.
        stagedUploads.set(tabId, files);
        const sel = cmd.clickSelector || cmd.button || "input[type=file]";
        const center = await freshCenter(tabId, sel);
        if (!center) { stagedUploads.delete(tabId); return { ok: false, error: `botón de subir no encontrado: ${sel}` }; }
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: "left", clickCount: 1 });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: "left", clickCount: 1 });
        // dar tiempo a que dispare fileChooserOpened y se carguen
        await new Promise(r => setTimeout(r, 1200));
        const pending = stagedUploads.get(tabId);
        return { ok: true, mode: "click", files, loaded: !pending };
      }

      case "wait_for": {
        const tabId = await resolveTabId(cmd.tabId);
        const startTs = Date.now();
        const timeout = cmd.timeoutMs || 15000;
        while (Date.now() - startTs < timeout) {
          const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true }, world: "MAIN",
            func: (sel) => !!document.querySelector(sel),
            args: [cmd.selector],
          });
          if (results.some(r => r.result)) return { ok: true, foundIn: Date.now() - startTs };
          await new Promise(r => setTimeout(r, 250));
        }
        return { ok: false, error: "timeout" };
      }

      // ─── v2 ────────────────────────────────────────────────────────────────

      case "see2": {
        // Numbered overlay + AX-style catalog + screenshot anotado
        const tabId = await resolveTabId(cmd.tabId);
        const tab = await chrome.tabs.get(tabId);
        const maxEl = cmd.max || 80;
        // 1) pintar overlays y catalogar
        const [catRes] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: pageBuildCatalog, args: [maxEl],
        });
        const cat = catRes.result;
        // 2) screenshot CON overlays
        await new Promise(r => setTimeout(r, 100)); // dar tiempo a render
        const annotated = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        // 3) limpiar overlays (opt-out con keep_overlay)
        if (!cmd.keep_overlay) {
          await chrome.scripting.executeScript({
            target: { tabId }, world: "MAIN", func: pageClearOverlay,
          });
        }
        // 4) screenshot LIMPIO también (algunos modelos prefieren ver el sitio sin marcas)
        let clean = null;
        if (cmd.also_clean) {
          clean = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        }
        // 5) guardar registry para act/click_index posteriores
        tabRegistries.set(tabId, { stamp: Date.now(), elements: cat.elements });
        return {
          ok: true, url: cat.url, title: cat.title, viewport: cat.viewport,
          elements: cat.elements,
          screenshot_dataUrl: annotated,
          screenshot_clean_dataUrl: clean,
          count: cat.elements.length,
        };
      }

      case "clear_overlay": {
        const tabId = await resolveTabId(cmd.tabId);
        await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN", func: pageClearOverlay,
        });
        return { ok: true };
      }

      case "act": {
        // Acción unificada por índice o selector.
        // cmd: {type: click|fill|hover|select_option|check|submit|clear, index?, selector?, value?}
        const tabId = await resolveTabId(cmd.tabId);
        const reg = tabRegistries.get(tabId);
        let selector = cmd.selector;
        let bbox = null;
        if (cmd.index != null) {
          if (!reg) return { ok: false, error: "no hay registry para este tab — corré see2 primero" };
          const entry = reg.elements.find(e => e.idx === Number(cmd.index));
          if (!entry) return { ok: false, error: `índice ${cmd.index} no existe en el registry` };
          selector = entry.selector;
          bbox = entry.bbox;
        }
        // CLICK = trusted via debugger Input (coords frescas). Si falla, cae al .click() viejo.
        if ((cmd.type || "click") === "click" && selector) {
          try {
            const c = await freshCenter(tabId, selector);
            if (c) { await trustedClick(tabId, c.x, c.y); return { ok: true, trusted: true, at: c }; }
          } catch (e) { /* fallback abajo */ }
        }
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: pageAct,
          args: [{ type: cmd.type, selector, bbox, value: cmd.value }],
        });
        return res.result;
      }

      case "tclick_text": {
        // Click TRUSTED por TEXTO visible, resuelto FRESCO al momento (sobrevive el re-render de
        // SPAs como LinkedIn). cmd: {text: regex, scope?: css del contenedor}
        const tabId = await resolveTabId(cmd.tabId);
        const [r] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: (txt, scopeSel) => {
            const rx = new RegExp(txt, "i");
            const root = (scopeSel && document.querySelector(scopeSel)) || document;
            let cands = [...root.querySelectorAll('button, a, [role=button], [role=link], [role=tab]')]
              .filter(e => {
                if (e.offsetParent === null || e.disabled) return false;
                const t = ((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || e.textContent || '')).trim();
                return rx.test(t) && t.length < 80;
              });
            if (!cands.length) return null;
            // descartar la barra de nav/filtros (arriba) y preferir BOTÓN más grande/abajo
            const below = cands.filter(e => e.getBoundingClientRect().top > 120);
            if (below.length) cands = below;
            cands.sort((a, b) => {
              const ab = a.tagName === 'BUTTON' ? 1 : 0, bb = b.tagName === 'BUTTON' ? 1 : 0;
              if (ab !== bb) return bb - ab;
              const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
              return (rb.width * rb.height) - (ra.width * ra.height);
            });
            const el = cands[0];
            el.scrollIntoView({ block: "center", inline: "center" });
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) return null;
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
          },
          args: [cmd.text, cmd.scope || null],
        });
        const c = r && r.result;
        if (!c) return { ok: false, error: "texto no encontrado" };
        await trustedClick(tabId, c.x, c.y);
        return { ok: true, at: c };
      }

      case "click_text": {
        const tabId = await resolveTabId(cmd.tabId);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: pageClickText,
          args: [{ text: cmd.text, role: cmd.role, occurrence: cmd.occurrence || 0 }],
        });
        return res.result;
      }

      case "type_human": {
        const tabId = await resolveTabId(cmd.tabId);
        let selector = cmd.selector;
        let bbox = null;
        if (cmd.index != null) {
          const reg = tabRegistries.get(tabId);
          if (reg) {
            const e = reg.elements.find(x => x.idx === Number(cmd.index));
            if (e) { selector = e.selector; bbox = e.bbox; }
          }
        }
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: pageTypeHuman,
          args: [{ selector, bbox, value: cmd.value, baseDelay: cmd.delay || 35 }],
        });
        // Esperar a que termine el tipeo (delay * len * 2 cap 5s)
        const wait = Math.min(5000, (cmd.delay || 35) * (cmd.value?.length || 0) * 2.5);
        await new Promise(r => setTimeout(r, wait));
        return res.result;
      }

      case "key": {
        const tabId = await resolveTabId(cmd.tabId);
        let selector = cmd.selector;
        if (cmd.index != null) {
          const reg = tabRegistries.get(tabId);
          if (reg) {
            const e = reg.elements.find(x => x.idx === Number(cmd.index));
            if (e) selector = e.selector;
          }
        }
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: pageKey,
          args: [{ selector, key: cmd.key, modifiers: cmd.modifiers || {} }],
        });
        return res.result;
      }

      case "hover": {
        const tabId = await resolveTabId(cmd.tabId);
        let selector = cmd.selector;
        let bbox = null;
        if (cmd.index != null) {
          const reg = tabRegistries.get(tabId);
          if (reg) {
            const e = reg.elements.find(x => x.idx === Number(cmd.index));
            if (e) { selector = e.selector; bbox = e.bbox; }
          }
        }
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN", func: pageAct,
          args: [{ type: 'hover', selector, bbox }],
        });
        return res.result;
      }

      case "scroll": {
        const tabId = await resolveTabId(cmd.tabId);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN", func: pageScroll,
          args: [{ selector: cmd.selector, dx: cmd.dx || 0, dy: cmd.dy || 0, behavior: cmd.behavior || 'auto' }],
        });
        return res.result;
      }

      case "wait_idle": {
        const tabId = await resolveTabId(cmd.tabId);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN", func: pageWaitIdle,
          args: [{ idleMs: cmd.idleMs || 600, maxMs: cmd.maxMs || 8000 }],
        });
        return res.result;
      }

      case "select_option": {
        const tabId = await resolveTabId(cmd.tabId);
        let selector = cmd.selector;
        let bbox = null;
        if (cmd.index != null) {
          const reg = tabRegistries.get(tabId);
          if (reg) {
            const e = reg.elements.find(x => x.idx === Number(cmd.index));
            if (e) { selector = e.selector; bbox = e.bbox; }
          }
        }
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN", func: pageAct,
          args: [{ type: 'select_option', selector, bbox, value: cmd.value }],
        });
        return res.result;
      }

      case "inspect": {
        const tabId = await resolveTabId(cmd.tabId);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN", func: pageInspect,
          args: [{ selector: cmd.selector }],
        });
        return res.result;
      }

      // ─────────────────────────────────────────────────────────────────
      // CDP (Chrome DevTools Protocol) actions — bypassan shadow DOM
      // cerrado (Adobe Spectrum, Lit, etc.). Eventos TRUSTED a nivel browser.
      // ─────────────────────────────────────────────────────────────────

      case "cdp_focus": {
        // Trae la pestaña al frente y le da el foco del SO. Hace falta antes de cdp_type:
        // Input.insertText escribe en el elemento enfocado del renderer, y si la ventana no
        // tiene foco no hay elemento enfocado, así que el texto no entra a ningún lado —
        // pero el comando devuelve ok igual. Diagnosticado el 08/08 con la caja de reply de X:
        // document.hasFocus() === false, cdp_click ok, cdp_type ok, y la caja vacía.
        const tabId = await resolveTabId(cmd.tabId);
        try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
        try {
          const t = await chrome.tabs.get(tabId);
          await chrome.windows.update(t.windowId, { focused: true });
        } catch (e) {}
        try {
          await ensureDebugger(tabId);
          await chrome.debugger.sendCommand({ tabId }, "Page.bringToFront");
        } catch (e) {}
        return { ok: true, focused: tabId };
      }

      case "cdp_type": {
        // Tipea texto vía Input.insertText (rápido) o key-by-key.
        // Usage: { action: "cdp_type", text: "...", keyByKey: false }
        const tabId = await resolveTabId(cmd.tabId);
        await ensureDebugger(tabId);
        const text = String(cmd.text || "");
        if (cmd.keyByKey) {
          for (const ch of text) {
            await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "char", text: ch, unmodifiedText: ch,
            });
            if (cmd.delay) await new Promise(r => setTimeout(r, cmd.delay));
          }
        } else {
          await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
        }
        return { ok: true, typed: text.length };
      }

      case "cdp_click": {
        // Click trusted en coordenadas (CSS pixels relativos al viewport).
        // Usage: { action: "cdp_click", x: 700, y: 640, button: "left", clickCount: 1 }
        const tabId = await resolveTabId(cmd.tabId);
        await ensureDebugger(tabId);
        const x = Number(cmd.x), y = Number(cmd.y);
        const button = cmd.button || "left";
        const clickCount = Number(cmd.clickCount || 1);
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mousePressed", x, y, button, clickCount,
        });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x, y, button, clickCount,
        });
        return { ok: true, x, y };
      }

      case "cdp_key": {
        // Dispatch tecla individual (Enter, Tab, Escape, etc.).
        // Usage: { action: "cdp_key", key: "Enter" }
        const tabId = await resolveTabId(cmd.tabId);
        await ensureDebugger(tabId);
        const keyMap = {
          Enter:   { key: "Enter",   code: "Enter",   windowsVirtualKeyCode: 13 },
          Tab:     { key: "Tab",     code: "Tab",     windowsVirtualKeyCode: 9 },
          Escape:  { key: "Escape",  code: "Escape",  windowsVirtualKeyCode: 27 },
          Backspace:{ key:"Backspace",code:"Backspace",windowsVirtualKeyCode:8 },
          ArrowDown:{ key:"ArrowDown",code:"ArrowDown",windowsVirtualKeyCode:40 },
          ArrowUp:{ key:"ArrowUp",code:"ArrowUp",windowsVirtualKeyCode:38 },
        };
        const k = keyMap[cmd.key] || { key: cmd.key, code: cmd.key };
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
          type: "keyDown", ...k,
        });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
          type: "keyUp", ...k,
        });
        return { ok: true, key: cmd.key };
      }

      case "cdp_focus": {
        // Mueve focus al elemento por bbox center (via mouse move + click).
        // Útil antes de cdp_type cuando hay shadow DOM cerrado.
        // Usage: { action: "cdp_focus", x, y }
        const tabId = await resolveTabId(cmd.tabId);
        await ensureDebugger(tabId);
        const x = Number(cmd.x), y = Number(cmd.y);
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x, y,
        });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mousePressed", x, y, button: "left", clickCount: 1,
        });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x, y, button: "left", clickCount: 1,
        });
        return { ok: true, x, y };
      }

      default:
        return { ok: false, error: `unknown action: ${cmd.action}` };
    }
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes("Frame with ID 0 is showing error page") || msg.includes("chromewebdata") || msg.includes("cannot access")) {
      return {
        ok: false,
        error: "page_load_error: La pestaña actual muestra una página de error de Chrome (DNS/red o sitio caído). No se pueden ejecutar acciones de scraping ni interacción en páginas que no cargaron. Navegá a una URL válida o usá web_search."
      };
    }
    return { ok: false, error: msg };
  }
}

async function assertTabRunnable(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;
    const url = (tab.url || "").toLowerCase();
    if (url.startsWith("chrome-error://") || url.startsWith("chrome://net-error/") || url.includes("chromewebdata")) {
      throw new Error(`page_load_error: La pestaña está en la página de error de Chrome (${tab.url || 'chrome-error://'}). El sitio web no cargó o no existe (DNS error). Navegá a una URL válida o usá web_search.`);
    }
    if (url.startsWith("chrome://") || url.startsWith("devtools://") || url.startsWith("chrome-extension://")) {
      throw new Error(`page_load_error: La pestaña está en una URL interna de Chrome (${tab.url}). No se pueden inyectar scripts en páginas internas. Navegá a un sitio web público.`);
    }
  } catch (err) {
    if (err.message && err.message.includes("page_load_error")) throw err;
  }
}

async function resolveTabId(maybeId, checkExecutable = true) {
  let tabId = maybeId;
  if (!tabId) {
    if (TARGET_TAB != null) {
      try { const t = await chrome.tabs.get(TARGET_TAB); if (t) tabId = TARGET_TAB; }
      catch (e) { TARGET_TAB = null; }
    }
    if (!tabId) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active) tabId = active.id;
      else {
        const [anyActive] = await chrome.tabs.query({ active: true });
        if (anyActive) tabId = anyActive.id;
        else {
          const [anyTab] = await chrome.tabs.query({});
          if (anyTab) tabId = anyTab.id;
          else throw new Error("no active tab");
        }
      }
    }
  }
  if (checkExecutable && tabId) {
    await assertTabRunnable(tabId);
  }
  return tabId;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(); } }, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete" && !done) {
        done = true; clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Auto-maneja los diálogos JS nativos (beforeunload "¿Desea abandonar el sitio?", alert,
// confirm, prompt). Con el debugger attachado + Page habilitado, Chrome NO muestra el cartel
// nativo (que bloqueaba al bot porque no es DOM): en su lugar dispara este evento y lo
// aceptamos solos. Antes, esos carteles dejaban al bot colgado esperando un click manual.
// Archivos "staged" por tab: el agente los deja listos ANTES de clickear el botón de subir;
// cuando la página abre el selector de archivos, lo interceptamos (Finder NO se abre) y los
// cargamos solos. Esto arregla el caso Gumroad donde se abría el Finder y el bot no sabía.
const stagedUploads = new Map();   // tabId -> [rutas]

let dialogHandlerInstalled = false;
function installDialogHandler() {
  if (dialogHandlerInstalled) return;
  dialogHandlerInstalled = true;
  chrome.debugger.onEvent.addListener(async (src, method, params) => {
    if (!src.tabId) return;
    // beforeunload / alert / confirm / prompt -> aceptar (seguir).
    if (method === "Page.javascriptDialogOpening") {
      chrome.debugger.sendCommand({ tabId: src.tabId }, "Page.handleJavaScriptDialog",
        { accept: true }).catch(() => {});
    }
    // Selector de archivos: Finder interceptado. Si hay archivos staged, los cargamos.
    if (method === "Page.fileChooserOpened") {
      const files = stagedUploads.get(src.tabId);
      if (files && files.length && params && params.backendNodeId != null) {
        try {
          await chrome.debugger.sendCommand({ tabId: src.tabId }, "DOM.setFileInputFiles",
            { backendNodeId: params.backendNodeId, files });
          stagedUploads.delete(src.tabId);
        } catch (e) {}
      }
      // sin archivos staged: queda interceptado (no bloquea con Finder).
    }
  });
}

async function ensureDebugger(tabId) {
  installDialogHandler();
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
  // Page.enable: los diálogos JS llegan como evento (no cartel nativo bloqueante).
  try { await chrome.debugger.sendCommand({ tabId }, "Page.enable"); } catch (e) {}
  // Interceptar el selector de archivos: el Finder nativo nunca se abre; en su lugar
  // disparamos Page.fileChooserOpened y cargamos los archivos staged por CDP.
  try { await chrome.debugger.sendCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: true }); } catch (e) {}
  chrome.debugger.onDetach.addListener((src) => {
    if (src.tabId) { attachedTabs.delete(src.tabId); stagedUploads.delete(src.tabId); }
  });
}

// Coordenadas FRESCAS del centro de un elemento (scroll a la vista + getBoundingClientRect).
async function freshCenter(tabId, selector) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: (sel) => {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) {}
      if (!el) {
        for (const x of document.querySelectorAll('*')) {
          if (x.shadowRoot) { try { el = x.shadowRoot.querySelector(sel); if (el) break; } catch (e) {} }
        }
      }
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return null;
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    },
    args: [selector],
  });
  return r && r.result;
}

// CLICK TRUSTED (isTrusted=true) via debugger Input — las SPA tipo LinkedIn IGNORAN el
// element.click() sintético; este pasa por el pipeline de input del navegador, indistinguible
// de un click humano. Reusa la sesión logueada del Chrome real.
async function trustedClick(tabId, x, y) {
  await ensureDebugger(tabId);
  const tgt = { tabId };
  await chrome.debugger.sendCommand(tgt, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await chrome.debugger.sendCommand(tgt, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 35));
  await chrome.debugger.sendCommand(tgt, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

function serializeResult(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
}

// =====================================================================================
// v0.3.0 — Depuración del navegador (solo lectura / diagnóstico). Ver README-NEW-ACTIONS.md
// Sin anti-detección, sin huellas, sin captchas: ante captcha/desafío/aviso -> status "captcha_or_warning".
// =====================================================================================
const H = {}; // acciones nuevas (el resto sigue en rkBaseHandleCommand)
const RK_LOG = new RkRing(RK_LOG_CAPACITY);
const RK_CONSOLE_TABS = new Map(); // tabId -> { network: bool, since: ts }
let rkPersistTimer = null;
const rkSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rkLog(entry) {
  const e = RK_LOG.push(entry);
  rkSchedulePersist();
  return e;
}
function rkSchedulePersist() {
  if (rkPersistTimer) return;
  rkPersistTimer = setTimeout(async () => {
    rkPersistTimer = null;
    try {
      if (chrome.storage && chrome.storage.session) await chrome.storage.session.set({ rk_log_v1: RK_LOG.dump(300) });
    } catch (e) {}
  }, 2000);
}
(async () => {
  try {
    if (chrome.storage && chrome.storage.session) {
      const r = await chrome.storage.session.get("rk_log_v1");
      if (r && Array.isArray(r.rk_log_v1) && RK_LOG.buf.length === 0) RK_LOG.load(r.rk_log_v1);
    }
  } catch (e) {}
  rkLog({ kind: "system", level: "info", msg: "bridge start v" + RK_VERSION });
})();

// ---- captura de red (solo observa; no bloquea ni modifica requests) ----
try {
  if (chrome.webRequest) {
    chrome.webRequest.onErrorOccurred.addListener(
      (d) => {
        if (rkIgnoreRequest(d)) return;
        if (d.error === "net::ERR_ABORTED") return; // cancelaciones normales de navegación
        rkLog(rkFormatWebRequestError(d));
      },
      { urls: ["<all_urls>"] }
    );
    chrome.webRequest.onCompleted.addListener(
      (d) => {
        if (rkIgnoreRequest(d)) return;
        const e = rkFormatWebRequestCompleted(d);
        if (e) rkLog(e);
      },
      { urls: ["<all_urls>"] }
    );
  }
} catch (e) {
  rkLog({ kind: "system", level: "warn", msg: "webRequest no disponible: " + String(e && e.message ? e.message : e) });
}

// ---- consola por pestaña (vía debugger; solo si el caller la pidió con console_start) ----
try {
  chrome.debugger.onEvent.addListener((src, method, params) => {
    if (!src || src.tabId === undefined || !RK_CONSOLE_TABS.has(src.tabId)) return;
    const e = rkFormatCdpEvent(method, params);
    if (e) rkLog(Object.assign({ tabId: src.tabId }, e));
  });
  chrome.debugger.onDetach.addListener((src, reason) => {
    if (src && RK_CONSOLE_TABS.has(src.tabId)) {
      RK_CONSOLE_TABS.delete(src.tabId);
      rkLog({ kind: "system", level: "warn", tabId: src.tabId, msg: "debugger desconectado de la pestaña (" + reason + "); captura de consola detenida" });
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (RK_CONSOLE_TABS.delete(tabId)) rkLog({ kind: "system", level: "info", tabId, msg: "pestaña cerrada; captura de consola detenida" });
  });
} catch (e) {}

// ---- permisos de sitio / pestañas descartadas ----
const RK_HINT_SITE_ACCESS = rkClassifyScriptError("Cannot access contents of the page");

async function rkWaitComplete(tabId, ms) {
  const end = Date.now() + (ms || 15000);
  await rkSleep(400);
  while (Date.now() < end) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete" && !t.discarded) return t;
    } catch (e) { return null; }
    await rkSleep(250);
  }
  try { return await chrome.tabs.get(tabId); } catch (e) { return null; }
}

// Recarga SOLO esa pestaña, y solo si está descartada.
async function rkReloadDiscarded(tabId, ms) {
  const t = await chrome.tabs.get(Number(tabId));
  if (!t.discarded) return { reloaded: false, tab: t };
  await chrome.tabs.reload(t.id);
  rkLog({ kind: "perm", level: "info", tabId: t.id, msg: "pestaña descartada recargada a pedido del caller" });
  return { reloaded: true, tab: await rkWaitComplete(t.id, ms) };
}

async function rkSiteAccess(tab, opts) {
  const pattern = rkOriginPattern(tab.url);
  const info = {
    tabId: tab.id, url: rkSanitizeUrl(tab.url), origin: pattern, discarded: !!tab.discarded,
    restricted: rkIsRestrictedUrl(tab.url), permissionGranted: null, requested: false, requestResult: null, probe: null,
  };
  if (pattern) {
    try { info.permissionGranted = await chrome.permissions.contains({ origins: [pattern] }); } catch (e) { info.permissionGranted = null; }
    if (info.permissionGranted === false && opts && opts.request) {
      info.requested = true;
      try {
        info.requestResult = await chrome.permissions.request({ origins: [pattern] });
        if (info.requestResult) info.permissionGranted = true;
      } catch (e) {
        // En un service worker no hay gesto del usuario: Chrome suele rechazarlo. No es un fallo del bridge.
        info.requestResult = "error: " + rkRedact(e && e.message ? e.message : e, 160);
      }
    }
  }
  if (!info.discarded && !info.restricted && tab.url) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => 1 });
      info.probe = "ok";
    } catch (e) {
      const c = rkClassifyScriptError(e);
      info.probe = c ? c.status : "error";
      info.probeError = rkRedact(e && e.message ? e.message : e, 200);
    }
  } else if (info.discarded) info.probe = "skipped_discarded";
  else if (info.restricted) info.probe = "restricted_page";
  if (info.probe === "no_site_access" || info.permissionGranted === false) {
    info.hint = RK_HINT_SITE_ACCESS.hint;
    info.hint_en = RK_HINT_SITE_ACCESS.hint_en;
  }
  return info;
}

// Convierte un error (objeto o texto) en una respuesta estructurada, o null si no es un error conocido.
async function rkErrorResponse(e, m) {
  const msg = String(e && e.message ? e.message : e);
  const c = rkClassifyScriptError(e);
  if (!c) return null;
  const res = { ok: false, status: c.status, error: msg, hint: c.hint, hint_en: c.hint_en };
  if (m && m.tabId !== undefined && m.tabId !== null && m.tabId !== "") res.tabId = Number(m.tabId);
  if (c.status === "no_site_access" || c.status === "restricted_page") {
    try {
      let tid = res.tabId;
      if (tid === undefined) tid = await resolveTabId(m.tabId, false);
      if (tid !== undefined && tid !== null) {
        const t = await chrome.tabs.get(tid);
        res.tabId = tid;
        res.url = rkSanitizeUrl(t.url);
        res.discarded = !!t.discarded;
        res.origin = rkOriginPattern(t.url);
        if (res.origin) {
          try { res.permissionGranted = await chrome.permissions.contains({ origins: [res.origin] }); } catch (e2) {}
          if (res.permissionGranted === false && m.requestAccess === true) {
            try { res.requestResult = await chrome.permissions.request({ origins: [res.origin] }); } catch (e3) { res.requestResult = "error: " + rkRedact(e3 && e3.message ? e3.message : e3, 160); }
          }
        }
        if (t.discarded) res.hint_discarded = "La pestaña está descartada: pedí reloadIfDiscarded:true (recarga solo esa pestaña) o usá tab_reload_discarded.";
      }
    } catch (e4) {}
  }
  return res;
}

// ---- guard captcha / desafío / aviso ----
async function rkGuardTab(tab) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: rkGuardInPage });
  const snap = r ? r.result : null;
  return rkDecideGuard(tab.url, snap);
}

// Acciones que operan sobre una pestaña (para validar tabId / descartada).
const RK_ACTING = new Set(["click", "click_text", "tclick_text", "fill", "fill_form", "act", "type_human", "select_option", "key", "cdp_click", "cdp_focus", "cdp_type", "cdp_key", "upload", "set_files",
  "survey_click_start", "survey_click_in_oopif", "survey_apply_select", "survey_apply_select_oopif", "click_best_offer_survey"]);
// Acciones que MUEVEN/ESCRIBEN en la página: ahí corre el guard. Las de solo lectura (see, inspect, screenshot…) no se bloquean: sirven para diagnosticar.
const RK_TAB_ACTIONS = new Set([...RK_ACTING, "navigate", "wait_idle", "wait_for", "screenshot", "see", "clear_overlay", "see2", "eval", "hover", "scroll", "inspect",
  "read_text", "quick_eval", "cdp_eval", "detect_questions", "detect_surveys", "detect_jobs", "detect_offer_surveys", "detect_questions_oopif", "x_unfollow_step"]);

async function rkPreflight(m) {
  if (!RK_TAB_ACTIONS.has(m.action)) return {};
  const explicit = m.tabId !== undefined && m.tabId !== null && m.tabId !== "" && m.tabId !== 0;
  let tab = null;
  if (explicit) {
    try {
      tab = await chrome.tabs.get(Number(m.tabId));
    } catch (e) {
      // resolveTabId() no valida existencia; evitamos que una acción caiga en otra pestaña por error.
      return { block: { ok: false, status: "no_tab", error: "tab inexistente: " + m.tabId, tabId: Number(m.tabId), hint: "No uso otra pestaña como reemplazo." } };
    }
    if (tab.discarded && m.action !== "navigate") {
      if (m.reloadIfDiscarded === true) {
        const r = await rkReloadDiscarded(tab.id, Number(m.reloadTimeoutMs) || 15000);
        tab = r.tab || tab;
      } else {
        return { block: { ok: false, status: "tab_discarded", error: "la pestaña " + tab.id + " está descartada (Chrome la descargó de memoria)", tabId: tab.id, url: rkSanitizeUrl(tab.url), hint: "Repetí la acción con reloadIfDiscarded:true (recarga SOLO esa pestaña) o llamá tab_reload_discarded.", hint_en: "Repeat with reloadIfDiscarded:true (reloads ONLY that tab) or call tab_reload_discarded." } };
      }
    }
  }
  if (RK_ACTING.has(m.action)) {
    if (!tab) {
      const id = await resolveTabId(m.tabId, false); // misma pestaña que usaría la acción (pegajosa / activa)
      tab = id !== undefined && id !== null ? await chrome.tabs.get(id) : null;
    }
    if (tab && tab.id !== undefined) {
      let dec;
      try {
        dec = await rkGuardTab(tab);
      } catch (e) {
        if (rkClassifyScriptError(e)) throw e; // permisos / página restringida: se reporta como tal
        return { block: { ok: false, status: "guard_failed", error: "no pude verificar captcha/aviso: " + rkRedact(e && e.message ? e.message : e, 200), tabId: tab.id, hint: "Acción detenida por seguridad; reintentá tras wait_idle." } };
      }
      if (dec.flagged) {
        rkLog({ kind: "guard", level: "warn", tabId: tab.id, msg: "captcha_or_warning (" + dec.kind + ") en " + rkSanitizeUrl(tab.url) + " antes de " + m.action, data: { kind: dec.kind, source: dec.source, evidence: dec.evidence } });
        return { block: { ok: false, status: "captcha_or_warning", stop: true, kind: dec.kind, source: dec.source, evidence: dec.evidence, tabId: tab.id, url: rkSanitizeUrl(tab.url), action: m.action, error: "captcha_or_warning: la página muestra un " + dec.kind + "; acción detenida. No resuelvo captchas ni los esquivo.", hint: "Resolvelo/revisalo a mano en el navegador y reintentá, o frená el flujo." } };
      }
    }
  }
  return { tab };
}

async function rkDispatch(m, h) {
  const t0 = Date.now();
  let res;
  try {
    const pre = await rkPreflight(m);
    res = pre.block ? pre.block : await h(m);
  } catch (e) {
    res = (await rkErrorResponse(e, m)) || { ok: false, error: String(e && e.message ? e.message : e) };
  }
  // Errores de scripting devueltos como {ok:false,error:"..."} por el handler base: se enriquecen sin cambiar `error`.
  if (res && res.ok === false && typeof res.error === "string" && !res.status && !res.error.startsWith("page_load_error")) {
    const full = await rkErrorResponse(res.error, m);
    if (full) {
      const keepError = res.error;
      for (const k of Object.keys(full)) if (res[k] === undefined) res[k] = full[k];
      res.error = keepError;
    }
  }
  if (m.action === "ping" && res && res.ok) Object.assign(res, { version: RK_VERSION, caps: RK_CAPS });
  const ok = !!(res && res.ok);
  rkLog({
    kind: "action", level: ok ? "debug" : "warn", tabId: res && res.tabId !== undefined ? res.tabId : (m.tabId !== undefined && m.tabId !== "" && m.tabId !== null ? Number(m.tabId) : undefined),
    msg: m.action + " -> " + (ok ? "ok" : (res && res.status) || "fail") + " (" + (Date.now() - t0) + "ms)",
    data: { action: m.action, ok, status: res && res.status, ms: Date.now() - t0, error: !ok && res && res.error ? rkRedact(res.error, 200) : undefined },
  });
  return res;
}

function rkTabRow(t, extra) {
  const row = {
    id: t.id, windowId: t.windowId, url: t.url, title: t.title, status: t.status, discarded: !!t.discarded, active: !!t.active,
    audible: !!t.audible, pinned: !!t.pinned, incognito: !!t.incognito, autoDiscardable: t.autoDiscardable, lastAccessed: t.lastAccessed,
  };
  if (extra) Object.assign(row, extra);
  return row;
}

function rkNeedTabId(m) {
  if (m.tabId === undefined || m.tabId === null || m.tabId === "") return { ok: false, status: "bad_input", error: "tabId obligatorio (no uso la pestaña activa por defecto)" };
  return null;
}

Object.assign(H, {
  tabs_info: async (m) => {
    let tabs = await chrome.tabs.query({});
    if (m.discardedOnly) tabs = tabs.filter((t) => t.discarded);
    if (m.activeOnly) tabs = tabs.filter((t) => t.active);
    if (m.urlContains) tabs = tabs.filter((t) => String(t.url || "").toLowerCase().includes(String(m.urlContains).toLowerCase()));
    const rows = [];
    for (const t of tabs) {
      const pattern = rkOriginPattern(t.url);
      let granted = null;
      if (pattern) { try { granted = await chrome.permissions.contains({ origins: [pattern] }); } catch (e) {} }
      rows.push(rkTabRow(t, { restricted: rkIsRestrictedUrl(t.url), siteAccess: granted, console: RK_CONSOLE_TABS.has(t.id) }));
    }
    return { ok: true, count: rows.length, tabs: rows };
  },
  site_access: async (m) => {
    const bad = rkNeedTabId(m); if (bad) return bad;
    let tab;
    try { tab = await chrome.tabs.get(Number(m.tabId)); } catch (e) { return { ok: false, status: "no_tab", error: "tab inexistente: " + m.tabId }; }
    return Object.assign({ ok: true }, await rkSiteAccess(tab, { request: m.request === true }));
  },
  tab_reload_discarded: async (m) => {
    const bad = rkNeedTabId(m); if (bad) return bad;
    let tab;
    try { tab = await chrome.tabs.get(Number(m.tabId)); } catch (e) { return { ok: false, status: "no_tab", error: "tab inexistente: " + m.tabId }; }
    if (!tab.discarded) return { ok: false, status: "not_discarded", tabId: tab.id, error: "la pestaña no está descartada; no la recargo" };
    const r = await rkReloadDiscarded(tab.id, Number(m.timeoutMs) || 15000);
    const t = r.tab;
    return { ok: !!t && !t.discarded, tabId: tab.id, reloaded: r.reloaded, status: t ? t.status : null, discarded: t ? !!t.discarded : null, url: t ? rkSanitizeUrl(t.url) : null };
  },
  guard_check: async (m) => {
    const bad = rkNeedTabId(m); if (bad) return bad;
    let tab;
    try { tab = await chrome.tabs.get(Number(m.tabId)); } catch (e) { return { ok: false, status: "no_tab", error: "tab inexistente: " + m.tabId }; }
    if (tab.discarded) return { ok: false, status: "tab_discarded", tabId: tab.id, hint: "usá tab_reload_discarded" };
    const dec = await rkGuardTab(tab);
    return { ok: true, tabId: tab.id, url: rkSanitizeUrl(tab.url), flagged: dec.flagged, status: dec.flagged ? "captcha_or_warning" : "clear", kind: dec.kind, source: dec.source, evidence: dec.evidence };
  },
  console_start: async (m) => {
    const bad = rkNeedTabId(m); if (bad) return bad;
    const tabId = Number(m.tabId);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return { ok: false, status: "no_tab", error: "tab inexistente: " + m.tabId }; }
    if (tab.discarded) return { ok: false, status: "tab_discarded", tabId, hint: "usá tab_reload_discarded primero" };
    if (rkIsRestrictedUrl(tab.url)) return { ok: false, status: "restricted_page", tabId, error: "página restringida de Chrome" };
    await ensureDebugger(tabId); // mismo attach que usa el resto de las acciones CDP de este bridge
    const target = { tabId };
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "Log.enable");
    if (m.network === true) await chrome.debugger.sendCommand(target, "Network.enable");
    RK_CONSOLE_TABS.set(tabId, { network: m.network === true, since: Date.now() });
    rkLog({ kind: "system", level: "info", tabId, msg: "captura de consola iniciada" + (m.network ? " (+Network CDP)" : "") });
    return { ok: true, tabId, capturing: true, network: m.network === true, note: "Chrome muestra el aviso 'está depurando este navegador' mientras dure la captura." };
  },
  console_stop: async (m) => {
    const bad = rkNeedTabId(m); if (bad) return bad;
    const tabId = Number(m.tabId);
    const was = RK_CONSOLE_TABS.delete(tabId);
    try { await chrome.debugger.detach({ tabId }); } catch (e) {}
    attachedTabs.delete(tabId);
    stagedUploads.delete(tabId);
    if (was) rkLog({ kind: "system", level: "info", tabId, msg: "captura de consola detenida" });
    return { ok: true, tabId, wasCapturing: was };
  },
  console_read: async (m) => {
    const bad = rkNeedTabId(m); if (bad) return bad;
    const f = { kind: "console", tabId: m.tabId, minLevel: m.minLevel, sinceSeq: m.sinceSeq, limit: m.limit, contains: m.contains };
    const entries = RK_LOG.read(f);
    if (m.clear === true) RK_LOG.clear({ kind: "console", tabId: m.tabId });
    return { ok: true, tabId: Number(m.tabId), capturing: RK_CONSOLE_TABS.has(Number(m.tabId)), count: entries.length, entries, lastSeq: RK_LOG.seq };
  },
  net_errors: async (m) => {
    const f = { kind: "net", tabId: m.tabId, minLevel: m.minLevel, sinceSeq: m.sinceSeq, limit: m.limit, contains: m.contains };
    const entries = RK_LOG.read(f);
    if (m.clear === true) RK_LOG.clear({ kind: "net", tabId: m.tabId });
    return { ok: true, count: entries.length, entries, lastSeq: RK_LOG.seq };
  },
  log_read: async (m) => {
    const entries = RK_LOG.read({ kind: m.kind, tabId: m.tabId, minLevel: m.minLevel, sinceSeq: m.sinceSeq, limit: m.limit, contains: m.contains });
    return { ok: true, count: entries.length, entries, stats: RK_LOG.stats() };
  },
  log_clear: async (m) => ({ ok: true, removed: RK_LOG.clear({ kind: m.kind, tabId: m.tabId }), stats: RK_LOG.stats() }),
  debug_info: async () => ({ ok: true, version: RK_VERSION, caps: RK_CAPS, log: RK_LOG.stats(), consoleTabs: [...RK_CONSOLE_TABS.keys()], actingGuarded: [...RK_ACTING] }),
});

// Punto de entrada que usa ws.onmessage: acciones nuevas (H) o el switch original, ambos con preflight + log.
async function handleCommand(cmd) {
  const h = Object.prototype.hasOwnProperty.call(H, cmd.action) ? H[cmd.action] : rkBaseHandleCommand;
  return rkDispatch(cmd, h);
}

connect();
