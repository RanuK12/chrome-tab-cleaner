// Ranukita Bridge — helpers de depuración (v0.3.0).
// Funciones PURAS (sin chrome.*) salvo rkGuardInPage, que se serializa dentro de la página
// (chrome.scripting.executeScript) y por eso es AUTOCONTENIDA. Se prueba en node: tests/rk_debug.test.js.
// Sin anti-detección, sin huellas, sin resolver captchas: ante un captcha/desafío/aviso, se frena.

const RK_LOG_CAPACITY = 1000;
const RK_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// ---------- redacción / sanitizado (los logs nunca deben llevar secretos) ----------
function rkRedact(s, max) {
  let t = String(s === undefined || s === null ? "" : s);
  t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 [REDACTED]");
  t = t.replace(/\b(auth_token|ct0|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|passw(?:or)?d|session(?:id)?|sid)(["']?\s*[:=]\s*["']?)[^\s"'&;,]{4,}/gi, "$1$2[REDACTED]");
  t = t.replace(/\b(sk|pk|gh[pousr]|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g, "[REDACTED]");
  t = t.replace(/\b[A-Za-z0-9_+\/=-]{48,}\b/g, "[REDACTED_LONG]");
  const lim = max || 500;
  return t.length > lim ? t.slice(0, lim) + "…" : t;
}

// Quita query y hash (pueden llevar tokens). Deja origen + path.
function rkSanitizeUrl(u) {
  const s = String(u || "");
  if (!s) return "";
  try {
    const x = new URL(s);
    if (/^(https?|wss?|ftp):$/.test(x.protocol)) return x.origin + x.pathname;
    return x.protocol + "[omitido]"; // data:/blob:/etc. pueden contener datos
  } catch (e) {
    return rkRedact(s.split(/[?#]/)[0], 200);
  }
}

function rkOriginPattern(url) {
  try {
    const x = new URL(String(url));
    if (x.protocol === "http:" || x.protocol === "https:") return x.protocol + "//" + x.hostname + "/*";
  } catch (e) {}
  return null;
}

// Páginas donde NINGUNA extensión puede inyectar scripts.
function rkIsRestrictedUrl(url) {
  const s = String(url || "");
  if (!s) return false;
  if (/^(chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|edge|about|view-source|chrome-error):/i.test(s)) return true;
  try {
    const x = new URL(s);
    if (x.hostname === "chromewebstore.google.com" || (x.hostname === "chrome.google.com" && x.pathname.startsWith("/webstore"))) return true;
  } catch (e) {}
  return false;
}

// ---------- ring buffer ----------
class RkRing {
  constructor(cap) { this.cap = cap || RK_LOG_CAPACITY; this.buf = []; this.seq = 0; this.dropped = 0; }
  push(entry) {
    const now = Date.now();
    const e = Object.assign({ seq: ++this.seq, ts: now, iso: new Date(now).toISOString(), level: "info" }, entry);
    this.buf.push(e);
    if (this.buf.length > this.cap) { const n = this.buf.length - this.cap; this.buf.splice(0, n); this.dropped += n; }
    return e;
  }
  _match(e, f) {
    if (f.kind && e.kind !== f.kind && !(Array.isArray(f.kind) && f.kind.includes(e.kind))) return false;
    if (f.tabId !== undefined && f.tabId !== null && f.tabId !== "" && e.tabId !== Number(f.tabId)) return false;
    if (f.minLevel && (RK_LEVELS[e.level] || 0) < (RK_LEVELS[f.minLevel] || 0)) return false;
    if (f.sinceSeq !== undefined && f.sinceSeq !== null && e.seq <= Number(f.sinceSeq)) return false;
    if (f.contains && !String(e.msg || "").toLowerCase().includes(String(f.contains).toLowerCase())) return false;
    return true;
  }
  read(f) {
    f = f || {};
    const limit = Math.max(1, Math.min(RK_LOG_CAPACITY, Number(f.limit) || 200));
    const all = this.buf.filter((e) => this._match(e, f));
    return all.slice(-limit);
  }
  clear(f) {
    f = f || {};
    const before = this.buf.length;
    if (!f.kind && (f.tabId === undefined || f.tabId === null || f.tabId === "")) this.buf = [];
    else this.buf = this.buf.filter((e) => !this._match(e, f));
    return before - this.buf.length;
  }
  stats() {
    const byKind = {};
    for (const e of this.buf) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    return { size: this.buf.length, capacity: this.cap, lastSeq: this.seq, dropped: this.dropped, byKind };
  }
  dump(n) { return this.buf.slice(-(n || 300)); }
  load(entries) {
    if (!Array.isArray(entries)) return;
    for (const e of entries) { if (e && typeof e === "object") { this.buf.push(e); if (e.seq > this.seq) this.seq = e.seq; } }
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
  }
}

// ---------- errores de scripting / permisos ----------
// Devuelve null o {status, error, hint, hint_en}
function rkClassifyScriptError(err) {
  const msg = String(err && err.message ? err.message : err || "");
  if (!msg) return null;
  if (/Cannot access contents of (the page|url)|Extension manifest must request permission to access (this host|the respective host)|permission to access/i.test(msg)) {
    // "Cannot access contents of url chrome-error://" = página de error de red: igual cae acá, con hint.
    return {
      status: "no_site_access",
      hint: "La extensión no tiene acceso al sitio. En chrome://extensions → 'Ranukita Bridge' → Detalles → 'Acceso al sitio' = 'En todos los sitios'; después recargá SOLO esa pestaña.",
      hint_en: "The extension has no access to this site. Go to chrome://extensions → 'Ranukita Bridge' → Details → Site access = 'On all sites', then reload only that tab.",
    };
  }
  if (/Cannot access a (chrome|chrome-extension|devtools|edge):|cannot be scripted|extensions gallery|chrome-error:|The tab was closed in a restricted/i.test(msg)) {
    return { status: "restricted_page", hint: "Página restringida de Chrome: ninguna extensión puede leerla.", hint_en: "Restricted Chrome page: no extension can script it." };
  }
  if (/No tab with id|Invalid tab ID/i.test(msg)) return { status: "no_tab", hint: "La pestaña no existe (¿se cerró?).", hint_en: "The tab no longer exists." };
  if (/Frame with ID \d+ (was removed|is showing error page)|No frame with id|The frame was removed|Frame was detached/i.test(msg)) {
    return { status: "frame_gone", hint: "La página navegó o se cerró durante la acción; reintentá tras wait_idle.", hint_en: "The page navigated or closed mid-action; retry after wait_idle." };
  }
  if (/Tabs cannot be edited right now/i.test(msg)) return { status: "tab_busy", hint: "Chrome está arrastrando una pestaña; reintentá.", hint_en: "Chrome is busy dragging a tab; retry." };
  if (/Another debugger is already attached|Debugger is not attached|Cannot attach to this target|Cannot access a chrome/i.test(msg)) {
    return { status: "debugger_error", hint: "Otro depurador (DevTools) está conectado a esa pestaña, o no se puede adjuntar.", hint_en: "Another debugger (DevTools) holds this tab, or attach is not possible." };
  }
  return null;
}

// ---------- guard de captcha / desafío / aviso ----------
const RK_CAPTCHA_RE = /captcha|arkose|funcaptcha|turnstile|are you (a )?(human|robot)|verify (that )?you.?re (a )?(human|not a robot)|i.?m not a robot|no soy un robot|eres (un )?(humano|robot)|prueba que eres|verifica que eres (un )?humano|security check|verificaci[oó]n de seguridad/i;
const RK_CHALLENGE_RE = /just a moment|un momento\.\.\.|checking (if the site connection is secure|your browser)|verificando (que eres|tu navegador)|unusual traffic|tr[aá]fico inusual|attention required|press (&|and) hold|mant[eé]n (presionado|pulsado)|ddos protection by|access denied|acceso denegado/i;
const RK_WARNING_RE = /rate limit|limit exceeded|too many (requests|follows|unfollows|attempts)|demasiad[oa]s (solicitudes|acciones|intentos)|l[ií]mite de (frecuencia|tasa|solicitudes)|(follow|unfollow)(ing)? limit|daily limit|unusual activity|suspicious|temporarily (restricted|locked|limited)|account (is )?(locked|restricted|suspended)|actividad (inusual|sospechosa)|cuenta (bloqueada|restringida|suspendida)|verify (your|it.?s you)|verifica (tu|que)|try again later|int[eé]ntalo de nuevo m[aá]s tarde|intenta(lo)? m[aá]s tarde/i;

function rkClassifyText(text, opts) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (RK_CAPTCHA_RE.test(s)) return "captcha";
  if (RK_CHALLENGE_RE.test(s)) return "challenge";
  if (!(opts && opts.noWarning) && RK_WARNING_RE.test(s)) return "warning";
  return null;
}

function rkClassifyUrlGuard(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return null; }
  const p = u.pathname.toLowerCase();
  if (/^\/cdn-cgi\/(challenge-platform|l\/chk_captcha)/.test(p)) return "challenge";
  if (/^\/(sorry\/index|captcha|recaptcha|challenge)(\/|$)/.test(p) && !/\.(png|jpg|css|js)$/.test(p)) return "captcha";
  if (/^\/account\/(access|login_challenge|locked|suspended)/.test(p)) return "warning";
  if (/^\/i\/(flow\/(?!login)|verify)/.test(p) && /(^|\.)(x|twitter)\.com$/.test(u.hostname.replace(/^www\./, ""))) return "challenge";
  if (/(^|\.)(hcaptcha\.com|captcha-delivery\.com|arkoselabs\.com|funcaptcha\.com)$/.test(u.hostname)) return "captcha";
  return null;
}

// Se ejecuta DENTRO de la página. AUTOCONTENIDA. Solo lee; no toca nada.
function rkGuardInPage() {
  const out = { title: String(document.title || "").slice(0, 200), domSignals: [], alertTexts: [], bodyText: "", bodyLen: 0 };
  const inViewFull = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) return false;
    if (r.width < 30 || r.height < 30) return false;
    // El badge flotante de reCAPTCHA v3 asoma recortado por la derecha; no es un desafío.
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 || (r.width > 280 && r.height > 280);
  };
  const add = (kind, ev) => { if (out.domSignals.length < 6) out.domSignals.push({ kind, evidence: String(ev).slice(0, 120) }); };
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    const src = String(f.getAttribute("src") || f.src || "");
    if (!src) continue;
    let kind = null;
    if (/recaptcha\/(api2|enterprise)\/bframe/i.test(src)) kind = "captcha";
    else if (/recaptcha\/(api2|enterprise)\/anchor/i.test(src)) kind = "captcha";
    else if (/hcaptcha\.com/i.test(src)) kind = "captcha";
    else if (/challenges\.cloudflare\.com|turnstile/i.test(src)) kind = "captcha";
    else if (/arkoselabs|funcaptcha/i.test(src)) kind = "captcha";
    else if (/captcha-delivery\.com|datadome/i.test(src)) kind = "captcha";
    else if (/captcha/i.test(src)) kind = "captcha";
    if (kind && inViewFull(f)) add(kind, "iframe " + src.split("?")[0]);
  }
  const sel = ["#cf-challenge-running", "#challenge-running", "#challenge-stage", "form#challenge-form", ".cf-turnstile", ".g-recaptcha", ".h-captcha", "#arkose", "[data-sitekey]"];
  for (const s of sel) {
    const el = document.querySelector(s);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) add(/challenge/.test(s) ? "challenge" : "captcha", "selector " + s);
    }
  }
  const txt = (e) => ((e && (e.innerText || e.textContent)) || "").replace(/\s+/g, " ").trim().slice(0, 400);
  for (const a of Array.from(document.querySelectorAll('[role="alert"],[role="alertdialog"],[role="dialog"],[data-testid="toast"]'))) {
    const t = txt(a);
    if (t && out.alertTexts.length < 8) out.alertTexts.push(t);
  }
  const body = document.body ? document.body.innerText || "" : "";
  out.bodyLen = body.length;
  // Las páginas de desafío son cortas: solo analizamos el texto del body si es corto.
  if (body.length < 1200) out.bodyText = body.replace(/\s+/g, " ").trim().slice(0, 1200);
  return out;
}

