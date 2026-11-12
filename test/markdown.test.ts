/**
 * The UI renders text from agent logs — i.e. anything a model, a tool or a web
 * page produced. These tests treat that text as hostile and check that the
 * renderer only ever emits its own allow-listed markup.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const code = readFileSync(new URL('../ui/markdown.js', import.meta.url), 'utf8');
const sandbox: { BlackboxMarkdown?: { esc: (s: unknown) => string; md: (s: string) => string } } = {};
vm.runInNewContext(code, sandbox);
const { esc, md } = sandbox.BlackboxMarkdown!;

const TAGS = new Set(['p', 'br', 'pre', 'code', 'strong', 'em', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'table', 'tr', 'th', 'td', 'a']);
const ATTRS = new Set(['href', 'target', 'rel']);

/** Throws if `html` contains anything outside the allow-list. */
function assertSafe(html: string, input: string): void {
  const ctx = () => `\ninput:  ${JSON.stringify(input).slice(0, 300)}\noutput: ${JSON.stringify(html).slice(0, 300)}`;
  let tags = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^<>]*)>/g)) {
    tags++;
    const [, , name = '', rest = ''] = m;
    assert.ok(TAGS.has(name.toLowerCase()), `unexpected tag <${name}>${ctx()}`);
    let leftover = rest;
    for (const a of rest.matchAll(/\s([a-zA-Z-]+)="([^"]*)"/g)) {
      const [, attr = '', value = ''] = a;
      assert.ok(ATTRS.has(attr), `unexpected attribute ${attr}${ctx()}`);
      if (attr === 'href') {
        // Only http(s) with a real host start, and never containing (even escaped) angle brackets or quotes.
        assert.match(value, /^https?:\/\/[A-Za-z0-9][^\s"'<>]*$/, `unsafe href ${value}${ctx()}`);
        assert.doesNotMatch(value, /&lt;|&gt;|&quot;|&#39;/, `href swallowed escaped markup ${value}${ctx()}`);
      }
      leftover = leftover.replace(a[0], '');
    }
    assert.equal(leftover.trim(), '', `stray attribute text "${leftover}"${ctx()}`);
  }
  // Every "<" in the output must belong to one of our tags; everything else was escaped.
  assert.equal((html.match(/</g) ?? []).length, tags, `unescaped "<"${ctx()}`);
}

const ATTACKS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[x](https://a.com" onmouseover="alert(1))',
  '[x](https://a.com\'onmouseover=\'alert(1))',
  'https://a.com"onmouseover=alert(1)',
  'see https://a.com/<script>',
  '`<b>code</b>`',
  '**<i>bold</i>**',
  '*<svg onload=alert(1)>*',
  '# <iframe src=//evil>',
  '> <img src=x onerror=alert(1)>',
  '- <script>x</script>\n- [a](https://ok.com)',
  '1. <style>body{display:none}</style>',
  '| a | <b>b</b> |\n|---|---|\n| <img src=x> | [x](javascript:1) |',
  '```\n</code></pre><script>alert(1)</script>\n```',
  '```html\n<script>\n',
  '[[x](https://a.com)](https://b.com)',
  '[see (https://evil.com)](https://ok.com)',
  'https://a.com)https://b.com',
  '&lt;script&gt; already-escaped &amp; text',
  '<!-- comment --><![CDATA[x]]>',
  '\u0000<script>\u2028</script>',
  '<<script>script>alert(1)<</script>/script>',
  // Found by the 2026-11 review: an autolink inside the href an earlier pass had written broke out of it.
  '[docs](https://x.example/(https://y/autofocus/onfocus=location=/javascript:void%28alert(1)%29/.source//)',
  '[d](https://x/(https://y/onmouseover=alert(1)//)',
  '**[d](https://x/(https://y/x=1//)**',
  '[`https://y/onfocus=1`](https://x/)',
  '(https://a/(https://b/(https://c/onload=1)))',
].map((s) => s.replace(/\\u0000/g, String.fromCharCode(0)).replace(/\\u2028/g, String.fromCharCode(0x2028)));

describe('esc', () => {
  it('escapes every HTML-significant character', () => {
    assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    assert.equal(esc(null), '');
    assert.equal(esc(42), '42');
  });
});

describe('markdown renderer', () => {
  it('renders the supported subset', () => {
    assert.equal(md('**bold** and `code`'), '<p><strong>bold</strong> and <code>code</code></p>');
    assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
    assert.match(md('[docs](https://example.com/a?b=1&c=2)'), /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
    assert.equal(md('```\n<b>\n```'), '<pre><code>&lt;b&gt;</code></pre>');
  });

  it('never lets markup through from known attack strings', () => {
    for (const input of ATTACKS) assertSafe(md(input), input);
  });

  it('does not turn non-http links into anchors', () => {
    for (const input of ['[x](javascript:alert(1))', '[x](data:text/html,<script>)', '[x](//evil.com)', '[x](file:///etc/passwd)']) {
      assert.doesNotMatch(md(input), /<a /, input);
    }
  });

  it('survives random hostile input', () => {
    const alphabet = ['<', '>', '"', "'", '&', '*', '`', '[', ']', '(', ')', '|', '#', '-', '>', ' ', '\n', ':', '/', 'a', 'x', 'https://', 'javascript:', 'onerror=', '<script>', '```', '**', '1. ', '- ', '| '];
    let seed = 1234567;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 3000; i++) {
      let s = '';
      const len = 1 + Math.floor(rand() * 40);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
      assertSafe(md(s), s);
    }
  });

  it('survives random hostile links', () => {
    // Links built from pieces: URLs inside URLs, brackets and parentheses, attribute-looking text.
    const pieces = ['[', ']', '(', ')', 'https://x/', 'https://y.example/', '(https://', 'onfocus=', '/autofocus', '"', "'", '`', '**', '*', ' ', '&', '<', '>', 'a', '/', '=', '%28', '//'];
    let seed = 7654321;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 20_000; i++) {
      let s = '';
      const len = 2 + Math.floor(rand() * 16);
      for (let j = 0; j < len; j++) s += pieces[Math.floor(rand() * pieces.length)];
      const input = rand() < 0.5 ? `[l](https://x/${s})` : s;
      assertSafe(md(input), input);
    }
  });

  it('keeps nested inline forms', () => {
    assert.equal(md('**see [docs](https://a.example/x)**'), '<p><strong>see <a href="https://a.example/x" target="_blank" rel="noopener noreferrer">docs</a></strong></p>');
    assert.equal(md('`**not bold**`'), '<p><code>**not bold**</code></p>');
    assert.equal(md('[`a`](https://b.example/)'), '<p><a href="https://b.example/" target="_blank" rel="noopener noreferrer"><code>a</code></a></p>');
    assert.equal(md('[https://in.example/](https://out.example/)'), '<p><a href="https://out.example/" target="_blank" rel="noopener noreferrer">https://in.example/</a></p>', 'no link inside a link');
    assert.equal(md('go to https://a.example/x now'), '<p>go to <a href="https://a.example/x" target="_blank" rel="noopener noreferrer">https://a.example/x</a> now</p>');
  });

  it('stays fast on pathological input (no catastrophic backtracking)', () => {
    const inputs = [' '.repeat(50_000) + '|a|', '| ' + ' '.repeat(50_000) + '|','*'.repeat(50_000), '['.repeat(50_000) + ']', '|'.repeat(100_000), 'https://'.repeat(20_000), '`'.repeat(50_000), '**a'.repeat(30_000), 'x'.repeat(2_000_000), '- a\n'.repeat(50_000)];
    for (const input of inputs) {
      const t = performance.now();
      const out = md(input);
      const ms = performance.now() - t;
      assert.ok(ms < 1500, `${ms.toFixed(0)}ms for ${JSON.stringify(input.slice(0, 20))}…`);
      assertSafe(out.slice(0, 20_000).replace(/<[^>]*$/, ''), input.slice(0, 50));
    }
  });
});
