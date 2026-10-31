// Ranukita Browser & X Bridge v2.5.0 — Full navigation, DOM & CDP Debugger suite + x_unfollow_step + depuración (tabs/consola/red/logs/permisos/guard)
// v2.5.0: ver README-NEW-ACTIONS.md. Compatible hacia atrás: las acciones existentes siguen igual (list_tabs solo suma campos).
// v2.4.0: versión unificada, x_unfollow_step (clicks CDP de confianza + verificación + corte ante avisos),
// navigate/new_tab ya no pisan la pestaña activa de Emilio ni pestañas ajenas a X.
importScripts("x_tab_policy.js", "x_unfollow_core.js", "rk_debug.js");
const RK_VERSION = "2.5.0";
const RK_CAPS = ["x_unfollow_step", "tabs_info", "site_access", "tab_reload_discarded", "guard_check", "console_start", "console_stop", "console_read", "net_errors", "log_read", "log_clear", "debug_info", "captcha_guard", "reload_if_discarded"];
const WS_URL = "ws://127.0.0.1:9223/ws";
let ws = null;
const attachedTabs = new Map(); // tabId -> detachTimer

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function activeTab(tabId, hint) {
  const xOnly = wantsX(hint);
  if (tabId !== undefined && tabId !== null && tabId !== "") {
    try {
      const t = await chrome.tabs.get(Number(tabId));
      if (!xOnly || isXUrl(t.url)) return t;
    } catch (e) {}
  }
  if (xOnly) {
    const all = await chrome.tabs.query({});
    return all.find((t) => isXUrl(t.url)) || null;
  }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (t) return t;
  const all = await chrome.tabs.query({});
  return all.find((x) => x.url && !x.url.startsWith("chrome://")) || all[0];
}

async function inPage(tab, func, args = [], world = "ISOLATED") {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world,
    func,
    args,
  });
  return r ? r.result : null;
}

async function getXUser() {
  for (const url of ["https://x.com", "https://twitter.com"]) {
    try {
      const c = await chrome.cookies.get({ url, name: "twid" });
      if (c && c.value) {
        return decodeURIComponent(c.value).replace(/^u=/, "");
      }
    } catch (e) {}
  }
  return null;
}

function scheduleDetach(tabId) {
  if (attachedTabs.has(tabId)) {
    clearTimeout(attachedTabs.get(tabId));
  }
  const timer = setTimeout(async () => {
    attachedTabs.delete(tabId);
    if (typeof RK_CONSOLE_TABS !== "undefined" && RK_CONSOLE_TABS.has(tabId)) return; // v2.5.0: captura de consola activa, no desconectar
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {}
  }, 4000);
  attachedTabs.set(tabId, timer);
}

async function withDebugger(tabId, fn) {
  const target = { tabId: Number(tabId) };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (!msg.toLowerCase().includes("already attached")) {
      throw e;
    }
  }
  scheduleDetach(target.tabId);
  try {
    return await fn(target);
  } finally {
    scheduleDetach(target.tabId);
  }
}

async function cdpEval(tab, jsExpr) {
  try {
    return await withDebugger(tab.id, async (target) => {
      await chrome.debugger.sendCommand(target, "Runtime.enable");
      let res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: String(jsExpr),
        returnByValue: true,
        awaitPromise: true,
      });
      if (
        res &&
        res.exceptionDetails &&
        JSON.stringify(res.exceptionDetails).includes("Illegal return statement")
      ) {
        res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          expression: `(function(){ ${jsExpr} })()`,
          returnByValue: true,
          awaitPromise: true,
        });
      }
      if (res && res.exceptionDetails) {
        const desc =
          res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          "eval exception";
        return { ok: false, error: desc, result: null };
      }
      return {
        ok: true,
        result: res && res.result ? res.result.value : null,
      };
    });
  } catch (e) {
    try {
      const val = await inPage(
        tab,
        async (code) => {
          try {
            const r = (0, eval)(code);
            return r && typeof r.then === 'function' ? await r : r;
          } catch (err) {
            try {
              const fn = new Function('return (async () => { ' + code + ' })()');
              return await fn();
            } catch (err2) {
              return new Function(code)();
            }
          }
        },
        [String(jsExpr)],
        "MAIN"
      );
      return { ok: true, result: val };
    } catch (e2) {
      return { ok: false, error: String(e2 || e), result: null };
    }
  }
}