// Decisión pura sobre url + snapshot de rkGuardInPage.
function rkDecideGuard(url, snap) {
  const u = rkClassifyUrlGuard(url);
  if (u) return { flagged: true, kind: u, source: "url", evidence: [rkSanitizeUrl(url)] };
  if (snap) {
    if (snap.domSignals && snap.domSignals.length) {
      const s = snap.domSignals[0];
      return { flagged: true, kind: s.kind, source: "dom", evidence: snap.domSignals.map((d) => d.evidence) };
    }
    const tk = rkClassifyText(snap.title, { noWarning: true });
    if (tk) return { flagged: true, kind: tk, source: "title", evidence: [String(snap.title).slice(0, 120)] };
    for (const t of snap.alertTexts || []) {
      const k = rkClassifyText(t);
      if (k) return { flagged: true, kind: k, source: "alert", evidence: [rkRedact(t, 140)] };
    }
    const bk = snap.bodyText ? rkClassifyText(snap.bodyText) : null;
    if (bk) return { flagged: true, kind: bk, source: "body", evidence: [rkRedact(snap.bodyText, 140)] };
  }
  return { flagged: false, kind: null, source: null, evidence: [] };
}

// ---------- consola / CDP ----------
function rkRemoteObjectToString(o) {
  if (!o || typeof o !== "object") return String(o);
  if (o.value !== undefined) return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
  if (o.unserializableValue) return String(o.unserializableValue);
  if (o.description) return String(o.description);
  return "[" + (o.type || "object") + "]";
}

