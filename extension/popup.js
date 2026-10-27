(async function () {
  const $ = (s) => document.querySelector(s);
  const btn = $('#toggle');
  const statusEl = $('#status');
  const DEF = PERIPHERY_DEFAULTS;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab ? tab.id : null;
  const url = (tab && tab.url) || '';
  let isPlayer = url.startsWith(chrome.runtime.getURL('player.html'));
  if (!url && tabId != null) {
    // URL may be hidden for some tabs; the built-in player answers status requests itself
    try { isPlayer = !!(await chrome.runtime.sendMessage({ type: 'player:status', tabId })); } catch (e) { /* not the player */ }
  }
  const supported = isPlayer || /^(https?|file):/.test(url);
  let settings = await peripheryLoadSettings();
  let custom = (await chrome.storage.local.get('customPreset')).customPreset || null;
  let plan = null;
  let lastMsg = '';
  let needPerm = false;

  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-surround');
    $('.kbd').textContent = (cmd && cmd.shortcut) || '設定快捷鍵';
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------- main sliders (from schema)
  const slidersEl = $('#sliders');
  const inputs = {};
  for (const grp of PERIPHERY_SCHEMA) {
    for (const it of grp.items) {
      if (!it.main) continue;
      const row = document.createElement('label');
      row.className = 'row';
      row.title = it.hint || '';
      row.innerHTML = `<span>${it.label}</span><input type="range" min="${it.min}" max="${it.max}" step="${it.step}"><output></output>`;
      const input = row.querySelector('input');
      input.dataset.k = it.k;
      input.addEventListener('input', () => {
        settings[it.k] = parseFloat(input.value);
        paint(it.k);
        save({ [it.k]: settings[it.k] });
        markPreset();
      });
      input.addEventListener('dblclick', () => {
        settings[it.k] = DEF[it.k];
        paint(it.k);
        save({ [it.k]: settings[it.k] });
        markPreset();
      });
      slidersEl.appendChild(row);
      inputs[it.k] = input;
    }
  }
  function paint(k) {
    const input = inputs[k];
    if (!input) return;
    const it = PERIPHERY_ITEMS[k];
    input.value = settings[k];
    const p = ((settings[k] - it.min) / (it.max - it.min)) * 100;
    input.style.setProperty('--p', Math.max(0, Math.min(100, p)) + '%');
    input.nextElementSibling.textContent = it.fmt(settings[k]);
    input.parentElement.classList.toggle('changed', Math.abs(settings[k] - DEF[k]) > it.step / 2);
  }
  const pending = {};
  let saveTimer = 0;
  function save(obj) {
    Object.assign(pending, obj);
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      const out = Object.assign({}, pending);
      for (const key in pending) delete pending[key];
      saveTimer = 0;
      chrome.storage.local.set(out);
    }, 50);
  }
  const paintAll = () => { for (const k in inputs) paint(k); markPreset(); };

  // ---------------------------------------------------------------- presets
  function renderPresets() {
    const el = $('#presets');
    el.innerHTML = '';
    const all = PERIPHERY_PRESETS.map((p) => ({ name: p.name, values: peripheryPresetValues(p.id) }));
    if (custom) all.push({ name: '我的設定', values: custom });
    for (const p of all) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = p.name;
      b._values = p.values;
      b.addEventListener('click', () => {
        Object.assign(settings, p.values);
        save(p.values);
        paintAll();
      });
      el.appendChild(b);
    }
    markPreset();
  }
  function markPreset() {
    let found = false;
    for (const b of document.querySelectorAll('#presets .chip')) {
      let eq = true;
      for (const k in b._values) {
        const d = b._values[k];
        if (typeof d === 'number' ? Math.abs(settings[k] - d) > 1e-4 : String(settings[k]) !== String(d)) { eq = false; break; }
      }
      b.classList.toggle('active', eq && !found);
      if (eq) found = true;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.customPreset) { custom = changes.customPreset.newValue || null; renderPresets(); }
    let any = false;
    for (const k in changes) {
      if (k in DEF && !(k in pending) && changes[k].newValue !== undefined) { settings[k] = changes[k].newValue; any = true; }
    }
    if (any) paintAll();
  });

  // ---------------------------------------------------------------- displays glyph
  async function loadPlan() {
    try {
      const info = await chrome.runtime.sendMessage({ type: 'popup:displays', windowId: tab.windowId });
      plan = info && info.plan;
    } catch (e) { /* ignore */ }
  }
  function paintGlyph(st) {
    for (const el of document.querySelectorAll('.scr.side')) {
      const side = el.dataset.side;
      el.classList.toggle('found', !!(plan && !plan.preview && plan.sides.includes(side)));
      el.classList.toggle('on', !!(st && st.active && (st.sides || []).includes(side)));
    }
  }

  // ---------------------------------------------------------------- toggle / status
  const REASONS = {
    novideo: '找不到影片，請先在這個分頁播放影片。',
    drm: '這部影片受 DRM 保護（Netflix 等），無法使用。',
    blocked: '側邊視窗被彈出式視窗封鎖擋住了，請允許此網站的彈出式視窗。',
    unsupported: '這個頁面無法使用，請在影片網站上開啟。',
    fileaccess: '本機檔案需要到 chrome://extensions 開啟「允許存取檔案網址」，或改用本機播放器。',
    inject: '無法在這個頁面上執行（瀏覽器限制的頁面）。',
    engine: '啟動失敗，請重新整理頁面再試一次。',
    needperm: '影片在嵌入式播放器裡，需要額外授權才能讀取。',
  };
  function describePlan() {
    if (!plan) return '';
    if (plan.preview) return '<span class="warn">沒有偵測到左右側螢幕</span>，會以預覽視窗開啟';
    const names = plan.sides.map((s) => (s === 'left' ? '左側' : '右側')).join('、');
    return `已偵測到 <b>${names}</b> 螢幕`;
  }

  async function refresh() {
    if (!supported) {
      btn.disabled = true;
      btn.textContent = '開啟環繞模式';
      statusEl.innerHTML = REASONS.unsupported;
      return;
    }
    if (needPerm) return;
    let st = null;
    try {
      st = await chrome.runtime.sendMessage({ type: isPlayer ? 'player:status' : 'popup:status', tabId });
    } catch (e) { /* ignore */ }
    const active = !!(st && st.active);
    btn.disabled = false;
    btn.classList.toggle('on', active);
    btn.textContent = active ? '關閉環繞模式' : '開啟環繞模式';
    if (active) {
      const e = (st && st.engine) || {};
      const bits = [st.preview ? '預覽視窗' : '運作中'];
      if (e.aspect) bits.push(`畫面 ${e.aspect.toFixed(2)}:1`);
      if (e.mode === '2d') bits.push('相容模式');
      if (e.vel && Math.abs(e.vel.x) > 0.0015) bits.push(e.vel.x < 0 ? '鏡頭 →' : '鏡頭 ←');
      statusEl.innerHTML = bits.join('・');
      paintGlyph({ active: true, sides: st.sides || e.sides || [] });
    } else {
      statusEl.innerHTML = lastMsg || describePlan() || '&nbsp;';
      paintGlyph(null);
    }
  }

  async function doToggle() {
    btn.disabled = true;
    lastMsg = '';
    let res = null;
    try { res = await chrome.runtime.sendMessage({ type: 'popup:toggle', tabId }); } catch (e) { /* ignore */ }
    if (res && res.ok === false) {
      if (res.reason === 'needperm') {
        needPerm = true;
        btn.disabled = false;
        btn.classList.remove('on');
        btn.textContent = '授權並開啟';
        statusEl.innerHTML = `<span class="warn">${REASONS.needperm}</span>`;
        return;
      }
      lastMsg = `<span class="warn">${REASONS[res.reason] || '無法開啟：' + (res.reason || '未知錯誤')}</span>`;
    }
    setTimeout(refresh, 400);
  }

  btn.addEventListener('click', async () => {
    if (needPerm) {
      // must be called directly from the click (user gesture)
      const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
      needPerm = false;
      if (!ok) { lastMsg = '<span class="warn">沒有授權，無法讀取嵌入式播放器的影片。</span>'; refresh(); return; }
    }
    doToggle();
  });

  $('#reset').addEventListener('click', () => {
    settings = Object.assign({}, DEF);
    save(Object.assign({}, DEF));
    paintAll();
  });
  $('#options').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
  $('#player').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('player.html') });
    window.close();
  });

  paintAll();
  renderPresets();
  await loadPlan();
  await refresh();
  setInterval(refresh, 1000);
})();
