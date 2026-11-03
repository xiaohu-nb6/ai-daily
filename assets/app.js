/* =========================================================
   AI 前沿日报 · 前端逻辑
   数据来自 data/news.js（window.AI_DAILY_DATA）
   阅读记录存 localStorage：{ id, title, ts }
   ========================================================= */
(function () {
  'use strict';

  var CAT = {
    model:    { label: '模型发布', cls: 'tag-model',    swatch: 'sw-model' },
    policy:   { label: '政策监管', cls: 'tag-policy',   swatch: 'sw-policy' },
    industry: { label: '行业动态', cls: 'tag-industry', swatch: 'sw-industry' }
  };
  var RECORD_KEY = 'ai-daily.records.v1';
  var THEME_KEY = 'ai-daily.theme.v1';
  var MAX_RECORDS = 80;

  var state = {
    data: window.AI_DAILY_DATA || { articles: [], updatedAt: '', edition: '' },
    filter: 'all',
    query: '',
    records: loadRecords(),
    currentId: null
  };

  var $ = function (id) { return document.getElementById(id); };
  var listEl = $('list');
  var briefEl = $('briefList');
  var recordEl = $('recordList');
  var heroSlot = $('heroSlot');
  var emptyEl = $('empty');

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /* 搜索命中高亮：先按小写定位，再逐段转义，避免把用户输入当 HTML 或正则 */
  function hl(text) {
    var q = state.query.trim();
    var src = String(text == null ? '' : text);
    if (!q) return esc(src);
    var low = src.toLowerCase(), ql = q.toLowerCase();
    var out = '', i = 0, idx;
    while (ql && (idx = low.indexOf(ql, i)) > -1) {
      out += esc(src.slice(i, idx)) + '<mark class="hit">' + esc(src.slice(idx, idx + ql.length)) + '</mark>';
      i = idx + ql.length;
    }
    return out + esc(src.slice(i));
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  /* 全站日期统一为 11/03 形式，配等宽字体对齐 */
  function fmtShort(str) {
    var p = String(str || '').split('-');
    if (p.length < 3) return String(str || '');
    return pad(+p[1]) + '/' + pad(+p[2]);
  }
  function stamp(dateStr, time) {
    var d = fmtShort(dateStr);
    return time ? d + ' · ' + time : d;
  }
  function fmtClock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function shortTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function relTime(ts) {    var d = new Date(ts);
    var diff = Date.now() - d.getTime();
    if (isNaN(diff)) return '';
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    var today = new Date(); today.setHours(0, 0, 0, 0);
    if (d >= today) return '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    var y = new Date(today); y.setDate(y.getDate() - 1);
    if (d >= y) return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function setHash(hash) {
    try { history.replaceState(null, '', hash || (location.pathname + location.search)); }
    catch (e) { /* file:// 或沙箱环境下可能被拒，忽略即可 */ }
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('is-on'); }, 2600);
  }

  /* ---------------- 风格切换 ---------------- */
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'tech' ? 'tech' : 'paper';
  }
  function syncThemeButtons(t) {
    document.querySelectorAll('.theme-opt').forEach(function (b) {
      var on = b.dataset.theme === t;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function applyTheme(name, opts) {
    var next = name === 'tech' ? 'tech' : 'paper';
    var root = document.documentElement;
    var animate = !opts || opts.animate !== false;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (animate && !reduce) {
      root.classList.add('is-theming');
      clearTimeout(root._themeTimer);
      root._themeTimer = setTimeout(function () { root.classList.remove('is-theming'); }, 620);
    }
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式静默失败 */ }
    syncThemeButtons(next);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'tech' ? '#060a12' : '#f5f0e3');

    /* 两套主题的字族不同，行高会微调，速览可用高度要重新算 */
    clearTimeout(root._footTimer);
    root._footTimer = setTimeout(updateBriefFoot, 700);
  }
  function bindTheme() {
    document.querySelectorAll('.theme-opt').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.theme === currentTheme()) return;
        applyTheme(btn.dataset.theme);
      });
    });
    syncThemeButtons(currentTheme());
  }

  /* ---------------- 阅读记录 ---------------- */
  function loadRecords() {
    try {
      var raw = localStorage.getItem(RECORD_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(function (r) { return r && r.id; }) : [];
    } catch (e) { return []; }
  }
  function saveRecords() {
    try { localStorage.setItem(RECORD_KEY, JSON.stringify(state.records)); }
    catch (e) { /* 隐私模式下静默失败，不影响阅读 */ }
  }
  function isRead(id) {
    return state.records.some(function (r) { return r.id === id; });
  }
  function pushRecord(article) {
    state.records = state.records.filter(function (r) { return r.id !== article.id; });
    state.records.unshift({ id: article.id, title: article.title, ts: Date.now() });
    if (state.records.length > MAX_RECORDS) state.records.length = MAX_RECORDS;
    saveRecords();
    renderRecords();
    renderList();
  }
  function removeRecord(id) {
    state.records = state.records.filter(function (r) { return r.id !== id; });
    saveRecords();
    renderRecords();
    renderList();
    toast('已删除这条阅读记录');
  }

  /* ---------------- 数据 ---------------- */
  function all() { return (state.data.articles || []).slice(); }

  function visible() {
    var q = state.query.trim().toLowerCase();
    return all()
      .filter(function (a) { return state.filter === 'all' || a.category === state.filter; })
      .filter(function (a) {
        if (!q) return true;
        var hay = [a.title, a.summary, (a.tags || []).join(' '), (a.body || []).join(' '), a.source]
          .join(' ').toLowerCase();
        return hay.indexOf(q) > -1;
      })
      .sort(function (x, y) {
        var d = String(y.date).localeCompare(String(x.date));
        if (d !== 0) return d;
        return String(y.time || '').localeCompare(String(x.time || ''));
      });
  }

  function byId(id) { return all().filter(function (a) { return a.id === id; })[0]; }

  /* ---------------- 渲染：头部 ---------------- */
  function renderMeta() {
    var d = state.data;
    var dateStr = d.edition || (all()[0] && all()[0].date) || '';
    if (dateStr) {
      var p = dateStr.split('-');
      $('issueDate').textContent = p[0] + ' / ' + pad(+p[1]) + ' / ' + pad(+p[2]);
    }
    $('issueCount').textContent = '共 ' + all().length + ' 条';
    var up = d.updatedAt ? new Date(d.updatedAt) : null;
    $('issueUpdated').textContent = up && !isNaN(up.getTime())
      ? '更新于 ' + pad(up.getHours()) + ':' + pad(up.getMinutes())
      : '数据待更新';
  }

  function renderTicker() {
    var freq = {};
    all().forEach(function (a) {
      (a.tags || []).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; });
    });
    var tops = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 9);
    if (!tops.length) tops = ['AI 日报'];
    var q = state.query.trim();
    $('tickerTrack').innerHTML = tops.map(function (t) {
      return '<button class="kw' + (t === q ? ' is-on' : '') + '" type="button" data-kw="' + esc(t) + '"' +
        ' title="搜索「' + esc(t) + '」">' + esc(t) + '</button>';
    }).join('');
    syncTickerEnd();
  }

  /* 关键词条滚到底时取消右端渐隐，避免把最后一个词也蒙掉 */
  function syncTickerEnd() {
    var tr = $('tickerTrack');
    if (!tr) return;
    tr.classList.toggle('is-end', tr.scrollLeft + tr.clientWidth >= tr.scrollWidth - 2);
  }

  /* ---------------- 搜索状态 ---------------- */
  function renderSearchUi() {
    var input = $('searchInput');
    var clear = $('searchClear');
    /* 只在值不同时回写，避免打断中文输入法的候选状态 */
    if (input.value !== state.query) input.value = state.query;
    clear.hidden = !input.value.trim();
    var q = state.query.trim();
    document.querySelectorAll('.kw').forEach(function (k) {
      k.classList.toggle('is-on', !!q && k.dataset.kw === q);
    });
  }

  function setQuery(q, opts) {
    state.query = q;
    renderSearchUi();
    renderTicker();
    renderHero();
    renderList();
    if (opts && opts.focus) {
      var input = $('searchInput');
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
    }
  }

  /* ---------------- 渲染：今日焦点 ---------------- */
  function renderHero() {
    var feat = null;
    if (state.filter === 'all' && !state.query.trim()) {
      feat = all().filter(function (a) { return a.featured; })[0] || all()[0];
    }
    if (!feat) { heroSlot.innerHTML = ''; return; }

    var cat = CAT[feat.category] || CAT.industry;
    var keys = (feat.tags || []).slice(0, 4).map(function (t) {
      return '<span class="hero-key">' + esc(t) + '</span>';
    }).join('');
    var words = ((feat.body || []).join('').length);
    var mins = Math.max(1, Math.round(words / 400));

    heroSlot.innerHTML =
      '<div class="hero" data-id="' + esc(feat.id) + '" tabindex="0" role="button" aria-label="打开焦点资讯：' + esc(feat.title) + '">' +
        '<span class="hero-flag">今日焦点</span>' +
        '<div class="hero-main">' +
          '<div class="hero-cat">' + esc(cat.label) + ' · ' + esc(fmtShort(feat.date)) + '</div>' +
          '<h2><span class="hero-highlight">' + esc(feat.title) + '</span></h2>' +
          '<p class="hero-summary">' + esc(feat.summary) + '</p>' +
          '<div class="hero-foot">' +
            '<span class="hero-cta">读全文' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>' +
            '</span>' +
            '<span>约 ' + mins + ' 分钟</span>' +
            '<span>·</span>' +
            '<span>' + esc(feat.source) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="hero-side">' +
          '<div class="hero-side-label">本文关键词</div>' +
          '<div class="hero-keys">' + keys + '</div>' +
          '<div class="hero-stat"><span>本日收录</span><b>' + all().length + '</b> 条 · 三条线并读</div>' +
          '<div class="hero-stat"><span>数据更新</span><b>' + esc(shortTime(state.data.updatedAt)) + '</b></div>' +
        '</div>' +
      '</div>';
  }

  /* ---------------- 渲染：卡片 ---------------- */
  function renderList() {
    var items = visible();
    emptyEl.hidden = items.length > 0;

    listEl.innerHTML = items.map(function (a) {
      var cat = CAT[a.category] || CAT.industry;
      var readCls = isRead(a.id) ? ' is-read' : '';
      return '' +
        '<article class="card' + readCls + '" data-id="' + esc(a.id) + '" tabindex="0" role="button" aria-label="打开详情：' + esc(a.title) + '">' +
          '<div class="card-top">' +
            '<span class="tag ' + cat.cls + '">' + esc(cat.label) + '</span>' +
            '<span class="card-date">' + esc(stamp(a.date, a.time)) + '</span>' +
          '</div>' +
          '<h3 class="card-title">' + hl(a.title) + '</h3>' +
          '<p class="card-sum">' + hl(a.summary) + '</p>' +
          '<div class="card-foot">' +
            '<span class="card-src">' + hl(a.source || '公开报道') + '</span>' +
            '<span class="card-more">详情</span>' +
          '</div>' +
        '</article>';
    }).join('');

    renderBriefs(items);
    renderTabCounts();
    renderSearchUi();

    var note = $('loadNote');
    if (items.length) {
      note.textContent = '已显示 ' + items.length + ' 条' + (state.query.trim() ? '（搜索：' + state.query.trim() + '）' : '') + ' · 点击卡片看全文';
    } else {
      note.textContent = '';
    }
  }

  /* 分类角标数字 */
  function renderTabCounts() {
    var counts = { all: 0, model: 0, policy: 0, industry: 0 };
    all().forEach(function (a) {
      counts.all++;
      if (counts[a.category] !== undefined) counts[a.category]++;
    });
    document.querySelectorAll('.tab-num').forEach(function (el) {
      el.textContent = counts[el.dataset.num] || 0;
    });
  }

  function renderBriefs(items) {
    /* 记下滚动位置：阅读记录触发重绘时，速览列表不该弹回顶部 */
    var keep = briefEl.scrollTop;
    briefEl.innerHTML = items.map(function (a) {
      return '<li class="brief-item" data-id="' + esc(a.id) + '" tabindex="0" role="button">' +
        '<div>' +
          '<p class="brief-title">' + hl(a.title) + '</p>' +
          '<p class="brief-sum">' + hl(a.summary) + '</p>' +
        '</div>' +
      '</li>';
    }).join('');
    if (!items.length) {
      briefEl.innerHTML = '<li class="record-empty">当前筛选下暂无可速览内容。</li>';
    }
    briefEl.scrollTop = keep;
    updateBriefFoot();
  }

  /* 速览末尾提示：还剩几条没露出，替代原来「渐隐硬切」的观感 */
  function updateBriefFoot() {
    var foot = $('briefFoot');
    if (!foot) return;
    var items = briefEl.querySelectorAll('.brief-item');
    if (!items.length) { foot.hidden = true; return; }
    var box = briefEl.getBoundingClientRect();
    var rest = 0;
    items.forEach(function (li) {
      /* 完全露出的不算；只有越过列表底边的才计入「还有 N 条」 */
      if (li.getBoundingClientRect().bottom > box.bottom + 1) rest++;
    });
    var scrollable = briefEl.scrollHeight > briefEl.clientHeight + 2;
    if (!scrollable) { foot.hidden = true; return; }
    foot.hidden = false;
    foot.textContent = rest > 0
      ? '还有 ' + rest + ' 条 · 向下滚动查看'
      : '已到最末 · 共 ' + items.length + ' 条';
  }

  function renderRecords() {
    $('recordsCount').textContent = state.records.length;
    $('recordEmpty').hidden = state.records.length > 0;
    recordEl.innerHTML = state.records.map(function (r) {
      var a = byId(r.id);
      var title = a ? a.title : r.title || '（已下线的内容）';
      return '<li class="record-item" data-id="' + esc(r.id) + '">' +
        '<div class="record-main" tabindex="0" role="button" aria-label="重新打开：' + esc(title) + '">' +
          '<p class="record-title">' + esc(title) + '</p>' +
          '<div class="record-time">' + esc(relTime(r.ts)) + '</div>' +
        '</div>' +
        '<button class="record-del" type="button" title="删除这条记录" aria-label="删除记录：' + esc(title) + '">×</button>' +
      '</li>';
    }).join('');
  }

  /* ---------------- 详情 ---------------- */
  /* 上下篇的顺序 = 当前列表的可见顺序；若当前文章不在筛选结果里，退回全量顺序 */
  function navList(a) {
    var l = visible();
    var hit = l.some(function (x) { return x.id === a.id; });
    return hit ? l : all();
  }

  function renderDrawer(a) {
    var cat = CAT[a.category] || CAT.industry;
    var body = (a.body || []).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    var tags = (a.tags || []).map(function (t) { return '<span class="d-tag">' + esc(t) + '</span>'; }).join('');
    var chars = (a.body || []).join('').length;
    var mins = Math.max(1, Math.round(chars / 400));

    var list = navList(a);
    var idx = -1;
    for (var i = 0; i < list.length; i++) { if (list[i].id === a.id) { idx = i; break; } }
    var hasPrev = idx > 0;
    var hasNext = idx > -1 && idx < list.length - 1;
    var posText = idx > -1 ? (idx + 1) + ' / ' + list.length : '— / ' + list.length;

    var related = all()
      .filter(function (x) { return x.id !== a.id && x.category === a.category; })
      .slice(0, 3);

    $('drawerBody').innerHTML =
      '<span class="d-cat ' + cat.cls + '">' + esc(cat.label) + '</span>' +
      '<h2 class="d-title" id="drawerTitle">' + esc(a.title) + '</h2>' +
      '<div class="d-meta">' +
        '<span>' + esc(stamp(a.date, a.time)) + '</span>' +
        '<span class="sep">/</span>' +
        '<span>来源：' + esc(a.source || '公开报道') + '</span>' +
        '<span class="sep">/</span>' +
        '<span>约 ' + mins + ' 分钟读完</span>' +
      '</div>' +
      '<div class="d-summary">' +
        '<span class="d-summary-label">速览 · ' + Array.from(a.summary || '').length + ' 字</span>' +
        '<p>' + esc(a.summary) + '</p>' +
      '</div>' +
      '<div class="d-body">' + body + '</div>' +
      (tags ? '<div class="d-tags">' + tags + '</div>' : '') +
      '<div class="d-foot">' +
        '<div class="d-source">原文：<b>' + esc(a.source || '') + '</b><br />数字与口径以原文报道为准</div>' +
        '<a class="d-open" href="' + esc(a.url || '#') + '" target="_blank" rel="noopener noreferrer">阅读原文' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/></svg>' +
        '</a>' +
      '</div>' +
      '<div class="d-nav">' +
        '<button class="d-nav-btn" type="button" data-go="prev"' + (hasPrev ? '' : ' disabled') + '>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H6M11 6l-6 6 6 6"/></svg>上一条</button>' +
        '<span class="d-nav-pos" title="当前顺序位置">' + esc(posText) + '</span>' +
        '<button class="d-nav-btn" type="button" data-go="next"' + (hasNext ? '' : ' disabled') + '>下一条' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg></button>' +
      '</div>' +
      (related.length ? '<div class="d-related"><h4>同类其他资讯</h4>' +
        related.map(function (r) {
          return '<div class="d-rel-item" data-rel="' + esc(r.id) + '" tabindex="0" role="button">' +
            '<span>' + esc(fmtShort(r.date)) + '</span>' + esc(r.title) + '</div>';
        }).join('') + '</div>' : '');
  }

  function openArticle(id, opts) {
    var a = byId(id);
    if (!a) { toast('这条资讯已不在数据里（可能被更新脚本移除）'); return; }
    state.currentId = id;
    renderDrawer(a);
    pushRecord(a);
    $('drawer').classList.add('is-open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('scrim').hidden = false;
    setTimeout(function () { $('scrim').classList.add('is-on'); }, 20);
    document.body.style.overflow = 'hidden';
    $('drawer').scrollTop = 0;
    updateProgress();
    if (!opts || opts.hash !== false) {
      setHash('#/a/' + encodeURIComponent(id));
    }
    setTimeout(function () { $('drawerClose').focus(); }, 80);
  }

  /* 上一条 / 下一条：±1，到头则不动 */
  function goSibling(step) {
    if (!state.currentId) return;
    var cur = byId(state.currentId);
    if (!cur) return;
    var list = navList(cur);
    var idx = -1;
    for (var i = 0; i < list.length; i++) { if (list[i].id === cur.id) { idx = i; break; } }
    var next = list[idx + step];
    if (idx < 0 || !next) {
      toast(step < 0 ? '已经是第一条了' : '已经是最后一条了');
      return;
    }
    openArticle(next.id);
  }

  /* 阅读进度条 */
  function updateProgress() {
    var d = $('drawer'), bar = $('drawerProgress');
    if (!bar) return;
    var max = d.scrollHeight - d.clientHeight;
    var p = max > 8 ? Math.min(1, Math.max(0, d.scrollTop / max)) : 0;
    bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
  }

  function closeDrawer() {
    state.currentId = null;
    $('drawer').classList.remove('is-open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('scrim').classList.remove('is-on');
    setTimeout(function () { $('scrim').hidden = true; }, 300);
    document.body.style.overflow = '';
    if (location.hash) setHash('');
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    document.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (b) {
          b.classList.remove('is-active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('is-active');
        btn.setAttribute('aria-selected', 'true');
        state.filter = btn.dataset.cat;
        renderHero();
        renderList();
      });
    });

    // 搜索：边打边筛（15 条数据量，同步渲染不卡，也不依赖 rAF）
    var searchInput = $('searchInput');
    function onSearchInput(v) {
      state.query = v;
      $('searchClear').hidden = !v.trim();
      renderTicker();
      renderHero();
      renderList();
    }
    searchInput.addEventListener('input', function (e) { onSearchInput(e.target.value); });
    $('searchClear').addEventListener('click', function () {
      onSearchInput('');
      searchInput.focus();
    });

    // 卡片 / 速览 / 焦点 / 上下篇 / 关键词：事件委托
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.closest) return;

      var kw = t.closest('.kw');
      if (kw) {
        var active = kw.dataset.kw === state.query.trim();
        setQuery(active ? '' : kw.dataset.kw, { focus: false });
        document.querySelector('.feed-head').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      var go = t.closest('[data-go]');
      if (go) { goSibling(go.dataset.go === 'prev' ? -1 : 1); return; }

      var card = t.closest('.card, .hero, .brief-item, .d-rel-item');
      if (card) {
        var id = card.dataset.id || card.dataset.rel;
        if (id) { openArticle(id); return; }
      }
      var del = t.closest('.record-del');
      if (del) {
        var li = del.closest('.record-item');
        if (li) removeRecord(li.dataset.id);
        return;
      }
      var main = t.closest('.record-main');
      if (main) {
        var rli = main.closest('.record-item');
        if (rli) openArticle(rli.dataset.id);
      }
    });

    // 键盘可达
    document.addEventListener('keydown', function (e) {
      var el = document.activeElement;
      var typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if (e.key === 'Escape') {
        if (state.currentId) { closeDrawer(); return; }
        if (typing && $('searchInput').value) {
          onSearchInput('');
          return;
        }
      }
      // "/" 快速聚焦搜索
      if (e.key === '/' && !typing && !state.currentId) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
        return;
      }
      // 抽屉内 ←/→ 翻篇
      if (state.currentId && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing) {
        e.preventDefault();
        goSibling(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && el) {
        if (el.matches('.card, .hero, .brief-item, .d-rel-item, .record-main')) {
          e.preventDefault();
          var id = el.dataset.id || el.dataset.rel;
          if (id) openArticle(id);
          else if (el.classList.contains('record-main')) {
            var li = el.closest('.record-item');
            if (li) openArticle(li.dataset.id);
          }
        }
      }
    });

    $('drawerClose').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    $('drawer').addEventListener('scroll', updateProgress, { passive: true });

    $('recordsBtn').addEventListener('click', function () {
      var el = document.querySelector('.panel-records');
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.animate(
        [{ boxShadow: '0 0 0 0 rgba(43,108,168,.45)' }, { boxShadow: '0 0 0 10px rgba(43,108,168,0)' }],
        { duration: 900, iterations: 2 }
      );
    });
    $('clearRecords').addEventListener('click', function () {
      if (!state.records.length) { toast('当前没有阅读记录'); return; }
      state.records = [];
      saveRecords();
      renderRecords();
      renderList();
      toast('阅读记录已全部清空');
    });

    // 速览剩余条数提示
    var footTimer = 0;
    briefEl.addEventListener('scroll', function () {
      clearTimeout(footTimer);
      footTimer = setTimeout(updateBriefFoot, 70);
    }, { passive: true });

    // 关键词条右端渐隐状态
    $('tickerTrack').addEventListener('scroll', syncTickerEnd, { passive: true });

    // 「关于」折叠后速览可用高度变了，重算一次
    var notePanel = $('notePanel');
    if (notePanel) notePanel.addEventListener('toggle', function () { setTimeout(updateBriefFoot, 40); });

    window.addEventListener('resize', function () {
      updateBriefFoot();
      syncTickerEnd();
    });

    $('refreshBtn').addEventListener('click', refresh);

    window.addEventListener('hashchange', function () {
      var m = /^#\/a\/(.+)$/.exec(location.hash);
      if (m) {
        var id = decodeURIComponent(m[1]);
        if (id !== state.currentId) openArticle(id, { hash: false });
      } else if (state.currentId) {
        closeDrawer();
      }
    });
  }

  /* ---------------- 数据热更新 ---------------- */
  function refresh() {
    if (location.protocol === 'file:') {
      toast('本地文件模式下浏览器禁止读取数据文件，重新打开页面即可看到最新内容');
      return;
    }
    toast('正在检查更新…');
    fetch('data/news.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (json) {
        if (!json || !Array.isArray(json.articles)) throw new Error('数据格式不对');
        state.data = json;
        renderMeta(); renderTicker(); renderHero(); renderList(); renderRecords();
        toast('已更新：共 ' + json.articles.length + ' 条资讯');
      })
      .catch(function () {
        toast('没有读到新数据，当前展示的是内置版本');
      });
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    bindTheme();
    if (!all().length) {
      listEl.innerHTML = '';
      heroSlot.innerHTML = '';
      emptyEl.hidden = false;
      emptyEl.querySelector('p').textContent = '数据没加载出来：请确认 data/news.js 存在且格式正确。';
      $('loadNote').textContent = '';
      renderRecords();
      return;
    }
    renderMeta();
    renderTicker();
    renderHero();
    renderList();
    renderRecords();
    bind();
    updateBriefFoot();
    syncTickerEnd();
    /* 字体加载完成后行高会变，重新量一次 */
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { updateBriefFoot(); syncTickerEnd(); });
    }

    var m = /^#\/a\/(.+)$/.exec(location.hash);
    if (m) openArticle(decodeURIComponent(m[1]), { hash: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
