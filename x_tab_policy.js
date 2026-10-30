// Política pura: un destino de X nunca pisa ni cierra una pestaña de otro dominio.
function isXUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com");
  } catch (e) {
    return false;
  }
}

function wantsX(hint) {
  if (!hint) return false;
  if (hint.host === "x.com" || hint.host === "twitter.com") return true;
  return isXUrl(hint.url || "");
}

function planXNavigate(tabs, tabId, destUrl) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (!isXUrl(destUrl)) return { action: "foreign-dest" };
  if (tabId !== undefined && tabId !== null && tabId !== "") {
    const pinned = list.find((t) => String(t.id) === String(tabId));
    if (pinned && isXUrl(pinned.url)) return { action: "update", tabId: pinned.id };
    // v2.4.0: tabId explícito que NO es de X -> no se redirige a otra pestaña de X (antes pisaba la de Emilio).
    if (pinned) return { action: "refuse", error: "el tabId pedido no es una pestaña de X; no la toco ni uso otra" };
  }
  const existing = list.find((t) => isXUrl(t.url));
  if (existing) return { action: "update", tabId: existing.id };
  return { action: "create", active: false };
}

function planClose(tab) {
  if (!tab || !isXUrl(tab.url)) {
    return { action: "refuse", error: "no cierro una pestaña que no es de X" };
  }
  return { action: "close", tabId: tab.id };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { isXUrl, wantsX, planXNavigate, planClose };
}
