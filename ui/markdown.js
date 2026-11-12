/*
 * agent-blackbox: escaping and a tiny, safe Markdown renderer.
 *
 * Session logs contain whatever an agent or a tool printed, so every piece of
 * text is treated as hostile. The rule is simple: escape first, then add a
 * small allow-list of tags (p, br, pre, code, strong, em, h2–h4, ul/ol/li,
 * blockquote, table/tr/th/td, a). Links are only created for http(s) URLs.
 * Raw HTML in the input is never passed through.
 *
 * Shared by the UI, exported files and the test suite (which loads this file
 * in a sandbox and fuzzes it).
 */
(function (root) {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);
  }

  // A URL in already-escaped text: http(s), a host that starts with a letter or digit,
  // and it ends at whitespace, ")" or any escaped < > " ' (so `https://x"onclick=…` cannot grow an attribute).
  const URL_RE = 'https?:\\/\\/[A-Za-z0-9](?:(?!&lt;|&gt;|&quot;|&#39;)[^\\s<>")])*';
  // The label excludes [ as well as ]: otherwise every [ in a run like [[[[...] scans to the end and back,
  // which is quadratic (4 s for 50,000 brackets on a CI runner).
  //
  // All inline forms in ONE pass, left to right: each match becomes its final HTML and is never scanned again.
  // (Separate .replace() passes once let the autolink pass find a URL inside the href="…" an earlier pass had
  // written, which broke out of the attribute: `[x](https://a/(https://b/onfocus=…)` ran script.)
  const INLINE = new RegExp(
    '`([^`\\n]+)`' + // 1: code
      '|\\*\\*([^*\\n]+)\\*\\*' + // 2: strong
      '|(?<=^|[\\s(])\\*([^*\\n]+)\\*(?=[\\s).,!?:;]|$)' + // 3: em
      '|\\[([^\\[\\]\\n]+)\\]\\((' + URL_RE + ')\\)' + // 4: label, 5: url
      '|(?<=^|[\\s(])(' + URL_RE + ')', // 6: bare url
    'g',
  );
  const anchor = (href, label) => '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';

  // `s` is already escaped, so the only markup in the result is what is added here. Inside a link label no
  // further links are made (an anchor cannot hold another).
  function inline(s, inLink = false) {
    return s.replace(INLINE, (all, code, strong, em, label, url, bare) => {
      if (code !== undefined) return '<code>' + code + '</code>';
      if (strong !== undefined) return '<strong>' + inline(strong, inLink) + '</strong>';
      if (em !== undefined) return '<em>' + inline(em, inLink) + '</em>';
      if (label !== undefined) return inLink ? all : anchor(url, inline(label, true));
      return inLink ? bare : anchor(bare, bare);
    });
  }

  function md(src) {
    const text = String(src || '').replace(/\r/g, '');
    const out = [];
    const parts = text.split(/^```[^\n]*\n?/m);
    // even parts are prose, odd parts are fenced code
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
          // The separator row. `^\s*\|?\s*` backtracked quadratically on a long run of spaces (2 s for 50,000).
          const rows = table.filter((r) => !/^\s*(?:\|\s*)?:?-{2,}/.test(r));
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

  root.BlackboxMarkdown = { esc, md };
})(typeof window !== 'undefined' ? window : globalThis);
