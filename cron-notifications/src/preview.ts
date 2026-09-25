import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';
import { isPushEndpoint } from '../../src/lib/push-endpoint.ts';
import { deliver, findCandidates, sendPush, type NotificationEnv, type SendFn } from './notifications.ts';

interface PreviewDeps { db?: SupabaseClient; send?: SendFn; now?: Date }

const ROUTES = new Set(['/preview/test-push', '/preview/dry-run']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (data: unknown, status = 200) => Response.json(data, { status });

/** Constant-time comparison: hash both sides so lengths match and timing reveals nothing. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return timingSafeEqual(await digest(given), await digest(expected));
}

/**
 * Root-only test tools, called by the web app with a shared secret. Neither route writes
 * notification_log; test-push always uses fixed text and only the ownerId it is given.
 */
export async function handlePreview(request: Request, env: NotificationEnv, deps: PreviewDeps = {}): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !ROUTES.has(path)) return reply({ error: 'Not found' }, 404);
  if (!env.NOTIFIER_SECRET) return reply({ error: 'Preview endpoints are not configured' }, 503);
  const bearer = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '');
  if (!bearer || !(await sameSecret(bearer[1], env.NOTIFIER_SECRET))) return reply({ error: 'Unauthorized' }, 401);

  try {
    const db = deps.db ?? createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    return path === '/preview/test-push'
      ? await testPush(request, env, db, deps.send)
      : await dryRun(db, deps.now ?? new Date());
  } catch (error) {
    console.error('Preview failed:', error instanceof Error ? error.message : 'unknown error');
    return reply({ error: 'Internal error' }, 500);
  }
}

async function testPush(request: Request, env: NotificationEnv, db: SupabaseClient, send?: SendFn): Promise<Response> {
  let body: { ownerId?: unknown };
  try { body = await request.json(); } catch { return reply({ error: 'Invalid JSON body' }, 400); }
  if (typeof body.ownerId !== 'string' || !UUID.test(body.ownerId)) return reply({ error: 'ownerId must be a uuid' }, 400);

  const { data, error } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('owner_id', body.ownerId);
  if (error) throw error;
  const valid = (data ?? []).filter(sub => isPushEndpoint(sub.endpoint));
  const payload = JSON.stringify({ title: 'ทดสอบการแจ้งเตือน', body: 'ถ้าเห็นข้อความนี้ แสดงว่าระบบแจ้งเตือนทำงานปกติ', url: '/' });
  const result = await deliver(db, send ?? ((sub, text) => sendPush(env, sub, text)), valid, payload);
  return reply({ devices: valid.length, ...result });
}

async function dryRun(db: SupabaseClient, now: Date): Promise<Response> {
  const shown = (await findCandidates(db, now)).slice(0, 200);
  const logged = new Set<string>();
  if (shown.length) {
    const { data, error } = await db.from('notification_log').select('kind, entity_id').in('entity_id', shown.map(c => c.entityId));
    if (error) throw error;
    for (const row of data ?? []) logged.add(`${row.kind}:${row.entity_id}`);
  }
  return reply({
    now: new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' '),
    candidates: shown.map(c => ({ kind: c.kind, title: c.title, body: c.body, ownerId: c.ownerId, alreadySent: logged.has(`${c.kind}:${c.entityId}`) })),
  });
}
