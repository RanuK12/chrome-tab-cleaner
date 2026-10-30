// Ranukita X Bridge — núcleo del unfollow (v2.4.0).
// Funciones puras + `xSnapshotInPage`, que se serializa tal cual dentro de la página
// (chrome.scripting.executeScript) y por eso debe ser AUTOCONTENIDA (no usa nada de afuera).
// Se prueba en node con jsdom: tests/core.test.js.

const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const X_ID_RE = /^[0-9]{5,25}$/;

function normalizeHandle(h) {
  const s = String(h || "").trim().replace(/^@/, "");
  return X_HANDLE_RE.test(s) ? s : null;
}

// Devuelve un código si la URL es una pantalla de desafío / login / cuenta bloqueada.
function classifyUrl(url) {
  let path = "";
  try {
    const u = new URL(String(url));
    path = u.pathname.toLowerCase();
  } catch (e) {
    return null;
  }
  if (/^\/(i\/flow\/login|login|logout)(\/|$)/.test(path)) return "logged_out";
  if (/^\/account\/(access|login_challenge|locked|suspended)/.test(path)) return "challenge_url";
  if (/^\/i\/(flow|verify)/.test(path)) return "challenge_url";
  return null;
}

// Clasifica texto de toast / alerta / diálogo (EN + ES). Orden = prioridad.
const WARN_PATTERNS = [
  ["captcha", /captcha|arkose|are you (a )?(human|robot)|eres (un )?(humano|robot)|confirm(a)? (that )?you.?re (a )?human|prueba que eres/i],
  ["rate_limit", /rate limit|limit exceeded|too many (requests|follows|unfollows)|l[ií]mite de (frecuencia|tasa|solicitudes)|demasiadas (solicitudes|acciones)|exceed/i],
  ["follow_limit", /(follow|unfollow)(ing)? limit|daily limit|you.?ve reached|alcanzaste el l[ií]mite|l[ií]mite (diario|de seguimientos)|unable to (follow|unfollow)|no (se )?pudo(?:ste)? (seguir|dejar)/i],
  ["account_restricted", /unusual activity|suspicious|temporarily (restricted|locked|limited)|account (is )?(locked|restricted|suspended)|actividad (inusual|sospechosa)|temporalmente|cuenta (bloqueada|restringida|suspendida)|verify (your|it.?s you)|verifica (tu|que)/i],
  ["try_again", /try again (later|in a few)|int[eé]ntalo de nuevo|intenta(lo)? (de nuevo|m[aá]s tarde)|vuelve a intentarlo/i],
  ["something_wrong", /something went wrong|algo sali[oó] mal|algo ha salido mal|se (ha )?produjo un error|error al cargar/i],
];

function classifyWarningText(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  for (const [code, re] of WARN_PATTERNS) if (re.test(s)) return code;
  return null;
}

// Decide qué hacer con un snapshot ANTES de clickear. Pura -> testeable.
// snap: salida de xSnapshotInPage. want: {userId, handle, expectUser}
function decidePre(snap, want) {
  if (!snap) return { stop: true, status: "error", detail: "sin snapshot" };
  if (snap.warning) return { stop: true, status: "warning", code: snap.warning, detail: snap.warningText };
  if (snap.loggedAs && want.expectUser &&
      snap.loggedAs.toLowerCase() !== want.expectUser.toLowerCase()) {
    return { stop: true, status: "wrong_account", detail: `sesión=@${snap.loggedAs} esperada=@${want.expectUser}` };
  }
  if (!snap.loggedAs) return { stop: true, status: "wrong_account", detail: "no pude leer la cuenta logueada" };
  if (snap.accountMissing) return { stop: false, status: "account_missing" };
  if (snap.followBtn && !snap.unfollowBtn) return { stop: false, status: "already_not_following" };
  if (!snap.unfollowBtn) {
    return { stop: false, status: snap.otherFollowBtns ? "id_mismatch" : "target_not_found" };
  }
  if (snap.unfollowBtn.aria && want.handle &&
      !snap.unfollowBtn.aria.toLowerCase().includes("@" + want.handle.toLowerCase())) {
    return { stop: false, status: "id_mismatch", detail: snap.unfollowBtn.aria };
  }
  if (!snap.unfollowBtn.hit) return { stop: true, status: "button_covered" };
  return { stop: false, status: "ok_to_click" };
}

