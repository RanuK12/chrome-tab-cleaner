// Carga el background.js REAL (base Mac mini 0.2.4 + depuración 0.3.0) en un contexto vm con `chrome` simulado. Sin Chrome, sin red.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");

function boot(state) {
  const listeners = {};
  const L = (name) => ({ addListener: (f) => { (listeners[name] = listeners[name] || []).push(f); }, removeListener() {} });
  const calls = [];
  const tabs = state.tabs;
  const chrome = {
    alarms: { create() {}, onAlarm: L("alarm") },
    runtime: { reload() {}, onStartup: L("startup"), onInstalled: L("installed") },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: {
      onActivated: L("tabs.activated"), onUpdated: L("tabs.updated"), onRemoved: L("tabs.removed"),
      get: async (id) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("No tab with id: " + id); return Object.assign({}, t); },
      query: async (q) => (q && q.active ? tabs.filter((t) => t.active) : tabs.slice()).map((t) => Object.assign({}, t)),
      reload: async (id) => { calls.push(["tabs.reload", id]); const t = tabs.find((x) => x.id === id); t.discarded = false; t.status = "complete"; },
      update: async (id, p) => { calls.push(["tabs.update", id, p]); return { id }; },
      create: async () => ({ id: 99, windowId: 1 }),
      remove: async () => {},
    },
    cookies: { get: async () => null },
    permissions: {
      contains: async ({ origins }) => state.granted.includes(origins[0]),
      request: async () => { throw new Error("This function must be called during a user gesture"); },
    },
    scripting: {
      executeScript: async ({ target, func }) => {
        calls.push(["exec", target.tabId, func && func.name]);
        if (state.scriptError) throw new Error(state.scriptError);
        if (func && func.name === "rkGuardInPage") return [{ result: state.guardSnap }];
        return [{ result: state.pageResult === undefined ? true : state.pageResult }];
      },
    },
    debugger: {
      onEvent: L("dbg.event"), onDetach: L("dbg.detach"),
      attach: async (t) => { calls.push(["dbg.attach", t.tabId]); },
      detach: async (t) => { calls.push(["dbg.detach", t.tabId]); },
      sendCommand: async (t, cmd) => { calls.push(["dbg.cmd", t.tabId, cmd]); return {}; },
    },
    webRequest: { onErrorOccurred: L("wr.err"), onCompleted: L("wr.done") },
  };
  const ctx = vm.createContext({
    chrome, console, setTimeout, clearTimeout, setInterval: () => 0, URL, Date, JSON, Promise, Math, Map, Set, Error, String, Number, Array, Object, RegExp,
    WebSocket: class { constructor() { this.readyState = 0; } send() {} },
  });
  ctx.WebSocket.OPEN = 1; ctx.WebSocket.CONNECTING = 0;
  ctx.importScripts = (...fs_) => fs_.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f }));
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  const api = vm.runInContext("({ H, handleCommand, RK_LOG, RK_CONSOLE_TABS, RK_VERSION, RK_CAPS })", ctx);
  const run = (m) => api.handleCommand(m);
  const fireDbg = (...a) => (listeners["dbg.event"] || []).forEach((f) => f(...a));
  return { api, run, calls, listeners, tabs, state, fireDbg };
}
const mk = (over) => Object.assign({ id: 1, windowId: 1, url: "https://example.com/page?q=1", title: "Ex", status: "complete", discarded: false, active: false }, over);
const clearSnap = { title: "Ex", domSignals: [], alertTexts: [], bodyText: "", bodyLen: 5000 };

test("compat: ping/list_tabs/unknown mantienen forma y suman campos", async () => {
  const b = boot({ tabs: [mk({ id: 1, active: true }), mk({ id: 2, discarded: true })], granted: [], guardSnap: clearSnap });
  const p = await b.run({ action: "ping" });
  assert.strictEqual(p.pong, true); assert.strictEqual(p.ok, true);
  assert.strictEqual(p.version, "0.3.0"); assert.ok(p.caps.includes("console_start") && p.caps.includes("captcha_guard"));
  const l = await b.run({ action: "list_tabs" });
  assert.strictEqual(JSON.stringify(Object.keys(l.tabs[0]).slice(0, 4)), JSON.stringify(["id", "url", "title", "active"]));
  assert.strictEqual(l.tabs[1].discarded, true); assert.strictEqual(l.tabs[0].status, "complete");
  const u = await b.run({ action: "nope_xyz" });
  assert.strictEqual(u.ok, false); assert.ok(/unknown action: nope_xyz/.test(u.error));
  assert.ok(!("x_unfollow_step" in b.api.H));
});

