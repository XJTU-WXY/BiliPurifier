// ==================== BiliPurifier 内容脚本 ====================
const Core = window.BiliPurifierCore;

const videoMetaCache = new Map();
let tidMapConfig = null;
let tidMapLoading = null;
const warnedTids = new Set();

let currentSettings = Core.normalizeSettings({});
let settingsReady = false;
let extensionEnabled = true;

// ==================== 会话总开关 ====================
function readExtensionEnabled() {
  return new Promise((resolve) => {
    if (!chrome.storage || !chrome.storage.session) {
      resolve(true);
      return;
    }
    try {
      chrome.storage.session.get(['enabled'], (data) => {
        if (chrome.runtime.lastError) {
          resolve(true);
          return;
        }
        resolve(!data || data.enabled !== false);
      });
    } catch (error) {
      resolve(true);
    }
  });
}

function watchExtensionEnabled() {
  if (!chrome.storage || !chrome.storage.session || !chrome.storage.session.onChanged) return;
  try {
    chrome.storage.session.onChanged.addListener((changes) => {
      if (!('enabled' in changes)) return;
      const next = changes.enabled.newValue !== false;
      if (next === extensionEnabled) return;
      extensionEnabled = next;
      clearAllMarks();
      removeUpBanButtons();
      if (extensionEnabled) scheduleScan(50);
    });
  } catch (error) {
    console.warn('[BiliPurifier] 无法监听会话开关:', error);
  }
}

// ==================== 本次会话统计 ====================
const STAT_CATEGORIES = [
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

const sessionStats = {
  startedAt: Date.now(),
  total: 0,
  counts: {}
};

STAT_CATEGORIES.forEach((item) => {
  sessionStats.counts[item.key] = 0;
});

const countedNodes = new WeakSet();

function recordBlock(target, category) {
  if (!target || countedNodes.has(target)) return;
  countedNodes.add(target);
  sessionStats.total += 1;
  if (category in sessionStats.counts) {
    sessionStats.counts[category] += 1;
  }
}

function snapshotStats() {
  return {
    startedAt: sessionStats.startedAt,
    total: sessionStats.total,
    categories: STAT_CATEGORIES.map((item) => ({
      key: item.key,
      label: item.label,
      count: sessionStats.counts[item.key] || 0
    }))
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'BILIPURIFIER_STATS') return undefined;
    sendResponse(snapshotStats());
    return true;
  });
}

// 从本地/云端加载设置并归一化
async function loadSettingsIntoCache() {
  let data;
  try {
    if (typeof window !== 'undefined' && window.syncManager) {
      data = await window.syncManager.loadSettings();
    } else {
      data = await new Promise((resolve) => chrome.storage.local.get(null, resolve));
    }
  } catch (error) {
    console.error('加载设置失败，使用本地存储:', error);
    data = await new Promise((resolve) => chrome.storage.local.get(null, resolve));
  }
  currentSettings = Core.normalizeSettings(data);
  if (currentSettings.statError) {
    console.warn('[BiliPurifier] 统计表达式无法解析：' + currentSettings.statError);
  }
  settingsReady = true;
}

// ==================== 分区映射 ====================
async function loadTidMapConfig() {
  if (tidMapConfig) return;
  if (!tidMapLoading) {
    tidMapLoading = (async () => {
      try {
        const url = chrome.runtime.getURL('tidmap.json');
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        tidMapConfig = await response.json();
      } catch (error) {
        console.error('加载分区映射配置失败:', error);
        tidMapConfig = { '1': '动画', '13': '番剧', '167': '国创', '3': '音乐', '4': '游戏' };
      }
    })();
  }
  await tidMapLoading;
}

async function getTidName(tid) {
  await loadTidMapConfig();
  const name = tidMapConfig[tid];
  if (name) return name;
  if (!warnedTids.has(tid)) {
    warnedTids.add(tid);
    console.warn('[BiliPurifier] 分区表未收录 tid=' + tid + '，该分区规则不生效');
  }
  return null;
}

