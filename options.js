const Core = window.BiliPurifierCore;

const LIST_FIELDS = [
  'titleBlock', 'titleAllow',
  'upBlock', 'upAllow',
  'commentTextBlock', 'commentTextAllow',
  'commentUserBlock', 'commentUserAllow',
  'sectionRules'
];

const PRESETS = [
  { label: '播放过万', expr: 'play >= 10000' },
  { label: '赞播比 5% 以上', expr: 'like / play >= 0.05' },
  { label: '有讨论热度', expr: 'danmaku >= 100 and reply >= 50' },
  { label: '投币收藏率各 2%', expr: 'coin / play >= 0.02 and favorite / play >= 0.02' },
  { label: '综合互动率 10%', expr: '(like + coin * 2 + favorite * 2) / play >= 0.1' },
];

let draft = null;
let toastTimer = null;

function cloneList(list) {
  return Core.normalizeList(list).map((entry) => ({ pattern: entry.pattern, regex: !!entry.regex }));
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

// ==================== 语法高亮 ====================
function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

// 逐字符扫描正则，按语法成分着色：转义、字符组、分组、量词、锚点、分支、通配点
function highlightPattern(pattern) {
  let out = '';
  let i = 0;

  const push = (cls, text) => {
    out += cls ? '<span class="' + cls + '">' + escapeHtml(text) + '</span>' : escapeHtml(text);
  };

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '\\' && i + 1 < pattern.length) {
      push('tok-esc', pattern.slice(i, i + 2));
      i += 2;
      continue;
    }

    if (ch === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j += 1;
      if (pattern[j] === ']') j += 1;
      while (j < pattern.length && pattern[j] !== ']') {
        if (pattern[j] === '\\') j += 1;
        j += 1;
      }
      j = Math.min(j + 1, pattern.length);
      push('tok-class', pattern.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '(') {
      let j = i + 1;
      if (pattern[j] === '?') {
        while (j < pattern.length && pattern[j] !== ':' && pattern[j] !== ')') {
          if (pattern[j] === '>') { j += 1; break; }
          j += 1;
        }
        if (pattern[j] === ':') j += 1;
      }
      push('tok-group', pattern.slice(i, j));
      i = j;
      continue;
    }

    if (ch === ')') { push('tok-group', ch); i += 1; continue; }
    if (ch === '|') { push('tok-alt', ch); i += 1; continue; }
    if (ch === '^' || ch === '$') { push('tok-anchor', ch); i += 1; continue; }
    if (ch === '*' || ch === '+' || ch === '?') { push('tok-quant', ch); i += 1; continue; }

    if (ch === '{') {
      const match = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i));
      if (match) {
        push('tok-quant', match[0]);
        i += match[0].length;
        continue;
      }
    }

    if (ch === '.') { push('tok-dot', ch); i += 1; continue; }

    push('', ch);
    i += 1;
  }

  return out;
}

// 一行一条：首尾都被 / 包裹的行按正则着色，其余按普通关键词显示
function highlightRuleText(text) {
  const source = String(text == null ? '' : text);
  const lines = source.split('\n');

  const html = lines.map((line) => {
    const trimmed = line.trim();
    const isRegex = trimmed.length > 2 && trimmed.charAt(0) === '/' && trimmed.charAt(trimmed.length - 1) === '/';
    if (!isRegex) return escapeHtml(line);

    const start = line.indexOf('/');
    const end = line.lastIndexOf('/');
    const pattern = line.slice(start + 1, end);
    const body = escapeHtml(line.slice(0, start)) +
      '<span class="tok-delim">/</span>' +
      highlightPattern(pattern) +
      '<span class="tok-delim">/</span>' +
      escapeHtml(line.slice(end + 1));

    try {
      new RegExp(pattern);
      return body;
    } catch (error) {
      return '<span class="tok-invalid">' + body + '</span>';
    }
  }).join('\n');

  return html.endsWith('\n') || !html ? html + '\u200b' : html;
}

function editorOf(field) {
  return document.querySelector('[data-field="' + field + '"]');
}

function highlightOf(field) {
  return document.querySelector('[data-hl="' + field + '"]');
}

function gutterOf(field) {
  return document.querySelector('[data-gutter="' + field + '"]');
}

function statusOf(field) {
  return document.querySelector('[data-status="' + field + '"]');
}

function tallyOf(field) {
  return document.querySelector('[data-tally="' + field + '"]');
}

function regexErrorMessage(error) {
  return String(error && error.message ? error.message : error)
    .replace(/^Invalid regular expression:\s*\/[\s\S]*\/:\s*/, '')
    .trim();
}

