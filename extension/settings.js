// Shared settings schema for Periphery (loaded by content scripts, popup, options, player, background).
// The defaults below are the tuned "standard" look.
(function (g) {
  const pct = (v) => Math.round(v * 100) + '%';
  const x = (d) => (v) => v.toFixed(d) + '×';
  const signed = (v) => (v > 0 ? '+' : '') + Math.round(v * 100);

  // group -> items. `main: true` items also appear in the toolbar popup.
  const SCHEMA = [
    {
      id: 'picture', title: '畫面', items: [
        { k: 'brightness', label: '亮度', def: 0.75, min: 0.1, max: 1.3, step: 0.01, fmt: pct, main: true,
          hint: '側螢幕整體亮度。太亮會搶走注意力，建議 60–80%。' },
        { k: 'intensity', label: '效果強度', def: 1.0, min: 0, max: 1.6, step: 0.01, fmt: pct, main: true,
          hint: '0% 只剩柔和的色光；100% 為標準；更高會讓延伸出去的畫面細節更明顯。' },
        { k: 'contrast', label: '對比', def: 1.0, min: 0.5, max: 1.6, step: 0.01, fmt: pct,
          hint: '拉開亮部與暗部的差距。' },
        { k: 'saturation', label: '飽和度', def: 1.05, min: 0.3, max: 1.8, step: 0.01, fmt: pct,
          hint: '色彩濃淡。側螢幕面板若偏淡可以調高。' },
        { k: 'warmth', label: '色溫', def: 0, min: -1, max: 1, step: 0.01, fmt: signed,
          hint: '左右螢幕和主螢幕色調不同時用來對齊。正值偏暖，負值偏冷。' },
      ],
    },
    {
      id: 'clarity', title: '清晰度', items: [
        { k: 'sharpness', label: '清晰度', def: 0.5, min: 0, max: 1, step: 0.01, fmt: pct, main: true,
          hint: '靠近主螢幕那一側的清晰程度。越高越看得出延伸出去的細節。' },
        { k: 'blur', label: '模糊程度', def: 1.0, min: 0.3, max: 2, step: 0.01, fmt: x(2),
          hint: '整體模糊倍率，主要影響外側。越高越像柔和光暈。' },
        { k: 'spread', label: '光暈擴散', def: 1.0, min: 0.2, max: 2, step: 0.01, fmt: pct,
          hint: '邊緣顏色往外延伸時上下擴散的程度。越低越像水平光條，越高越像柔和光錐。' },
      ],
    },
    {
      id: 'extend', title: '延伸', items: [
        { k: 'stretch', label: '延伸倍率', def: 1.35, min: 1, max: 2.5, step: 0.01, fmt: x(2), main: true,
          hint: '側螢幕的畫面被拉寬的程度。越大包覆感越強，鏡頭移動在側邊看起來也越快。' },
        { k: 'outerFade', label: '外側亮度', def: 0.35, min: 0, max: 1, step: 0.01, fmt: pct,
          hint: '側螢幕最外緣相對於內側的亮度。' },
        { k: 'verticalFade', label: '上下漸暗', def: 0.6, min: 0, max: 1, step: 0.01, fmt: pct,
          hint: '電影有上下黑邊時，側螢幕對應區域的漸暗程度。' },
        { k: 'verticalOffset', label: '垂直位置', def: 0, min: -0.25, max: 0.25, step: 0.005, fmt: signed,
          hint: '側螢幕和主螢幕高度沒對齊時，用來上下微調延伸畫面。' },
      ],
    },
    {
      id: 'motion', title: '動態', items: [
        { k: 'motion', label: '跟隨鏡頭運動', def: 1.0, min: 0, max: 1.5, step: 0.01, fmt: pct, main: true,
          hint: '鏡頭搖動時，移出主畫面的內容會繼續滑到側螢幕上。設為 0 只保留靜態色光。' },
        { k: 'persistence', label: '殘影停留', def: 0.7, min: 0, max: 1, step: 0.01, fmt: pct,
          hint: '移出畫面的內容在側邊停留多久才淡回背景色。' },
        { k: 'responsiveness', label: '色彩反應速度', def: 0.45, min: 0.05, max: 1, step: 0.01, fmt: pct,
          hint: '側邊顏色跟上主畫面變化的速度。調低可以減少閃爍，調高反應更即時。' },
        { k: 'cutSensitivity', label: '場景切換靈敏度', def: 1.0, min: 0.3, max: 2, step: 0.01, fmt: pct,
          hint: '剪接時重置側邊畫面的靈敏度。誤判太多就調低，沒有反應就調高。' },
      ],
    },
    {
      id: 'screens', title: '螢幕', items: [
        { k: 'leftGain', label: '左側亮度', def: 1.0, min: 0.3, max: 1.5, step: 0.01, fmt: pct,
          hint: '左右兩台螢幕亮度不一致時分別微調。' },
        { k: 'rightGain', label: '右側亮度', def: 1.0, min: 0.3, max: 1.5, step: 0.01, fmt: pct,
          hint: '左右兩台螢幕亮度不一致時分別微調。' },
        { k: 'bezel', label: '螢幕邊框間距', def: 0.02, min: 0, max: 0.1, step: 0.002, fmt: (v) => (v * 100).toFixed(1) + '%',
          hint: '螢幕之間邊框的寬度（佔主螢幕寬度的比例），讓延伸位置更準確。' },
        { k: 'leftDisplay', label: '左側螢幕', def: 'auto', type: 'display' },
        { k: 'rightDisplay', label: '右側螢幕', def: 'auto', type: 'display' },
      ],
    },
    {
      id: 'quality', title: '效能與品質', items: [
        { k: 'renderScale', label: '渲染解析度', def: 1.0, min: 0.4, max: 1, step: 0.05, fmt: pct,
          hint: '側螢幕的渲染解析度。電腦較慢時可以調低，因為畫面本來就模糊，差異不大。' },
        { k: 'dither', label: '去色帶', def: 1.0, min: 0, max: 2, step: 0.05, fmt: pct,
          hint: '加入極細微雜訊，消除大面積漸層的一圈圈色階。' },
      ],
    },
  ];

  const DEFAULTS = {};
  const ITEMS = {};
  for (const grp of SCHEMA) for (const it of grp.items) { DEFAULTS[it.k] = it.def; ITEMS[it.k] = it; }
  const DISPLAY_KEYS = ['leftDisplay', 'rightDisplay'];

  // Presets only list what differs from the defaults; display assignment is never touched.
  const PRESETS = [
    { id: 'standard', name: '標準', desc: '預設值', values: {} },
    { id: 'soft', name: '柔和', desc: '低調、不搶戲', values: {
      brightness: 0.6, intensity: 0.75, sharpness: 0.3, blur: 1.25, outerFade: 0.25, saturation: 0.95, spread: 1.3, motion: 0.8 } },
    { id: 'vivid', name: '鮮明', desc: '包覆感最強', values: {
      brightness: 0.9, intensity: 1.25, contrast: 1.1, sharpness: 0.65, blur: 0.85, spread: 1.15, saturation: 1.2, outerFade: 0.5, stretch: 1.25, persistence: 0.8 } },
    { id: 'ambient', name: '純色光', desc: '類 Ambilight', values: {
      brightness: 0.65, intensity: 0, motion: 0, blur: 1.6, spread: 1.6, saturation: 1.15, sharpness: 0.2 } },
  ];

  function presetValues(id) {
    const p = PRESETS.find((x) => x.id === id);
    const out = {};
    for (const k in DEFAULTS) if (!DISPLAY_KEYS.includes(k)) out[k] = DEFAULTS[k];
    return Object.assign(out, p ? p.values : {});
  }

  g.PERIPHERY_SCHEMA = SCHEMA;
  g.PERIPHERY_DEFAULTS = DEFAULTS;
  g.PERIPHERY_ITEMS = ITEMS;
  g.PERIPHERY_PRESETS = PRESETS;
  g.PERIPHERY_DISPLAY_KEYS = DISPLAY_KEYS;
  g.peripheryPresetValues = presetValues;
  g.peripheryLoadSettings = async function () {
    try {
      const s = await chrome.storage.local.get(DEFAULTS);
      return Object.assign({}, DEFAULTS, s);
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  };
})(globalThis);