// ==================== 视频元数据 ====================
async function getVideoMeta(bvid) {
  if (videoMetaCache.has(bvid)) return videoMetaCache.get(bvid);
  try {
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    const data = await response.json();
    if (data.code !== 0 || !data.data) return null;
    const meta = { tid: data.data.tid, stat: data.data.stat || {} };
    if (videoMetaCache.size >= 1200) {
      const dropCount = Math.ceil(videoMetaCache.size * 0.2);
      const keys = videoMetaCache.keys();
      for (let i = 0; i < dropCount; i++) {
        const key = keys.next().value;
        if (key === undefined) break;
        videoMetaCache.delete(key);
      }
    }
    videoMetaCache.set(bvid, meta);
    return meta;
  } catch (error) {
    console.error('获取视频信息失败:', error);
    return null;
  }
}

// ==================== 工具函数 ====================
function parseDurationSeconds(duration) {
  const parts = String(duration).split(':').map(Number);
  if (parts.some((value) => !isFinite(value))) return 0;

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return 0;
}

function cardTargetOf(element) {
  return element.closest('.bili-feed-card, .feed-card') || element;
}

function blockCardElement(element, reason, category) {
  const target = cardTargetOf(element);
  recordBlock(target, category);
  target.dataset.bilipurified = 'true';
  target.classList.remove('bp-hidden', 'bp-placeholder');
  if (currentSettings.blockMode === 'placeholder') {
    target.dataset.bpReason = '已屏蔽：' + (reason || '命中规则') + ' 点击查看';
    target.classList.add('bp-placeholder');
  } else {
    target.removeAttribute('data-bp-reason');
    target.classList.add('bp-hidden');
  }
  element.dataset.bilipurified = 'true';
}

function revealCardElement(element) {
  const target = cardTargetOf(element);
  target.classList.remove('bp-hidden', 'bp-placeholder');
  target.removeAttribute('data-bp-reason');
}

// 点击占位卡片恢复原始内容；恢复后保留处理标记，避免下一轮扫描重新屏蔽
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const placeholder = target.closest('.bp-placeholder');
  if (!placeholder) return;
  event.preventDefault();
  event.stopPropagation();
  placeholder.classList.remove('bp-placeholder');
  placeholder.classList.add('bp-revealed');
}, true);

// ==================== 元数据校验队列（带并发限制） ====================
const metaQueue = [];
let metaPumping = false;

function enqueueMetaChecks(tasks) {
  if (tasks.length === 0) return;
  metaQueue.push(...tasks);
  pumpMetaQueue();
}

async function pumpMetaQueue() {
  if (metaPumping) return;
  metaPumping = true;
  try {
    const concurrency = Math.min(4, metaQueue.length || 1);
    let index = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (index < metaQueue.length) {
        const task = metaQueue[index++];
        // 卡片可能已被后续逻辑移出 DOM（路由切换、被屏蔽等），跳过
        if (!task.cardElement.isConnected) continue;
        try {
          await applyMetaRules(task);
        } catch (error) {
          console.error('处理视频元数据失败:', error);
        }
      }
    });
    await Promise.all(workers);
  } finally {
    metaPumping = false;
    metaQueue.length = 0;
  }
}

async function applyMetaRules(task) {
  const { cardElement, bvid, needSection, needStat } = task;
  const settings = currentSettings;
  if (!extensionEnabled) return;

  const meta = await getVideoMeta(bvid);
  if (!cardElement.isConnected) return;
  if (!meta) {
    revealCardElement(cardElement);
    return;
  }

  if (needSection) {
    const tidName = await getTidName(meta.tid);
    if (cardElement.isConnected && tidName) {
      const sectionHit = Core.matchAny(tidName, settings.sectionCompiled);
      if (sectionHit) {
        blockCardElement(cardElement, '分区「' + tidName + '」', 'section');
        return;
      }
    }
  }

  if (!cardElement.isConnected) return;

  if (needStat) {
    let passed = false;
    try {
      passed = Core.testExpression(settings.statCompiled, meta.stat);
    } catch (error) {
      passed = false;
    }
    if (!passed) {
      blockCardElement(cardElement, '统计条件不满足', 'stat');
      return;
    }
  }

  revealCardElement(cardElement);
}

// ==================== UP 主快捷屏蔽 ====================
const UP_BAN_CLASS = 'bp-upban';
const UP_BAN_ICON =
  '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="5.6"/>' +
  '<path d="M4.2 11.8 11.8 4.2"/></svg>';

let upBanWriteChain = Promise.resolve();

function removeUpBanButtons() {
  document.querySelectorAll('.' + UP_BAN_CLASS).forEach((node) => node.remove());
}