// Snapshot DOM. SE SERIALIZA: no referenciar nada externo. Devuelve JSON plano.
// opts: {userId, measure: 'unfollow'|'confirm'|null}
function xSnapshotInPage(opts) {
  const out = {
    url: location.href, loggedAs: null, profileLoaded: false, accountMissing: false,
    followBtn: false, unfollowBtn: null, otherFollowBtns: false, confirm: null,
    warning: null, warningText: null, toastCount: 0,
  };
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (e) => (e && (e.innerText || e.textContent) || "").replace(/\s+/g, " ").trim();

  // Cuenta logueada: link del perfil en la barra lateral.
  const me = q('[data-testid="AppTabBar_Profile_Link"]');
  if (me) {
    const href = (me.getAttribute("href") || "").replace(/^\//, "").split(/[/?#]/)[0];
    out.loggedAs = href || null;
  }

  // Avisos. Solo texto de toast / alerta / diálogo (nunca la bio ni el timeline).
  const WP = [
    ["captcha", /captcha|arkose|are you (a )?(human|robot)|eres (un )?(humano|robot)|confirm(a)? (that )?you.?re (a )?human|prueba que eres/i],
    ["rate_limit", /rate limit|limit exceeded|too many (requests|follows|unfollows)|l[ií]mite de (frecuencia|tasa|solicitudes)|demasiadas (solicitudes|acciones)|exceed/i],
    ["follow_limit", /(follow|unfollow)(ing)? limit|daily limit|you.?ve reached|alcanzaste el l[ií]mite|l[ií]mite (diario|de seguimientos)|unable to (follow|unfollow)|no (se )?pudo(?:ste)? (seguir|dejar)/i],
    ["account_restricted", /unusual activity|suspicious|temporarily (restricted|locked|limited)|account (is )?(locked|restricted|suspended)|actividad (inusual|sospechosa)|temporalmente|cuenta (bloqueada|restringida|suspendida)|verify (your|it.?s you)|verifica (tu|que)/i],
    ["try_again", /try again (later|in a few)|int[eé]ntalo de nuevo|intenta(lo)? (de nuevo|m[aá]s tarde)|vuelve a intentarlo/i],
    ["something_wrong", /something went wrong|algo sali[oó] mal|algo ha salido mal|se (ha )?produjo un error|error al cargar/i],
  ];
  const classify = (s) => { for (const p of WP) if (p[1].test(s)) return p[0]; return null; };
  const warn = (code, text) => { if (!out.warning) { out.warning = code; out.warningText = String(text || "").slice(0, 160); } };

  const toasts = qa('[data-testid="toast"]');
  out.toastCount = toasts.length;
  for (const t of toasts) warn(classify(txt(t)) || "toast", txt(t)); // CUALQUIER toast corta
  for (const a of qa('[role="alert"]')) {
    const s = txt(a);
    if (s && !a.closest('[data-testid="toast"]')) { const c = classify(s); if (c) warn(c, s); }
  }
  for (const d of qa('[role="dialog"],[role="alertdialog"]')) {
    if (d.querySelector('[data-testid="confirmationSheetConfirm"]')) continue; // el nuestro
    const s = txt(d); const c = classify(s);
    if (c) warn(c, s);
    else if (d.getAttribute("role") === "alertdialog" && s) warn("unexpected_dialog", s);
  }
  const ed = q('[data-testid="error-detail"]');
  if (ed) warn(classify(txt(ed)) || "something_wrong", txt(ed));
  if (q('iframe[src*="arkoselabs"],iframe[src*="recaptcha"],iframe[src*="captcha"],#arkose,[data-testid="ocfEnterTextTextInput"]')) warn("captcha", "iframe/captcha");

  // Cuenta inexistente / suspendida (solo dentro del empty state).
  const es = q('[data-testid="emptyState"]');
  if (es && /doesn.?t exist|no existe|account suspended|cuenta suspendida|esta cuenta est[aá] suspendida/i.test(txt(es))) {
    out.accountMissing = true;
  }

  const id = String((opts && opts.userId) || "");
  const sel = (k) => '[data-testid="' + id + "-" + k + '"]';
  const centerOf = (el, scroll) => {
    if (scroll && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const inView = r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
    const top = inView ? document.elementFromPoint(x, y) : null;
    return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height),
             hit: !!(top && (top === el || el.contains(top))) };
  };
  if (id) {
    const unf = q(sel("unfollow")), fol = q(sel("follow"));
    out.followBtn = !!fol;
    if (unf) {
      const c = centerOf(unf, opts && opts.measure === "unfollow");
      c.aria = unf.getAttribute("aria-label") || "";
      out.unfollowBtn = c;
    }
    out.otherFollowBtns = !unf && !fol && qa('[data-testid$="-follow"],[data-testid$="-unfollow"]').length > 0;
  }
  const conf = q('[data-testid="confirmationSheetConfirm"]');
  if (conf) out.confirm = centerOf(conf, opts && opts.measure === "confirm");
  out.profileLoaded = !!(out.loggedAs && (out.unfollowBtn || out.followBtn || out.accountMissing || out.otherFollowBtns || q('[data-testid="UserName"]') || q('[data-testid="primaryColumn"] [data-testid="UserDescription"]')));
  return out;
}


