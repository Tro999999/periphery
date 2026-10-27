// Built-in local file player: same engine, side windows opened as extension pages.
(function () {
  const $ = (s) => document.querySelector(s);
  const video = $('#video');
  const btn = $('#surround');
  let myTabId = null;
  chrome.tabs.getCurrent((t) => { myTabId = t ? t.id : null; });

  let engine = null;
  let sideWins = {};   // side -> windowId
  let plan = null;
  let onStore = null;
  let starting = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- messages
  let msgTimer = 0;
  function flash(text, ms = 3200) {
    const m = $('#msg');
    m.textContent = text;
    m.classList.add('on');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => m.classList.remove('on'), ms);
  }

  // ---------------------------------------------------------------- file loading
  let objectUrl = null;
  function loadFile(file) {
    if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    document.body.classList.add('has-video');
    $('#name').textContent = file.name;
    document.title = file.name + ' — Periphery';
    video.play().catch(() => {});
  }
  $('#file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  $('#change').addEventListener('click', () => $('#file').click());
  const drop = $('#drop');
  for (const ev of ['dragenter', 'dragover']) {
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  }
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  video.addEventListener('error', () => flash('這個影片格式瀏覽器無法播放。\n建議使用 MP4 (H.264) 或 WebM。', 5000));

  // ---------------------------------------------------------------- idle UI
  let idleTimer = 0;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) document.body.classList.add('idle'); }, 2500);
  }
  document.addEventListener('mousemove', wake);
  video.addEventListener('pause', wake);
  wake();

  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.key === 's' || e.key === 'S') { if (!e.altKey && !e.ctrlKey && !e.metaKey) toggle(); }
    else if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen();
    } else if (e.key === ' ' && e.target === document.body) {
      e.preventDefault();
      if (video.paused) video.play(); else video.pause();
    }
  });

  // ---------------------------------------------------------------- surround
  async function waitView(windowId) {
    for (let i = 0; i < 80; i++) {
      const v = chrome.extension.getViews({ windowId })[0];
      if (v && v.document.readyState === 'complete' && v.document.querySelector('canvas')) return v;
      await sleep(50);
    }
    return null;
  }

  async function start() {
    if (engine || starting) return;
    if (!video.src) { flash('請先選擇一部影片'); return; }
    starting = true;
    try {
      const win = await chrome.windows.getCurrent();
      plan = await chrome.runtime.sendMessage({ type: 'player:plan', windowId: win.id });
      const settings = await peripheryLoadSettings();
      const canvases = {};
      sideWins = {};
      for (const side of plan.sides) {
        const b = plan.bounds[side];
        const opts = plan.preview
          ? { left: b.left, top: b.top, width: b.width, height: b.height }
          : { left: b.left + 40, top: b.top + 40, width: Math.max(320, Math.min(800, b.width - 80)), height: Math.max(240, Math.min(600, b.height - 80)) };
        const w = await chrome.windows.create(Object.assign({
          url: chrome.runtime.getURL('side.html') + '#' + side, type: 'popup', focused: false,
        }, opts));
        sideWins[side] = w.id;
        const view = await waitView(w.id);
        if (!view) continue;
        view.document.title = 'Periphery·' + side;
        view.addEventListener('keydown', (e) => { if (e.key === 'Escape') stop(); });
        canvases[side] = view.document.querySelector('canvas');
        if (!plan.preview) {
          await sleep(120);
          await chrome.windows.update(w.id, { state: 'fullscreen' });
        }
      }
      try { await chrome.windows.update(win.id, { focused: true }); } catch (e) { /* ignore */ }
      engine = new PeripheryEngine(video, canvases, settings, { aspect: screen.width / screen.height });
      engine.start();
      onStore = (changes, area) => {
        if (area !== 'local' || !engine) return;
        const upd = {};
        for (const k in changes) upd[k] = changes[k].newValue;
        engine.updateSettings(upd);
      };
      chrome.storage.onChanged.addListener(onStore);
      btn.textContent = '關閉環繞';
      btn.classList.add('on');
      flash(plan.preview
        ? '環繞模式已開啟（預覽視窗：沒有偵測到左右側螢幕）'
        : '環繞模式已開啟 — 按 F 進入全螢幕，按 S 或在側螢幕按 Esc 關閉');
    } catch (e) {
      console.error('[Periphery player]', e);
      flash('啟動失敗：' + (e && e.message ? e.message : e));
      await stop();
    } finally {
      starting = false;
    }
  }

  async function stop() {
    const wins = sideWins;
    sideWins = {};
    if (engine) { engine.stop(); engine = null; }
    if (onStore) { chrome.storage.onChanged.removeListener(onStore); onStore = null; }
    for (const side in wins) {
      try { await chrome.windows.remove(wins[side]); } catch (e) { /* already closed */ }
    }
    btn.textContent = '開啟環繞';
    btn.classList.remove('on');
  }

  function toggle() { return engine ? stop() : start(); }
  btn.addEventListener('click', toggle);

  chrome.windows.onRemoved.addListener((id) => {
    for (const side in sideWins) {
      if (sideWins[side] === id) {
        delete sideWins[side];
        if (engine) engine.removeSide(side);
      }
    }
    if (engine && Object.keys(sideWins).length === 0) stop();
  });
  window.addEventListener('pagehide', () => { for (const s in sideWins) chrome.windows.remove(sideWins[s]).catch(() => {}); });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.tabId !== myTabId) return false;
    if (msg.type === 'player:toggle') { toggle(); sendResponse({ ok: true }); }
    else if (msg.type === 'player:status') {
      sendResponse(engine
        ? { active: true, preview: plan && plan.preview, sides: Object.keys(sideWins), engine: engine.getStatus() }
        : { active: false });
    }
    return false;
  });
})();