function attachUpBanButton(upElement) {
  if (!upElement) return;
  const name = (upElement.textContent || '').trim();
  if (!name) return;
  if (upElement.nextElementSibling && upElement.nextElementSibling.classList.contains(UP_BAN_CLASS)) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = UP_BAN_CLASS;
  button.title = '屏蔽「' + name + '」';
  button.setAttribute('aria-label', '屏蔽 UP 主 ' + name);
  button.innerHTML = UP_BAN_ICON;

  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  button.addEventListener('mousedown', stop);
  button.addEventListener('mouseup', stop);
  button.addEventListener('click', (event) => {
    stop(event);
    banUpName(name, button);
  });

  upElement.insertAdjacentElement('afterend', button);
}

function settingsPayload(settings) {
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
    preloadScreens: settings.preloadScreens,
  };
}

function banUpName(name, button) {
  const pattern = '^' + Core.escapeRegex(name) + '$';
  button.classList.add('is-done');
  upBanWriteChain = upBanWriteChain.then(async () => {
    try {
      const raw = await window.syncManager.loadSettings();
      const settings = Core.normalizeSettings(raw);
      if (settings.upBlock.some((entry) => entry.regex && entry.pattern === pattern)) return;
      settings.upBlock = settings.upBlock.concat([{ pattern: pattern, regex: true }]);
      await window.syncManager.saveSettings(settingsPayload(settings));
    } catch (error) {
      button.classList.remove('is-done');
      console.error('写入 UP 主屏蔽规则失败:', error);
    }
  });
  return upBanWriteChain;
}

// ==================== 视频屏蔽 ====================
const cardSelectors = [
  // 首页视频
  {
    card: '.feed-card, .bili-feed-card',
    title: '.bili-video-card__info--tit, .bili-video-card__info .bili-video-card__info--tit',
    bvid: "a[href*='/BV']",
    up: '.up-name__text, .bili-video-card__info--author',
    duration: '.bili-video-card__stats__duration, .bpx-player-homepage-time-label-total-time',
  },
  // 热门页视频
  {
    card: '.bili-video-card',
    title: '.bili-video-card__info--tit',
    bvid: "a[href*='/BV']",
    up: '.up-name__text, .bili-video-card__info--author',
    duration: '.bili-video-card__stats__duration',
  },
  // 其他页面视频
  {
    card: '.video-card',
    title: '.video-name',
    bvid: "a[href*='/BV']",
    up: '.up-name__text, .bili-video-card__info--author',
    duration: '.bili-video-card__stats__duration',
  },
  // 详情页侧边栏推荐视频卡片
  {
    card: '.video-page-card-small',
    title: '.title',
    bvid: "a[href*='/BV']",
    up: '.upname .name',
    duration: '.duration',
  },
];

async function hideVideos(settings) {
  const rulesActive = Core.hasActiveRules(settings);
  const metaTasks = [];
  const needSection = rulesActive && settings.sectionCompiled.length > 0;
  const needStat = rulesActive && !!(settings.statCompiled && settings.statCompiled.ast);

  for (const { card, title, bvid, up, duration } of cardSelectors) {
    const videoCards = document.querySelectorAll(`${card}:not([data-bilipurified])`);
    if (videoCards.length === 0) continue;

    for (const cardElement of videoCards) {
      cardElement.dataset.bilipurified = 'true';

      const upElement = cardElement.querySelector(up);
      attachUpBanButton(upElement);

      if (!rulesActive) continue;

      const titleElement = cardElement.querySelector(title);
      const bvidElement = cardElement.querySelector(bvid);
      const durationElement = cardElement.querySelector(duration);

      if (!titleElement || !bvidElement) continue;

      const titleText = titleElement.textContent || '';
      const upName = upElement ? (upElement.textContent || '') : '';

      // 白名单优先级最高：命中即保留，不再参与任何屏蔽规则
      const allowHit =
        Core.matchAny(titleText, settings.titleAllowRules) ||
        (upName && Core.matchAny(upName, settings.upAllowRules));
      if (allowHit) {
        revealCardElement(cardElement);
        continue;
      }

      const titleHit = Core.matchAny(titleText, settings.titleBlockRules);
      if (titleHit) {
        blockCardElement(cardElement, '标题含「' + titleHit + '」', 'title');
        continue;
      }

      if (upName) {
        const upHit = Core.matchAny(upName, settings.upBlockRules);
        if (upHit) {
          blockCardElement(cardElement, 'UP 主含「' + upHit + '」', 'up');
          continue;
        }
      }

      if (settings.durationSec > 0 && durationElement) {
        const durationSeconds = parseDurationSeconds(durationElement.textContent.trim());
        if (durationSeconds > 0 && durationSeconds < settings.durationSec) {
          blockCardElement(cardElement, '时长不足', 'duration');
          continue;
        }
      }

      // 分区与统计需要请求接口，先入队统一限流处理
      if (needSection || needStat) {
        const bvidMatch = bvidElement.href.match(/\/BV[\w]+/);
        if (bvidMatch) {
          metaTasks.push({
            cardElement,
            bvid: bvidMatch[0].replace('/', ''),
            needSection,
            needStat,
          });
          continue;
        }
      }

      // 未命中任何规则：清除可能残留的屏蔽（SPA 路由切换后节点可能被复用渲染新视频）
      revealCardElement(cardElement);
    }
  }

  enqueueMetaChecks(metaTasks);
}