function validateField(field) {
  const area = editorOf(field);
  const status = statusOf(field);
  if (!area || !status) return null;

  const lines = area.value.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!(trimmed.length > 2 && trimmed.charAt(0) === '/' && trimmed.charAt(trimmed.length - 1) === '/')) continue;
    try {
      new RegExp(trimmed.slice(1, -1));
    } catch (error) {
      status.textContent = '第 ' + (index + 1) + ' 行正则无效：' + regexErrorMessage(error);
      return { line: index + 1, pattern: trimmed.slice(1, -1), message: regexErrorMessage(error) };
    }
  }

  status.textContent = '';
  return null;
}

// 行号列随文本行数增长，并跟随文本域的纵向滚动
function syncGutter(field) {
  const area = editorOf(field);
  const gutter = gutterOf(field);
  const highlight = highlightOf(field);
  if (!area || !gutter || !highlight) return;

  const lines = area.value.split('\n').length;
  let text = '';
  for (let index = 1; index <= lines; index += 1) {
    text += (index === 1 ? '' : '\n') + index;
  }
  if (gutter.textContent !== text) gutter.textContent = text;

  area.closest('.editor').style.setProperty('--gutter-w', gutter.offsetWidth + 'px');

  // 横向滚动条占去可视高度后，两侧的底部留白同步补足，纵向滚动范围才与文本域一致
  const bar = Math.max(0, area.offsetHeight - area.clientHeight);
  const paddingBottom = (10 + bar) + 'px';
  if (gutter.style.paddingBottom !== paddingBottom) {
    gutter.style.paddingBottom = paddingBottom;
    highlight.style.paddingBottom = paddingBottom;
  }

  gutter.scrollTop = area.scrollTop;
}

function renderEditor(field, options) {
  const area = editorOf(field);
  const highlight = highlightOf(field);
  if (!area || !highlight) return;

  highlight.innerHTML = highlightRuleText(area.value);
  syncGutter(field);
  highlight.scrollTop = area.scrollTop;
  highlight.scrollLeft = area.scrollLeft;
  if (!options || options.validate !== false) validateField(field);

  const tally = tallyOf(field);
  if (tally) {
    const rules = Core.parseRuleText(area.value);
    const regexCount = rules.filter((rule) => rule.regex).length;
    if (!rules.length) {
      tally.textContent = '';
    } else if (regexCount === rules.length) {
      tally.textContent = rules.length + ' 条正则';
    } else {
      tally.textContent = rules.length + ' 条' + (regexCount ? ' · ' + regexCount + ' 条正则' : '');
    }
  }
}

function renderAllEditors() {
  LIST_FIELDS.forEach((field) => renderEditor(field));
}

// ==================== 统计表达式 ====================
function validateExpr() {
  const status = document.getElementById('exprStatus');
  const result = Core.compileExpression(draft.statExpr);

  if (result.empty) {
    status.className = 'expr-status';
    status.textContent = '';
    return;
  }
  if (result.ok) {
    status.className = 'expr-status ok';
    if (result.variables.length) {
      const names = result.variables.map((name) => Core.VARIABLE_LABELS[name] || name).join('、');
      status.textContent = '表达式有效 · 使用 ' + names;
    } else {
      status.textContent = '表达式有效';
    }
    return;
  }
  status.className = 'expr-status err';
  status.textContent = result.error;
}

function insertAtCursor(text) {
  const area = document.getElementById('statExpr');
  const start = area.selectionStart || 0;
  const end = area.selectionEnd || 0;
  area.value = area.value.slice(0, start) + text + area.value.slice(end);
  area.selectionStart = start + text.length;
  area.selectionEnd = start + text.length;
  area.focus();
  draft.statExpr = area.value;
  validateExpr();
}

function setExpression(text) {
  const area = document.getElementById('statExpr');
  area.value = text;
  draft.statExpr = text;
  validateExpr();
  area.focus();
}

function renderChips() {
  const varBox = document.getElementById('varChips');
  varBox.innerHTML = '';
  Core.VARIABLES.forEach((name) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = name;
    chip.title = Core.VARIABLE_LABELS[name] + '，点击插入';
    chip.addEventListener('click', () => insertAtCursor(name));
    varBox.appendChild(chip);
  });

  const presetBox = document.getElementById('presetChips');
  presetBox.innerHTML = '';
  PRESETS.forEach((preset) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = preset.label;
    chip.title = preset.expr;
    chip.addEventListener('click', () => setExpression(preset.expr));
    presetBox.appendChild(chip);
  });
}

function syncModeUI() {
  document.querySelectorAll('.mode-option').forEach((label) => {
    const input = label.querySelector('input');
    label.classList.toggle('is-active', input.checked);
  });
}

function syncPreloadUI() {
  const enabled = !!draft.preloadEnabled;
  document.getElementById('preloadEnabled').checked = enabled;
  document.getElementById('preloadScreens').disabled = !enabled;
}

