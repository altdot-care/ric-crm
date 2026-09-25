import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

function load() {
  const path = new URL('../public/company-renewals.js', import.meta.url);
  assert.ok(existsSync(path), 'company renewals module exists');
  const context = { window: {} };
  vm.runInNewContext(readFileSync(path, 'utf8'), context);
  return context.window;
}

const renewals = [
  { id: 'a', company_id: 'c1', audit_due: '2026-12-01' },
  { id: 'b', company_id: 'c2', audit_due: '2026-10-01' },
  { id: 'c', company_id: 'c1', audit_due: '2026-10-15' },
];

test('company renewals only include that company, soonest audit first', () => {
  const ids = load().companyRenewals(renewals, 'c1').map(r => r.id);
  assert.deepEqual(ids, ['c', 'a']);
});

test('company renewals do not mutate the shared list', () => {
  const copy = [...renewals];
  load().companyRenewals(renewals, 'c1');
  assert.deepEqual(renewals, copy);
});

test('company with no renewals gets an empty list', () => {
  assert.deepEqual(load().companyRenewals(renewals, 'none'), []);
});

test('company detail page wires up the certificates tab', () => {
  const html = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  assert.match(html, /id="company-tab-btn-renewals"[^>]*>ใบรับรอง</);
  assert.match(html, /id="company-tab-renewals"/);
  assert.match(html, /id="company-renewals-list"/);
  assert.match(html, /src="\/company-renewals\.js"/);
  assert.match(html, /switchCompanyTab\('renewals'\)/);
});