// ==================== 评论屏蔽 ====================
const COMMENT_HOST_SELECTOR = [
  'bili-comment-thread-renderer',
  '.reply-item',
].join(',');

// 楼中楼子树：判定一级评论时整体跳过，正文与作者都不采集其中的内容
function isReplyBranch(element) {
  const name = element.localName;
  if (name === 'bili-comment-replies-renderer' || name === 'bili-comment-reply-renderer') return true;
  return !!(element.classList && element.classList.contains('sub-reply-item'));
}

const COMMENT_PLACEHOLDER_STYLE = [
  'display:block',
  'box-sizing:border-box',
  'width:100%',
  'margin:6px 0',
  'padding:9px 12px',
  'border:1px dashed #d5d8dd',
  'border-radius:8px',
  'background:#f4f5f7',
  'color:#9299a4',
  'font-size:12px',
  'font-family:inherit',
  'line-height:1.6',
  'text-align:center',
  'cursor:pointer',
].join(';');

const observedRoots = new WeakSet();
const blockedComments = new Set();
const revealedComments = new Set();
// 展开状态按「作者 + 正文」记，节点被评论组件重建后仍认得出是同一条评论
const revealedCommentKeys = new Set();
const commentPlaceholders = new Set();
let mutationObserver = null;

function collectCommentScopes() {
  const scopes = [];
  const host = document.querySelector('bili-comments');
  if (host) scopes.push(host.shadowRoot || host);
  const legacy = document.querySelector('#comment');
  if (legacy) scopes.push(legacy);
  return scopes;
}

function observeRoot(root) {
  if (!mutationObserver || !pageObserved || observedRoots.has(root)) return;
  observedRoots.add(root);
  try {
    mutationObserver.observe(root, { childList: true, subtree: true });
  } catch (error) {
    // 部分节点（如已废弃的 shadow root）不接受观察，忽略即可
  }
}

// 深度优先遍历组合树；shadow root 与 light 子节点都算在内
function walkComposed(node, visit) {
  const stack = [node];
  let guard = 0;
  while (stack.length && guard < 4000) {
    const current = stack.pop();
    guard += 1;
    if (current.nodeType === 1) {
      if (current !== node && isReplyBranch(current)) continue;
      visit(current);
      if (current.shadowRoot) stack.push(current.shadowRoot);
    }
    if (current.nodeType === 1 || current.nodeType === 11) {
      let child = current.lastChild;
      while (child) {
        stack.push(child);
        child = child.previousSibling;
      }
    }
  }
}

// 正文提取要绕开的标签：评论组件的样式表写在各自的 shadow root 里，
const TEXT_SKIP_TAGS = { STYLE: 1, SCRIPT: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1 };

function composedText(node, limit) {
  let text = '';
  const stack = [node];
  let guard = 0;
  while (stack.length && guard < 4000) {
    const current = stack.pop();
    guard += 1;
    if (current.nodeType === 3) {
      text += current.nodeValue || '';
    } else if (current.nodeType === 1 || current.nodeType === 11) {
      if (current !== node && current.nodeType === 1) {
        if (isReplyBranch(current)) continue;
        if (TEXT_SKIP_TAGS[String(current.tagName || '').toUpperCase()]) continue;
      }
      if (current.shadowRoot) stack.push(current.shadowRoot);
      let child = current.lastChild;
      while (child) {
        stack.push(child);
        child = child.previousSibling;
      }
    }
    if (text.length > limit) break;
  }
  return text;
}

