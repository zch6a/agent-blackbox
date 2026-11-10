/* agent-blackbox UI — vanilla JS, no dependencies, works offline and inside exported HTML files. */
(() => {
  'use strict';

  const BOOT = window.__BLACKBOX__ || { mode: 'live' };
  const LIVE = BOOT.mode === 'live';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const main = $('#main');
  const tooltip = $('#tooltip');

  const AGENTS = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
    'deepseek-harness': 'DeepSeek Harness',
  };
  const IDLE_GAP = 5 * 60 * 1000;
  const CHUNK = 300;

  // ---------- preferences ----------
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('blackbox:' + k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('blackbox:' + k, JSON.stringify(v));
      } catch {
        /* private mode */
      }
    },
  };

  const S = {
    sessions: [],
    loaded: false,
    filter: { agents: new Set(store.get('agents', [])), q: '', range: store.get('range', 'all'), sort: store.get('sort', 'time'), subagents: store.get('subagents', false) },
    listLimit: 150,
    key: null,
    data: null,
    view: 'sessions',
    opts: Object.assign({ mode: 'all', thinking: false, costs: false, tab: 'timeline' }, store.get('opts', {})),
    tl: null, // timeline render state
    replay: null,
  };

  // ---------- formatting ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const money = (usd) => {
    if (!isFinite(usd)) return '—';
    if (usd === 0) return '$0';
    if (usd < 0.01) return '<$0.01';
    if (usd < 100) return '$' + usd.toFixed(2);
    return '$' + Math.round(usd).toLocaleString('en-US');
  };
  const costLabel = (cost) => {
    if (!cost || cost.source === 'unknown') return '—';
    if (cost.source === 'recorded' || cost.usd < 0.01) return money(cost.usd);
    return '~' + money(cost.usd) + (cost.source === 'partial' ? '+' : '');
  };
  const tok = (n) => {
    n = n || 0;
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k';
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M';
    return (n / 1e9).toFixed(2) + 'B';
  };
  const num = (n) => (n || 0).toLocaleString('en-US');
  const dur = (ms) => {
    if (!isFinite(ms) || ms <= 0) return '—';
    if (ms < 1000) return Math.round(ms) + 'ms';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  };
  const pad2 = (n) => String(n).padStart(2, '0');
  const clock = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  };
  const day = (ms) => {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };
  const when = (ms) => {
    if (!ms) return '—';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
    return day(ms);
  };
  const totalTokens = (u) => (u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0);
  const home = (p) => String(p || '').replace(/^([A-Za-z]:)?[\\/](Users|home)[\\/][^\\/]+/, '~').replace(/\\/g, '/');
  const project = (cwd) => {
    const parts = String(cwd || '').split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || '(unknown)';
  };
  const activeMs = (s) => (typeof s.activeMs === 'number' ? s.activeMs : Math.max(0, s.endedAt - s.startedAt));

  // ---------- tiny safe markdown ----------
  function inline(s) {
    // s is already escaped
    return s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  }
  function md(src) {
    const text = String(src || '').replace(/\r/g, '');
    const out = [];
    const parts = text.split(/^```[^\n]*\n?/m);
    // even = prose, odd = code
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        out.push('<pre><code>' + esc(parts[i].replace(/\n$/, '')) + '</code></pre>');
        continue;
      }
      const lines = parts[i].split('\n');
      let para = [];
      let list = null;
      let table = null;
      const flushPara = () => {
        if (para.length) out.push('<p>' + para.map((l) => inline(esc(l))).join('<br>') + '</p>');
        para = [];
      };
      const flushList = () => {
        if (list) out.push('<' + list.tag + '>' + list.items.map((x) => '<li>' + inline(esc(x)) + '</li>').join('') + '</' + list.tag + '>');
        list = null;
      };
      const flushTable = () => {
        if (table) {
          const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
          const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
          out.push(
            '<table>' +
              rows
                .map((r, ri) => '<tr>' + cells(r).map((c) => (ri === 0 ? '<th>' : '<td>') + inline(esc(c.trim())) + (ri === 0 ? '</th>' : '</td>')).join('') + '</tr>')
                .join('') +
              '</table>',
          );
        }
        table = null;
      };
      for (const line of lines) {
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        const li = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
        if (/^\s*\|.*\|\s*$/.test(line)) {
          flushPara();
          flushList();
          (table = table || []).push(line);
          continue;
        }
        flushTable();
        if (!line.trim()) {
          flushPara();
          flushList();
        } else if (h) {
          flushPara();
          flushList();
          const lvl = Math.min(4, h[1].length + 1);
          out.push('<h' + lvl + '>' + inline(esc(h[2])) + '</h' + lvl + '>');
        } else if (li) {
          flushPara();
          const tag = li[1] ? 'ol' : 'ul';
          if (!list || list.tag !== tag) {
            flushList();
            list = { tag, items: [] };
          }
          list.items.push(li[2]);
        } else if (/^>\s?/.test(line)) {
          flushPara();
          flushList();
          out.push('<blockquote>' + inline(esc(line.replace(/^>\s?/, ''))) + '</blockquote>');
        } else {
          flushList();
          para.push(line);
        }
      }
      flushPara();
      flushList();
      flushTable();
    }
    return out.join('');
  }

  // ---------- API ----------
  async function api(path) {
    const res = await fetch(path, { headers: { 'x-blackbox-token': BOOT.token || '' } });
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try {
        msg = (await res.json()).error || msg;
      } catch {
        /* not json */
      }
      throw new Error(msg);
    }
    return res.json();
  }

  // ---------- tooltip ----------
  function showTip(html, x, y) {
    tooltip.innerHTML = html;
    tooltip.classList.add('on');
    const r = tooltip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, x + 14);
    const top = y + r.height + 18 > window.innerHeight ? y - r.height - 10 : y + 16;
    tooltip.style.left = Math.max(8, left) + 'px';
    tooltip.style.top = Math.max(8, top) + 'px';
  }
  const hideTip = () => tooltip.classList.remove('on');
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el) {
      const r = el.getBoundingClientRect();
      showTip(esc(el.getAttribute('data-tip')), r.left, r.bottom - 10);
    }
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('[data-tip]')) hideTip();
  });

  // ---------- theme ----------
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme(store.get('theme', 'system'));
  function cycleTheme() {
    const order = ['system', 'dark', 'light'];
    const next = order[(order.indexOf(store.get('theme', 'system')) + 1) % order.length];
    store.set('theme', next);
    applyTheme(next);
    if (S.data && S.opts.tab === 'timeline') drawFlight();
    if (S.view === 'insights' && S.stats) renderInsights(S.stats);
  }
  $('#theme').addEventListener('click', cycleTheme);

  // ---------- routing ----------
  function route() {
    const h = location.hash || '#/';
    const m = /^#\/s\/(.+)$/.exec(h);
    $$('#nav a').forEach((a) => a.classList.toggle('on', (a.dataset.view === 'insights') === h.startsWith('#/insights')));
    if (!LIVE) return openSession(null, BOOT.session);
    if (!m) document.title = 'agent-blackbox';
    if (h.startsWith('#/insights')) {
      S.view = 'insights';
      return showInsights();
    }
    S.view = 'sessions';
    const key = m ? decodeURIComponent(m[1]) : null;
    renderShell();
    if (key) openSession(key);
    else showEmptyDetail();
  }
  window.addEventListener('hashchange', route);

  // ---------- sessions list ----------
  function rangeStart(range) {
    const now = Date.now();
    return { '24h': now - 864e5, '7d': now - 7 * 864e5, '30d': now - 30 * 864e5, '90d': now - 90 * 864e5 }[range] || 0;
  }
  function filtered() {
    const f = S.filter;
    const q = f.q.trim().toLowerCase();
    const since = rangeStart(f.range);
    let list = S.sessions.filter(
      (s) =>
        (f.subagents || !s.parentKey) &&
        (!f.agents.size || f.agents.has(s.agent)) &&
        (!since || s.endedAt >= since) &&
        (!q || s.title.toLowerCase().includes(q) || String(s.cwd).toLowerCase().includes(q) || s.id.toLowerCase().startsWith(q) || s.models.join(' ').toLowerCase().includes(q)),
    );
    const sorters = {
      time: (a, b) => b.endedAt - a.endedAt,
      cost: (a, b) => ownCost(b) - ownCost(a),
      tools: (a, b) => b.toolCalls - a.toolCalls,
      errors: (a, b) => b.toolErrors - a.toolErrors,
    };
    return list.sort(sorters[f.sort] || sorters.time);
  }
  /** Sub-agents whose cost is inside their parent's recorded total add nothing to sums. */
  const ownCost = (s) => (s.costInParent ? 0 : s.cost.usd);
  const childrenOf = (key) => S.sessions.filter((x) => x.parentKey === key).sort((a, b) => a.startedAt - b.startedAt);
  /** What a piece of work cost: the session plus sub-agents that are not already inside its recorded total. */
  const familyCost = (s) => ownCost(s) + (s.children ? childrenOf(s.key).reduce((a, c) => a + ownCost(c), 0) : 0);
  const familyLabel = (s) => {
    const extra = familyCost(s) - ownCost(s);
    if (!extra) return costLabel(s.cost);
    const exact = s.cost.source === 'recorded' && childrenOf(s.key).every((c) => c.costInParent || c.cost.source === 'recorded');
    return (exact ? '' : '~') + money(familyCost(s));
  };
  const summaryOf = (key) => S.sessions.find((x) => x.key === key);

  function renderShell() {
    if ($('.split')) return;
    main.innerHTML = `
      <div class="split">
        <aside class="sidebar">
          <div class="filters">
            <input class="search" id="q" type="search" aria-label="Search sessions" placeholder="Search titles, projects, ids, models…  ( / )" autocomplete="off" spellcheck="false" />
            <div class="chips" id="agents"></div>
            <div class="row-inline">
              <select class="mini" id="range" aria-label="Time range">
                <option value="all">All time</option><option value="24h">Last 24h</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option>
              </select>
              <select class="mini" id="sort" aria-label="Sort">
                <option value="time">Newest</option><option value="cost">Most expensive</option><option value="tools">Most tool calls</option><option value="errors">Most errors</option>
              </select>
              <span class="list-meta" id="list-meta"></span>
              <button class="icon-btn live-only" id="refresh" title="Rescan logs" aria-label="Rescan logs">↻</button>
            </div>
          </div>
          <nav class="session-list" id="list" aria-label="Sessions"></nav>
        </aside>
        <section class="detail" id="detail"></section>
      </div>`;
    const q = $('#q');
    q.value = S.filter.q;
    q.addEventListener('input', () => {
      S.filter.q = q.value;
      S.listLimit = 150;
      renderList();
    });
    $('#range').value = S.filter.range;
    $('#range').addEventListener('change', (e) => {
      S.filter.range = e.target.value;
      store.set('range', S.filter.range);
      renderList();
    });
    $('#sort').value = S.filter.sort;
    $('#sort').addEventListener('change', (e) => {
      S.filter.sort = e.target.value;
      store.set('sort', S.filter.sort);
      renderList();
    });
    $('#refresh').addEventListener('click', () => loadSessions(true));
    $('#agents').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      if (chip.dataset.subagents !== undefined) {
        S.filter.subagents = !S.filter.subagents;
        store.set('subagents', S.filter.subagents);
        renderList();
        return;
      }
      const a = chip.dataset.agent;
      if (S.filter.agents.has(a)) S.filter.agents.delete(a);
      else S.filter.agents.add(a);
      store.set('agents', [...S.filter.agents]);
      renderList();
    });
    $('#list').addEventListener('click', (e) => {
      if (e.target.closest('.more')) {
        S.listLimit += 300;
        renderList();
      }
    });
    renderList();
  }

  function renderList() {
    const el = $('#list');
    if (!el) return;
    const counts = {};
    let subs = 0;
    for (const s of S.sessions) {
      if (s.parentKey) subs++;
      else counts[s.agent] = (counts[s.agent] || 0) + 1;
    }
    $('#agents').innerHTML =
      Object.keys(AGENTS)
        .filter((a) => counts[a])
        .map((a) => `<button type="button" class="chip ${S.filter.agents.has(a) ? 'on' : ''}" data-agent="${a}" aria-pressed="${S.filter.agents.has(a)}"><span class="dot ${a}"></span>${AGENTS[a]} <span class="n">${counts[a]}</span></button>`)
        .join('') +
      (subs
        ? `<button type="button" class="chip ${S.filter.subagents ? 'on' : ''}" data-subagents aria-pressed="${!!S.filter.subagents}" data-tip="Sessions spawned by another agent. Their parents show ⑂ with a count.">↳ Sub-agents <span class="n">${subs}</span></button>`
        : '');
    if (!S.loaded) {
      el.innerHTML = '<div class="empty">Indexing sessions…</div>';
      return;
    }
    if (!S.sessions.length) {
      el.innerHTML = `<div class="empty"><h2>No sessions found</h2>agent-blackbox reads logs from Claude Code, Codex, OpenCode and DeepSeek Harness.<br/>Run <code>blackbox doctor</code> to see where it looked.</div>`;
      return;
    }
    const list = filtered();
    // With sub-agents hidden, each parent row carries its family's cost.
    const total = list.reduce((a, s) => a + (S.filter.subagents ? ownCost(s) : familyCost(s)), 0);
    $('#list-meta').textContent = `${num(list.length)} · ${money(total)}`;
    el.innerHTML =
      list
        .slice(0, S.listLimit)
        .map((s) => {
          const flags = [
            s.toolErrors ? `<span class="flag err" data-tip="${s.toolErrors} failed tool calls">✗ ${s.toolErrors}</span>` : '',
            s.flags.includes('log-uploaded') ? `<span class="flag up" data-tip="Session log uploaded to the DeepSeek API">↑ uploaded</span>` : '',
            s.children ? `<span class="flag kids" data-tip="Spawned ${s.children} sub-agent${s.children > 1 ? 's' : ''}">⑂ ${s.children}</span>` : '',
            s.parentKey ? `<span class="flag sub" data-tip="Sub-agent${s.agentName ? ' (' + esc(s.agentName) + ')' : ''}">↳ ${esc(s.agentName || 'sub')}</span>` : '',
            s.flags.includes('incomplete') ? `<span class="flag inc" data-tip="Log ends mid-turn: still running, interrupted or crashed">… live</span>` : '',
          ].join('');
          return `<a class="s-item ${s.key === S.key ? 'on' : ''}" href="#/s/${encodeURIComponent(s.key)}" data-key="${esc(s.key)}"${s.key === S.key ? ' aria-current="page"' : ''}>
            <div class="s-title">${esc(s.title)}</div>
            <div class="s-meta"><span class="dot ${s.agent}" data-tip="${AGENTS[s.agent]}"></span><span>${esc(project(s.cwd))}</span><span>·</span><span>${when(s.endedAt)}</span><span class="s-flags">${flags}</span><span class="cost">${s.costInParent ? '<span class="hint" data-tip="Included in the parent session’s recorded cost">in parent</span>' : s.children && !S.filter.subagents ? `<span data-tip="Including ${s.children} sub-agent${s.children > 1 ? 's' : ''}">${familyLabel(s)}</span>` : costLabel(s.cost)}</span></div>
          </a>`;
        })
        .join('') + (list.length > S.listLimit ? `<button class="more">Show ${Math.min(300, list.length - S.listLimit)} more of ${num(list.length - S.listLimit)}</button>` : '');
    if (!list.length) el.innerHTML = '<div class="empty">No sessions match these filters.</div>';
  }

  async function loadSessions(refresh) {
    // Show indexing progress while the (possibly first, uncached) scan runs.
    const poll = setInterval(async () => {
      try {
        const st = await api('/api/status');
        const el = $('#list');
        if (st.indexing && st.total && el && !S.loaded) {
          el.innerHTML = `<div class="empty">Indexing sessions ${num(st.done)} / ${num(st.total)}…<br><span class="hint">The first run reads every log. After that a cache makes it instant.</span></div>`;
        }
      } catch {
        /* ignore */
      }
    }, 600);
    try {
      const { sessions } = await api('/api/sessions' + (refresh ? '?refresh=1' : ''));
      S.sessions = sessions;
      S.loaded = true;
      renderList();
      if (!S.key && S.view === 'sessions') showEmptyDetail();
    } catch (err) {
      main.innerHTML = `<div class="empty"><h2>Could not load sessions</h2>${esc(err.message)}</div>`;
    } finally {
      clearInterval(poll);
    }
  }

  function showEmptyDetail() {
    S.key = null;
    S.data = null;
    stopReplay();
    const d = $('#detail');
    if (!d) return;
    $('.split') && $('.split').classList.remove('has-session');
    $$('.s-item.on').forEach((x) => x.classList.remove('on'));
    if (!S.loaded) {
      d.innerHTML = '<div class="empty">Reading your agent logs…</div>';
      return;
    }
    const total = S.sessions.reduce((a, s) => a + ownCost(s), 0);
    const tools = S.sessions.reduce((a, s) => a + s.toolCalls, 0);
    const top = S.sessions.filter((s) => !s.parentKey).length;
    d.innerHTML = `<div class="empty">
      <h2>${num(top)} sessions · ${money(total)} · ${num(tools)} tool calls</h2>
      Pick a session to replay it, or open <a href="#/insights">Insights</a> to see where the money and time went.
      <p class="hint" style="margin-top:18px"><kbd>/</kbd> search &nbsp; <kbd>j</kbd> <kbd>k</kbd> next / previous &nbsp; <kbd>space</kbd> replay &nbsp; <kbd>e</kbd> errors only &nbsp; <kbd>t</kbd> theme</p>
    </div>`;
  }

  // ---------- session detail ----------
  async function openSession(key, preloaded) {
    stopReplay();
    S.key = key || (preloaded && preloaded.key);
    $$('.s-item').forEach((x) => {
      const on = x.dataset.key === S.key;
      x.classList.toggle('on', on);
      if (on) x.setAttribute('aria-current', 'page');
      else x.removeAttribute('aria-current');
    });
    const split = $('.split');
    if (split) split.classList.add('has-session');
    if (!LIVE) {
      document.body.classList.add('mode-export');
      main.innerHTML = `<div class="split has-session"><section class="detail" id="detail"></section></div>`;
    }
    const d = $('#detail');
    if (!preloaded) {
      d.innerHTML = '<div class="empty">Loading session…</div>';
      try {
        preloaded = await api('/api/session/' + encodeURIComponent(key));
      } catch (err) {
        d.innerHTML = `<div class="empty"><h2>Could not load this session</h2>${esc(err.message)}</div>`;
        return;
      }
      if (S.key !== key) return; // user moved on
    }
    // Family links are computed across sessions, so they come from the list, not the session payload.
    const sum = LIVE ? summaryOf(S.key) : null;
    if (sum) {
      preloaded.children = sum.children;
      preloaded.costInParent = sum.costInParent;
    }
    S.data = prepare(preloaded);
    S.data._kids = LIVE ? childrenOf(S.key) : [];
    S.data._kidByTool = new Map(S.data._kids.filter((k) => k.parentToolId).map((k) => [k.parentToolId, k]));
    document.title = S.data.title + ' · agent-blackbox';
    renderDetail();
  }

  /** Pre-compute per-event helpers used by the flight strip, replay and filters. */
  function prepare(s) {
    const ev = s.events;
    const pos = new Array(ev.length);
    const cum = new Array(ev.length);
    let p = 0;
    let last = 0;
    let c = 0;
    for (let i = 0; i < ev.length; i++) {
      const t = ev[i].t || last;
      if (last && t > last) p += Math.min(IDLE_GAP, t - last);
      if (t > last) last = t;
      pos[i] = p;
      if (ev[i].kind === 'usage') c += ev[i].usd || 0;
      cum[i] = c;
    }
    // When the agent recorded (part of) its own total, scale the running estimate so the curve ends at it.
    const scale = (s.cost.source === 'recorded' || s.cost.source === 'mixed') && c > 0 ? s.cost.usd / c : 1;
    for (let i = 0; i < cum.length; i++) cum[i] *= scale;
    s._pos = pos;
    s._cum = cum;
    s._span = p || 1;
    const files = new Map();
    const tools = new Map();
    ev.forEach((e, i) => {
      if (e.kind !== 'tool') return;
      const t = tools.get(e.name) || { name: e.name, calls: 0, errors: 0, ms: 0 };
      t.calls++;
      if (e.isError) t.errors++;
      if (e.endT && e.endT > e.t) t.ms += e.endT - e.t;
      tools.set(e.name, t);
      for (const ed of e.edits || []) {
        const f = files.get(ed.path) || { path: ed.path, added: 0, removed: 0, edits: [], ops: new Set() };
        f.added += ed.added;
        f.removed += ed.removed;
        f.ops.add(ed.op);
        f.edits.push({ i, ed });
        files.set(ed.path, f);
      }
    });
    s._files = [...files.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed));
    s._tools = [...tools.values()].sort((a, b) => b.calls - a.calls);
    return s;
  }

  function kpi(k, v, sub, tip) {
    return `<div class="kpi" ${tip ? `data-tip="${esc(tip)}"` : ''}><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub || '&nbsp;'}</div></div>`;
  }

  function renderDetail() {
    const s = S.data;
    const d = $('#detail');
    const u = s.usage;
    const promptTok = u.input + u.cacheRead + u.cacheWrite;
    const cachePct = promptTok ? Math.round((u.cacheRead / promptTok) * 100) : 0;
    const wall = Math.max(0, s.endedAt - s.startedAt);
    const notices = [];
    if (s.flags.includes('log-uploaded'))
      notices.push(`<div class="notice danger">↑ <span><b>This session's log was uploaded to the DeepSeek API.</b> DeepSeek Harness enables session-log delivery by default on the official API; you can turn it off in its Settings.</span></div>`);
    if (s.flags.includes('incomplete')) notices.push(`<div class="notice warn">… <span>The log ends mid-turn — the agent is still running, was interrupted, or crashed.</span></div>`);
    if (s.parentKey) {
      const parent = LIVE ? summaryOf(s.parentKey) : null;
      const link = parent ? `<a href="#/s/${encodeURIComponent(parent.key)}">${esc(parent.title)}</a>` : `<span class="mono">${esc(s.parentKey.slice(s.parentKey.indexOf(':') + 1))}</span>`;
      notices.push(
        `<div class="notice info">↳ <span>Sub-agent${s.agentName ? ` <b>${esc(s.agentName)}</b>` : ''} spawned by ${link}.${s.costInParent ? ' Its cost is already included in the parent’s recorded cost.' : ''}</span></div>`,
      );
    }
    const kids = s._kids || [];
    const famUsd = kids.length ? familyCost(s) : 0;
    const costTip =
      s.cost.source === 'recorded'
        ? 'Cost recorded by the agent itself'
        : s.cost.source === 'mixed'
          ? `Recorded by the agent from ${day(s.cost.recordedSince)} ${clock(s.cost.recordedSince)}; earlier requests estimated from list prices`
          : s.cost.source === 'partial'
          ? 'Estimated from list prices; some models have no known price'
          : s.cost.source === 'estimated'
            ? `Estimated from token counts and list prices (${BOOT.pricesUpdated || ''})`
            : 'No usage data in this log';
    d.innerHTML = `<div class="detail-inner">
      <a class="back" href="#/">← All sessions</a>
      <div class="crumbs"><span class="dot ${s.agent}"></span><span>${AGENTS[s.agent]}</span><span class="sep">/</span><span>${esc(project(s.cwd))}</span><span class="sep">/</span><span class="mono" data-tip="${esc(s.id)}">${esc(s.id.slice(0, 13))}</span></div>
      <h1 class="title">${esc(s.title)}</h1>
      <div class="subtitle"><span class="mono">${esc(home(s.cwd) || '—')}</span><span>${day(s.startedAt)} ${clock(s.startedAt)} → ${s.endedAt - s.startedAt > 864e5 ? day(s.endedAt) + ' ' : ''}${clock(s.endedAt)}</span><span>${esc(s.models.join(', ') || 'unknown model')}</span></div>
      ${notices.join('')}
      <div class="kpis">
        ${
          s.costInParent
            ? kpi('Cost', '<span class="hint">in parent</span>', `~${money(s.cost.usd)} est.`, 'Included in the parent session’s recorded cost')
            : famUsd > ownCost(s) + 0.005
              ? kpi('Cost', familyLabel(s), `${costLabel(s.cost)} here + ${kids.length} sub-agent${kids.length > 1 ? 's' : ''}`, costTip + ' — plus sub-agents not included in it')
              : kpi('Cost', costLabel(s.cost), s.cost.source + (kids.length ? ` · +${kids.length} sub-agent${kids.length > 1 ? 's' : ''}` : ''), costTip + (kids.length ? ', including its sub-agents' : ''))
        }
        ${kpi('Tokens', tok(totalTokens(u)), promptTok ? cachePct + '% cache hits' : '', `input ${num(u.input)} · output ${num(u.output)} · cache read ${num(u.cacheRead)} · cache write ${num(u.cacheWrite)}`)}
        ${kpi('Active time', dur(activeMs(s)), 'over ' + dur(wall), 'Idle gaps longer than 5 minutes are not counted')}
        ${kpi('Prompts', num(s.prompts), s.prompts ? money(s.cost.usd / s.prompts) + ' / prompt' : '')}
        ${kpi('Tool calls', num(s.toolCalls), s.toolErrors ? `<span style="color:var(--err)">${s.toolErrors} failed</span>` : 'no failures')}
        ${kpi('Files changed', num(s.filesChanged), `<span style="color:var(--add)">+${num(s.linesAdded)}</span> <span style="color:var(--del)">−${num(s.linesRemoved)}</span>`)}
      </div>
      <div class="flight">
        <div class="flight-head"><b>Flight path</b>
          <span class="legend"><i style="background:var(--user)"></i>prompt</span>
          <span class="legend"><i style="background:var(--tool)"></i>tool calls</span>
          <span class="legend"><i style="background:var(--err)"></i>errors</span>
          <span class="legend"><i style="background:var(--warn)"></i>compaction</span>
          <span class="legend"><i style="background:var(--accent);height:2px"></i>cumulative cost</span>
          <span class="spacer"></span><span>idle gaps compressed · click to jump</span>
        </div>
        <canvas id="flight" role="img" aria-label="Session activity over time: ${num(s.prompts)} prompts, ${num(s.toolCalls)} tool calls, ${num(s.toolErrors)} failed. Click to jump to a moment."></canvas>
        <div class="flight-axis"><span>${clock(s.startedAt)}</span><span id="flight-mid"></span><span>${clock(s.endedAt)}</span></div>
      </div>
      <div class="toolbar" id="toolbar">
        <div class="seg" id="tabs">
          <button data-tab="timeline">Timeline</button>
          <button data-tab="files">Files ${s._files.length}</button>
          ${kids.length ? `<button data-tab="agents">Sub-agents ${kids.length}</button>` : ''}
          <button data-tab="tools">Tools ${s._tools.length}</button>
        </div>
        <span class="tl-only seg" id="mode">
          <button data-mode="all" data-tip="Everything">All</button>
          <button data-mode="chat" data-tip="Only the conversation, no tool calls">Chat</button>
          <button data-mode="errors" data-tip="Failed tool calls and errors, with the prompts around them (e)">Errors</button>
        </span>
        <label class="toggle tl-only"><input type="checkbox" id="opt-thinking" /> Thinking</label>
        <label class="toggle tl-only"><input type="checkbox" id="opt-costs" /> Costs</label>
        <span class="tb-right tl-only">
          <input class="find" id="find" type="search" aria-label="Find in this session (Enter for next match)" placeholder="Find in session…" autocomplete="off" spellcheck="false" />
          <button class="btn primary" id="play" data-tip="Replay the session step by step (space)">▶ Replay</button>
        </span>
        <div class="replay" id="replay">
          <button class="btn" id="rp-toggle">❚❚</button>
          <span class="seg" id="rp-speed"><button data-speed="1">1×</button><button data-speed="4">4×</button><button data-speed="16">16×</button><button data-speed="64">64×</button></span>
          <input type="range" id="rp-range" min="0" max="0" value="0" aria-label="Replay position" />
          <span class="clock" id="rp-clock"></span>
          <button class="btn" id="rp-exit">Exit</button>
        </div>
      </div>
      <div id="tabbody"></div>
    </div>`;
    d.scrollTop = 0;
    bindToolbar();
    drawFlight();
    renderTab();
  }

  function bindToolbar() {
    const tb = $('#toolbar');
    const sync = () => {
      $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.opts.tab));
      $$('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.opts.mode));
      $('#opt-thinking').checked = !!S.opts.thinking;
      $('#opt-costs').checked = !!S.opts.costs;
      $$('.tl-only', tb).forEach((x) => (x.style.display = S.opts.tab === 'timeline' && !S.replay ? '' : 'none'));
      store.set('opts', S.opts);
    };
    tb.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      const mode = e.target.closest('[data-mode]');
      const speed = e.target.closest('[data-speed]');
      if (tab) {
        S.opts.tab = tab.dataset.tab;
        sync();
        renderTab();
      } else if (mode) {
        S.opts.mode = mode.dataset.mode;
        sync();
        renderTimeline();
      } else if (speed && S.replay) {
        S.replay.speed = Number(speed.dataset.speed);
        store.set('replay-speed', S.replay.speed);
        syncReplay();
      }
    });
    $('#opt-thinking').addEventListener('change', (e) => {
      S.opts.thinking = e.target.checked;
      sync();
      renderTimeline();
    });
    $('#opt-costs').addEventListener('change', (e) => {
      S.opts.costs = e.target.checked;
      sync();
      $('#timeline') && $('#timeline').classList.toggle('show-costs', S.opts.costs);
    });
    let findTimer = 0;
    $('#find').addEventListener('input', () => {
      clearTimeout(findTimer);
      findTimer = setTimeout(() => renderTimeline(), 180);
    });
    $('#find').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        jumpToMatch(e.shiftKey ? -1 : 1);
      }
    });
    $('#play').addEventListener('click', startReplay);
    $('#rp-toggle').addEventListener('click', () => (S.replay && S.replay.timer ? pauseReplay() : resumeReplay()));
    $('#rp-exit').addEventListener('click', () => {
      stopReplay();
      sync();
      renderTimeline();
    });
    $('#rp-range').addEventListener('input', (e) => {
      if (!S.replay) return;
      pauseReplay();
      seekReplay(Number(e.target.value));
    });
    S._syncToolbar = sync;
    sync();
  }

  function renderTab() {
    stopReplay();
    S._syncToolbar && S._syncToolbar();
    const body = $('#tabbody');
    if (S.opts.tab === 'files') return renderFiles(body);
    if (S.opts.tab === 'tools') return renderTools(body);
    if (S.opts.tab === 'agents') {
      if (S.data._kids.length) return renderAgents(body);
      S.opts.tab = 'timeline';
      S._syncToolbar && S._syncToolbar();
    }
    body.innerHTML = `<div class="timeline ${S.opts.costs ? 'show-costs' : ''}" id="timeline"></div>`;
    renderTimeline();
  }

  // ---------- timeline ----------
  function visibleIndices() {
    const s = S.data;
    const mode = S.opts.mode;
    const q = ($('#find') && $('#find').value.trim().toLowerCase()) || '';
    const out = [];
    const ev = s.events;
    const keepContext = new Set();
    if (mode === 'errors') {
      // Show each error together with the most recent prompt before it.
      let lastUser = -1;
      ev.forEach((e, i) => {
        if (e.kind === 'user') lastUser = i;
        const bad = (e.kind === 'tool' && e.isError) || (e.kind === 'system' && e.level !== 'info');
        if (bad && lastUser >= 0) keepContext.add(lastUser);
      });
    }
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.kind === 'thinking' && !S.opts.thinking) continue;
      if (mode === 'chat' && (e.kind === 'tool' || e.kind === 'usage' || (e.kind === 'system' && e.level === 'info'))) continue;
      if (mode === 'errors') {
        const bad = (e.kind === 'tool' && e.isError) || (e.kind === 'system' && e.level !== 'info');
        if (!bad && !keepContext.has(i)) continue;
      }
      if (q && !matches(e, q)) continue;
      out.push(i);
    }
    return out;
  }

  function matches(e, q) {
    const hay =
      e.kind === 'tool'
        ? e.name + ' ' + (e.brief || '') + ' ' + (typeof e.input === 'string' ? e.input : JSON.stringify(e.input)) + ' ' + (e.output || '')
        : e.text || e.model || '';
    return hay.toLowerCase().includes(q);
  }

  function renderTimeline() {
    const el = $('#timeline');
    if (!el || !S.data) return;
    const vis = visibleIndices();
    S.tl = { vis, rendered: 0, el };
    el.innerHTML = vis.length ? '' : `<div class="empty">${S.opts.mode === 'errors' ? 'No errors in this session. 🎉' : 'Nothing matches.'}</div>`;
    const sentinel = document.createElement('div');
    sentinel.className = 'sentinel';
    el.appendChild(sentinel);
    S.tl.sentinel = sentinel;
    if (S.tl.io) S.tl.io.disconnect();
    S.tl.io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) renderMore();
    }, { root: $('#detail'), rootMargin: '1200px' });
    S.tl.io.observe(sentinel);
    renderMore();
    const q = $('#find') && $('#find').value.trim();
    if (q) S.matchCursor = -1;
  }

  function renderMore(upTo) {
    const tl = S.tl;
    if (!tl) return;
    const end = Math.min(tl.vis.length, Math.max(tl.rendered + CHUNK, upTo === undefined ? 0 : upTo + 40));
    if (end <= tl.rendered) return;
    const html = [];
    for (let v = tl.rendered; v < end; v++) html.push(eventHtml(tl.vis[v], v));
    tl.sentinel.insertAdjacentHTML('beforebegin', html.join(''));
    tl.rendered = end;
    if (S.replay) applyReplayVisibility();
    if (tl.rendered >= tl.vis.length) tl.sentinel.style.display = 'none';
  }

  function eventHtml(i, v) {
    const e = S.data.events[i];
    const q = ($('#find') && $('#find').value.trim()) || '';
    const cls = q ? ' match' : '';
    const t = `<span class="t">${clock(e.t)}</span>`;
    const attrs = `data-i="${i}" data-v="${v}"`;
    switch (e.kind) {
      case 'user': {
        const imgs = e.images ? ` <span class="model">· ${e.images} image${e.images > 1 ? 's' : ''}</span>` : '';
        if (e.from === 'agent') return `<div class="ev user task${cls}" ${attrs}>${t}<div class="card"><div class="who">Task from the parent agent${imgs}</div>${textBlock(e.text)}</div></div>`;
        return `<div class="ev user${cls}" ${attrs}>${t}<div class="card"><div class="who">You${imgs}</div>${textBlock(e.text)}</div></div>`;
      }
      case 'assistant':
        return `<div class="ev assistant${cls}" ${attrs}>${t}<div class="card"><div class="who">Agent ${e.model ? `<span class="model">${esc(e.model)}</span>` : ''}</div>${textBlock(e.text)}</div></div>`;
      case 'thinking':
        return `<div class="ev thinking${cls}" ${attrs}>${t}<div class="card"><div class="who">Thinking</div>${textBlock(e.text, 600)}</div></div>`;
      case 'tool': {
        const edits = (e.edits || []).map((x) => `<span class="add">+${x.added}</span> <span class="del">−${x.removed}</span>`).join(' ');
        const status = e.isError
          ? `<span class="st bad" data-tip="${esc(e.err || 'failed')}">✗ ${esc(e.err || 'failed')}</span>`
          : e.output || e.endT
            ? '<span class="st">✓</span>'
            : '<span class="st pending" data-tip="No result recorded">…</span>';
        const took = e.endT && e.endT > e.t ? `<span class="dur">${dur(e.endT - e.t)}</span>` : '';
        const kid = S.data._kidByTool && S.data._kidByTool.get(e.id);
        const kidLink = kid ? `<a class="kid-link" href="#/s/${encodeURIComponent(kid.key)}" data-tip="Open the sub-agent session: ${esc(kid.title)}">⑂ ${esc(kid.agentName || 'sub-agent')} · ${num(kid.toolCalls)} tools</a>` : '';
        return `<div class="ev toolev${cls}" ${attrs}>${t}<details class="tool${e.isError ? ' err' : ''}${e.parentId ? ' nested' : ''}"><summary>${toolName(e.name)}<span class="brief">${esc(e.brief || '')}</span>${kidLink}${edits ? `<span class="ed">${edits}</span>` : ''}${took}${status}</summary></details></div>`;
      }
      case 'usage':
        return `<div class="ev usage" ${attrs}>${t}<div class="note">${e.priced ? money(e.usd) : '$?'} · ${tok(totalTokens(e.usage))} tokens (in ${tok(e.usage.input)}, out ${tok(e.usage.output)}, cache ${tok(e.usage.cacheRead)}) · ${esc(e.model)}</div></div>`;
      case 'system':
        return `<div class="ev system ${e.level}${cls}" ${attrs}>${t}<div class="note">${esc(e.text.length > 1500 ? e.text.slice(0, 1500) + '…' : e.text)}</div></div>`;
      case 'compact':
        return `<div class="ev compact" ${attrs}>${t}<div class="note"><span>⇣ context compacted</span></div></div>`;
      default:
        return '';
    }
  }

  /** `mcp__github__create_issue` → "create_issue" with a dim "github" prefix; full name on hover. */
  function toolName(name) {
    const m = /^mcp__(.+?)__(.+)$/.exec(name);
    const inner = m ? `<i>${esc(m[1])}</i>${esc(m[2])}` : esc(name);
    return `<span class="name" title="${esc(name)}">${inner}</span>`;
  }

  function textBlock(text, clampAt = 1600) {
    const long = text.length > clampAt || text.split('\n').length > 28;
    return `<div class="text${long ? ' clamp' : ''}">${md(text)}</div>${long ? '<button class="expand">Show all</button>' : ''}`;
  }

  function toolBody(e, i) {
    const input = typeof e.input === 'string' ? e.input : JSON.stringify(e.input, null, 2);
    const parts = [];
    if (e.edits && e.edits.length) parts.push(e.edits.map(diffHtml).join(''));
    parts.push(`<div><h4>Input <button data-copy="in">copy</button></h4><pre class="out">${esc(input)}</pre></div>`);
    if (e.output || e.isError) {
      parts.push(
        `<div><h4>Output${e.endT && e.endT > e.t ? ' · ' + dur(e.endT - e.t) : ''} <button data-copy="out">copy</button>${e.clipped && LIVE ? ` <button data-full="${i}">load full output</button>` : ''}</h4><pre class="out${e.isError ? ' err' : ''}">${esc(e.output || '(empty)')}</pre></div>`,
      );
    }
    return `<div class="tool-body">${parts.join('')}</div>`;
  }

  function diffHtml(ed) {
    const lines = String(ed.diff || '')
      .split('\n')
      .map((l) => {
        const c = l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : l.startsWith('@@') ? 'h' : 'c';
        return `<div class="l ${c}">${esc(l) || ' '}</div>`;
      })
      .join('');
    return `<div class="diff"><div class="path">${esc(home(ed.path))} <span class="op">${ed.op} · <span style="color:var(--add)">+${ed.added}</span> <span style="color:var(--del)">−${ed.removed}</span></span></div>${ed.diff ? lines : ''}</div>`;
  }

  // Lazily build tool bodies the first time they are opened (keeps the DOM small).
  document.addEventListener(
    'toggle',
    (e) => {
      const det = e.target;
      if (!(det instanceof HTMLDetailsElement) || !det.classList.contains('tool') || !det.open || det.dataset.built) return;
      const evEl = det.closest('.ev');
      if (!evEl || !S.data) return;
      const i = Number(evEl.dataset.i);
      det.insertAdjacentHTML('beforeend', toolBody(S.data.events[i], i));
      det.dataset.built = '1';
    },
    true,
  );

  document.addEventListener('click', async (e) => {
    const exp = e.target.closest('.expand');
    if (exp) {
      const t = exp.previousElementSibling;
      t.classList.toggle('clamp');
      exp.textContent = t.classList.contains('clamp') ? 'Show all' : 'Show less';
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const i = Number(copy.closest('.ev').dataset.i);
      const ev = S.data.events[i];
      const text = copy.dataset.copy === 'in' ? (typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input, null, 2)) : ev.output;
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'copied';
        setTimeout(() => (copy.textContent = 'copy'), 1200);
      } catch {
        copy.textContent = 'copy failed';
      }
      return;
    }
    const full = e.target.closest('[data-full]');
    if (full && LIVE) {
      const i = Number(full.dataset.full);
      full.textContent = 'loading…';
      try {
        const ev = await api(`/api/session/${encodeURIComponent(S.key)}/event/${i}`);
        Object.assign(S.data.events[i], { output: ev.output, input: ev.input, clipped: false });
        const det = full.closest('details');
        det.querySelector('.tool-body').outerHTML = toolBody(S.data.events[i], i);
      } catch (err) {
        full.textContent = 'failed: ' + err.message;
      }
      return;
    }
    const row = e.target.closest('tr[data-file]');
    if (row) {
      const next = row.nextElementSibling;
      if (next && next.classList.contains('file-row')) {
        next.remove();
        return;
      }
      const f = S.data._files[Number(row.dataset.file)];
      row.insertAdjacentHTML(
        'afterend',
        `<tr class="file-row"><td colspan="4" style="padding:0"><div class="file-diffs">${f.edits
          .map(({ i, ed }) => `<div><div class="hint" style="margin-bottom:4px">${clock(S.data.events[i].t)} · <a href="#" data-jump="${i}">jump to tool call</a></div>${diffHtml(ed)}</div>`)
          .join('')}</div></td></tr>`,
      );
      return;
    }
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      e.preventDefault();
      jumpTo(Number(jump.dataset.jump));
      return;
    }
    const top = e.target.closest('[data-open]');
    if (top) location.hash = '#/s/' + encodeURIComponent(top.dataset.open);
  });

  function jumpTo(i, open = true) {
    if (S.opts.tab !== 'timeline') {
      S.opts.tab = 'timeline';
      renderTab();
    }
    let v = S.tl.vis.indexOf(i);
    if (v === -1) {
      // The event is filtered out: reset filters so it can be shown.
      S.opts.mode = 'all';
      if ($('#find')) $('#find').value = '';
      if (S.data.events[i].kind === 'thinking') S.opts.thinking = true;
      S._syncToolbar();
      renderTimeline();
      v = S.tl.vis.indexOf(i);
      if (v === -1) {
        // fall back to nearest visible event
        v = S.tl.vis.findIndex((x) => x >= i);
        if (v === -1) v = S.tl.vis.length - 1;
      }
    }
    renderMore(v);
    const el = $(`.ev[data-v="${v}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    const det = el.querySelector('details');
    if (open && det && S.data.events[S.tl.vis[v]].isError) det.open = true;
  }

  function jumpToMatch(dir) {
    if (!S.tl || !S.tl.vis.length) return;
    S.matchCursor = ((S.matchCursor ?? -1) + dir + S.tl.vis.length) % S.tl.vis.length;
    jumpTo(S.tl.vis[S.matchCursor], false);
  }

  // ---------- flight strip ----------
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawFlight() {
    const cv = $('#flight');
    if (!cv || !S.data) return;
    const s = S.data;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const nb = Math.max(20, Math.floor(W / 3));
    const buckets = Array.from({ length: nb }, () => ({ tools: 0, errors: 0, prompts: 0, compacts: 0, first: -1, cost: 0, t0: 0, t1: 0 }));
    const ev = s.events;
    for (let i = 0; i < ev.length; i++) {
      const b = buckets[Math.min(nb - 1, Math.floor((s._pos[i] / s._span) * nb))];
      const e = ev[i];
      if (b.first < 0) b.first = i;
      if (e.t) {
        if (!b.t0) b.t0 = e.t;
        b.t1 = e.t;
      }
      if (e.kind === 'tool') {
        b.tools++;
        if (e.isError) b.errors++;
      } else if (e.kind === 'user') b.prompts++;
      else if (e.kind === 'compact') b.compacts++;
      else if (e.kind === 'system' && e.level === 'error') b.errors++;
      b.cost = s._cum[i];
    }
    let running = 0;
    for (const b of buckets) {
      if (b.first < 0) b.cost = running;
      running = b.cost;
    }
    const maxTools = Math.max(1, ...buckets.map((b) => b.tools));
    const bw = W / nb;
    const top = 6;
    const base = H - 4;
    const hh = base - top;
    ctx.fillStyle = cssVar('--line');
    ctx.fillRect(0, base, W, 1);
    const colTool = cssVar('--tool');
    const colErr = cssVar('--err');
    const colUser = cssVar('--user');
    const colWarn = cssVar('--warn');
    const colAcc = cssVar('--accent');
    buckets.forEach((b, k) => {
      const x = k * bw;
      if (b.tools) {
        const h = Math.max(2, Math.sqrt(b.tools / maxTools) * hh * 0.9);
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = colTool;
        ctx.fillRect(x + 0.3, base - h, Math.max(1, bw - 0.6), h);
        ctx.globalAlpha = 1;
      }
      if (b.errors) {
        ctx.fillStyle = colErr;
        const h = Math.min(hh, 6 + b.errors * 3);
        ctx.fillRect(x + 0.3, top, Math.max(1.5, bw - 0.6), h);
      }
      if (b.prompts) {
        ctx.fillStyle = colUser;
        ctx.fillRect(x + bw / 2 - 1, top, 2, hh);
      }
      if (b.compacts) {
        ctx.fillStyle = colWarn;
        for (let y = top; y < base; y += 6) ctx.fillRect(x + bw / 2 - 0.75, y, 1.5, 3);
      }
    });
    const total = running || 0;
    if (total > 0) {
      ctx.strokeStyle = colAcc;
      ctx.lineWidth = 2;
      ctx.beginPath();
      buckets.forEach((b, k) => {
        const x = (k + 0.5) * bw;
        const y = base - (b.cost / total) * hh;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    if (S.replay) {
      const p = S.replay.pos;
      const i = S.tl.vis[p];
      if (i !== undefined) {
        const x = (s._pos[i] / s._span) * W;
        ctx.fillStyle = cssVar('--fg');
        ctx.fillRect(x - 1, 0, 2, H);
      }
    }
    S._buckets = buckets;
    const midIdx = Math.floor(nb / 2);
    const mid = buckets.slice(midIdx).find((b) => b.t0);
    $('#flight-mid').textContent = mid ? clock(mid.t0) : '';
    if (!cv._bound) {
      cv._bound = true;
      cv.addEventListener('mousemove', (e) => {
        const r = cv.getBoundingClientRect();
        const k = Math.min(S._buckets.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * S._buckets.length)));
        const b = S._buckets[k];
        if (!b || b.first < 0) return hideTip();
        showTip(
          `<b>${clock(b.t0)}${b.t1 && b.t1 !== b.t0 ? '–' + clock(b.t1) : ''}</b><br>${b.prompts ? b.prompts + ' prompt' + (b.prompts > 1 ? 's' : '') + ' · ' : ''}${b.tools} tool calls${b.errors ? ` · <span style="color:#ff8080">${b.errors} errors</span>` : ''}${b.compacts ? ' · compaction' : ''}<br>cost so far ${money(b.cost)}`,
          e.clientX,
          e.clientY,
        );
      });
      cv.addEventListener('mouseleave', hideTip);
      cv.addEventListener('click', (e) => {
        const r = cv.getBoundingClientRect();
        const k = Math.floor(((e.clientX - r.left) / r.width) * S._buckets.length);
        // nearest non-empty bucket
        for (let d = 0; d < S._buckets.length; d++) {
          for (const kk of [k + d, k - d]) {
            const b = S._buckets[kk];
            if (b && b.first >= 0) {
              if (S.replay) {
                pauseReplay();
                const v = S.tl.vis.findIndex((x) => x >= b.first);
                seekReplay(v === -1 ? S.tl.vis.length - 1 : v);
              } else jumpTo(b.first, false);
              return;
            }
          }
        }
      });
    }
  }
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => S.data && drawFlight(), 120);
  });

  // ---------- replay ----------
  function startReplay() {
    if (!S.data || !S.tl) return;
    S.replay = { pos: 0, speed: store.get('replay-speed', 1), timer: 0 };
    $('#replay').classList.add('on');
    S._syncToolbar();
    $('#rp-range').max = String(Math.max(0, S.tl.vis.length - 1));
    applyReplayVisibility();
    $('#detail').scrollTop = $('#toolbar').offsetTop - 10;
    syncReplay();
    resumeReplay();
  }
  function stopReplay() {
    if (!S.replay) return;
    clearTimeout(S.replay.timer);
    S.replay = null;
    const bar = $('#replay');
    if (bar) bar.classList.remove('on');
    $$('.ev.hidden-replay').forEach((x) => x.classList.remove('hidden-replay'));
    drawFlight();
  }
  function pauseReplay() {
    if (!S.replay) return;
    clearTimeout(S.replay.timer);
    S.replay.timer = 0;
    syncReplay();
  }
  function resumeReplay() {
    if (!S.replay) return;
    if (S.replay.pos >= S.tl.vis.length - 1) S.replay.pos = 0;
    clearTimeout(S.replay.timer);
    S.replay.timer = 1;
    syncReplay();
    tick();
  }
  function tick() {
    const r = S.replay;
    if (!r || !r.timer) return;
    if (r.pos >= S.tl.vis.length - 1) {
      r.timer = 0;
      syncReplay();
      return;
    }
    const ev = S.data.events;
    const a = ev[S.tl.vis[r.pos]];
    const b = ev[S.tl.vis[r.pos + 1]];
    const gap = Math.max(0, ((b && b.t) || 0) - ((a && a.t) || 0)) / 1000;
    // Compress real time: long pauses still feel like pauses, but nothing takes forever.
    const delay = Math.min(1800, 70 + 320 * Math.log10(1 + Math.min(gap, 600))) / r.speed;
    r.timer = setTimeout(() => {
      if (!S.replay) return;
      seekReplay(r.pos + 1, true);
      tick();
    }, Math.max(8, delay));
  }
  function seekReplay(pos, follow) {
    const r = S.replay;
    if (!r) return;
    r.pos = Math.max(0, Math.min(S.tl.vis.length - 1, pos));
    renderMore(r.pos);
    applyReplayVisibility();
    syncReplay();
    const el = $(`.ev[data-v="${r.pos}"]`);
    if (el && follow !== false) el.scrollIntoView({ block: 'nearest' });
  }
  function applyReplayVisibility() {
    if (!S.replay || !S.tl) return;
    const p = S.replay.pos;
    for (const el of S.tl.el.children) {
      if (!el.dataset || el.dataset.v === undefined) continue;
      el.classList.toggle('hidden-replay', Number(el.dataset.v) > p);
    }
  }
  function syncReplay() {
    const r = S.replay;
    if (!r) return;
    $('#rp-toggle').textContent = r.timer ? '❚❚' : '▶';
    $$('#rp-speed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === r.speed));
    $('#rp-range').value = String(r.pos);
    const i = S.tl.vis[r.pos];
    const e = S.data.events[i];
    $('#rp-clock').textContent = e ? `${clock(e.t)} · ${r.pos + 1}/${S.tl.vis.length} · ${money(S.data._cum[i])}` : '';
    drawFlight();
  }

  // ---------- files & tools tabs ----------
  function renderFiles(body) {
    const files = S.data._files;
    if (!files.length) {
      body.innerHTML = '<div class="panel"><div class="empty">No file edits recorded in this session.</div></div>';
      return;
    }
    const max = Math.max(...files.map((f) => f.added + f.removed), 1);
    body.innerHTML = `<div class="panel"><table>
      <tr><th>File</th><th class="num">Edits</th><th class="num">Lines</th><th style="width:22%"></th></tr>
      ${files
        .map(
          (f, k) => `<tr class="click" data-file="${k}"><td class="mono">${esc(home(f.path))}${f.ops.has('create') ? ' <span class="flag sub">new</span>' : ''}${f.ops.has('delete') ? ' <span class="flag err">deleted</span>' : ''}</td>
          <td class="num">${f.edits.length}</td><td class="num"><span style="color:var(--add)">+${num(f.added)}</span> <span style="color:var(--del)">−${num(f.removed)}</span></td>
          <td><div class="hbar" style="width:${((f.added + f.removed) / max) * 100}%"></div></td></tr>`,
        )
        .join('')}
    </table></div><p class="hint">Click a file to see every change made to it, in order.</p>`;
  }

  function renderAgents(body) {
    const kids = S.data._kids;
    const max = Math.max(...kids.map((k) => k.toolCalls), 1);
    body.innerHTML = `<div class="panel"><table>
      <tr><th>Sub-agent</th><th>Task</th><th class="num">Started</th><th class="num">Active</th><th class="num">Tools</th><th class="num">Cost</th><th style="width:16%"></th></tr>
      ${kids
        .map(
          (k) => `<tr class="click" data-open="${esc(k.key)}"><td class="mono">${esc(k.agentName || '—')}</td><td>${esc(k.title)}</td><td class="num">${clock(k.startedAt)}</td><td class="num">${dur(activeMs(k))}</td>
          <td class="num">${num(k.toolCalls)}${k.toolErrors ? ` <span style="color:var(--err)">✗${k.toolErrors}</span>` : ''}</td>
          <td class="num">${k.costInParent ? '<span class="hint" data-tip="Included in this session’s recorded cost">in parent</span>' : costLabel(k.cost)}</td>
          <td><div class="hbar tool" style="width:${(k.toolCalls / max) * 100}%"></div></td></tr>`,
        )
        .join('')}
    </table></div><p class="hint">Click a row to open that sub-agent's own timeline.</p>`;
  }

  function renderTools(body) {
    const tools = S.data._tools;
    if (!tools.length) {
      body.innerHTML = '<div class="panel"><div class="empty">No tool calls in this session.</div></div>';
      return;
    }
    const max = Math.max(...tools.map((t) => t.calls), 1);
    body.innerHTML = `<div class="panel"><table>
      <tr><th>Tool</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">Total time</th><th class="num">Avg</th><th style="width:26%"></th></tr>
      ${tools
        .map(
          (t) => `<tr><td class="mono">${esc(t.name)}</td><td class="num">${num(t.calls)}</td><td class="num" style="${t.errors ? 'color:var(--err)' : ''}">${t.errors ? num(t.errors) + ' (' + Math.round((t.errors / t.calls) * 100) + '%)' : '—'}</td>
          <td class="num">${dur(t.ms)}</td><td class="num">${t.ms ? dur(t.ms / t.calls) : '—'}</td><td><div class="hbar tool" style="width:${(t.calls / max) * 100}%"></div></td></tr>`,
        )
        .join('')}
    </table></div>`;
  }

  // ---------- insights ----------
  async function showInsights() {
    stopReplay();
    S.key = null;
    S.data = null;
    const range = store.get('insights-range', '30d');
    main.innerHTML = `<div class="insights"><div class="insights-inner">
      <div class="range-row"><h1 class="title" style="margin:0">Insights</h1><span class="spacer" style="flex:1"></span>
        <select class="mini" id="ins-range"><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option><option value="all">All time</option></select>
      </div><div id="ins-body"><div class="empty">Crunching numbers…</div></div></div></div>`;
    $('#ins-range').value = range;
    $('#ins-range').addEventListener('change', (e) => {
      store.set('insights-range', e.target.value);
      showInsights();
    });
    try {
      S.stats = await api('/api/stats?since=' + rangeStart(range));
      S.stats.range = range;
      if (S.view === 'insights') renderInsights(S.stats);
    } catch (err) {
      $('#ins-body').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  function breakdown(rows, opts) {
    const max = Math.max(...rows.map((r) => r[opts.metric] || 0), 1e-9);
    return `<div class="panel"><table><tr><th>${opts.title}</th>${opts.cols.map((c) => `<th class="num">${c[0]}</th>`).join('')}<th style="width:30%"></th></tr>
      ${rows
        .slice(0, opts.limit || 12)
        .map(
          (r) =>
            `<tr><td class="${opts.mono ? 'mono' : ''}">${esc(r.key)}</td>${opts.cols.map((c) => `<td class="num">${c[1](r)}</td>`).join('')}<td><div class="hbar ${opts.bar || ''}" style="width:${((r[opts.metric] || 0) / max) * 100}%"></div></td></tr>`,
        )
        .join('')}</table></div>`;
  }

  function renderInsights(st) {
    const o = st.overview;
    const body = $('#ins-body');
    if (!body) return;
    if (!o.sessions) {
      body.innerHTML = '<div class="empty">No sessions in this time range.</div>';
      return;
    }
    const days = st.groups.day;
    const uploaded = o.uploadedSessions;
    const hasDeepseek = st.groups.agent.some((r) => r.key === 'DeepSeek Harness');
    body.innerHTML = `
      <div class="kpis">
        ${kpi('Spend', money(o.usd), Math.round(o.recordedShare * 100) + '% recorded, rest estimated')}
        ${kpi('Tokens', tok(totalTokens(o.usage)), Math.round(o.cacheHitRate * 100) + '% from cache')}
        ${kpi('Sessions', num(o.sessions), (o.subagents ? '+' + num(o.subagents) + ' sub-agents · ' : '') + dur(o.durationMs) + ' active')}
        ${kpi('Prompts', num(o.prompts), money(o.costPerPrompt) + ' / prompt')}
        ${kpi('Tool calls', num(o.toolCalls), o.toolCalls ? ((o.toolErrors / o.toolCalls) * 100).toFixed(1) + '% failed' : '')}
        ${kpi('Code written', '+' + tok(o.linesAdded), '−' + tok(o.linesRemoved) + ' · ' + num(o.filesChanged) + ' file edits')}
      </div>
      <div class="chart"><div class="flight-head"><b>Daily spend</b><span class="spacer"></span><span>${days.filter((d) => d.sessions).length} active days · peak ${money(Math.max(...days.map((d) => d.usd)))}</span></div><svg id="daily"></svg></div>
      ${
        hasDeepseek
          ? `<h2>Privacy</h2><div class="panel" style="padding:14px"><div class="privacy"><span class="big">${uploaded ? '↑' : '✓'}</span><div>${
              uploaded
                ? `<b style="color:var(--err)">${uploaded} DeepSeek Harness session${uploaded > 1 ? 's were' : ' was'} uploaded to the DeepSeek API.</b><br><span class="hint">DeepSeek Harness turns on session-log delivery by default for the official API. Turn it off in its Settings if you do not want your logs sent.</span>`
                : '<b>No DeepSeek Harness session logs were uploaded in this period.</b>'
            }</div></div></div>`
          : ''
      }
      <div class="grid-2">
        <div><h2>By agent</h2>${breakdown(st.groups.agent, { title: 'Agent', metric: 'usd', cols: [['Sessions', (r) => num(r.sessions)], ['Cost', (r) => money(r.usd)], ['Tokens', (r) => tok(r.tokens)]] })}</div>
        <div><h2>By model</h2>${breakdown(st.groups.model, { title: 'Model', mono: true, metric: 'usd', cols: [['Sessions', (r) => num(r.sessions)], ['Cost', (r) => money(r.usd)], ['Tokens', (r) => tok(r.tokens)]] })}</div>
        <div><h2>By project</h2>${breakdown(st.groups.project, { title: 'Project', metric: 'usd', cols: [['Sessions', (r) => num(r.sessions)], ['Cost', (r) => money(r.usd)], ['Active', (r) => dur(r.durationMs)]] })}</div>
        <div><h2>Most used tools</h2>${breakdown(st.groups.tool, { title: 'Tool', mono: true, metric: 'toolCalls', bar: 'tool', limit: 15, cols: [['Calls', (r) => num(r.toolCalls)], ['Sessions', (r) => num(r.sessions)]] })}</div>
      </div>
      <h2>Most expensive sessions</h2>
      <div class="panel"><table><tr><th>Session</th><th>Agent</th><th class="num">When</th><th class="num">Tools</th><th class="num">Cost</th></tr>
        ${st.top
          .filter((s) => s.cost.usd > 0)
          .map((s) => `<tr class="click" data-open="${esc(s.key)}"><td>${esc(s.title)}</td><td><span class="dot ${s.agent}"></span> ${AGENTS[s.agent]}</td><td class="num">${when(s.endedAt)}</td><td class="num">${num(s.toolCalls)}</td><td class="num"><b>${costLabel(s.cost)}</b></td></tr>`)
          .join('')}
      </table></div>
      <p class="hint">Costs marked ~ are estimated from public list prices (${esc(BOOT.pricesUpdated || '')}); your plan or contract may differ. Override prices with <code>~/.config/agent-blackbox/pricing.json</code>.</p>`;
    drawDaily(days);
  }

  function drawDaily(days) {
    const svg = $('#daily');
    if (!svg || !days.length) return;
    const W = svg.clientWidth || 800;
    const H = 220;
    const padL = 46;
    const padB = 22;
    const max = Math.max(...days.map((d) => d.usd), 0.01);
    const nice = niceMax(max);
    const bw = (W - padL) / days.length;
    const y = (v) => H - padB - (v / nice) * (H - padB - 8);
    let out = '';
    for (let k = 0; k <= 4; k++) {
      const v = (nice * k) / 4;
      out += `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${money(v)}</text>`;
    }
    const every = Math.max(1, Math.ceil(days.length / 10));
    days.forEach((d, k) => {
      const x = padL + k * bw;
      const h = Math.max(d.usd > 0 ? 1.5 : 0, H - padB - y(d.usd));
      out += `<rect class="bar" x="${x + bw * 0.12}" y="${H - padB - h}" width="${Math.max(1, bw * 0.76)}" height="${h}" rx="2" data-tip="${d.key} · ${money(d.usd)} · ${d.sessions} sessions · ${tok(d.tokens)} tokens"/>`;
      if (k % every === 0) out += `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.key.slice(5)}</text>`;
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = out;
  }
  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (typing) document.activeElement.blur();
      else if (S.replay) {
        stopReplay();
        S._syncToolbar && S._syncToolbar();
      }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      const f = S.data && S.opts.tab === 'timeline' && $('#find') && document.activeElement !== $('#q') && !$('#q') ? $('#find') : $('#q') || $('#find');
      f && f.focus();
    } else if (e.key === 't') cycleTheme();
    else if ((e.key === 'j' || e.key === 'k') && LIVE && S.view === 'sessions') {
      const list = filtered();
      const idx = list.findIndex((s) => s.key === S.key);
      const next = list[Math.max(0, Math.min(list.length - 1, idx + (e.key === 'j' ? 1 : -1)))];
      if (next) {
        location.hash = '#/s/' + encodeURIComponent(next.key);
        const el = $(`.s-item[data-key="${CSS.escape(next.key)}"]`);
        el && el.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === ' ' && S.data && S.opts.tab === 'timeline') {
      e.preventDefault();
      if (!S.replay) startReplay();
      else if (S.replay.timer) pauseReplay();
      else resumeReplay();
    } else if (e.key === 'e' && S.data) {
      S.opts.mode = S.opts.mode === 'errors' ? 'all' : 'errors';
      if (S.opts.tab !== 'timeline') S.opts.tab = 'timeline';
      renderTab();
    } else if (S.replay && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      pauseReplay();
      seekReplay(S.replay.pos + (e.key === 'ArrowRight' ? 1 : -1));
    }
  });

  /** Quietly pick up new and updated sessions while the tab is visible. */
  async function backgroundRefresh() {
    if (document.visibilityState !== 'visible' || !S.loaded) return;
    try {
      const { sessions } = await api('/api/sessions');
      const sig = (list) => list.map((s) => s.key + ':' + s.endedAt).join('|');
      if (sig(sessions) === sig(S.sessions)) return;
      S.sessions = sessions;
      const scroll = $('#list') && $('#list').scrollTop;
      renderList();
      if ($('#list')) $('#list').scrollTop = scroll;
    } catch {
      /* server stopped: keep showing what we have */
    }
  }

  // ---------- boot ----------
  if (LIVE) {
    route();
    loadSessions(false);
    setInterval(backgroundRefresh, 30_000);
  } else {
    route();
  }
})();