// Convierte un evento CDP en una entrada de log, o null si no interesa.
function rkFormatCdpEvent(method, p) {
  p = p || {};
  if (method === "Runtime.consoleAPICalled") {
    const lvl = { error: "error", assert: "error", warning: "warn", debug: "debug", trace: "debug" }[p.type] || "info";
    const msg = (p.args || []).map(rkRemoteObjectToString).join(" ");
    const f = p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0];
    return { kind: "console", level: lvl, msg: rkRedact(msg, 500), data: { type: p.type, src: f ? rkSanitizeUrl(f.url) + ":" + f.lineNumber : undefined } };
  }
  if (method === "Runtime.exceptionThrown") {
    const d = p.exceptionDetails || {};
    const msg = (d.exception && d.exception.description) || d.text || "exception";
    return { kind: "console", level: "error", msg: rkRedact(msg, 600), data: { type: "exception", src: d.url ? rkSanitizeUrl(d.url) + ":" + d.lineNumber : undefined } };
  }
  if (method === "Log.entryAdded") {
    const e = p.entry || {};
    const lvl = { error: "error", warning: "warn", verbose: "debug" }[e.level] || "info";
    return { kind: "console", level: lvl, msg: rkRedact(e.text || "", 500), data: { type: "log", source: e.source, src: e.url ? rkSanitizeUrl(e.url) : undefined } };
  }
  if (method === "Network.loadingFailed") {
    return { kind: "net", level: "error", msg: rkRedact((p.errorText || "loadingFailed") + (p.blockedReason ? " blocked:" + p.blockedReason : ""), 300), data: { via: "cdp", requestId: p.requestId, type: p.type, canceled: !!p.canceled } };
  }
  if (method === "Network.responseReceived") {
    const r = p.response || {};
    if (Number(r.status) >= 400) return { kind: "net", level: Number(r.status) >= 500 ? "error" : "warn", msg: "HTTP " + r.status + " " + rkSanitizeUrl(r.url), data: { via: "cdp", status: r.status, type: p.type } };
  }
  return null;
}