test("tabs_info: url,title,status,discarded,active + siteAccess", async () => {
  const b = boot({ tabs: [mk({ id: 1, active: true }), mk({ id: 2, url: "chrome://extensions", discarded: true })], granted: ["https://example.com/*"], guardSnap: clearSnap });
  const r = await b.run({ action: "tabs_info" });
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.tabs[0].siteAccess, true); assert.strictEqual(r.tabs[1].restricted, true);
  const d = await b.run({ action: "tabs_info", discardedOnly: true });
  assert.strictEqual(JSON.stringify(d.tabs.map((t) => t.id)), "[2]");
});

test("tabId inexistente: no_tab, sin caer en la pestaña activa", async () => {
  const b = boot({ tabs: [mk({ id: 1, active: true })], granted: [], guardSnap: clearSnap });
  for (const a of ["click", "inspect", "read_text", "cdp_click", "navigate"]) {
    const r = await b.run({ action: a, tabId: 77, selector: "#x", url: "https://a.com", x: 1, y: 1 });
    assert.strictEqual(r.ok, false, a); assert.strictEqual(r.status, "no_tab", a);
  }
  assert.ok(!b.calls.some((c) => c[0] === "exec" || c[0] === "tabs.update"));
});

test("pestaña descartada: se informa; reloadIfDiscarded recarga SOLO esa", async () => {
  const b = boot({ tabs: [mk({ id: 1, active: true }), mk({ id: 2, discarded: true, status: "unloaded" })], granted: [], guardSnap: clearSnap, pageResult: { ok: true } });
  const r = await b.run({ action: "inspect", tabId: 2, selector: "a" });
  assert.strictEqual(r.status, "tab_discarded"); assert.ok(/reloadIfDiscarded/.test(r.hint));
  assert.ok(!b.calls.some((c) => c[0] === "tabs.reload"));
  const r2 = await b.run({ action: "inspect", tabId: 2, selector: "a", reloadIfDiscarded: true });
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(b.calls.filter((c) => c[0] === "tabs.reload"), [["tabs.reload", 2]]);
  const r3 = await b.run({ action: "tab_reload_discarded", tabId: 1 });
  assert.strictEqual(r3.status, "not_discarded");
  assert.strictEqual(b.calls.filter((c) => c[0] === "tabs.reload").length, 1);
});

test("'Cannot access contents of the page' -> no_site_access con hint y estado del permiso (lectura y escritura)", async () => {
  const b = boot({ tabs: [mk({ id: 5 })], granted: [], guardSnap: clearSnap, scriptError: "Cannot access contents of the page. Extension manifest must request permission to access the respective host." });
  for (const a of ["inspect", "click"]) {
    const r = await b.run({ action: a, tabId: 5, selector: "a" });
    assert.strictEqual(r.ok, false, a); assert.strictEqual(r.status, "no_site_access", a);
    assert.strictEqual(r.permissionGranted, false); assert.ok(/En todos los sitios/.test(r.hint) && /On all sites/.test(r.hint_en));
    assert.ok(/Ranukita Bridge/.test(r.hint));
    assert.strictEqual(r.url, "https://example.com/page"); // sin query
    assert.ok(/Cannot access contents/.test(r.error), "el error original se conserva");
  }
  const r2 = await b.run({ action: "inspect", tabId: 5, selector: "a", requestAccess: true });
  assert.ok(String(r2.requestResult).startsWith("error:"));
  const s = await b.run({ action: "site_access", tabId: 5, request: true });
  assert.strictEqual(s.probe, "no_site_access"); assert.strictEqual(s.requested, true); assert.ok(s.hint);
});

