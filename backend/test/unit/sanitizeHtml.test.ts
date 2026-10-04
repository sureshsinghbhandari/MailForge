import { describe, expect, it } from 'vitest';
import { htmlToText, sanitizeEmailHtml } from '../../src/services/sanitizeHtml.js';

describe('sanitizeEmailHtml', () => {
  it('removes scripts, iframes, objects, embeds, forms and event handlers', () => {
    const out = sanitizeEmailHtml(
      '<p onclick="x()">hi</p><script>alert(1)</script><iframe src="https://evil"></iframe>' +
        '<object data="x"></object><embed src="x"><form action="/x"><input name="a"></form><style>body{display:none}</style>' +
        '<img src="https://a.example/p.png" onerror="alert(1)">',
    );
    expect(out).not.toMatch(/script|iframe|object|embed|form|input|onclick|onerror|<style|alert/i);
    expect(out).toContain('<p>hi</p>');
    expect(out).toContain('src="https://a.example/p.png"');
  });

  it('blocks dangerous URL schemes', () => {
    const out = sanitizeEmailHtml(
      '<a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt:alert(1)">b</a>' +
        '<a href="data:text/html;base64,PHNjcmlwdD4=">c</a><a href="vbscript:x">d</a>' +
        '<a href="https://ok.example/">e</a>',
    );
    expect(out).not.toMatch(/javascript|vbscript|data:/i);
    expect(out).toContain('href="https://ok.example/"');
  });

  it('forces safe link attributes', () => {
    const out = sanitizeEmailHtml('<a href="https://a.example" target="_self">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('strips dangerous inline styles but keeps harmless ones', () => {
    const out = sanitizeEmailHtml(
      '<div style="color:red;background:url(https://evil/x);position:fixed;width:expression(alert(1))">x</div>',
    );
    expect(out).toContain('color:red');
    expect(out).not.toMatch(/url\(|position|expression/i);
  });

  it('resolves cid images only from the supplied map and restricts data: images', () => {
    const out = sanitizeEmailHtml(
      '<img src="cid:logo"><img src="cid:missing"><img src="data:image/png;base64,AAAA"><img src="data:image/svg+xml;base64,AAAA">',
      { inlineImages: { logo: 'data:image/png;base64,QUJD' } },
    );
    expect(out).toContain('src="data:image/png;base64,QUJD"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).not.toMatch(/svg|cid:/);
  });
});

describe('htmlToText', () => {
  it('keeps visible text with line breaks and drops scripts/styles', () => {
    const text = htmlToText('<style>p{}</style><p>Your code is <b>123456</b></p><p>Thanks &amp; bye</p><script>x</script>');
    expect(text).toBe('Your code is 123456\nThanks & bye');
  });
});
