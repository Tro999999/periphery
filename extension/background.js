// Periphery service worker: toggling, display detection and side-window placement.
importScripts('settings.js');

const PLAYER_URL = chrome.runtime.getURL('player.html');
// tabId -> { frameId, windowId, plan, popupTabs: number[] }
const active = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ displays
async function computePlan(windowId) {
  const settings = await peripheryLoadSettings();
  const displays = await chrome.system.display.getInfo();
  let win = null;
  try { win = await chrome.windows.get(windowId); } catch (e) { /* ignore */ }

  const inside = (b, x, y) => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height;
  let center = null;
  if (win) {
    const cx = win.left + win.width / 2, cy = win.top + win.height / 2;
    center = displays.find((d) => inside(d.bounds, cx, cy));
  }
  center = center || displays.find((d) => d.isPrimary) || displays[0];

  const others = displays.filter((d) => d.id !== center.id);
  const cb = center.bounds;
  const midX = (d) => d.bounds.left + d.bounds.width / 2;
  function pick(pref, side) {
    if (pref === 'none') return null;
    if (pref && pref !== 'auto') return others.find((d) => d.id === pref) || null;
    const c = others.filter((d) => (side === 'left' ? midX(d) < cb.left : midX(d) > cb.left + cb.width));
    c.sort((a, b) => (side === 'left' ? midX(b) - midX(a) : midX(a) - midX(b)));
    return c[0] || null;
  }
  const left = pick(settings.leftDisplay, 'left');
  const right = pick(settings.rightDisplay, 'right');

  const plan = { sides: [], bounds: {}, displays: {}, preview: false, centerId: center.id, shortcut: await shortcut() };
  if (left) { plan.sides.push('left'); plan.bounds.left = left.bounds; plan.displays.left = left.id; }
  if (right) { plan.sides.push('right'); plan.bounds.right = right.bounds; plan.displays.right = right.id; }

  if (plan.sides.length === 0) {
    // no side monitors: open two preview windows on the main display
    const wa = center.workArea;
    const w = Math.round(wa.width * 0.3), h = Math.round(w * 9 / 16);
    const top = Math.round(wa.top + (wa.height - h) / 2);
    plan.preview = true;
    plan.sides = ['left', 'right'];
    plan.bounds.left = { left: wa.left, top, width: w, height: h };
    plan.bounds.right = { left: wa.left + wa.width - w, top, width: w, height: h };
  }
  return plan;
}

async function shortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === 'toggle-surround');
    return (c && c.shortcut) || '';
  } catch (e) { return ''; }
}

async function describeDisplays(windowId) {
  const displays = await chrome.system.display.getInfo();
  const plan = await computePlan(windowId);
  return {
    displays: displays.map((d) => ({
      id: d.id, name: d.name, isPrimary: d.isPrimary, bounds: d.bounds,
      center: d.id === plan.centerId,
    })),
    plan,
  };
}

// ------------------------------------------------------------------ popups permission
async function allowPopups(url) {
  let u;
  try { u = new URL(url); } catch (e) { return; }
  const patterns = [];
  if (u.protocol === 'file:') patterns.push('file:///*');
  else if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (u.port) patterns.push(`${u.protocol}//${u.hostname}:${u.port}/*`);
    patterns.push(`${u.protocol}//${u.hostname}/*`);
  }
  for (const primaryPattern of patterns) {
    try {
      await chrome.contentSettings.popups.set({ primaryPattern, setting: 'allow' });
      return;
    } catch (e) { /* try next pattern */ }
  }
}

// ------------------------------------------------------------------ toggle
async function toast(tabId, text, frameId = 0) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'periphery:toast', text }, { frameId }); } catch (e) { /* ignore */ }
}

function ownerOf(tabId) {
  if (active.has(tabId)) return tabId;
  for (const [owner, e] of active) if (e.popupTabs.includes(tabId)) return owner;
  return null;
}

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e8893a' });
  } catch (e) { /* ignore */ }
}

async function toggle(tab) {
  if (!tab) return { ok: false, reason: 'notab' };
  const owner = ownerOf(tab.id);
  if (owner != null) { await stop(owner); return { ok: true, active: false }; }
  return start(tab);
}