function findFirstComposed(node, predicate) {
  let found = null;
  walkComposed(node, (element) => {
    if (found) return;
    if (predicate(element)) found = element;
  });
  return found;
}

function findCommentAuthor(host) {
  let name = '';
  walkComposed(host, (element) => {
    if (name) return;
    if (element.localName !== 'a') return;
    const href = element.getAttribute('href') || '';
    if (href.indexOf('space.bilibili.com') < 0) return;
    const text = (element.textContent || '').trim();
    if (text) name = text;
  });
  if (name) return name;

  const fallback = findFirstComposed(host, (element) =>
    element.id === 'user-name' || (element.classList && element.classList.contains('user-name'))
  );
  return fallback ? composedText(fallback, 120).trim() : '';
}

function findRichTextContents(node) {
  const rich = findFirstComposed(node, (element) => element.localName === 'bili-rich-text');
  if (!rich) return null;
  const contents = rich.shadowRoot && rich.shadowRoot.querySelector('#contents');
  return contents || rich;
}

function findCommentTextHost(host) {
  if (host.localName === 'bili-comment-thread-renderer') {
    const renderer = findFirstComposed(host, (element) => element.localName === 'bili-comment-renderer');
    if (renderer) return findRichTextContents(renderer) || renderer;
  }
  if (host.classList && host.classList.contains('reply-item')) {
    return host.querySelector('.reply-content') || host;
  }
  return findRichTextContents(host) || host;
}

function isInsideBlockedComment(host) {
  let node = host.getRootNode();
  while (node && node.host) {
    if (node.host.dataset && node.host.dataset.bilipurified === 'true') return true;
    node = node.host.getRootNode();
  }
  return false;
}

function judgeComment(host, settings) {
  const author = findCommentAuthor(host);
  const text = composedText(findCommentTextHost(host), 4000).replace(/\s+/g, ' ').trim();
  if (!text && !author) return null;

  const key = author + '\u0001' + text.slice(0, 300);

  if (author && Core.matchAny(author, settings.commentUserAllowRules)) return null;
  if (text && Core.matchAny(text, settings.commentTextAllowRules)) return null;

  const textHit = Core.matchAny(text, settings.commentTextBlockRules);
  if (textHit) return { key, category: 'comment', rule: textHit, reason: '评论含「' + textHit + '」' };

  const userHit = author ? Core.matchAny(author, settings.commentUserBlockRules) : null;
  if (userHit) return { key, category: 'commenter', rule: userHit, reason: '评论者含「' + userHit + '」' };

  if (settings.blockMention && text.indexOf('@') >= 0) {
    return { key, category: 'mention', rule: null, reason: '评论提及他人' };
  }

  return null;
}

function markCommentRevealed(host) {
  revealedComments.add(host);
  host.dataset.bpRevealed = 'true';
  host.style.removeProperty('display');
}

function blockCommentHost(host, verdict) {
  if (blockedComments.has(host)) return;
  blockedComments.add(host);
  recordBlock(host, verdict.category);
  host.dataset.bilipurified = 'true';
  host.style.setProperty('display', 'none', 'important');

  if (currentSettings.blockMode !== 'placeholder') return;

  const placeholder = document.createElement('button');
  placeholder.type = 'button';
  placeholder.className = 'bp-comment-placeholder';
  placeholder.textContent = '已屏蔽 · ' + verdict.reason + ' · 点击查看';
  placeholder.setAttribute('style', COMMENT_PLACEHOLDER_STYLE);
  placeholder.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    blockedComments.delete(host);
    rememberRevealedKey(verdict.key);
    markCommentRevealed(host);
    commentPlaceholders.delete(placeholder);
    placeholder.remove();
  });

  commentPlaceholders.add(placeholder);
  host.parentNode.insertBefore(placeholder, host.nextSibling);
}

function rememberRevealedKey(key) {
  if (!key) return;
  if (revealedCommentKeys.size >= 2000) {
    const drop = revealedCommentKeys.values();
    for (let i = 0; i < 500; i += 1) {
      const next = drop.next();
      if (next.done) break;
      revealedCommentKeys.delete(next.value);
    }
  }
  revealedCommentKeys.add(key);
}

