// Periphery content script: finds the video, opens the side windows and drives the engine.
(function () {
  if (window.__periphery) return;
  const P = (window.__periphery = {});
  let state = null;

  // ------------------------------------------------------------ video discovery
  function collectVideos() {
    const out = Array.from(document.querySelectorAll('video'));
    // also look inside open shadow roots (some custom players)
    const walker = document.createTreeWalker(document.documentElement || document, NodeFilter.SHOW_ELEMENT);
    let n = 0;
    for (let el = walker.currentNode; el && n < 20000; el = walker.nextNode(), n++) {
      if (el.shadowRoot) out.push(...el.shadowRoot.querySelectorAll('video'));
    }
    return out;
  }

  function scoreVideo(v) {
    if (!v.isConnected) return 0;
    const r = v.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    let s = w * h;
    if (s < 160 * 90) return 0;
    if (!v.paused && !v.ended && v.readyState >= 2) s *= 3;
    if (!v.videoWidth) s *= 0.3;
    return s;
  }

  function bestVideo() {
    let best = null, bs = 0;
    for (const v of collectVideos()) {
      const s = scoreVideo(v);
      if (s > bs) { bs = s; best = v; }
    }
    return best ? { video: best, score: bs } : null;
  }

  P.probe = function () {
    const b = bestVideo();
    if (!b) return null;
    const v = b.video;
    return {
      score: b.score,
      drm: !!v.mediaKeys,
      width: v.videoWidth,
      height: v.videoHeight,
      playing: !v.paused,
      active: !!state,
    };
  };

  // ------------------------------------------------------------ toast
  let toastHost = null, toastTimer = 0;
  function toast(text, ms = 3800) {
    try {
      if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:24px;left:50%;transform:translateX(-50%);pointer-events:none;';
        const sh = toastHost.attachShadow({ mode: 'open' });
        sh.innerHTML = `<style>
          .t{font:500 14px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif;
             color:#f4f1ea;background:rgba(18,18,20,.86);backdrop-filter:blur(12px);
             border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 16px;
             box-shadow:0 8px 30px rgba(0,0,0,.45);max-width:520px;text-align:center;
             opacity:0;transition:opacity .25s ease;white-space:pre-line}
          .t.on{opacity:1}
          .t b{color:#ffb35c;font-weight:600}
        </style><div class="t"></div>`;
      }
      const parent = (document.fullscreenElement && document.fullscreenElement.tagName !== 'VIDEO')
        ? document.fullscreenElement : document.documentElement;
      if (toastHost.parentNode !== parent) parent.appendChild(toastHost);
      const box = toastHost.shadowRoot.querySelector('.t');
      box.innerHTML = text;
      box.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => box.classList.remove('on'), ms);
    } catch (e) { /* ignore */ }
  }
  P.toast = toast;

  // ------------------------------------------------------------ side windows
  function openSide(side, plan) {
    const name = 'periphery-' + side + '-' + Math.random().toString(36).slice(2, 8);
    const b = plan.bounds && plan.bounds[side];
    const feat = b
      ? `popup=yes,width=${Math.round(b.width)},height=${Math.round(b.height)},left=${Math.round(b.left)},top=${Math.round(b.top)}`
      : 'popup=yes,width=480,height=270';
    const w = window.open('', name, feat);
    if (!w) return null;
    const d = w.document;
    d.title = 'Periphery·' + side;
    try { w.location.hash = 'periphery-' + side; } catch (e) { /* ignore */ }
    const style = d.createElement('style');
    style.textContent = 'html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}' +
      'canvas{display:block;width:100vw;height:100vh}';
    (d.head || d.documentElement).appendChild(style);
    const canvas = d.createElement('canvas');
    const dpr = w.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(w.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(w.innerHeight * dpr));
    (d.body || d.documentElement).appendChild(canvas);
    return { win: w, canvas };
  }

  // ------------------------------------------------------------ start / stop
  P.start = async function (plan, settings) {
    if (state) return { ok: true, already: true };
    const b = bestVideo();
    if (!b) {
      toast('找不到影片。請先在這個分頁播放影片，再開啟環繞模式。');
      return { ok: false, reason: 'novideo' };
    }
    const video = b.video;
    if (video.mediaKeys) {
      toast('這部影片受 <b>DRM 版權保護</b>（例如 Netflix、Disney+），\n瀏覽器不允許讀取畫面，無法使用環繞模式。', 6000);
      return { ok: false, reason: 'drm' };
    }

    const wins = {}, canvases = {};
    for (const side of plan.sides) {
      const s = openSide(side, plan);
      if (!s) {
        for (const k in wins) try { wins[k].close(); } catch (e) { /* ignore */ }
        toast('側邊視窗被<b>彈出式視窗封鎖</b>擋住了。\n請在網址列右側允許此網站的彈出式視窗後再試一次。', 6000);
        return { ok: false, reason: 'blocked' };
      }
      wins[side] = s.win;
      canvases[side] = s.canvas;
    }

    let engine;
    try {
      engine = new PeripheryEngine(video, canvases, settings, { aspect: screen.width / screen.height });
    } catch (e) {
      for (const k in wins) try { wins[k].close(); } catch (err) { /* ignore */ }
      console.error('[Periphery] engine init failed', e);
      toast('啟動失敗：' + (e && e.message ? e.message : e));
      return { ok: false, reason: 'engine' };
    }
    engine.start();

    const st = (state = { engine, video, wins, stopping: false });

    // side window lifecycle
    for (const side in wins) {
      const w = wins[side];
      const onKey = (e) => { if (e.key === 'Escape') P.stop('esc'); };
      w.addEventListener('keydown', onKey);
      // an accidental click on a side screen shouldn't steal keyboard focus from the movie
      w.addEventListener('mousedown', () => {
        chrome.runtime.sendMessage({ type: 'periphery:focus-main' }).catch(() => {});
      });
      w.addEventListener('pagehide', () => {
        if (state !== st || st.stopping) return;
        engine.removeSide(side);
        delete wins[side];
        if (Object.keys(wins).length === 0) P.stop('closed');
      });
    }

    // live settings
    st.onStore = (changes, area) => {
      if (area !== 'local') return;
      const upd = {};
      for (const k in changes) upd[k] = changes[k].newValue;
      engine.updateSettings(upd);
    };
    chrome.storage.onChanged.addListener(st.onStore);

    // follow video swaps (SPA navigation, ads, etc.)
    st.timer = setInterval(() => {
      const cur = st.video;
      const nb = bestVideo();
      if (!nb) return;
      if (nb.video !== cur && (!cur.isConnected || nb.score > scoreVideo(cur) * 1.5)) {
        st.video = nb.video;
        if (nb.video.mediaKeys) { toast('新影片受 DRM 保護，無法環繞。'); return; }
        engine.setVideo(nb.video);
      }
    }, 1500);

    st.onPageHide = () => P.stop('pagehide');
    window.addEventListener('pagehide', st.onPageHide);

    // ask the background to move side windows onto the side monitors
    try {
      await chrome.runtime.sendMessage({ type: 'periphery:place', sides: Object.keys(wins) });
    } catch (e) { /* ignore */ }

    const key = plan.shortcut ? `按 ${plan.shortcut} ` : '';
    toast(plan.preview
      ? `環繞模式已開啟（<b>預覽視窗</b>：沒有偵測到左右側螢幕）\n${key}或在側邊視窗按 Esc 關閉`
      : `環繞模式已開啟 — 現在可以把影片切到全螢幕\n${key}或在側螢幕按 Esc 關閉`, 4500);
    return { ok: true };
  };

  P.stop = function (reason) {
    if (!state) return;
    const st = state;
    st.stopping = true;
    state = null;
    try { st.engine.stop(); } catch (e) { /* ignore */ }
    clearInterval(st.timer);
    try { chrome.storage.onChanged.removeListener(st.onStore); } catch (e) { /* ignore */ }
    window.removeEventListener('pagehide', st.onPageHide);
    for (const k in st.wins) try { st.wins[k].close(); } catch (e) { /* ignore */ }
    try { chrome.runtime.sendMessage({ type: 'periphery:stopped' }).catch(() => {}); } catch (e) { /* ignore */ }
    if (reason !== 'pagehide') toast('環繞模式已關閉', 2000);
  };

  P.status = function () {
    if (!state) return { active: false };
    return Object.assign({ active: true }, state.engine.getStatus());
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'periphery:start':
        P.start(msg.plan, msg.settings).then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e) }));
        return true;
      case 'periphery:stop':
        P.stop('request');
        sendResponse({ ok: true });
        break;
      case 'periphery:status':
        sendResponse(P.status());
        break;
      case 'periphery:toast':
        toast(msg.text, msg.ms);
        sendResponse({ ok: true });
        break;
    }
  });
})();