async function start(tab) {
  const tabId = tab.id;
  const url = tab.url || '';
  if (!url || url.startsWith(PLAYER_URL)) {
    // the built-in player handles its own side windows (and answers only for its own tab)
    try {
      const r = await chrome.runtime.sendMessage({ type: 'player:toggle', tabId });
      if (r && r.ok) return { ok: true, player: true };
    } catch (e) { /* not the player */ }
    if (!url) return { ok: false, reason: 'unsupported' };
  }
  if (!/^(https?|file):/.test(url)) {
    return { ok: false, reason: 'unsupported' };
  }

  // Access comes from activeTab (toolbar click / shortcut). Cross-origin iframes additionally
  // need the optional <all_urls> permission; frames we can't reach are simply skipped.
  const inject = async (target) => {
    await chrome.scripting.executeScript({ target, files: ['settings.js', 'engine.js', 'content.js'] });
    return chrome.scripting.executeScript({ target, func: () => (window.__periphery ? window.__periphery.probe() : null) });
  };
  let results = [];
  try {
    results = await inject({ tabId, allFrames: true });
  } catch (e) {
    try {
      results = await inject({ tabId, frameIds: [0] });
    } catch (err) {
      if (url.startsWith('file:')) return { ok: false, reason: 'fileaccess' };
      return { ok: false, reason: 'inject' };
    }
  }
  let best = null;
  let bigFrames = 0;
  for (const r of results) {
    if (r && r.result && (!best || r.result.score > best.result.score)) best = r;
  }
  if (!best) {
    // is the video probably inside a cross-origin iframe we may not read yet?
    try {
      const [top] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => Array.from(document.querySelectorAll('iframe')).filter((f) => {
          const r = f.getBoundingClientRect();
          return r.width * r.height > innerWidth * innerHeight * 0.15;
        }).length,
      });
      bigFrames = (top && top.result) || 0;
    } catch (e) { /* ignore */ }
    const hasAll = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (bigFrames > 0 && !hasAll) {
      await toast(tabId, '影片在嵌入式播放器裡，需要額外授權。\n請點工具列的 <b>Periphery</b> 圖示，按「授權並開啟」。');
      return { ok: false, reason: 'needperm' };
    }
    await toast(tabId, '找不到影片。請先在這個分頁播放影片，再開啟環繞模式。');
    return { ok: false, reason: 'novideo' };
  }
  if (best.result.drm) {
    await toast(tabId, '這部影片受 <b>DRM 版權保護</b>（例如 Netflix、Disney+），\n瀏覽器不允許讀取畫面，無法使用環繞模式。');
    return { ok: false, reason: 'drm' };
  }

  await allowPopups(url);
  const plan = await computePlan(tab.windowId);
  const settings = await peripheryLoadSettings();
  active.set(tabId, { frameId: best.frameId, windowId: tab.windowId, plan, popupTabs: [] });

  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'periphery:start', plan, settings }, { frameId: best.frameId });
  } catch (e) {
    res = { ok: false, reason: String(e) };
  }
  if (!res || !res.ok) {
    active.delete(tabId);
    return res || { ok: false };
  }
  await setBadge(tabId, true);
  return { ok: true, active: true, preview: plan.preview };
}

async function stop(tabId) {
  const e = active.get(tabId);
  active.delete(tabId);
  await setBadge(tabId, false);
  if (!e) return;
  try { await chrome.tabs.sendMessage(tabId, { type: 'periphery:stop' }, { frameId: e.frameId }); } catch (err) { /* ignore */ }
  // make sure side windows are gone even if the page is unresponsive
  await sleep(300);
  for (const t of e.popupTabs) {
    try { await chrome.tabs.remove(t); } catch (err) { /* already closed */ }
  }
}

// ------------------------------------------------------------------ placement
// Side windows are popups opened by the owner tab, in plan order (left, then right).
// Found through openerTabId so the extension doesn't need the "tabs" permission.
async function findPopupTabs(ownerTabId, count, exclude) {
  for (let i = 0; i < 30; i++) {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
    const tabs = [];
    for (const w of wins) for (const t of w.tabs || []) {
      if (t.openerTabId === ownerTabId && !exclude.includes(t.id)) tabs.push(t);
    }
    if (tabs.length >= count) {
      tabs.sort((a, b) => a.id - b.id);
      return tabs.slice(-count);
    }
    await sleep(100);
  }
  return [];
}