test("guard captcha_or_warning frena acciones que actúan, no las de lectura", async () => {
  const snap = { title: "Ex", domSignals: [{ kind: "captcha", evidence: "iframe https://www.google.com/recaptcha/api2/bframe" }], alertTexts: [], bodyText: "" };
  const b = boot({ tabs: [mk({ id: 3, active: true })], granted: [], guardSnap: snap, pageResult: { ok: true } });
  const acts = [{ action: "click", selector: "#b" }, { action: "fill", selector: "#i", value: "x" }, { action: "cdp_click", x: 1, y: 2 }, { action: "cdp_type", text: "hola" }, { action: "cdp_key", key: "Enter" }, { action: "upload", files: ["/a"], selector: "#f" }, { action: "click_text", text: "ok" }, { action: "tclick_text", text: "ok" }, { action: "survey_click_start" }];
  for (const m of acts) {
    const before = b.calls.filter((c) => c[0] === "dbg.cmd").length;
    const r = await b.run(Object.assign({ tabId: 3 }, m));
    assert.strictEqual(r.status, "captcha_or_warning", m.action); assert.strictEqual(r.ok, false); assert.strictEqual(r.stop, true); assert.strictEqual(r.kind, "captcha");
    assert.strictEqual(b.calls.filter((c) => c[0] === "dbg.cmd").length, before, "no debe enviar input a la página: " + m.action);
  }
  // sin tabId explícito: el guard mira la pestaña que usaría la acción (activa)
  const rImplicit = await b.run({ action: "click", selector: "#b" });
  assert.strictEqual(rImplicit.status, "captcha_or_warning");
  assert.ok(!b.calls.some((c) => c[0] === "exec" && c[2] !== "rkGuardInPage"), "ninguna acción corrió");
  const g = await b.run({ action: "guard_check", tabId: 3 });
  assert.strictEqual(g.flagged, true); assert.strictEqual(g.status, "captcha_or_warning");
  const read = await b.run({ action: "inspect", tabId: 3, selector: "a" });
  assert.strictEqual(read.ok, true); // lectura sigue disponible para diagnosticar
  assert.ok(b.api.RK_LOG.read({ kind: "guard" }).length >= acts.length);
});

test("guard por texto de aviso (rate limit) y fail-closed si no puede verificar", async () => {
  const snap = { title: "Ex", domSignals: [], alertTexts: ["Rate limit exceeded. Try again later."], bodyText: "" };
  const b = boot({ tabs: [mk({ id: 3, active: true })], granted: [], guardSnap: snap, pageResult: { ok: true } });
  const r = await b.run({ action: "click", tabId: 3, selector: "#b" });
  assert.strictEqual(r.status, "captcha_or_warning"); assert.strictEqual(r.kind, "warning");
  const b2 = boot({ tabs: [mk({ id: 3, active: true })], granted: [], guardSnap: clearSnap, scriptError: "boom inesperado" });
  const r2 = await b2.run({ action: "click", tabId: 3, selector: "#b" });
  assert.strictEqual(r2.status, "guard_failed"); assert.strictEqual(r2.ok, false);
  assert.ok(!b2.calls.some((c) => c[0] === "exec" && c[2] !== "rkGuardInPage"));
});

test("sin captcha: la acción corre normal (base intacta)", async () => {
  const b = boot({ tabs: [mk({ id: 3, active: true })], granted: [], guardSnap: clearSnap, pageResult: { ok: true } });
  const r = await b.run({ action: "click", tabId: 3, selector: "#b" });
  assert.strictEqual(r.ok, true);
  const nf = boot({ tabs: [mk({ id: 3, active: true })], granted: [], guardSnap: clearSnap, pageResult: { ok: false } });
  const r2 = await nf.run({ action: "click", tabId: 3, selector: "#b" });
  assert.strictEqual(r2.ok, false); assert.strictEqual(r2.error, "selector not found in any frame");
  assert.strictEqual(r2.status, undefined);
});

