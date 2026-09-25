import type { APIRoute } from 'astro';
import { NOTIFIER_URL, NOTIFIER_SECRET } from 'astro:env/server';
import { requireRoot } from '@/lib/auth';
import { callNotifier, notifierResponse } from '@/lib/notifier';

export const prerender = false;

// Sends a fixed test notification to the signed-in root's own devices via the Cron Worker.
export const POST: APIRoute = async ({ locals }) => {
  const denied = await requireRoot(locals);
  if (denied) return denied;
  // The target is the session's user — never taken from the request.
  return notifierResponse(await callNotifier('/preview/test-push', { ownerId: locals.user!.id }, { url: NOTIFIER_URL, secret: NOTIFIER_SECRET }));
};