function removeCommentPlaceholders() {
  commentPlaceholders.forEach((node) => node.remove());
  commentPlaceholders.clear();
}

function collectRoots(scope) {
  const roots = [scope];
  for (let index = 0; index < roots.length && roots.length < 800; index += 1) {
    for (const element of roots[index].querySelectorAll('*')) {
      if (!element.shadowRoot) continue;
      roots.push(element.shadowRoot);
      observeRoot(element.shadowRoot);
    }
  }
  return roots;
}

function hideComments(settings) {
  if (!Core.hasCommentRules(settings)) return;

  if (blockedComments.size > 800) {
    blockedComments.forEach((host) => { if (!host.isConnected) blockedComments.delete(host); });
    revealedComments.forEach((host) => { if (!host.isConnected) revealedComments.delete(host); });
  }

  const scopes = collectCommentScopes();
  if (!scopes.length) return;

  for (const scope of scopes) {
    const roots = collectRoots(scope);
    for (const root of roots) {
      const hosts = root.querySelectorAll(
        COMMENT_HOST_SELECTOR + ':not([data-bilipurified]):not([data-bp-revealed])'
      );
      for (const host of hosts) {
        if (isInsideBlockedComment(host)) continue;
        const verdict = judgeComment(host, settings);
        if (!verdict) continue;
        if (revealedCommentKeys.has(verdict.key)) {
          markCommentRevealed(host);
          continue;
        }
        blockCommentHost(host, verdict);
      }
    }
  }
}

// ==================== 页面净化 ====================
const adSelectors = ['.feed-card', '.bili-video-card', '.video-page-card-small'];
const liveSelectors = ['.pop-live-small-mode', '.floor-single-card', '.bili-live-card'];

function cleanPage() {
  const adEnabled = currentSettings.cleanAd;
  const liveEnabled = currentSettings.cleanLive;
  if (!adEnabled && !liveEnabled) return;

  // 广告卡片：新版广告角标渲染在 stats 文本位置，
  if (adEnabled) {
    for (const selector of adSelectors) {
      const elements = document.querySelectorAll(`${selector}:not([data-bilipurified])`);
      for (const element of elements) {
        const isAd =
          element.querySelector('.bili-video-card__info--creative-ad') ||
          element.querySelector('.bili-video-card__info--ad') ||
          Array.from(element.querySelectorAll('.bili-video-card__stats--text'))
            .some((el) => el.textContent.trim() === '广告');
        if (isAd) blockCardElement(element, '广告', 'ad');
      }
    }
  }

  // 直播/活动卡片
  if (liveEnabled) {
    for (const selector of liveSelectors) {
      const elements = document.querySelectorAll(`${selector}:not([data-bilipurified])`);
      for (const element of elements) {
        blockCardElement(element, '直播或活动', 'live');
      }
    }
  }
}

// ==================== 预加载 ====================
// 信息流的续载只认窗口滚动位置：在单帧内把滚动位置推到页面底部，绘制前再复位，
const PRELOAD_BATCH_LIMIT = 8;
const PRELOAD_RETRY_MS = 8000;

let preloadRunning = false;
let preloadKickTimer = null;
let feedRetryAfter = 0;

function sleepFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitUntil(predicate, timeout) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      let done = false;
      try {
        done = !!predicate();
      } catch (error) {
        done = false;
      }
      if (done) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeout) {
        resolve(false);
        return;
      }
      setTimeout(tick, 60);
    };
    tick();
  });
}

async function nudgeScrollTo(top) {
  const se = document.scrollingElement || document.documentElement;
  const originY = window.scrollY;
  const maxTop = Math.max(0, se.scrollHeight - window.innerHeight);
  const target = Math.max(0, Math.min(Math.round(top), maxTop));
  if (Math.abs(target - originY) < 4) return false;

  const previousBehavior = se.style.scrollBehavior;
  se.style.scrollBehavior = 'auto';
  try {
    window.scrollTo({ top: target, left: window.scrollX, behavior: 'instant' });
    await sleepFrame();
  } finally {
    window.scrollTo({ top: originY, left: window.scrollX, behavior: 'instant' });
    se.style.scrollBehavior = previousBehavior;
  }
  return true;
}

function countFeedCards() {
  return document.querySelectorAll('.feed-card, .bili-feed-card, .bili-video-card').length;
}