async function refreshSyncStatus() {
  const box = document.getElementById('syncStatus');
  let status;
  try {
    status = await window.syncManager.getSyncStatus();
  } catch (error) {
    box.textContent = '同步不可用';
    return;
  }
  const localTime = status.localVersion ? new Date(status.localVersion).toLocaleString() : '—';
  const cloudTime = status.cloudVersion ? new Date(status.cloudVersion).toLocaleString() : '—';
  const sizeKb = (status.payloadSize / 1024).toFixed(1);
  const limitKb = Math.round(status.payloadLimit / 1024);

  box.innerHTML = '';
  const items = [
    ['本机更新', localTime],
    ['云端更新', cloudTime],
    ['规则体积', sizeKb + ' KB / 上限 ' + limitKb + ' KB'],
  ];
  items.forEach(([name, value]) => {
    const span = document.createElement('span');
    span.innerHTML = name + ' <b>' + value + '</b>';
    box.appendChild(span);
  });

  if (status.payloadSize > status.payloadLimit) {
    const warn = document.createElement('span');
    warn.style.color = '#d9534f';
    warn.innerHTML = '规则体积超出上限，云端同步已暂停';
    box.appendChild(warn);
  }
}

function buildPayload() {
  const payload = {
    durationSec: Math.max(0, Math.round(Number(draft.durationSec) || 0)),
    statExpr: String(draft.statExpr || '').trim(),
    blockMode: draft.blockMode,
    blockMention: !!draft.blockMention,
    cleanAd: !!draft.cleanAd,
    cleanLive: !!draft.cleanLive,
    preloadEnabled: !!draft.preloadEnabled,
    preloadScreens: Core.clampCount(draft.preloadScreens, Core.DEFAULTS.preloadScreens, 12),
  };
  LIST_FIELDS.forEach((field) => {
    payload[field] = draft[field];
  });
  return payload;
}

async function saveSettings() {
  const payload = buildPayload();

  const expression = Core.compileExpression(payload.statExpr);
  if (!expression.ok) {
    showToast('统计表达式有误，请先修正');
    return;
  }

  for (const field of LIST_FIELDS) {
    const problem = validateField(field);
    if (problem) {
      showToast('第 ' + problem.line + ' 行正则无效：' + problem.message);
      editorOf(field).focus();
      return;
    }
  }

  await window.syncManager.saveSettings(payload);
  showToast('设置已保存');
  refreshSyncStatus();
}

function bindEvents() {
  LIST_FIELDS.forEach((field) => {
    const area = editorOf(field);
    const highlight = highlightOf(field);
    if (!area || !highlight) return;

    area.addEventListener('input', () => {
      draft[field] = Core.parseRuleText(area.value);
      renderEditor(field);
    });

    area.addEventListener('scroll', () => {
      highlight.scrollTop = area.scrollTop;
      highlight.scrollLeft = area.scrollLeft;
      const gutter = gutterOf(field);
      if (gutter) gutter.scrollTop = area.scrollTop;
    });

    // 中文输入法组合期间显示原文，结束后恢复高亮层
    area.addEventListener('compositionstart', () => {
      area.classList.add('is-composing');
      area.closest('.editor').classList.add('is-composing');
    });

    area.addEventListener('compositionend', () => {
      area.classList.remove('is-composing');
      area.closest('.editor').classList.remove('is-composing');
      renderEditor(field);
    });

    area.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      const start = area.selectionStart;
      const end = area.selectionEnd;
      area.value = area.value.slice(0, start) + '  ' + area.value.slice(end);
      area.selectionStart = start + 2;
      area.selectionEnd = start + 2;
      draft[field] = Core.parseRuleText(area.value);
      renderEditor(field);
    });
  });

  const area = document.getElementById('statExpr');
  area.addEventListener('input', () => {
    draft.statExpr = area.value;
    validateExpr();
  });

  document.querySelectorAll('input[name="blockMode"]').forEach((input) => {
    input.addEventListener('change', () => {
      draft.blockMode = input.value;
      syncModeUI();
    });
  });

  document.getElementById('durationSec').addEventListener('input', (event) => {
    draft.durationSec = Math.max(0, Math.round(Number(event.target.value) || 0));
  });

  document.getElementById('blockMention').addEventListener('change', (event) => {
    draft.blockMention = event.target.checked;
  });

  document.getElementById('cleanAd').addEventListener('change', (event) => {
    draft.cleanAd = event.target.checked;
  });

  document.getElementById('cleanLive').addEventListener('change', (event) => {
    draft.cleanLive = event.target.checked;
  });

  document.getElementById('preloadEnabled').addEventListener('change', (event) => {
    draft.preloadEnabled = event.target.checked;
    syncPreloadUI();
  });

  document.getElementById('preloadScreens').addEventListener('input', (event) => {
    draft.preloadScreens = Core.clampCount(event.target.value, Core.DEFAULTS.preloadScreens, 12);
  });

  document.getElementById('syncEnabled').addEventListener('change', async (event) => {
    await window.syncManager.setSyncEnabled(event.target.checked);
    if (event.target.checked) {
      await window.syncManager.manualSync();
    }
    refreshSyncStatus();
  });

  document.getElementById('manualSync').addEventListener('click', async (event) => {
    const button = event.target;
    button.disabled = true;
    button.textContent = '同步中…';
    try {
      await window.syncManager.manualSync();
      const raw = await window.syncManager.loadSettings();
      applySettingsToDraft(Core.normalizeSettings(raw));
      renderForm();
      showToast('已同步');
      refreshSyncStatus();
    } catch (error) {
      showToast('同步失败，请重试');
    } finally {
      button.disabled = false;
      button.textContent = '立即同步';
    }
  });

  document.getElementById('clearCloud').addEventListener('click', async () => {
    try {
      await window.syncManager.clearCloudData();
      showToast('云端数据已清除');
      refreshSyncStatus();
    } catch (error) {
      showToast('清除失败，请重试');
    }
  });

  document.getElementById('save').addEventListener('click', saveSettings);

  document.getElementById('exportConfig').addEventListener('click', exportConfig);

  document.getElementById('importConfig').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });

  document.getElementById('importFile').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    importConfig(file);
  });
}

