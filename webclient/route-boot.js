// Runs in <head>, before the body paints: names the route's view on <html data-route> so a reload of a
// project or account link never shows the home page first. app.js keeps the attribute current afterwards.
// Also the last-seen project summary cache, which app.js paints while a project's reads are in flight.
(function (root) {
  "use strict";

  // The same routes app.js renders; anything else is the home page.
  function routeKind(hash) {
    const value = String(hash || "");
    if (/^#\/account\/0x[0-9a-fA-F]{40}$/.test(value)) return "account";
    if (/^#\/project\/\d+(?:\/(?:overview|tokens|airdrops|latest))?\/?$/.test(value)) return "project";
    if (/^#\/@[^/]+(?:\/(?:overview|tokens|airdrops|latest))?\/?$/.test(value)) return "project";
    return "home";
  }

  // Project summaries only: public onchain facts, never a wallet's balance or position.
  const PREFIX = "sticky.project.v1:";
  const HANDLE_PREFIX = "sticky.handle.v1:";
  const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  const UINT = /^\d{1,78}$/;
  const text = (value, max = 200) => typeof value === "string" && value.length <= max;
  const key = (chainId, projectId) => `${PREFIX}${Number(chainId)}:${String(projectId)}`;
  const storageOf = (storage) => {
    if (storage !== undefined) return storage;
    try { return root.localStorage || null; } catch { return null; }
  };

  function validSummary(entry) {
    if (!entry || typeof entry !== "object") return false;
    const { info, header, details, chains } = entry;
    if (!info || !header || !Number.isFinite(entry.savedAt)) return false;
    if (!ADDRESS.test(info.stakedToken || "") || !ADDRESS.test(info.stToken || "")) return false;
    if (![info.symbol, info.name, info.stSymbol, info.stName].every((value) => text(value))) return false;
    if (!Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 36) return false;
    if (!UINT.test(info.reward || "") || typeof info.soulbound !== "boolean") return false;
    if (![header.title, header.stuck, header.sticks, header.average, header.top].every((value) => text(value))) return false;
    if (!Array.isArray(chains) || chains.length > 32 || !chains.every((chainId) => Number.isSafeInteger(chainId) && chainId > 0)) return false;
    if (details !== null) {
      if (!details || typeof details !== "object") return false;
      if (![details.sigma, details.supply, details.orphaned].every((value) => UINT.test(value || ""))) return false;
      if (!Number.isSafeInteger(details.trusted) || details.trusted < 0 || !ADDRESS.test(details.hook || "")) return false;
    }
    return true;
  }

  // A missing, stale, corrupt or unreadable entry reads as no cache; a bad one is dropped.
  function readProject(chainId, projectId, storage, now = Date.now()) {
    const store = storageOf(storage);
    if (!store) return null;
    try {
      const raw = store.getItem(key(chainId, projectId));
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (validSummary(entry) && now - entry.savedAt <= MAX_AGE) return entry;
    } catch {}
    try { store.removeItem(key(chainId, projectId)); } catch {}
    return null;
  }

  function writeProject(chainId, projectId, summary, storage, now = Date.now()) {
    const store = storageOf(storage);
    if (!store) return false;
    const entry = { ...summary, savedAt: now };
    if (!validSummary(entry)) return false;
    try {
      store.setItem(key(chainId, projectId), JSON.stringify(entry));
      return true;
    } catch {
      return false;
    }
  }

  // A verified @handle's project, so a reload of a handle link can paint its summary too.
  function readHandle(chainId, handle, storage) {
    const store = storageOf(storage);
    if (!store) return null;
    try {
      const raw = store.getItem(`${HANDLE_PREFIX}${Number(chainId)}:${String(handle).toLowerCase()}`);
      return raw && UINT.test(raw) ? raw : null;
    } catch {
      return null;
    }
  }
  function writeHandle(chainId, handle, projectId, storage) {
    const store = storageOf(storage);
    if (!store || !UINT.test(String(projectId))) return false;
    try {
      store.setItem(`${HANDLE_PREFIX}${Number(chainId)}:${String(handle).toLowerCase()}`, String(projectId));
      return true;
    } catch {
      return false;
    }
  }

  const api = { routeKind, readProject, writeProject, readHandle, writeHandle, validSummary };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StickyRouteBoot = api;
  try {
    if (root.document) root.document.documentElement.dataset.route = routeKind(root.location.hash);
  } catch {}
})(typeof window === "undefined" ? globalThis : window);
