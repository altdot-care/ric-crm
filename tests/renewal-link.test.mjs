import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renewalCreate, renewalUpdate } from '../src/lib/schemas.ts';

const base = {
  company_id: '11111111-1111-4111-8111-111111111111',
  cert: 'ISO 9001',
  audit_due: '2026-10-01',
  expiry: '2026-12-01',
};

test('renewal accepts an https link', () => {
  const parsed = renewalCreate.parse({ ...base, link: 'https://example.test/cert.pdf' });
  assert.equal(parsed.link, 'https://example.test/cert.pdf');
});

test('renewal link is optional and may be cleared with null', () => {
  assert.equal(renewalCreate.parse(base).link, undefined);
  assert.equal(renewalCreate.parse({ ...base, link: null }).link, null);
  assert.equal(renewalUpdate.parse({ link: null }).link, null);
});

test('renewal link rejects text that is not a URL', () => {
  assert.equal(renewalCreate.safeParse({ ...base, link: 'not a url' }).success, false);
});

test('renewal link rejects non-web schemes', () => {
  assert.equal(renewalCreate.safeParse({ ...base, link: 'javascript:alert(1)' }).success, false);
});

test('renewal link rejects URLs over 500 characters', () => {
  assert.equal(renewalCreate.safeParse({ ...base, link: 'https://example.test/' + 'a'.repeat(500) }).success, false);
});

test('renewal form has a link field and rows render it safely', () => {
  const html = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  assert.match(html, /id="ren-link"[^>]*type="url"|type="url"[^>]*id="ren-link"/);
  assert.match(html, /link: nullableInput\('ren-link'\)/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});