// ---------- webRequest ----------
function rkFormatWebRequestError(d) {
  return { kind: "net", level: "error", tabId: d.tabId, msg: rkRedact((d.error || "error") + " " + (d.method || "") + " " + rkSanitizeUrl(d.url), 400), data: { via: "webRequest", error: d.error, method: d.method, type: d.type, url: rkSanitizeUrl(d.url), initiator: d.initiator ? rkSanitizeUrl(d.initiator) : undefined } };
}
function rkFormatWebRequestCompleted(d) {
  if (!(Number(d.statusCode) >= 400)) return null;
  return { kind: "net", level: Number(d.statusCode) >= 500 ? "error" : "warn", tabId: d.tabId, msg: "HTTP " + d.statusCode + " " + (d.method || "") + " " + rkSanitizeUrl(d.url), data: { via: "webRequest", status: d.statusCode, method: d.method, type: d.type, url: rkSanitizeUrl(d.url), fromCache: !!d.fromCache } };
}
function rkIgnoreRequest(d) {
  if (!d || d.tabId === undefined || d.tabId < 0) return true; // requests de la propia extensión / service workers
  const u = String(d.url || "");
  if (/^wss?:\/\/127\.0\.0\.1:922\d\//.test(u)) return true;
  return false;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RK_LOG_CAPACITY, RK_LEVELS, RkRing,
    rkRedact, rkSanitizeUrl, rkOriginPattern, rkIsRestrictedUrl,
    rkClassifyScriptError, rkClassifyText, rkClassifyUrlGuard, rkGuardInPage, rkDecideGuard,
    rkFormatCdpEvent, rkFormatWebRequestError, rkFormatWebRequestCompleted, rkIgnoreRequest,
  };
}
