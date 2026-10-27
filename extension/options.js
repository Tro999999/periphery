(async function () {
  const $ = (s) => document.querySelector(s);
  const DEF = PERIPHERY_DEFAULTS;
  const ITEMS = PERIPHERY_ITEMS;
  const DISPLAY_KEYS = PERIPHERY_DISPLAY_KEYS;
  let settings = await peripheryLoadSettings();
  let custom = (await chrome.storage.local.get('customPreset')).customPreset || null;
  let engine = null;

  // ---------------------------------------------------------------- toast
  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
  }

  // ---------------------------------------------------------------- saving
  const pending = {};
  let saveTimer = 0;
  function queueSave(obj) {
    Object.assign(pending, obj);
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      const out = Object.assign({}, pending);
      for (const k in pending) delete pending[k];
      saveTimer = 0;
      chrome.storage.local.set(out);
    }, 60);
  }

  function apply(values, { save = true } = {}) {
    Object.assign(settings, values);
    for (const k in values) paint(k);
    if (engine) engine.updateSettings(values);
    if (save) queueSave(values);
    markPreset();
  }

  // ---------------------------------------------------------------- build UI
  const rows = {};
  const isChanged = (k) => {
    const it = ITEMS[k];
    const v = settings[k], d = DEF[k];
    if (typeof d === 'number') return Math.abs(v - d) > (it.step || 0.01) / 2;
    return String(v) !== String(d);
  };

  const groupsEl = $('#groups');
  for (const grp of PERIPHERY_SCHEMA) {
    const card = document.createElement('section');
    card.className = 'card';
    card.innerHTML = `<h2>${grp.title}</h2>`;
    for (const it of grp.items) {
      const item = document.createElement('div');
      item.className = 'item';
      const row = document.createElement('div');
      row.className = 'item-row' + (it.type === 'display' ? ' sel' : '');
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = it.label;
      row.appendChild(lbl);
      const reset = document.createElement('button');
      reset.className = 'reset';
      reset.title = '還原成預設值';
      reset.textContent = '↺';
      reset.addEventListener('click', () => apply({ [it.k]: DEF[it.k] }));

      if (it.type === 'display') {
        const sel = document.createElement('select');
        sel.addEventListener('change', () => apply({ [it.k]: sel.value }));
        row.appendChild(sel);
        row.appendChild(reset);
        rows[it.k] = { item, input: sel };
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'range';
        const tick = document.createElement('span');
        tick.className = 'tick';
        tick.title = '預設值';
        tick.style.left = `calc(8px + (100% - 16px) * ${(it.def - it.min) / (it.max - it.min)})`;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = it.min; input.max = it.max; input.step = it.step;
        input.setAttribute('aria-label', it.label);
        input.addEventListener('input', () => apply({ [it.k]: parseFloat(input.value) }));
        input.addEventListener('dblclick', () => apply({ [it.k]: DEF[it.k] }));
        wrap.appendChild(tick);
        wrap.appendChild(input);
        const val = document.createElement('span');
        val.className = 'val';
        row.appendChild(wrap);
        row.appendChild(val);
        row.appendChild(reset);
        rows[it.k] = { item, input, val };
      }
      item.appendChild(row);
      if (it.hint) {
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = it.hint;
        item.appendChild(hint);
      }
      card.appendChild(item);
    }
    groupsEl.appendChild(card);
  }

  function paint(k) {
    const r = rows[k];
    if (!r) return;
    const it = ITEMS[k];
    const v = settings[k];
    if (it.type === 'display') {
      r.input.value = String(v);
      if (r.input.value !== String(v)) r.input.value = 'auto';
    } else {
      r.input.value = v;
      const p = ((v - it.min) / (it.max - it.min)) * 100;
      r.input.style.setProperty('--p', Math.max(0, Math.min(100, p)) + '%');
      r.val.textContent = it.fmt ? it.fmt(v) : String(v);
    }
    r.item.classList.toggle('changed', isChanged(k));
  }

  // ---------------------------------------------------------------- presets
  function valuesEqual(vals) {
    for (const k in vals) {
      const d = vals[k], v = settings[k];
      if (typeof d === 'number' ? Math.abs(v - d) > 1e-4 : String(v) !== String(d)) return false;
    }
    return true;
  }
  function renderPresets() {
    const list = $('#presetList');
    list.innerHTML = '';
    const all = PERIPHERY_PRESETS.map((p) => ({ id: p.id, name: p.name, desc: p.desc, values: peripheryPresetValues(p.id) }));
    if (custom) all.push({ id: 'custom', name: '我的設定', desc: '', values: custom });
    for (const p of all) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.id = p.id;
      b.innerHTML = p.name + (p.desc ? `<small>${p.desc}</small>` : '');
      b.addEventListener('click', () => {
        apply(Object.assign({}, p.values));
        toast(`已套用「${p.name}」`);
      });
      b._values = p.values;
      list.appendChild(b);
    }
    markPreset();
  }
  function markPreset() {
    let found = false;
    for (const b of document.querySelectorAll('#presetList .chip')) {
      const on = !found && valuesEqual(b._values);
      if (on) found = true;
      b.classList.toggle('active', on);
    }
  }
  $('#saveCustom').addEventListener('click', async () => {
    custom = {};
    for (const k in DEF) if (!DISPLAY_KEYS.includes(k)) custom[k] = settings[k];
    await chrome.storage.local.set({ customPreset: custom });
    renderPresets();
    toast('已存成「我的設定」');
  });
  $('#resetAll').addEventListener('click', () => {
    apply(Object.assign({}, DEF));
    toast('已全部還原成預設值');
  });

  // ---------------------------------------------------------------- displays & shortcut
  async function loadDisplays() {
    let info = null;
    try {
      const win = await chrome.windows.getCurrent();
      info = await chrome.runtime.sendMessage({ type: 'popup:displays', windowId: win.id });
    } catch (e) { /* ignore */ }
    for (const k of DISPLAY_KEYS) {
      const sel = rows[k].input;
      sel.innerHTML = '';
      const add = (value, label) => {
        const o = document.createElement('option');
        o.value = value; o.textContent = label;
        sel.appendChild(o);
      };
      add('auto', '自動偵測');
      add('none', '不使用');
      if (info && info.displays) {
        info.displays.forEach((d, i) => {
          const tag = d.center ? '（目前視窗所在）' : d.isPrimary ? '（主要）' : '';
          add(d.id, `螢幕 ${i + 1}・${d.bounds.width}×${d.bounds.height}${tag}`);
        });
      }
      paint(k);
    }
  }
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-surround');
    $('#shortcut').textContent = (cmd && cmd.shortcut) || '尚未設定';
  } catch (e) { /* ignore */ }
  $('#shortcutsLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // ---------------------------------------------------------------- sync with other pages (popup)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.customPreset) { custom = changes.customPreset.newValue || null; renderPresets(); }
    const upd = {};
    for (const k in changes) {
      if (!(k in DEF)) continue;
      const v = changes[k].newValue;
      if (v !== undefined && v !== settings[k] && !(k in pending)) upd[k] = v;
    }
    if (Object.keys(upd).length) apply(upd, { save: false });
  });

  // ---------------------------------------------------------------- live preview
  const video = $('#pvVideo');
  try {
    engine = new PeripheryEngine(video, { left: $('#pvLeft'), right: $('#pvRight') }, settings, { aspect: 16 / 9 });
    engine.start();
  } catch (e) {
    $('#pvNote').textContent = '這台電腦無法顯示預覽（WebGL2 不可用）';
  }
  video.play().catch(() => {});
  const playBtn = $('#pvPlay');
  const syncPlay = () => { playBtn.textContent = video.paused ? '播放' : '暫停'; };
  playBtn.addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); });
  video.addEventListener('play', syncPlay);
  video.addEventListener('pause', syncPlay);
  let ownUrl = null;
  $('#pvFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (ownUrl) URL.revokeObjectURL(ownUrl);
    ownUrl = URL.createObjectURL(f);
    video.src = ownUrl;
    video.play().catch(() => {});
    $('#pvNote').textContent = '即時預覽：' + f.name;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
  });

  for (const k in DEF) paint(k);
  renderPresets();
  loadDisplays();
})();
