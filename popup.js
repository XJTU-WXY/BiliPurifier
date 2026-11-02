const Core = window.BiliPurifierCore;
const SESSION_KEY = 'enabled';

const ICONS = {
  ad: '<path d="M3 6.4v3.2a1 1 0 0 0 1 1h1.6L9.4 13V3L5.6 5.4H4a1 1 0 0 0-1 1Z"/><path d="M11.4 6.2a2.6 2.6 0 0 1 0 3.6"/>',
  live: '<circle cx="8" cy="8" r="2"/><path d="M5.2 4.7a4.6 4.6 0 0 0 0 6.6"/><path d="M10.8 4.7a4.6 4.6 0 0 1 0 6.6"/>',
  title: '<path d="M3 4.3h10"/><path d="M3 8h7"/><path d="M3 11.7h8.4"/>',
  up: '<circle cx="8" cy="5.7" r="2.2"/><path d="M3.9 12.6a4.5 4.5 0 0 1 8.2 0"/>',
  comment: '<rect x="2.7" y="3.5" width="10.6" height="7.2" rx="2"/><path d="M5.9 10.7 4.7 12.9v-2.2"/>',
  commenter: '<rect x="2.6" y="3.4" width="10.8" height="9.2" rx="2"/><circle cx="8" cy="6.9" r="1.7"/><path d="M5.5 11.4a2.9 2.9 0 0 1 5 0"/>',
  mention: '<circle cx="8" cy="8" r="2.3"/><path d="M10.3 6.2v2.5a1.4 1.4 0 0 0 2.8 0V8a5.1 5.1 0 1 0-2 4"/>',
  section: '<rect x="3" y="3" width="4" height="4" rx="1"/><rect x="9" y="3" width="4" height="4" rx="1"/><rect x="3" y="9" width="4" height="4" rx="1"/><rect x="9" y="9" width="4" height="4" rx="1"/>',
  stat: '<path d="M3.6 12.4V9.4"/><path d="M8 12.4V5.2"/><path d="M12.4 12.4V7.4"/>',
  duration: '<circle cx="8" cy="8" r="5.2"/><path d="M8 5.1V8l2.1 1.4"/>'
};

const CATEGORIES = [
  { key: 'title', label: '视频标题命中' },
  { key: 'up', label: 'UP 主昵称命中' },
  { key: 'section', label: '分区命中' },
  { key: 'duration', label: '时长过短' },
  { key: 'stat', label: '统计数据不达标' },
  { key: 'ad', label: '广告' },
  { key: 'live', label: '直播 / 活动' },
  { key: 'comment', label: '评论内容命中' },
  { key: 'commenter', label: '评论者昵称命中' },
  { key: 'mention', label: '评论中 @ 他人' },
];

let currentSettings = null;
let settingsLoaded = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconNode(key) {
  const span = el('span', 'stat-icon');
  span.innerHTML =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
    (ICONS[key] || '') +
    '</svg>';
  return span;
}

function setTotal(count, available) {
  document.getElementById('total').textContent = available ? count + ' 条' : '—';
}

function renderStats(payload) {
  const byKey = {};
  const available = !!(payload && payload.categories);
  if (available) {
    payload.categories.forEach((item) => {
      byKey[item.key] = item;
    });
  }

  const box = document.getElementById('stats');
  box.innerHTML = '';

  let total = 0;
  CATEGORIES.forEach((meta) => {
    const data = byKey[meta.key] || {};
    const count = data.count || 0;
    total += count;

    const row = el('div', 'stat-row' + (count ? '' : ' is-zero'));
    row.appendChild(iconNode(meta.key));
    row.appendChild(el('span', 'stat-label', meta.label));
    row.appendChild(el('b', 'stat-count', String(count)));
    box.appendChild(row);
  });

  setTotal(total, available);
}

function requestStats() {
  if (!chrome.tabs || !chrome.tabs.query) {
    renderStats(null);
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id === undefined || tab.id === null) {
      renderStats(null);
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'BILIPURIFIER_STATS' }, (response) => {
      renderStats(chrome.runtime.lastError ? null : response);
    });
  });
}

// ==================== 总开关 ====================
function sessionGet(key) {
  return new Promise((resolve) => {
    if (!chrome.storage || !chrome.storage.session) {
      resolve(undefined);
      return;
    }
    chrome.storage.session.get([key], (data) => {
      if (chrome.runtime.lastError) resolve(undefined);
      else resolve(data ? data[key] : undefined);
    });
  });
}

function sessionSet(value) {
  if (!chrome.storage || !chrome.storage.session) return;
  chrome.storage.session.set({ [SESSION_KEY]: value });
}

function applyEnabledUI(enabled) {
  document.getElementById('enabled').checked = enabled;
  document.getElementById('body').classList.toggle('is-off', !enabled);
}

async function initEnabledSwitch() {
  const stored = await sessionGet(SESSION_KEY);
  applyEnabledUI(stored !== false);

  document.getElementById('enabled').addEventListener('change', (event) => {
    const enabled = event.target.checked;
    applyEnabledUI(enabled);
    sessionSet(enabled);
  });
}

// ==================== 屏蔽方式 ====================
function applyBlockMode(mode) {
  document.querySelectorAll('input[name="blockMode"]').forEach((input) => {
    input.checked = input.value === mode;
  });
}

function payloadOf(settings) {
  return {
    titleBlock: settings.titleBlock,
    titleAllow: settings.titleAllow,
    upBlock: settings.upBlock,
    upAllow: settings.upAllow,
    commentTextBlock: settings.commentTextBlock,
    commentTextAllow: settings.commentTextAllow,
    commentUserBlock: settings.commentUserBlock,
    commentUserAllow: settings.commentUserAllow,
    blockMention: settings.blockMention,
    sectionRules: settings.sectionRules,
    durationSec: settings.durationSec,
    statExpr: settings.statExpr,
    blockMode: settings.blockMode,
    cleanAd: settings.cleanAd,
    cleanLive: settings.cleanLive,
    preloadEnabled: settings.preloadEnabled,
    preloadScreens: settings.preloadScreens
  };
}

async function loadSettings() {
  try {
    const raw = await window.syncManager.loadSettings();
    return Core.normalizeSettings(raw);
  } catch (error) {
    return Core.normalizeSettings({});
  }
}

async function setBlockMode(mode) {
  if (!settingsLoaded) return;
  if (currentSettings.blockMode === mode) return;
  currentSettings.blockMode = mode;
  try {
    await window.syncManager.saveSettings(payloadOf(currentSettings));
  } catch (error) {
    console.error('保存屏蔽方式失败:', error);
  }
}

async function initModeSwitch() {
  document.querySelectorAll('input[name="blockMode"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) setBlockMode(input.value);
    });
  });

  currentSettings = await loadSettings();
  settingsLoaded = true;
  applyBlockMode(currentSettings.blockMode);
}

function init() {
  renderStats(null);
  initEnabledSwitch();
  initModeSwitch();
  requestStats();

  document.getElementById('openOptions').addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
    window.close();
  });
}

document.addEventListener('DOMContentLoaded', init);
