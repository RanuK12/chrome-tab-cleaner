// node --test tests/   (sin Chrome ni red). jsdom es opcional: si no está, se saltea el test del guard en DOM.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const R = require("../rk_debug.js");

test("rkRedact oculta tokens y claves", () => {
  const s = R.rkRedact("Authorization: Bearer sample_dummy_test_bearer_token y token=sample_dummy_token_xyz y auth_token: sample_auth_token_value");
  assert.ok(!/sample_dummy_test_bearer_token|sample_dummy_token_xyz|sample_auth_token_value/.test(s), s);
  assert.ok(s.includes("[REDACTED]"));
  assert.ok(!R.rkRedact("x".repeat(60)).includes("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
});

test("rkSanitizeUrl quita query y hash", () => {
  assert.strictEqual(R.rkSanitizeUrl("https://a.com/p/q?token=abc#h"), "https://a.com/p/q");
  assert.ok(!R.rkSanitizeUrl("data:text/plain;base64,SECRETSECRET").includes("SECRET"));
});

test("rkOriginPattern / rkIsRestrictedUrl", () => {
  assert.strictEqual(R.rkOriginPattern("https://x.com/home?a=1"), "https://x.com/*");
  assert.strictEqual(R.rkOriginPattern("chrome://extensions"), null);
  assert.ok(R.rkIsRestrictedUrl("chrome://extensions"));
  assert.ok(R.rkIsRestrictedUrl("https://chromewebstore.google.com/detail/x"));
  assert.ok(!R.rkIsRestrictedUrl("https://example.com"));
});

test("RkRing: capacidad, filtros, sinceSeq, clear", () => {
  const r = new R.RkRing(5);
  for (let i = 1; i <= 8; i++) r.push({ kind: i % 2 ? "console" : "net", level: i > 6 ? "error" : "info", tabId: i % 3, msg: "m" + i });
  assert.strictEqual(r.buf.length, 5);
  assert.strictEqual(r.dropped, 3);
  assert.strictEqual(r.read({ kind: "net" }).length, r.buf.filter((e) => e.kind === "net").length);
  assert.ok(r.read({ minLevel: "error" }).every((e) => e.level === "error"));
  assert.deepStrictEqual(r.read({ sinceSeq: 6 }).map((e) => e.seq), [7, 8]);
  assert.strictEqual(r.read({ limit: 2 }).length, 2);
  assert.strictEqual(r.clear({ kind: "net" }) > 0, true);
  assert.ok(r.read({}).every((e) => e.kind !== "net"));
  assert.strictEqual(r.stats().lastSeq, 8);
});

test("rkClassifyScriptError", () => {
  assert.strictEqual(R.rkClassifyScriptError(new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.")).status, "no_site_access");
  assert.strictEqual(R.rkClassifyScriptError("Cannot access contents of url \"chrome-error://chromewebdata/\"").status, "no_site_access");
  assert.strictEqual(R.rkClassifyScriptError("Cannot access a chrome:// URL").status, "restricted_page");
  assert.strictEqual(R.rkClassifyScriptError("No tab with id: 12").status, "no_tab");
  assert.strictEqual(R.rkClassifyScriptError("Frame with ID 0 was removed.").status, "frame_gone");
  assert.strictEqual(R.rkClassifyScriptError("Another debugger is already attached to the tab").status, "debugger_error");
  assert.strictEqual(R.rkClassifyScriptError("selector not found: #x"), null);
  const c = R.rkClassifyScriptError("Cannot access contents of the page");
  assert.ok(/En todos los sitios/.test(c.hint) && /On all sites/.test(c.hint_en));
});

test("guard: texto / url / decisión", () => {
  assert.strictEqual(R.rkClassifyText("Are you a human?"), "captcha");
  assert.strictEqual(R.rkClassifyText("Verify you're a human to continue"), "captcha");
  assert.strictEqual(R.rkClassifyText("Just a moment..."), "challenge");
  assert.strictEqual(R.rkClassifyText("Rate limit exceeded, try again later"), "warning");
  assert.strictEqual(R.rkClassifyText("Hola, esta es una página normal"), null);
  assert.strictEqual(R.rkClassifyUrlGuard("https://x.com/account/access"), "warning");
  assert.strictEqual(R.rkClassifyUrlGuard("https://www.google.com/sorry/index?continue=x"), "captcha");
  assert.strictEqual(R.rkClassifyUrlGuard("https://example.com/cdn-cgi/challenge-platform/h/b"), "challenge");
  assert.strictEqual(R.rkClassifyUrlGuard("https://example.com/blog/captcha-history"), null);
  assert.strictEqual(R.rkDecideGuard("https://example.com/", { title: "Home", domSignals: [], alertTexts: [], bodyText: "" }).flagged, false);
  assert.strictEqual(R.rkDecideGuard("https://example.com/", { title: "Just a moment...", domSignals: [], alertTexts: [] }).kind, "challenge");
  const d = R.rkDecideGuard("https://example.com/", { title: "t", domSignals: [{ kind: "captcha", evidence: "iframe https://www.google.com/recaptcha/api2/bframe" }], alertTexts: [] });
  assert.ok(d.flagged && d.kind === "captcha" && d.source === "dom");
  assert.strictEqual(R.rkDecideGuard("https://example.com/", { title: "t", domSignals: [], alertTexts: ["Your account is temporarily restricted"] }).kind, "warning");
  // un artículo largo que menciona "captcha" NO dispara (bodyText solo viaja si es corto)
  assert.strictEqual(R.rkDecideGuard("https://example.com/", { title: "Blog", domSignals: [], alertTexts: [], bodyText: "" }).flagged, false);
});

test("formateo de eventos CDP / webRequest", () => {
  const c = R.rkFormatCdpEvent("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "boom token=sample_test_token_123" }, { type: "object", description: "Error: x" }] });
  assert.strictEqual(c.level, "error"); assert.ok(!c.msg.includes("sample_test_token_123")); assert.ok(c.msg.includes("Error: x"));
  assert.strictEqual(R.rkFormatCdpEvent("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "number", value: 3 }] }).level, "warn");
  assert.strictEqual(R.rkFormatCdpEvent("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: a" }, url: "https://a.com/x.js?k=1", lineNumber: 4 } }).data.src, "https://a.com/x.js:4");
  assert.strictEqual(R.rkFormatCdpEvent("Log.entryAdded", { entry: { level: "error", text: "net::ERR_X", source: "network" } }).level, "error");
  assert.strictEqual(R.rkFormatCdpEvent("Network.responseReceived", { response: { status: 200, url: "https://a.com" } }), null);
  assert.strictEqual(R.rkFormatCdpEvent("Network.responseReceived", { response: { status: 503, url: "https://a.com/x?y=1" } }).level, "error");
  assert.strictEqual(R.rkFormatCdpEvent("Page.frameNavigated", {}), null);
  const e = R.rkFormatWebRequestError({ tabId: 3, error: "net::ERR_NAME_NOT_RESOLVED", method: "GET", url: "https://nope.test/a?s=1", type: "xmlhttprequest" });
  assert.strictEqual(e.kind, "net"); assert.ok(!e.msg.includes("s=1"));
  assert.strictEqual(R.rkFormatWebRequestCompleted({ tabId: 3, statusCode: 200, url: "https://a.com" }), null);
  assert.strictEqual(R.rkFormatWebRequestCompleted({ tabId: 3, statusCode: 404, url: "https://a.com/z", method: "GET" }).level, "warn");
  assert.strictEqual(R.rkFormatWebRequestCompleted({ tabId: 3, statusCode: 500, url: "https://a.com/z" }).level, "error");
  assert.ok(R.rkIgnoreRequest({ tabId: -1, url: "https://a.com" }));
  assert.ok(R.rkIgnoreRequest({ tabId: 2, url: "ws://127.0.0.1:9223/ws" }));
  assert.ok(!R.rkIgnoreRequest({ tabId: 2, url: "https://a.com" }));
});

let JSDOM = null;
for (const p of ["jsdom", process.env.RK_JSDOM || "/tmp/rk-jsdom/node_modules/jsdom"]) {
  try { JSDOM = require(p).JSDOM; break; } catch (e) {}
}
test("rkGuardInPage detecta iframe de captcha visible y no el badge v3", { skip: !JSDOM }, () => {
  const run = (html) => {
    const d = new JSDOM("<body>" + html + "</body>", { url: "https://example.com/", runScripts: "outside-only", pretendToBeVisual: true });
    const w = d.window;
    w.Element.prototype.getBoundingClientRect = function () {
      const s = this.getAttribute("data-box");
      const [l, t, wd, h] = s ? s.split(",").map(Number) : [0, 0, 0, 0];
      return { left: l, top: t, width: wd, height: h, right: l + wd, bottom: t + h };
    };
    Object.defineProperty(w, "innerWidth", { value: 1200 }); Object.defineProperty(w, "innerHeight", { value: 800 });
    return w.eval("(" + R.rkGuardInPage.toString() + ")()");
  };
  const bad = run('<iframe data-box="100,100,304,78" src="https://www.google.com/recaptcha/api2/anchor?k=1"></iframe>');
  assert.strictEqual(R.rkDecideGuard("https://example.com/", bad).kind, "captcha");
  const badge = run('<iframe data-box="1130,700,256,60" src="https://www.google.com/recaptcha/api2/anchor?k=1"></iframe><p>hola</p>');
  assert.strictEqual(R.rkDecideGuard("https://example.com/", badge).flagged, false);
  const cf = run('<title>Just a moment...</title><div id="challenge-running" data-box="0,0,300,100"></div>');
  assert.strictEqual(R.rkDecideGuard("https://example.com/", cf).flagged, true);
  const ok = run("<h1>Hola</h1><p>Contenido normal</p>");
  assert.strictEqual(R.rkDecideGuard("https://example.com/", ok).flagged, false);
  const alert = run('<div role="alert">Rate limit exceeded</div>');
  assert.strictEqual(R.rkDecideGuard("https://example.com/", alert).kind, "warning");
});