// ==================== 配置文件 ====================
const CONFIG_KEYS = [
  'titleBlock', 'titleAllow', 'upBlock', 'upAllow',
  'commentTextBlock', 'commentTextAllow', 'commentUserBlock', 'commentUserAllow',
  'blockMention', 'sectionRules', 'durationSec', 'statExpr',
  'blockMode', 'cleanAd', 'cleanLive',
  'preloadEnabled', 'preloadScreens',
];

function exportConfig() {
  const payload = buildPayload();
  const settings = {};
  CONFIG_KEYS.forEach((key) => {
    if (key in payload) settings[key] = payload[key];
  });

  const data = {
    app: 'BiliPurifier',
    format: 1,
    exportedAt: new Date().toISOString(),
    settings: settings,
  };

  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const today = new Date();
  const stamp = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('');
  link.href = url;
  link.download = 'bilipurifier-' + stamp + '.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('配置已导出');
}

async function importConfig(file) {
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    showToast('文件不是有效的 JSON');
    return;
  }

  const source = parsed && typeof parsed === 'object' && parsed.settings && typeof parsed.settings === 'object'
    ? parsed.settings
    : parsed;

  if (!source || typeof source !== 'object' || Array.isArray(source) || !CONFIG_KEYS.some((key) => key in source)) {
    showToast('文件里没有可识别的设置');
    return;
  }

  applySettingsToDraft(Core.normalizeSettings(source));
  renderForm();

  try {
    await window.syncManager.saveSettings(buildPayload());
  } catch (error) {
    showToast('导入失败，请重试');
    return;
  }

  refreshSyncStatus();
  showToast('配置已导入');
}

function renderForm() {
  LIST_FIELDS.forEach((field) => {
    editorOf(field).value = Core.formatRuleText(draft[field]);
  });
  renderAllEditors();

  document.getElementById('durationSec').value = draft.durationSec || 0;
  document.getElementById('statExpr').value = draft.statExpr || '';
  document.getElementById('blockMention').checked = !!draft.blockMention;
  document.getElementById('cleanAd').checked = !!draft.cleanAd;
  document.getElementById('cleanLive').checked = !!draft.cleanLive;
  document.getElementById('modeHide').checked = draft.blockMode !== 'placeholder';
  document.getElementById('modePlaceholder').checked = draft.blockMode === 'placeholder';
  document.getElementById('preloadScreens').value = draft.preloadScreens;
  syncModeUI();
  syncPreloadUI();
  validateExpr();
}

function applySettingsToDraft(settings) {
  LIST_FIELDS.forEach((field) => {
    draft[field] = cloneList(settings[field]);
  });
  draft.durationSec = settings.durationSec;
  draft.statExpr = settings.statExpr;
  draft.blockMode = settings.blockMode;
  draft.blockMention = settings.blockMention;
  draft.cleanAd = settings.cleanAd;
  draft.cleanLive = settings.cleanLive;
  draft.preloadEnabled = settings.preloadEnabled;
  draft.preloadScreens = settings.preloadScreens;
}

async function init() {
  let raw = {};
  try {
    const enabled = await window.syncManager.getSyncEnabled();
    document.getElementById('syncEnabled').checked = enabled;
    raw = await window.syncManager.loadSettings();
  } catch (error) {
    raw = {};
  }

  draft = {};
  applySettingsToDraft(Core.normalizeSettings(raw));

  renderChips();
  renderForm();
  bindEvents();
  refreshSyncStatus();
}

document.addEventListener('DOMContentLoaded', init);