async function placePopups(ownerTabId, sides) {
  const e = active.get(ownerTabId);
  if (!e) return { ok: false };
  const order = e.plan.sides.filter((s) => sides.includes(s));
  const found = await findPopupTabs(ownerTabId, order.length, e.popupTabs);
  for (let i = 0; i < found.length; i++) {
    const side = order[i], t = found[i];
    const b = e.plan.bounds[side];
    if (!b) continue;
    if (!e.popupTabs.includes(t.id)) e.popupTabs.push(t.id);
    try {
      if (e.plan.preview) {
        await chrome.windows.update(t.windowId, { state: 'normal', left: b.left, top: b.top, width: b.width, height: b.height });
      } else {
        await chrome.windows.update(t.windowId, { state: 'normal' });
        await chrome.windows.update(t.windowId, {
          left: b.left + 40, top: b.top + 40,
          width: Math.max(320, Math.min(800, b.width - 80)), height: Math.max(240, Math.min(600, b.height - 80)),
        });
        await sleep(150);
        await chrome.windows.update(t.windowId, { state: 'fullscreen' });
      }
    } catch (err) {
      console.warn('[Periphery] could not place side window', side, err);
    }
  }
  try { await chrome.windows.update(e.windowId, { focused: true }); } catch (err) { /* ignore */ }
  return { ok: true };
}

// ------------------------------------------------------------------ events
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-surround') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await toggle(tab);
});

const HANDLED = new Set(['periphery:place', 'periphery:stopped', 'periphery:focus-main', 'popup:toggle', 'popup:status', 'popup:displays', 'player:plan']);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // only answer our own message types; others (player:*) are answered by the player page
  if (!msg || !HANDLED.has(msg.type)) return false;
  (async () => {
    switch (msg.type) {
      case 'periphery:place':
        return placePopups(sender.tab.id, msg.sides || []);
      case 'periphery:focus-main': {
        const e = sender.tab && active.get(sender.tab.id);
        if (e) { try { await chrome.windows.update(e.windowId, { focused: true }); } catch (err) { /* ignore */ } }
        return { ok: true };
      }
      case 'periphery:stopped':
        if (sender.tab) { active.delete(sender.tab.id); await setBadge(sender.tab.id, false); }
        return { ok: true };
      case 'popup:toggle': {
        const tab = await chrome.tabs.get(msg.tabId);
        return toggle(tab);
      }
      case 'popup:status': {
        const owner = ownerOf(msg.tabId);
        const out = { active: owner != null };
        if (owner != null) {
          const e = active.get(owner);
          out.preview = e.plan.preview;
          out.sides = e.plan.sides;
          try {
            out.engine = await chrome.tabs.sendMessage(owner, { type: 'periphery:status' }, { frameId: e.frameId });
          } catch (err) { /* ignore */ }
        }
        return out;
      }
      case 'popup:displays':
        return describeDisplays(msg.windowId);
      case 'player:plan':
        return computePlan(msg.windowId);
      default:
        return undefined;
    }
  })().then(sendResponse, (err) => sendResponse({ ok: false, reason: String(err) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const e = active.get(tabId);
  if (!e) return;
  active.delete(tabId);
  for (const t of e.popupTabs) chrome.tabs.remove(t).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  // after a full page load the content script (and its engine) is gone; clean up.
  // SPA navigations (e.g. YouTube autoplay) keep the content script alive, so we ping first.
  if (info.status !== 'complete' || !active.has(tabId)) return;
  const e = active.get(tabId);
  let alive = false;
  try {
    const s = await chrome.tabs.sendMessage(tabId, { type: 'periphery:status' }, { frameId: e.frameId });
    alive = !!(s && s.active);
  } catch (err) { /* no receiver */ }
  if (!alive && active.get(tabId) === e) {
    active.delete(tabId);
    setBadge(tabId, false);
    for (const t of e.popupTabs) chrome.tabs.remove(t).catch(() => {});
  }
});
