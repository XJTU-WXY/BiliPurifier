// 规则归一化、关键词匹配与统计表达式求值。

(function (global) {
  'use strict';

  // ==================== 统计表达式 ====================

  var VARIABLES = ['play', 'like', 'danmaku', 'reply', 'coin', 'favorite'];

  var VARIABLE_LABELS = {
    play: '播放量',
    like: '点赞量',
    danmaku: '弹幕量',
    reply: '回复量',
    coin: '硬币量',
    favorite: '收藏量'
  };

  var ALIASES = {
    play: 'play', view: 'play', views: 'play', '播放': 'play', '播放量': 'play',
    like: 'like', likes: 'like', '点赞': 'like', '点赞量': 'like',
    danmaku: 'danmaku', dm: 'danmaku', '弹幕': 'danmaku', '弹幕量': 'danmaku',
    reply: 'reply', replies: 'reply', comment: 'reply', comments: 'reply',
    '回复': 'reply', '回复量': 'reply', '评论': 'reply', '评论量': 'reply',
    coin: 'coin', coins: 'coin', '硬币': 'coin', '硬币量': 'coin', '投币': 'coin',
    favorite: 'favorite', fav: 'favorite', favorites: 'favorite',
    '收藏': 'favorite', '收藏量': 'favorite'
  };

  var FULLWIDTH = {
    '≥': '>=', '≤': '<=', '≠': '!=', '＝': '==', '＞': '>', '＜': '<',
    '（': '(', '）': ')', '＋': '+', '－': '-', '＊': '*', '／': '/',
    '％': '%', '　': ' '
  };

  var NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
  var IDENT_RE = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/;
  var CMP_OPS = ['>=', '<=', '==', '!=', '>', '<'];

  function normalizeSource(src) {
    var out = '';
    for (var i = 0; i < src.length; i++) {
      var ch = src[i];
      out += FULLWIDTH[ch] || ch;
    }
    return out;
  }

  function tokenize(source) {
    var src = normalizeSource(source);
    var tokens = [];
    var i = 0;
    while (i < src.length) {
      var ch = src[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

      if (ch === ',') { i++; continue; }

      var numMatch = NUMBER_RE.exec(src.slice(i));
      if (numMatch) {
        tokens.push({ type: 'num', value: parseFloat(numMatch[0]), at: i });
        i += numMatch[0].length;
        continue;
      }

      var idMatch = IDENT_RE.exec(src.slice(i));
      if (idMatch) {
        var word = idMatch[0];
        var lower = word.toLowerCase();
        if (lower === 'and' || lower === 'or' || lower === 'not') {
          tokens.push({ type: 'op', value: lower, at: i });
        } else if (lower === 'true' || lower === 'false') {
          tokens.push({ type: 'num', value: lower === 'true' ? 1 : 0, at: i });
        } else {
          tokens.push({ type: 'id', value: word, at: i });
        }
        i += word.length;
        continue;
      }

      var two = src.slice(i, i + 2);
      if (CMP_OPS.indexOf(two) >= 0) {
        tokens.push({ type: 'op', value: two, at: i });
        i += 2;
        continue;
      }

      if ('+-*/%()'.indexOf(ch) >= 0) {
        tokens.push({ type: 'op', value: ch, at: i });
        i++;
        continue;
      }

      if (CMP_OPS.indexOf(ch) >= 0) {
        tokens.push({ type: 'op', value: ch, at: i });
        i++;
        continue;
      }

      if (ch === '=') {
        throw new Error('第 ' + (i + 1) + ' 个字符是单个 =，比较请用 ==');
      }
      if (ch === '!') {
        throw new Error('第 ' + (i + 1) + ' 个字符是单个 !，不等于请用 !=');
      }
      throw new Error('第 ' + (i + 1) + ' 个字符「' + ch + '」无法识别');
    }
    tokens.push({ type: 'eof', at: src.length });
    return tokens;
  }

  function parse(source) {
    var tokens = tokenize(source);
    var pos = 0;
    var used = {};

    function peek() { return tokens[pos]; }
    function isOp(value) { var t = tokens[pos]; return t.type === 'op' && t.value === value; }
    function expect(value, hint) {
      if (!isOp(value)) {
        var t = tokens[pos];
        throw new Error('第 ' + (t.at + 1) + ' 个字符处' + (hint || ('缺少 ' + value)));
      }
      pos++;
    }

    function parseOr() {
      var left = parseAnd();
      while (isOp('or')) {
        pos++;
        left = { type: 'or', left: left, right: parseAnd() };
      }
      return left;
    }

    function parseAnd() {
      var left = parseNot();
      while (isOp('and')) {
        pos++;
        left = { type: 'and', left: left, right: parseNot() };
      }
      return left;
    }

    function parseNot() {
      if (isOp('not')) {
        pos++;
        return { type: 'not', arg: parseNot() };
      }
      return parseCmp();
    }

    function parseCmp() {
      var left = parseAdd();
      var t = peek();
      if (t.type === 'op' && CMP_OPS.indexOf(t.value) >= 0) {
        pos++;
        return { type: 'cmp', op: t.value, left: left, right: parseAdd() };
      }
      return left;
    }

    function parseAdd() {
      var left = parseMul();
      while (isOp('+') || isOp('-')) {
        var op = tokens[pos++].value;
        left = { type: 'bin', op: op, left: left, right: parseMul() };
      }
      return left;
    }

    function parseMul() {
      var left = parseUnary();
      while (isOp('*') || isOp('/') || isOp('%')) {
        var op = tokens[pos++].value;
        left = { type: 'bin', op: op, left: left, right: parseUnary() };
      }
      return left;
    }

    function parseUnary() {
      if (isOp('-')) { pos++; return { type: 'neg', arg: parseUnary() }; }
      if (isOp('+')) { pos++; return parseUnary(); }
      return parsePrimary();
    }

    function parsePrimary() {
      var t = peek();
      if (t.type === 'num') { pos++; return { type: 'num', value: t.value }; }
      if (t.type === 'id') {
        pos++;
        var key = String(t.value).toLowerCase();
        var name = ALIASES[key];
        if (!name) {
          throw new Error('未知变量「' + t.value + '」，可用：' + VARIABLES.join(' / '));
        }
        used[name] = true;
        return { type: 'var', name: name };
      }
      if (isOp('(')) {
        pos++;
        var inner = parseOr();
        if (!isOp(')')) {
          var cur = peek();
          throw new Error('第 ' + (cur.at + 1) + ' 个字符处缺少右括号');
        }
        pos++;
        return inner;
      }
      if (t.type === 'eof') throw new Error('表达式不完整，末尾缺少内容');
      throw new Error('第 ' + (t.at + 1) + ' 个字符处出现意外的「' + t.value + '」');
    }

    if (tokens.length === 1) throw new Error('表达式为空');
    var ast = parseOr();
    var rest = peek();
    if (rest.type !== 'eof') {
      throw new Error('第 ' + (rest.at + 1) + ' 个字符处多余的「' + rest.value + '」');
    }
    return { ast: ast, variables: Object.keys(used) };
  }

  function truthy(v) {
    return typeof v === 'number' ? v !== 0 : !!v;
  }

  function toNumber(v) {
    return typeof v === 'number' ? v : (v ? 1 : 0);
  }

  function evalNode(node, vars) {
    switch (node.type) {
      case 'num':
        return node.value;
      case 'var': {
        var v = vars[node.name];
        return typeof v === 'number' && isFinite(v) ? v : 0;
      }
      case 'neg':
        return -toNumber(evalNode(node.arg, vars));
      case 'not':
        return !truthy(evalNode(node.arg, vars));
      case 'and':
        return truthy(evalNode(node.left, vars)) ? truthy(evalNode(node.right, vars)) : false;
      case 'or':
        return truthy(evalNode(node.left, vars)) ? true : truthy(evalNode(node.right, vars));
      case 'cmp': {
        var a = toNumber(evalNode(node.left, vars));
        var b = toNumber(evalNode(node.right, vars));
        switch (node.op) {
          case '>=': return a >= b;
          case '<=': return a <= b;
          case '==': return a === b;
          case '!=': return a !== b;
          case '>': return a > b;
          case '<': return a < b;
        }
        return false;
      }
      case 'bin': {
        var x = toNumber(evalNode(node.left, vars));
        var y = toNumber(evalNode(node.right, vars));
        switch (node.op) {
          case '+': return x + y;
          case '-': return x - y;
          case '*': return x * y;
          case '/': return y === 0 ? 0 : x / y;
          case '%': return y === 0 ? 0 : x % y;
        }
        return 0;
      }
    }
    return 0;
  }

  function compileExpression(source) {
    var text = String(source == null ? '' : source).trim();
    if (!text) return { ok: true, ast: null, variables: [], empty: true };
    try {
      var parsed = parse(text);
      return { ok: true, ast: parsed.ast, variables: parsed.variables, empty: false };
    } catch (error) {
      return { ok: false, ast: null, variables: [], error: error.message };
    }
  }

  function statToVars(stat) {
    var s = stat || {};
    return {
      play: Number(s.view) || 0,
      like: Number(s.like) || 0,
      danmaku: Number(s.danmaku) || 0,
      reply: Number(s.reply) || 0,
      coin: Number(s.coin) || 0,
      favorite: Number(s.favorite) || 0
    };
  }

  function testExpression(compiled, stat) {
    if (!compiled || !compiled.ast) return true;
    return truthy(evalNode(compiled.ast, statToVars(stat)));
  }

  // ==================== 关键词规则 ====================

  function normalizeEntry(entry) {
    if (typeof entry === 'string') {
      var text = entry.trim();
      return text ? { pattern: text, regex: false } : null;
    }
    if (!entry || typeof entry !== 'object') return null;
    var pattern = String(entry.pattern == null ? '' : entry.pattern).trim();
    if (!pattern) return null;
    return { pattern: pattern, regex: !!entry.regex };
  }

  function normalizeList(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var entry = normalizeEntry(list[i]);
      if (entry) out.push(entry);
    }
    return out;
  }

  function compileRules(list) {
    var out = [];
    var rules = normalizeList(list);
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.regex) {
        try {
          out.push({ re: new RegExp(rule.pattern), label: rule.pattern });
        } catch (error) {
          console.warn('[BiliPurifier] 正则无效，已跳过：' + rule.pattern + '（' + error.message + '）');
        }
      } else {
        out.push({ text: rule.pattern, label: rule.pattern });
      }
    }
    return out;
  }

  // ==================== 关键词文本 ====================
  // 一行一条：首尾都被 / 包裹的按正则匹配，其余按包含匹配。

  function parseRuleText(text) {
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.length > 2 && line.charAt(0) === '/' && line.charAt(line.length - 1) === '/') {
        out.push({ pattern: line.slice(1, -1), regex: true });
      } else {
        out.push({ pattern: line, regex: false });
      }
    }
    return out;
  }

  function formatRuleText(list) {
    var rules = normalizeList(list);
    var lines = [];
    for (var i = 0; i < rules.length; i++) {
      lines.push(rules[i].regex ? '/' + rules[i].pattern + '/' : rules[i].pattern);
    }
    return lines.join('\n');
  }

  // 返回命中的规则原文，未命中返回 null
  // 匹配区分英文大小写：非正则规则按原样做包含匹配
  function matchAny(text, compiledRules) {
    if (!text || !compiledRules || !compiledRules.length) return null;
    var source = String(text);
    for (var i = 0; i < compiledRules.length; i++) {
      var rule = compiledRules[i];
      if (rule.re) {
        rule.re.lastIndex = 0;
        if (rule.re.test(source)) return rule.label;
      } else if (source.indexOf(rule.text) >= 0) {
        return rule.label;
      }
    }
    return null;
  }

  // ==================== 屏蔽类型 ====================
  // 占位显示范围按这里列出的类型逐项设置，列表顺序即设置页的排列顺序。

  var BLOCK_CATEGORIES = [
    { key: 'title', label: '视频标题命中' },
    { key: 'up', label: 'UP 主昵称命中' },
    { key: 'section', label: '分区命中' },
    { key: 'duration', label: '时长过短' },
    { key: 'stat', label: '统计数据不达标' },
    { key: 'promo', label: '推广标记' },
    { key: 'ad', label: '广告' },
    { key: 'live', label: '直播 / 活动' },
    { key: 'comment', label: '评论内容命中' },
    { key: 'commenter', label: '评论者昵称命中' },
    { key: 'mention', label: '评论中 @ 他人' }
  ];

  function normalizeScopes(raw) {
    var input = raw && typeof raw === 'object' ? raw : {};
    var out = {};
    for (var i = 0; i < BLOCK_CATEGORIES.length; i++) {
      var key = BLOCK_CATEGORIES[i].key;
      out[key] = input[key] !== false;
    }
    return out;
  }

  // 该类型命中时是否保留占位；返回 false 表示按移除处理
  function wantsPlaceholder(settings, category) {
    if (!settings || settings.blockMode !== 'placeholder') return false;
    var scopes = settings.placeholderScopes;
    if (!scopes) return true;
    return scopes[category] !== false;
  }

  // ==================== 设置归一化 ====================

  var DEFAULTS = {
    titleBlock: [],
    titleAllow: [],
    upBlock: [],
    upAllow: [],
    commentTextBlock: [],
    commentTextAllow: [],
    commentUserBlock: [],
    commentUserAllow: [],
    blockMention: false,
    sectionRules: [],
    durationSec: 0,
    statExpr: '',
    blockMode: 'hide',
    placeholderScopes: normalizeScopes(null),
    followUpPass: false,
    blockPromo: false,
    cleanAd: false,
    cleanLive: false,
    preloadEnabled: true,
    preloadScreens: 2
  };

  function splitLegacy(value) {
    if (!value) return [];
    return String(value)
      .split(/[|｜]/)
      .map(function (item) { return item.trim(); })
      .filter(Boolean)
      .map(function (item) { return { pattern: item, regex: false }; });
  }

  function clampCount(value, fallback, max) {
    if (value === undefined || value === null || value === '') return fallback;
    var number = Number(value);
    if (!isFinite(number)) return fallback;
    return Math.min(max, Math.max(0, Math.round(number)));
  }

  function normalizeSettings(raw) {
    var input = raw || {};
    var migrated = {
      titleBlock: input.titleBlock,
      titleAllow: input.titleAllow,
      upBlock: input.upBlock,
      upAllow: input.upAllow,
      commentTextBlock: input.commentTextBlock,
      commentTextAllow: input.commentTextAllow,
      commentUserBlock: input.commentUserBlock,
      commentUserAllow: input.commentUserAllow,
      blockMention: input.blockMention,
      sectionRules: input.sectionRules,
      durationSec: input.durationSec,
      statExpr: input.statExpr,
      blockMode: input.blockMode,
      placeholderScopes: input.placeholderScopes,
      followUpPass: input.followUpPass,
      blockPromo: input.blockPromo,
      cleanAd: input.cleanAd,
      cleanLive: input.cleanLive,
      preloadEnabled: input.preloadEnabled,
      preloadScreens: input.preloadScreens
    };

    if (migrated.titleBlock === undefined && input.titleKeywords !== undefined) {
      migrated.titleBlock = splitLegacy(input.titleKeywords);
    }
    if (migrated.upBlock === undefined && input.upKeywords !== undefined) {
      migrated.upBlock = splitLegacy(input.upKeywords);
    }
    if (migrated.sectionRules === undefined && input.sectionKeywords !== undefined) {
      migrated.sectionRules = splitLegacy(input.sectionKeywords);
    }
    if (migrated.durationSec === undefined && input.durationMin !== undefined) {
      migrated.durationSec = Math.round((Number(input.durationMin) || 0) * 60);
    }
    if (migrated.durationSec === undefined && input.minDuration !== undefined) {
      migrated.durationSec = Math.round((Number(input.minDuration) || 0) * 60);
    }

    if (migrated.cleanAd === undefined && input.cleanMode !== undefined) {
      migrated.cleanAd = !!input.cleanMode;
    }
    if (migrated.cleanLive === undefined && input.cleanMode !== undefined) {
      migrated.cleanLive = !!input.cleanMode;
    }

    var settings = {
      titleBlock: normalizeList(migrated.titleBlock),
      titleAllow: normalizeList(migrated.titleAllow),
      upBlock: normalizeList(migrated.upBlock),
      upAllow: normalizeList(migrated.upAllow),
      commentTextBlock: normalizeList(migrated.commentTextBlock),
      commentTextAllow: normalizeList(migrated.commentTextAllow),
      commentUserBlock: normalizeList(migrated.commentUserBlock),
      commentUserAllow: normalizeList(migrated.commentUserAllow),
      blockMention: !!migrated.blockMention,
      sectionRules: normalizeList(migrated.sectionRules),
      durationSec: Math.max(0, Math.round(Number(migrated.durationSec) || 0)),
      statExpr: String(migrated.statExpr == null ? '' : migrated.statExpr).trim(),
      blockMode: migrated.blockMode === 'placeholder' ? 'placeholder' : 'hide',
      placeholderScopes: normalizeScopes(migrated.placeholderScopes),
      followUpPass: !!migrated.followUpPass,
      blockPromo: !!migrated.blockPromo,
      cleanAd: !!migrated.cleanAd,
      cleanLive: !!migrated.cleanLive,
      preloadEnabled: migrated.preloadEnabled === undefined ? true : !!migrated.preloadEnabled,
      preloadScreens: clampCount(migrated.preloadScreens, DEFAULTS.preloadScreens, 12)
    };

    settings.titleBlockRules = compileRules(settings.titleBlock);
    settings.titleAllowRules = compileRules(settings.titleAllow);
    settings.upBlockRules = compileRules(settings.upBlock);
    settings.upAllowRules = compileRules(settings.upAllow);
    settings.commentTextBlockRules = compileRules(settings.commentTextBlock);
    settings.commentTextAllowRules = compileRules(settings.commentTextAllow);
    settings.commentUserBlockRules = compileRules(settings.commentUserBlock);
    settings.commentUserAllowRules = compileRules(settings.commentUserAllow);
    settings.sectionCompiled = compileRules(settings.sectionRules);

    var expression = compileExpression(settings.statExpr);
    settings.statCompiled = expression.ok ? expression : null;
    settings.statError = expression.ok ? null : expression.error;

    return settings;
  }

  function hasActiveRules(settings) {
    if (!settings) return false;
    return !!(
      settings.titleBlockRules.length ||
      settings.titleAllowRules.length ||
      settings.upBlockRules.length ||
      settings.upAllowRules.length ||
      settings.sectionCompiled.length ||
      settings.durationSec > 0 ||
      (settings.statCompiled && settings.statCompiled.ast)
    );
  }

  function hasCommentRules(settings) {
    if (!settings) return false;
    return !!(
      settings.commentTextBlockRules.length ||
      settings.commentTextAllowRules.length ||
      settings.commentUserBlockRules.length ||
      settings.commentUserAllowRules.length ||
      settings.blockMention
    );
  }

  // 把一段字面文本转成只匹配它本身的正则片段
  function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  global.BiliPurifierCore = {
    VARIABLES: VARIABLES,
    VARIABLE_LABELS: VARIABLE_LABELS,
    DEFAULTS: DEFAULTS,
    BLOCK_CATEGORIES: BLOCK_CATEGORIES,
    wantsPlaceholder: wantsPlaceholder,
    normalizeEntry: normalizeEntry,
    normalizeList: normalizeList,
    compileRules: compileRules,
    matchAny: matchAny,
    parseRuleText: parseRuleText,
    formatRuleText: formatRuleText,
    escapeRegex: escapeRegex,
    compileExpression: compileExpression,
    testExpression: testExpression,
    statToVars: statToVars,
    normalizeSettings: normalizeSettings,
    hasActiveRules: hasActiveRules,
    hasCommentRules: hasCommentRules,
    clampCount: clampCount
  };
})(typeof window !== 'undefined' ? window : this);