// Un unfollow completo y verificado. `env` abstrae chrome.* (así se prueba con un simulador):
//   env.tabUrl() -> url actual de la pestaña | env.navigate(url) | env.waitLoaded(ms)
//   env.snapshot({userId, measure}) -> xSnapshotInPage | env.click(x, y) -> clic CDP de confianza
//   env.sleep(ms) | env.rand(lo, hi) | env.now()
// m: {handle, userId, expectUser, dry}
async function runUnfollowStep(env, m) {
  const t0 = env.now();
  const res = (status, extra) => Object.assign({ ok: status === "unfollowed" || status === "already_not_following" || status === "account_missing" || status === "dry_would_unfollow", status, handle: m.handle, userId: m.userId, ms: env.now() - t0 }, extra || {});
  const handle = normalizeHandle(m.handle);
  if (!handle) return res("bad_input", { stop: true, detail: "handle inválido" });
  if (!X_ID_RE.test(String(m.userId || ""))) return res("bad_input", { stop: true, detail: "userId inválido" });
  if (!m.expectUser || !X_HANDLE_RE.test(String(m.expectUser))) return res("bad_input", { stop: true, detail: "falta expectUser" });
  const want = { userId: String(m.userId), handle, expectUser: String(m.expectUser) };

  const cur = env.tabUrl();
  const curCode = classifyUrl(cur);
  if (curCode) return res("warning", { stop: true, code: curCode, detail: cur });
  await env.navigate("https://x.com/" + handle);
  await env.waitLoaded(20000);

  // Esperar a que cargue el perfil (o aparezca un aviso / cuenta inexistente).
  let snap = null;
  const deadline = env.now() + 18000;
  while (env.now() < deadline) {
    snap = await env.snapshot({ userId: want.userId, measure: null });
    const uc = classifyUrl(snap && snap.url);
    if (uc) return res("warning", { stop: true, code: uc, detail: snap.url });
    if (snap && (snap.warning || snap.profileLoaded)) break;
    await env.sleep(400);
  }
  if (!snap || (!snap.warning && !snap.profileLoaded)) return res("profile_timeout", { stop: true });
  snap = await env.snapshot({ userId: want.userId, measure: "unfollow" }); // scroll + coords
  const d0 = decidePre(snap, want);
  if (d0.status !== "ok_to_click") {
    const pre = res(d0.status, { stop: !!d0.stop, code: d0.code, detail: d0.detail });
    if (d0.status === "already_not_following" || d0.status === "account_missing") pre.stop = false;
    return pre;
  }
  if (m.dry) return res("dry_would_unfollow", { aria: snap.unfollowBtn.aria });

  // Clic 1: "Siguiendo" -> hoja de confirmación.
  await env.sleep(env.rand(600, 1800));
  const jx = Math.round((env.rand(-20, 20) / 100) * snap.unfollowBtn.w);
  await env.click(snap.unfollowBtn.x + jx, snap.unfollowBtn.y);
  let conf = null, s1 = null;
  for (let i = 0; i < 30; i++) { // ~6 s
    await env.sleep(200);
    s1 = await env.snapshot({ userId: want.userId, measure: "confirm" });
    if (s1.warning) return res("warning", { stop: true, code: s1.warning, detail: s1.warningText, clicked: "unfollow" });
    if (s1.confirm) { conf = s1.confirm; break; }
  }
  if (!conf) return res("confirm_not_shown", { stop: true });
  if (!conf.hit) return res("button_covered", { stop: true, detail: "confirmar tapado" });

  // Clic 2: confirmar.
  await env.sleep(env.rand(500, 1300));
  await env.click(conf.x + Math.round((env.rand(-20, 20) / 100) * conf.w), conf.y);

  // Verificar: aparece `<id>-follow` y desaparece `<id>-unfollow`.
  let fin = null, flipped = false;
  const vEnd = env.now() + 9000;
  while (env.now() < vEnd) {
    await env.sleep(350);
    fin = await env.snapshot({ userId: want.userId, measure: null });
    if (fin.followBtn && !fin.unfollowBtn) { flipped = true; break; }
    if (fin.warning) break;
  }
  if (flipped) { await env.sleep(1200); fin = await env.snapshot({ userId: want.userId, measure: null }); } // toast tardío
  if (flipped && !fin.warning) return res("unfollowed", { verified: true });
  if (fin && fin.warning) return res(flipped ? "unfollowed_with_warning" : "warning", { stop: true, code: fin.warning, detail: fin.warningText, verified: flipped });
  return res("not_flipped", { stop: true });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { normalizeHandle, classifyUrl, classifyWarningText, decidePre, xSnapshotInPage, runUnfollowStep, X_HANDLE_RE, X_ID_RE };
}
