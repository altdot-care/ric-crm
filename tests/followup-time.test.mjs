import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activityCreate, activityUpdate } from '../src/lib/schemas.ts';

const lead_id = '11111111-1111-4111-8111-111111111111';
const create = extra => activityCreate.safeParse({ lead_id, description: 'x', ...extra });
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('a follow-up may carry a time in HH:MM', () => {
  const parsed = activityCreate.parse({ lead_id, description: 'x', followup: '2026-10-01', followup_time: '14:30' });
  assert.equal(parsed.followup_time, '14:30');
  assert.equal(create({ followup: '2026-10-01', followup_time: '00:00' }).success, true);
  assert.equal(create({ followup: '2026-10-01', followup_time: '23:59' }).success, true);
});

test('a follow-up time may be empty (no time chosen)', () => {
  assert.equal(create({ followup: '2026-10-01', followup_time: '' }).success, true);
  assert.equal(create({}).success, true);
});

test('malformed follow-up times are rejected', () => {
  for (const bad of ['24:00', '9:30', '12:60', '14:30:00', '14.30', 'noon']) {
    assert.equal(create({ followup: '2026-10-01', followup_time: bad }).success, false, bad);
  }
});

test('a time needs a date in the same request when creating', () => {
  assert.equal(create({ followup_time: '09:00' }).success, false);
  assert.equal(create({ followup: '', followup_time: '09:00' }).success, false);
});

test('update: a time cannot ride along with a cleared date, but may be sent alone', () => {
  assert.equal(activityUpdate.safeParse({ followup: '', followup_time: '09:00' }).success, false);
  assert.equal(activityUpdate.safeParse({ followup_time: '09:00' }).success, true);
  assert.equal(activityUpdate.safeParse({ followup: '2026-10-01', followup_time: '' }).success, true);
});

test('routes write followup_time and clear it when the date is cleared', () => {
  const post = read('../src/pages/api/activities.ts');
  const put = read('../src/pages/api/activities/[id].ts');
  assert.match(post, /followup_time/);
  assert.match(put, /followup_time/);
  assert.match(put, /followup === ''\s*\?\s*\{\s*followup_time:\s*null\s*\}/);
});

test('Log form has a time input tied to the follow-up date, and entries show the time', () => {
  const html = read('../src/pages/index.astro');
  assert.match(html, /id="lead-act-followup-time"[^>]*type="time"|type="time"[^>]*id="lead-act-followup-time"/);
  assert.match(html, /function syncFollowupTime/);
  assert.match(html, /function followupLabel/);
  assert.match(html, /followup_time: document\.getElementById\('lead-act-followup-time'\)\.value/);
  assert.equal((html.match(/esc\(followupLabel\(a\)\)/g) || []).length, 2, 'both the feed and the Log tab use followupLabel');
  assert.doesNotMatch(html, /นัดติดตาม: \$\{esc\(a\.followup\)\}/);
});