const KEY_DEFS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

const H = {
  reload: async () => {
    setTimeout(() => { chrome.runtime.reload(); }, 100);
    return { ok: true, reloaded: true };
  },
  get_cookies: async (m) => {
    const targetUrl = m.url || "https://flow.google.com";
    const cookies = await chrome.cookies.getAll({ url: targetUrl });
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    return { ok: true, cookieString: cookieStr, cookies: cookies.map(c => ({ name: c.name, value: c.value })) };
  },
  ping: async () => ({ ok: true, pong: true, version: RK_VERSION, ext: "ranukita-x-bridge", caps: RK_CAPS }),
  health: async () => ({ ok: true, pong: true, version: RK_VERSION, ext: "ranukita-x-bridge", caps: RK_CAPS, xuser: await getXUser() }),
  x_unfollow_step: async (m) => {
    // Un unfollow atómico, verificado, en UNA pestaña de X dada (tabId obligatorio). El ritmo, el tope diario,
    // la lista y el log los maneja el driver (rk-x-unfollow-candidates.py); acá no hay bucle.
    if (m.tabId === undefined || m.tabId === null || m.tabId === "") return { ok: false, status: "bad_input", stop: true, detail: "tabId obligatorio" };
    const tabId = Number(m.tabId);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return { ok: false, status: "bad_input", stop: true, detail: "tab inexistente" }; }
    if (!isXUrl(tab.url)) return { ok: false, status: "bad_input", stop: true, detail: "la pestaña no es de X" };
    const env = {
      now: () => Date.now(),
      sleep,
      rand: (lo, hi) => lo + Math.random() * (hi - lo),
      tabUrl: () => tab.url,
      navigate: async (url) => {
        const same = (tab.url || "").replace(/[?#].*$/, "").toLowerCase() === url.toLowerCase();
        if (!isXUrl(url)) throw new Error("destino no es X");
        if (same) await chrome.tabs.reload(tabId);
        else await chrome.tabs.update(tabId, { url, active: false });
      },
      waitLoaded: async (ms) => {
        const end = Date.now() + ms;
        await sleep(500);
        while (Date.now() < end) {
          tab = await chrome.tabs.get(tabId);
          if (tab.status === "complete") return;
          await sleep(300);
        }
      },
      snapshot: async (o) => {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: xSnapshotInPage, args: [o] });
        return r ? r.result : null;
      },
      click: async (x, y) => {
        await withDebugger(tabId, async (target) => {
          try { await chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true }); } catch (e) {}
          const ev = (type, extra) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", Object.assign({ type, x, y }, extra));
          await ev("mouseMoved", { button: "none", buttons: 0 });
          await sleep(60 + Math.random() * 120);
          await ev("mousePressed", { button: "left", buttons: 1, clickCount: 1 });
          await sleep(40 + Math.random() * 70);
          await ev("mouseReleased", { button: "left", buttons: 0, clickCount: 1 });
        });
      },
    };
    // Tras navegar la URL puede cambiar: refrescar `tab` en cada snapshot vía waitLoaded; tabUrl() se lee antes de navegar.
    try {
      return await runUnfollowStep(env, m);
    } catch (e) {
      return { ok: false, status: "error", stop: true, detail: String(e && e.message ? e.message : e) };
    }
  },
  reload_ext: async () => {
    setTimeout(() => chrome.runtime.reload(), 100);
    return { ok: true, reloading: true };
  },
  xuser: async () => ({ ok: true, xuser: await getXUser() }),
  list_tabs: async () => ({
    ok: true,
    tabs: (await chrome.tabs.query({})).map((t) => ({
      id: t.id,
      windowId: t.windowId,
      url: t.url,
      title: t.title,
      active: t.active,
      status: t.status, // v2.5.0 (campos nuevos, aditivos)
      discarded: !!t.discarded,
    })),
  }),
  navigate: async (m) => {
    if (isXUrl(m.url)) {
      const tabs = await chrome.tabs.query({});
      const plan = planXNavigate(tabs, m.tabId, m.url);
      if (plan.action === "refuse") return { ok: false, error: plan.error };
      if (plan.action === "create") {
        const created = await chrome.tabs.create({ url: m.url, active: false });
        return { ok: true, tabId: created.id, url: m.url, created: true };
      }
      await chrome.tabs.update(plan.tabId, { url: m.url, active: false });
      return { ok: true, tabId: plan.tabId, url: m.url, created: false };
    }
    // v2.4.0: un destino que no es de X exige tabId explícito; nunca pisa la pestaña activa de Emilio.
    if (m.tabId === undefined || m.tabId === null || m.tabId === "") {
      return { ok: false, error: "navigate a un sitio que no es X requiere tabId explícito" };
    }
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de destino" };
    await chrome.tabs.update(t.id, { url: m.url });
    return { ok: true, tabId: t.id, url: m.url };
  },
  new_tab: async (m) => {
    if (m.xOnly && !isXUrl(m.url)) return { ok: false, error: "new_tab xOnly: la URL no es de X" };
    const t = await chrome.tabs.create({ url: m.url, active: m.active === true });
    return { ok: true, tabId: t.id, windowId: t.windowId };
  },
  close_tab: async (m) => {
    let t;
    try {
      t = await chrome.tabs.get(Number(m.tabId));
    } catch (e) {
      return { ok: false, error: "tab inexistente" };
    }
    const plan = planClose(t);
    if (plan.action !== "close") return { ok: false, error: plan.error, url: t.url };
    await chrome.tabs.remove(plan.tabId);
    return { ok: true };
  },
  wait: async (m) => {
    await sleep(Number(m.ms || 1000));
    return { ok: true };
  },
  wait_idle: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const max = Number(m.maxMs || 15000);
    const st = Date.now();
    while (Date.now() - st < max) {
      const x = await chrome.tabs.get(t.id);
      if (x.status === "complete") break;
      await sleep(250);
    }
    await sleep(Number(m.idleMs || 600));
    return { ok: true, tabId: t.id };
  },
  wait_for: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const st = Date.now();
    const timeout = Number(m.timeoutMs || 15000);
    while (Date.now() - st < timeout) {
      const found = await inPage(t, (s) => !!document.querySelector(s), [m.selector]);
      if (found) return { ok: true, tabId: t.id };
      await sleep(350);
    }
    return { ok: false, error: "timeout waiting for " + m.selector };
  },
  screenshot: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const u = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
    return { ok: true, dataUrl: u, url: t.url, title: t.title, tabId: t.id };
  },
  see: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const u = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
    const txt = await inPage(t, () => (document.body ? document.body.innerText.slice(0, 8000) : ""));
    return { ok: true, screenshot_dataUrl: u, url: t.url, title: t.title, text: txt, tabId: t.id };
  },
  clear_overlay: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    await inPage(t, () => {
      const el = document.getElementById("__rk_see2_overlay__");
      if (el) el.remove();
    });
    return { ok: true };
  },
  see2: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const maxEls = Number(m.max || 80);
    let cleanUrl = null;
    if (m.also_clean) {
      await inPage(t, () => {
        const el = document.getElementById("__rk_see2_overlay__");
        if (el) el.remove();
      });
      cleanUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
    }
    const pageData = await inPage(
      t,
      (limit) => {
        const old = document.getElementById("__rk_see2_overlay__");
        if (old) old.remove();
        const sel = [
          "a[href]",
          "button",
          "input",
          "textarea",
          "select",
          "[role=button]",
          "[role=link]",
          "[role=textbox]",
          "[role=combobox]",
          "[role=menuitem]",
          "[role=tab]",
          "[role=checkbox]",
          "[role=radio]",
          "[contenteditable=true]",
          "sp-button",
          "sp-action-button",
          "firefly-textfield",
        ].join(",");
        const nodes = [...document.querySelectorAll(sel)];
        const overlay = document.createElement("div");
        overlay.id = "__rk_see2_overlay__";
        overlay.style.cssText =
          "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
        const elements = [];
        let idx = 0;
        for (const el of nodes) {
          if (idx >= limit) break;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
          const st = window.getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) continue;
          idx += 1;
          el.setAttribute("data-rk-idx", String(idx));
          const tag = (el.tagName || "").toLowerCase();
          const role =
            el.getAttribute("role") ||
            (tag === "a"
              ? "link"
              : tag === "button" || tag.includes("button")
              ? "button"
              : tag === "input" || tag === "textarea" || tag.includes("textfield")
              ? "textbox"
              : tag === "select"
              ? "combobox"
              : "");
          const text = (
            el.innerText ||
            el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            el.value ||
            el.title ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);
          const bbox = {
            x: Math.round(r.left),
            y: Math.round(r.top),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
          elements.push({
            idx,
            tag,
            role,
            text,
            type: el.type || null,
            name: el.name || null,
            placeholder: el.placeholder || null,
            href: el.href || null,
            selector: `[data-rk-idx="${idx}"]`,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            bbox,
          });
          const badge = document.createElement("div");
          badge.textContent = String(idx);
          badge.style.cssText = `position:fixed;left:${Math.max(0, bbox.x)}px;top:${Math.max(
            0,
            bbox.y
          )}px;background:#e11d48;color:#fff;font:bold 11px monospace;padding:1px 4px;border-radius:3px;border:1px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.4);`;
          overlay.appendChild(badge);
        }
        document.documentElement.appendChild(overlay);
        return {
          elements,
          text: document.body ? document.body.innerText.slice(0, 6000) : "",
        };
      },
      [maxEls]
    );
    await sleep(60);
    const shotUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
    if (!m.keep_overlay) {
      await inPage(t, () => {
        const el = document.getElementById("__rk_see2_overlay__");
        if (el) el.remove();
      });
    }
    const out = {
      ok: true,
      screenshot_dataUrl: shotUrl,
      url: t.url,
      title: t.title,
      text: pageData ? pageData.text : "",
      elements: pageData ? pageData.elements : [],
      tabId: t.id,
    };
    if (cleanUrl) out.screenshot_clean_dataUrl = cleanUrl;
    return out;
  },
  eval: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    return await cdpEval(t, m.js);
  },
  click: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const r = await inPage(
      t,
      (sel) => {
        const e = document.querySelector(sel);
        if (!e) return false;
        e.scrollIntoView({ block: "center", inline: "center" });
        e.focus?.();
        e.click();
        return true;
      },
      [m.selector]
    );
    // OJO: e.click() inyectado NO es de confianza; X lo ignora en unfollow/confirmar. Usar x_unfollow_step / cdp_click.
    return { ok: !!r, untrusted: true, error: r ? undefined : "selector not found: " + m.selector };
  },
  click_text: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const r = await inPage(
      t,
      (tx, role, occ) => {
        const q = role ? `[role="${role}"],${role}` : "a,button,[role=button],span,div,li,label";
        const target = (tx || "").trim().toLowerCase();
        const els = [...document.querySelectorAll(q)].filter((e) => {
          const et = (e.innerText || e.getAttribute("aria-label") || "").trim().toLowerCase();
          return et === target || et.includes(target);
        });
        const e = els[(occ || 1) - 1];
        if (!e) return false;
        e.scrollIntoView({ block: "center", inline: "center" });
        e.click();
        return true;
      },
      [m.text, m.role || null, Number(m.occurrence || 1)]
    );
    return { ok: !!r, error: r ? undefined : "text not found: " + m.text };
  },
  fill: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const r = await inPage(
      t,
      (sel, val) => {
        const e = document.querySelector(sel);
        if (!e) return { ok: false, error: "selector not found: " + sel };
        e.scrollIntoView({ block: "center" });
        e.focus();
        if (e.isContentEditable) {
          e.textContent = val;
          e.dispatchEvent(new InputEvent("input", { bubbles: true, data: val, inputType: "insertText" }));
          e.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, value: e.textContent };
        }
        const proto =
          e instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : e instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(e, val);
        else e.value = val;
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, value: e.value };
      },
      [m.selector, String(m.value ?? "")]
    );
    return r || { ok: false, error: "fill failed" };
  },
  fill_form: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const fields = typeof m.fields === "string" ? JSON.parse(m.fields) : m.fields || {};
    const results = {};
    for (const [sel, val] of Object.entries(fields)) {
      const res = await H.fill({ tabId: t.id, selector: sel, value: val });
      results[sel] = res.ok;
    }
    return { ok: Object.values(results).every(Boolean), results };
  },
  act: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const sel = m.selector || (m.index !== undefined ? `[data-rk-idx="${m.index}"]` : null);
    if (!sel) return { ok: false, error: "missing selector or index" };
    const kind = (m.type || "click").toLowerCase();
    if (kind === "click") return await H.click({ tabId: t.id, selector: sel });
    if (kind === "fill" || kind === "type")
      return await H.fill({ tabId: t.id, selector: sel, value: m.value ?? "" });
    if (kind === "select")
      return await H.select_option({ tabId: t.id, selector: sel, value: m.value ?? "" });
    if (kind === "hover") return await H.hover({ tabId: t.id, selector: sel });
    return { ok: false, error: "unknown act type: " + kind };
  },
  type_human: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const sel = m.selector || (m.index !== undefined ? `[data-rk-idx="${m.index}"]` : null);
    const val = String(m.value ?? m.text ?? "");
    if (sel) {
      await inPage(
        t,
        (s) => {
          const e = document.querySelector(s);
          if (e) {
            e.scrollIntoView({ block: "center" });
            e.focus();
          }
        },
        [sel]
      );
    }
    return await H.cdp_type({ tabId: t.id, text: val, keyByKey: true, delay: m.delay || 25 });
  },
  hover: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const sel = m.selector || (m.index !== undefined ? `[data-rk-idx="${m.index}"]` : null);
    const r = await inPage(
      t,
      (s) => {
        const e = document.querySelector(s);
        if (!e) return false;
        e.scrollIntoView({ block: "center" });
        const rect = e.getBoundingClientRect();
        const opts = {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        };
        e.dispatchEvent(new MouseEvent("mouseover", opts));
        e.dispatchEvent(new MouseEvent("mouseenter", opts));
        e.dispatchEvent(new MouseEvent("mousemove", opts));
        return true;
      },
      [sel]
    );
    return { ok: !!r };
  },
  scroll: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    await inPage(
      t,
      (sel, dx, dy) => {
        if (sel) {
          const e = document.querySelector(sel);
          if (e) {
            e.scrollBy(dx, dy);
            return;
          }
        }
        window.scrollBy(dx, dy);
      },
      [m.selector || null, Number(m.dx || 0), Number(m.dy || 600)]
    );
    return { ok: true };
  },
  select_option: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const sel = m.selector || (m.index !== undefined ? `[data-rk-idx="${m.index}"]` : null);
    const r = await inPage(
      t,
      (s, val) => {
        const e = document.querySelector(s);
        if (!e || e.tagName !== "SELECT") return false;
        const target = String(val).trim().toLowerCase();
        const opt = [...e.options].find(
          (o) =>
            o.value.toLowerCase() === target ||
            (o.textContent || "").trim().toLowerCase() === target ||
            (o.textContent || "").trim().toLowerCase().includes(target)
        );
        if (!opt) return false;
        e.value = opt.value;
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      [sel, String(m.value ?? "")]
    );
    return { ok: !!r };
  },
  key: async (m) => {
    return await H.cdp_key(m);
  },
  inspect: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const r = await inPage(
      t,
      (s) =>
        [...document.querySelectorAll(s)].slice(0, 40).map((e) => {
          const rect = e.getBoundingClientRect();
          return {
            tag: e.tagName,
            text: (e.innerText || "").slice(0, 120),
            name: e.name || null,
            type: e.type || null,
            id: e.id || null,
            value: e.value ?? null,
            ariaLabel: e.getAttribute("aria-label") || null,
            bbox: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
          };
        }),
      [m.selector]
    );
    return { ok: true, elements: r || [] };
  },
  cdp_click: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const x = Number(m.x);
    const y = Number(m.y);
    const button = m.button || "left";
    const buttons = m.buttons !== undefined ? Number(m.buttons) : (button === "right" ? 2 : (button === "middle" ? 4 : 1));
    const clickCount = Number(m.clickCount || 1);
    await withDebugger(t.id, async (target) => {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: 0,
      });
      await sleep(25);
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        buttons,
        clickCount,
      });
      await sleep(35);
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: 0,
        clickCount,
      });
    });
    return { ok: true, x, y };
  },
  cdp_focus: async (m) => {
    if (m.x !== undefined && m.y !== undefined) {
      return await H.cdp_click({ tabId: m.tabId, x: m.x, y: m.y });
    }
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    if (m.selector) {
      await inPage(
        t,
        (s) => {
          const e = document.querySelector(s);
          if (e) e.focus();
        },
        [m.selector]
      );
    }
    return { ok: true };
  },
  cdp_type: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const text = String(m.text ?? m.value ?? "");
    await withDebugger(t.id, async (target) => {
      if (m.keyByKey) {
        const delay = Number(m.delay || 20);
        for (const ch of text) {
          await chrome.debugger.sendCommand(target, "Input.insertText", { text: ch });
          if (delay > 0) await sleep(delay);
        }
      } else {
        await chrome.debugger.sendCommand(target, "Input.insertText", { text });
      }
    });
    return { ok: true, typed: text.length };
  },
  cdp_key: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const keyName = String(m.key || "Enter");
    const def = KEY_DEFS[keyName] || {
      key: keyName,
      code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName,
      keyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0,
      text: keyName.length === 1 ? keyName : undefined,
    };
    const mods = m.modifiers || {};
    const modMask =
      (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
    await withDebugger(t.id, async (target) => {
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: def.text ? "keyDown" : "rawKeyDown",
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        modifiers: modMask,
        text: def.text,
      });
      await sleep(20);
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        modifiers: modMask,
      });
    });
    return { ok: true, key: keyName };
  },
  upload: async (m) => {
    const t = await activeTab(m.tabId, m);
    if (!t) return { ok: false, error: "sin pestaña de X; no toco otras" };
    const sel = m.selector || 'input[type="file"]';
    const files = Array.isArray(m.files) ? m.files : [m.files].filter(Boolean);
    return await withDebugger(t.id, async (target) => {
      await chrome.debugger.sendCommand(target, "DOM.enable");
      const doc = await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: 1 });
      const q = await chrome.debugger.sendCommand(target, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: sel,
      });
      if (q && q.nodeId) {
        await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {
          nodeId: q.nodeId,
          files,
        });
        return { ok: true, files };
      }
      // Fallback via Runtime.evaluate objectId
      const ev = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(sel)})`,
      });
      if (ev && ev.result && ev.result.objectId) {
        await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {
          objectId: ev.result.objectId,
          files,
        });
        return { ok: true, files };
      }
      return { ok: false, error: "file input not found: " + sel };
    });
  },
  set_files: async (m) => {
    return await H.upload(m);
  },
};

// =====================================================================================
// v2.5.0 — Depuración del navegador (solo lectura / diagnóstico). Ver README-NEW-ACTIONS.md
// Sin anti-detección, sin huellas, sin captchas: ante captcha/desafío/aviso -> status "captcha_or_warning".
// =====================================================================================
const RK_LOG = new RkRing(RK_LOG_CAPACITY);
const RK_CONSOLE_TABS = new Map(); // tabId -> { network: bool, since: ts }
let rkPersistTimer = null;

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
    if (src && src.tabId !== undefined) {
      attachedTabs.delete(src.tabId);
    }
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
  await sleep(400);
  while (Date.now() < end) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete" && !t.discarded) return t;
    } catch (e) { return null; }
    await sleep(250);
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

async function rkErrorResponse(e, m) {
  const msg = String(e && e.message ? e.message : e);
  const c = rkClassifyScriptError(e);
  if (!c) return { ok: false, error: msg };
  const res = { ok: false, status: c.status, error: msg, hint: c.hint, hint_en: c.hint_en };
  if (m && m.tabId !== undefined && m.tabId !== null && m.tabId !== "") res.tabId = Number(m.tabId);
  if (c.status === "no_site_access" || c.status === "restricted_page") {
    try {
      const tid = res.tabId !== undefined ? res.tabId : (await activeTab(m.tabId, m) || {}).id;
      if (tid !== undefined) {
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
  const dec = rkDecideGuard(tab.url, snap);
  return dec;
}

const RK_TAB_ACTIONS = new Set(["navigate", "wait_idle", "wait_for", "screenshot", "see", "clear_overlay", "see2", "eval", "click", "click_text", "fill", "fill_form", "act", "type_human", "hover", "scroll", "select_option", "key", "inspect", "cdp_click", "cdp_focus", "cdp_type", "cdp_key", "upload", "set_files", "x_unfollow_step"]);
// Acciones que MUEVEN/ESCRIBEN en la página: ahí corre el guard. Las de solo lectura (see, inspect, screenshot…) no se bloquean: sirven para diagnosticar.
// x_unfollow_step tiene su propio guard interno.
const RK_ACTING = new Set(["click", "click_text", "fill", "fill_form", "act", "type_human", "select_option", "key", "cdp_click", "cdp_focus", "cdp_type", "cdp_key", "upload", "set_files"]);

async function rkPreflight(m) {
  if (!RK_TAB_ACTIONS.has(m.action)) return {};
  const explicit = m.tabId !== undefined && m.tabId !== null && m.tabId !== "";
  let tab = null;
  if (explicit && !(m.action === "navigate" && isXUrl(m.url))) {
    try {
      tab = await chrome.tabs.get(Number(m.tabId));
    } catch (e) {
      // activeTab() caería en la pestaña activa de Emilio: lo evitamos.
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
    if (!tab) tab = await activeTab(m.tabId, m);
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

async function dispatch(m, h) {
  const t0 = Date.now();
  let res;
  try {
    const pre = await rkPreflight(m);
    res = pre.block ? pre.block : await h(m);
  } catch (e) {
    res = await rkErrorResponse(e, m);
  }
  // Errores de scripting devueltos como {ok:false,error:"..."} por handlers viejos: se enriquecen sin cambiar `error`.
  if (res && res.ok === false && typeof res.error === "string" && !res.status) {
    const c = rkClassifyScriptError(res.error);
    if (c) Object.assign(res, { status: c.status, hint: c.hint, hint_en: c.hint_en });
  }
  const ok = !!(res && res.ok);
  rkLog({
    kind: "action", level: ok ? "debug" : "warn", tabId: res && res.tabId !== undefined ? res.tabId : (m.tabId !== undefined && m.tabId !== "" ? Number(m.tabId) : undefined),
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
    const target = { tabId };
    try {
      await chrome.debugger.attach(target, "1.3");
    } catch (e) {
      if (!String(e && e.message ? e.message : e).toLowerCase().includes("already attached")) throw e;
    }
    if (attachedTabs.has(tabId)) { clearTimeout(attachedTabs.get(tabId)); attachedTabs.delete(tabId); }
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

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    ws = null;
    return;
  }
  ws.onopen = async () => {
    try {
      ws.send(
        JSON.stringify({
          type: "hello",
          ext: "ranukita-x-bridge",
          version: RK_VERSION,
          caps: RK_CAPS,
          xuser: await getXUser(),
        })
      );
    } catch (e) {}
  };
  ws.onmessage = async (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    const h = H[m.action];
    let res;
    try {
      res = h ? await dispatch(m, h) : { ok: false, error: "acción no soportada: " + m.action };
    } catch (e) {
      res = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    try {
      ws.send(JSON.stringify({ id: m.id, ...res }));
    } catch (e) {}
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    ws = null;
  };
}

chrome.alarms.create("rk-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  else {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch (e) {
      connect();
    }
  }
});
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
}, 4000);
chrome.tabs.onActivated.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
});
chrome.tabs.onUpdated.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
});
connect();