// 播放页的推荐位是有限列表，只有信息流页面才需要向下续载
function hasFeedStream() {
  if (document.querySelector('#mirror-vdcon, .video-container-v1')) return false;
  return countFeedCards() >= 8;
}

// 视口下方还剩多少像素的已加载内容
function feedRemainingPx() {
  const se = document.scrollingElement || document.documentElement;
  return se.scrollHeight - window.scrollY - window.innerHeight;
}

async function feedPullOnce() {
  const se = document.scrollingElement || document.documentElement;
  const beforeCards = countFeedCards();
  const beforeHeight = se.scrollHeight;
  if (!(await nudgeScrollTo(se.scrollHeight))) return 'skip';

  const grew = await waitUntil(
    () => countFeedCards() > beforeCards || se.scrollHeight > beforeHeight + 40,
    3500
  );
  return grew ? 'grew' : 'stalled';
}

async function feedPump() {
  const screens = currentSettings.preloadScreens;
  if (screens <= 0 || Date.now() < feedRetryAfter || !hasFeedStream()) return;

  const goal = screens * window.innerHeight;
  if (!goal) return;

  for (let batch = 0; batch < PRELOAD_BATCH_LIMIT; batch += 1) {
    if (!extensionEnabled || !currentSettings.preloadEnabled) return;
    if (document.hidden) return;
    if (feedRemainingPx() >= goal) return;

    const result = await feedPullOnce();
    if (result === 'skip') return;
    if (result === 'stalled') {
      feedRetryAfter = Date.now() + PRELOAD_RETRY_MS;
      return;
    }

    scheduleScan(0, true);
    await waitUntil(() => !scanRunning && !scanTimer, 600);
  }

  feedRetryAfter = Date.now() + 4000;
}

async function preloadPass() {
  if (!settingsReady || !extensionEnabled) return;
  if (!currentSettings.preloadEnabled) return;
  if (document.hidden) return;
  if (preloadRunning) return;

  preloadRunning = true;
  try {
    await feedPump();
  } catch (error) {
    if (!isContextInvalidated(error)) console.error('预加载失败:', error);
  } finally {
    preloadRunning = false;
  }
}

function schedulePreload(waitMs = 300) {
  if (preloadKickTimer) return;
  preloadKickTimer = setTimeout(() => {
    preloadKickTimer = null;
    preloadPass();
  }, waitMs);
}

// ==================== 扫描调度 ====================
// 单个 MutationObserver + 防抖（带最长等待），避免持续变化导致扫描被无限推迟
let scanTimer = null;
let scanQueuedAt = 0;
let scanRunning = false;

function scheduleScan(delay = 300, force) {
  if (scanTimer) {
    // 已有排队的扫描；等待超过 1.2s 或被要求立即执行时就地跑掉
    if (!force && Date.now() - scanQueuedAt < 1200) return;
    clearTimeout(scanTimer);
    scanTimer = null;
    if (!scanRunning) runScan();
    return;
  }
  if (force) {
    if (!scanRunning) runScan();
    return;
  }
  scanQueuedAt = Date.now();
  scanTimer = setTimeout(() => {
    scanTimer = null;
    runScan();
  }, delay);
}

function isContextInvalidated(error) {
  return error && error.message && error.message.includes('Extension context invalidated');
}

async function runScan() {
  // 页面还在直出的 DOM 上做逐节点比对，此时任何改动都会让比对失败并触发整树重建
  if (!pageObserved) return;
  scanRunning = true;
  try {
    if (!settingsReady) return;
    if (!extensionEnabled) {
      clearAllMarks();
      removeUpBanButtons();
      return;
    }
    cleanPage();
    await hideVideos(currentSettings);
    hideComments(currentSettings);
    schedulePreload(500);
  } catch (error) {
    if (isContextInvalidated(error)) {
      if (mutationObserver) mutationObserver.disconnect();
      console.log('Extension reloaded or disabled');
    } else {
      console.error('扫描页面失败:', error);
    }
  } finally {
    scanRunning = false;
  }
}

// ==================== SPA 路由变化处理 ====================
// 详情页是 SPA：点击推荐视频只改 URL 不刷新页面，Vue 会复用旧节点渲染新视频，
// 因此路由变化后必须清除处理标记并重扫，否则已屏蔽的节点会错误地遮挡新内容。
let lastPathname = location.pathname;