test("consola por pestaña: start -> evento CDP -> read -> stop", async () => {
  const b = boot({ tabs: [mk({ id: 4 })], granted: [], guardSnap: clearSnap });
  assert.strictEqual((await b.run({ action: "console_start" })).status, "bad_input");
  const s = await b.run({ action: "console_start", tabId: 4, network: true });
  assert.strictEqual(s.ok, true); assert.ok(b.api.RK_CONSOLE_TABS.has(4));
  assert.ok(b.calls.some((c) => c[0] === "dbg.cmd" && c[2] === "Log.enable") && b.calls.some((c) => c[2] === "Network.enable"));
  b.fireDbg({ tabId: 4 }, "Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "falló con token=SUPERSECRET12345" }] });
  b.fireDbg({ tabId: 4 }, "Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: z" } } });
  b.fireDbg({ tabId: 9 }, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "otra pestaña" }] });
  const r = await b.run({ action: "console_read", tabId: 4 });
  assert.strictEqual(r.count, 2); assert.ok(!JSON.stringify(r).includes("SUPERSECRET12345"));
  assert.strictEqual((await b.run({ action: "console_read", tabId: 4, minLevel: "error", sinceSeq: r.entries[0].seq })).count, 1);
  const st = await b.run({ action: "console_stop", tabId: 4 });
  assert.strictEqual(st.wasCapturing, true); assert.ok(!b.api.RK_CONSOLE_TABS.has(4));
  b.fireDbg({ tabId: 4 }, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "ignorado" }] });
  assert.strictEqual((await b.run({ action: "console_read", tabId: 4 })).count, 2);
  // tras console_stop, una acción CDP vuelve a adjuntar el debugger (attachedTabs limpio)
  const att = b.calls.filter((c) => c[0] === "dbg.attach").length;
  await b.run({ action: "cdp_type", tabId: 4, text: "x" });
  assert.strictEqual(b.calls.filter((c) => c[0] === "dbg.attach").length, att + 1);
});

test("errores de red: webRequest onErrorOccurred / onCompleted>=400", async () => {
  const b = boot({ tabs: [mk({ id: 6 })], granted: [], guardSnap: clearSnap });
  b.listeners["wr.err"][0]({ tabId: 6, error: "net::ERR_CONNECTION_REFUSED", method: "GET", url: "https://api.example.com/v1?key=abc", type: "xmlhttprequest" });
  b.listeners["wr.err"][0]({ tabId: 6, error: "net::ERR_ABORTED", method: "GET", url: "https://a.com/x", type: "image" });
  b.listeners["wr.err"][0]({ tabId: -1, error: "net::ERR_FAILED", method: "GET", url: "https://bg.com/", type: "other" });
  b.listeners["wr.done"][0]({ tabId: 6, statusCode: 200, method: "GET", url: "https://ok.com/" });
  b.listeners["wr.done"][0]({ tabId: 6, statusCode: 404, method: "GET", url: "https://a.com/missing?t=1", type: "script" });
  b.listeners["wr.done"][0]({ tabId: 7, statusCode: 500, method: "POST", url: "https://a.com/api", type: "xmlhttprequest" });
  const r = await b.run({ action: "net_errors", tabId: 6 });
  assert.strictEqual(r.count, 2); assert.ok(!JSON.stringify(r).includes("key=abc") && !JSON.stringify(r).includes("t=1"));
  const all = await b.run({ action: "net_errors" });
  assert.strictEqual(all.count, 3);
  assert.strictEqual((await b.run({ action: "net_errors", minLevel: "error" })).count, 2);
});

test("log_read / log_clear / debug_info + acciones quedan en el ring buffer (sin secretos)", async () => {
  const b = boot({ tabs: [mk({ id: 1, active: true })], granted: [], guardSnap: clearSnap, pageResult: { ok: true } });
  await b.run({ action: "inspect", tabId: 1, selector: "a" });
  await b.run({ action: "fill", tabId: 1, selector: "#p", value: "MI_PASSWORD_SECRETA_123" });
  await b.run({ action: "inspect", tabId: 404, selector: "a" });
  const l = await b.run({ action: "log_read", kind: "action" });
  assert.ok(l.count >= 3 && l.stats.capacity === 1000);
  assert.ok(l.entries.some((e) => e.data.status === "no_tab"));
  assert.ok(!JSON.stringify(l).includes("MI_PASSWORD_SECRETA_123"));
  const di = await b.run({ action: "debug_info" });
  assert.strictEqual(di.version, "0.3.0"); assert.ok(di.actingGuarded.includes("click"));
  assert.ok((await b.run({ action: "log_clear", kind: "action" })).removed >= 3);
});
