import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { isPushEndpoint } from '../../src/lib/push-endpoint.ts';

export interface NotificationEnv {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT?: string;
}

interface Candidate {
  kind: string;
  entityId: string;
  ownerId: string;
  title: string;
  body: string;
}
interface Subscription { endpoint: string; keys: { p256dh: string; auth: string } }
interface RunOptions {
  client?: SupabaseClient;
  now?: Date;
  send?: (subscription: Subscription, payload: string) => Promise<number>;
}

function bangkokDate(now: Date): string {
  return new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

/** Anything without its own time (certificates, follow-ups with no time) goes out at 08:00 Bangkok. */
export const DEFAULT_SEND_MINUTE = 8 * 60;

/** Minutes since midnight in Bangkok. */
export function bangkokMinutes(now: Date): number {
  const bangkok = new Date(now.getTime() + 7 * 3600000);
  return bangkok.getUTCHours() * 60 + bangkok.getUTCMinutes();
}

/** Minute of the day a follow-up may start sending. `time` is "HH:MM" or Postgres "HH:MM:SS". */
export function followupStartMinute(time: string | null): number {
  if (!time) return DEFAULT_SEND_MINUTE;
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

export function daysUntil(date: string, now = new Date()): number {
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(bangkokDate(now) + 'T00:00:00Z')) / 86400000);
}

export async function findCandidates(db: SupabaseClient, now = new Date()): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const today = bangkokDate(now);
  const nowMinute = bangkokMinutes(now);
  // Paginate explicitly: Supabase normally limits a response to 1000 rows.
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from('activities')
      .select('id, description, followup_time, owner_id, lead:leads!lead_id(company:companies!company_id(name))')
      .eq('followup', today).order('id').range(offset, offset + 499);
    if (error) throw error;
    for (const activity of data ?? []) {
      if (followupStartMinute(activity.followup_time) > nowMinute) continue; // not time yet — a later run sends it
      const lead = activity.lead as unknown as { company: { name: string } | null } | null;
      const time = activity.followup_time ? activity.followup_time.slice(0, 5) : null;
      candidates.push({
        kind: 'followup_due', entityId: activity.id, ownerId: activity.owner_id,
        title: time ? `ถึงเวลานัดติดตาม ${time}` : 'ถึงวันนัดติดตามวันนี้',
        body: `${lead?.company?.name || ''}: ${activity.description}`,
      });
    }
    if (!data || data.length < 500) break;
  }
  // Certificates are a morning digest: nothing before 08:00 Bangkok.
  if (nowMinute < DEFAULT_SEND_MINUTE) return candidates;
  const cutoff = bangkokDate(new Date(now.getTime() + 30 * 86400000));
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from('renewals')
      .select('id, cert, audit_due, expiry, owner_id, company:companies!company_id(name)')
      .or(`audit_due.lte.${cutoff},expiry.lte.${cutoff}`).order('id').range(offset, offset + 499);
    if (error) throw error;
    for (const renewal of data ?? []) {
      const company = renewal.company as unknown as { name: string } | null;
      for (const field of ['audit_due', 'expiry'] as const) {
        if (!renewal[field]) continue;
        const days = daysUntil(renewal[field], now);
        if (!Number.isFinite(days) || days > 30) continue;
        const audit = field === 'audit_due';
        candidates.push({
          kind: `renewal_${audit ? 'audit' : 'expiry'}_${days < 0 ? 'overdue' : 'due'}`,
          entityId: renewal.id, ownerId: renewal.owner_id,
          title: audit ? (days < 0 ? 'เลยกำหนดตรวจใบรับรอง' : 'ใกล้ครบกำหนดตรวจใบรับรอง')
            : (days < 0 ? 'ใบรับรองหมดอายุแล้ว' : 'ใบรับรองใกล้หมดอายุ'),
          body: `${company?.name || ''} — ${renewal.cert}${days >= 0 ? ` (อีก ${days} วัน)` : ''}`,
        });
      }
    }
    if (!data || data.length < 500) break;
  }
  return candidates;
}

/** Use web-push for encryption/VAPID and Workers' native fetch for bounded delivery. */
export async function sendPush(env: NotificationEnv, subscription: Subscription, payload: string): Promise<number> {
  if (!isPushEndpoint(subscription.endpoint)) throw new Error('Unsupported push endpoint');
  const details = webpush.generateRequestDetails(subscription, payload, {
    TTL: 86400,
    vapidDetails: { subject: env.VAPID_SUBJECT || 'mailto:support@ricroyal.co.th', publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
  });
  const response = await fetch(details.endpoint, {
    method: details.method, headers: details.headers,
    body: new Uint8Array(details.body!), redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  await response.body?.cancel();
  return response.status;
}

export async function run(env: NotificationEnv, options: RunOptions = {}) {
  // Validate configuration before claiming any milestone.
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:support@ricroyal.co.th', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const db = options.client ?? createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const send = options.send ?? ((sub, payload) => sendPush(env, sub, payload));
  const candidates = await findCandidates(db, options.now);
  let sent = 0, skipped = 0, failed = 0, pruned = 0;
  for (const candidate of candidates) {
    const { data: subscriptions, error: subError } = await db.from('push_subscriptions')
      .select('id, endpoint, p256dh, auth').eq('owner_id', candidate.ownerId);
    if (subError) throw subError;
    const valid = (subscriptions ?? []).filter(sub => isPushEndpoint(sub.endpoint));
    if (!valid.length) { skipped++; continue; }
    const { data: logged, error: logError } = await db.from('notification_log')
      .upsert({ kind: candidate.kind, entity_id: candidate.entityId }, { onConflict: 'kind,entity_id', ignoreDuplicates: true }).select('id');
    if (logError) throw logError;
    if (!logged?.length) { skipped++; continue; }
    for (const sub of valid) {
      try {
        const code = await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: candidate.title, body: candidate.body, url: '/' }));
        if (code >= 200 && code < 300) sent++;
        else {
          failed++;
          if (code === 404 || code === 410) {
            const { error } = await db.from('push_subscriptions').delete().eq('id', sub.id);
            if (error) console.warn('Unable to prune expired push subscription');
            else pruned++;
          }
        }
      } catch {
        failed++;
        // Deliberately no retry: milestone remains claimed, as documented in the spec.
        // Do not log endpoints, keys, payloads or provider error bodies.
      }
    }
  }
  return { sent, skipped, failed, pruned };
}