function clearAllMarks() {
  if (!pageObserved) return;
  const marked = document.querySelectorAll('[data-bilipurified]');
  for (const el of marked) {
    el.removeAttribute('data-bilipurified');
  }
  const revealed = document.querySelectorAll('[data-bp-revealed]');
  for (const el of revealed) {
    el.removeAttribute('data-bp-revealed');
  }
  const blocked = document.querySelectorAll('.bp-hidden, .bp-placeholder, .bp-revealed');
  for (const el of blocked) {
    el.classList.remove('bp-hidden', 'bp-placeholder', 'bp-revealed');
    el.removeAttribute('data-bp-reason');
  }
  blockedComments.forEach((host) => {
    host.style.removeProperty('display');
    host.removeAttribute('data-bilipurified');
  });
  revealedComments.forEach((host) => host.removeAttribute('data-bp-revealed'));
  blockedComments.clear();
  revealedComments.clear();
  revealedCommentKeys.clear();
  removeCommentPlaceholders();
  feedRetryAfter = 0;
}

function checkRouteChange() {
  if (location.pathname === lastPathname) return;
  lastPathname = location.pathname;
  clearAllMarks();
  scheduleScan(150);
}

window.addEventListener('popstate', checkRouteChange);
window.addEventListener('hashchange', checkRouteChange);
setInterval(checkRouteChange, 400);

// ==================== 设置实时生效 ====================
let settingsRefreshTimer = null;

function scheduleSettingsRefresh() {
  if (settingsRefreshTimer) return;
  settingsRefreshTimer = setTimeout(async () => {
    settingsRefreshTimer = null;
    try {
      clearAllMarks();
      await loadSettingsIntoCache();
      scheduleScan(100);
    } catch (error) {
      if (isContextInvalidated(error)) {
        if (mutationObserver) mutationObserver.disconnect();
      }
    }
  }, 200);
}

const SSR_MARK = 'data-server-rendered';
const SETTLE_POLL_MS = 800;
const SETTLE_FORCE_MS = 8000;

let pageObserved = false;

function ssrMarked() {
  return document.querySelector('[' + SSR_MARK + ']');
}

function attachPageObserver() {
  if (pageObserved) return;
  if (!mutationObserver) {
    setTimeout(attachPageObserver, 100);
    return;
  }
  pageObserved = true;
  try {
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  } catch (error) {
  }
  scheduleScan(0);
}

function observePageWhenSettled() {
  const startedAt = Date.now();
  let poll = null;
  let markObserver = null;
  let attaching = false;

  const stopWatching = () => {
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
    if (markObserver) {
      markObserver.disconnect();
      markObserver = null;
    }
  };

  const settle = () => {
    if (pageObserved) {
      stopWatching();
      return;
    }
    if (attaching) return;
    if (document.readyState === 'loading') return;
    if (ssrMarked() && Date.now() - startedAt < SETTLE_FORCE_MS) return;
    attaching = true;
    stopWatching();
    setTimeout(attachPageObserver, 0);
  };

  try {
    markObserver = new MutationObserver(settle);
    markObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [SSR_MARK],
      subtree: true,
    });
  } catch (error) {
    markObserver = null;
  }

  poll = setInterval(settle, SETTLE_POLL_MS);
  window.addEventListener('load', settle, { once: true });
  settle();
}

// ==================== 启动 ====================
function startBlocking() {
  const init = async () => {
    try {
      mutationObserver = new MutationObserver(() => scheduleScan(300));

      if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          const relevant = [
            'titleBlock', 'titleAllow', 'upBlock', 'upAllow',
            'commentTextBlock', 'commentTextAllow', 'commentUserBlock', 'commentUserAllow', 'blockMention',
            'sectionRules', 'durationSec', 'statExpr', 'blockMode', 'cleanAd', 'cleanLive', 'version',
            'preloadEnabled', 'preloadScreens',
          ];
          if (Object.keys(changes).some((k) => relevant.includes(k))) {
            scheduleSettingsRefresh();
          }
        });
      }

      await loadSettingsIntoCache();
      extensionEnabled = await readExtensionEnabled();
      watchExtensionEnabled();
      observePageWhenSettled();
    } catch (error) {
      console.log('Failed to start observer:', error);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

startBlocking();
