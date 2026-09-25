import { json, fail } from './api.ts';

export type NotifierPath = '/preview/test-push' | '/preview/dry-run';
export interface NotifierConfig { url?: string; secret?: string; fetchImpl?: typeof fetch }
export type NotifierResult = { ok: true; data: unknown } | { ok: false; status: number; error: string };

/** Call the Cron Worker's preview endpoints with the shared secret. Errors are reported, never thrown. */
export async function callNotifier(path: NotifierPath, body: unknown, config: NotifierConfig): Promise<NotifierResult> {
  const { url, secret, fetchImpl = fetch } = config;
  if (!url || !secret) return { ok: false, status: 503, error: 'ยังไม่ได้ตั้งค่า NOTIFIER_URL / NOTIFIER_SECRET' };
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      // Workers reject the "error" redirect mode. 'manual' returns a 3xx as-is without following it (the secret is never
      // forwarded); a 3xx is not ok, so it is reported as a failure below.
      redirect: 'manual',
    });
  } catch {
    return { ok: false, status: 502, error: 'เชื่อมต่อ Cron Worker ไม่ได้ (ตรวจว่ารันอยู่และ NOTIFIER_URL ถูกต้อง)' };
  }
  if (!response.ok) return { ok: false, status: 502, error: `Cron Worker ตอบกลับผิดปกติ (${response.status})` };
  try {
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, status: 502, error: 'Cron Worker ตอบกลับในรูปแบบที่ไม่ถูกต้อง' };
  }
}

export function notifierResponse(result: NotifierResult): Response {
  return result.ok ? json(result.data) : fail(result.error, result.status);
}
