import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as schemas from '../src/lib/schemas.ts';

const { activityUpdate } = schemas;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('a log entry can change type, description and follow-up date', () => {
  const parsed = activityUpdate.parse({ type: 'meeting', description: 'ประชุมใหม่', followup: '2026-10-01' });
  assert.deepEqual(parsed, { type: 'meeting', description: 'ประชุมใหม่', followup: '2026-10-01' });
});

test('a log entry follow-up can be cleared', () => {
  assert.equal(activityUpdate.parse({ followup: '' }).followup, '');
});

test('editing never moves an entry to another deal or owner', () => {
  const parsed = activityUpdate.parse({ description: 'x', lead_id: '11111111-1111-4111-8111-111111111111', owner_id: '11111111-1111-4111-8111-111111111111' });
  assert.deepEqual(parsed, { description: 'x' });
});

test('a client cannot turn an entry into a stage_change row', () => {
  assert.equal(activityUpdate.safeParse({ type: 'stage_change' }).success, false);
});

test('an edited description cannot be blank', () => {
  assert.equal(activityUpdate.safeParse({ description: '   ' }).success, false);
});

test('the next-action feature is gone from the API', () => {
  assert.equal(existsSync(new URL('../src/pages/api/next-actions.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/pages/api/next-actions', import.meta.url)), false);
  assert.equal('nextActionCreate' in schemas, false);
  assert.equal('nextActionUpdate' in schemas, false);
});

test('activity route can edit and lets the owner delete, not just root', () => {
  const route = read('../src/pages/api/activities/[id].ts');
  assert.match(route, /export const PUT/);
  assert.match(route, /activityUpdate/);
  assert.doesNotMatch(route, /requireRoot/);
});

test('deal page has no next-action UI and the Log tab can edit and delete', () => {
  const html = read('../src/pages/index.astro');
  assert.doesNotMatch(html, /next-action|nextAction|next_action|งานถัดไป/);
  assert.match(html, /function editLeadActivity/);
  assert.match(html, /function deleteLeadActivity/);
  assert.match(html, /api\(`\/api\/activities\/\$\{[^}]+\}`, \{ method: 'PUT'/);
  assert.match(html, /api\(`\/api\/activities\/\$\{[^}]+\}`, \{ method: 'DELETE'/);
  assert.match(html, /function cancelLeadActivityEdit/);
});
