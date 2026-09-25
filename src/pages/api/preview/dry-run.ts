import type { APIRoute } from 'astro';
import { NOTIFIER_URL, NOTIFIER_SECRET } from 'astro:env/server';
import { requireRoot } from '@/lib/auth';
import { callNotifier, notifierResponse } from '@/lib/notifier';

export const prerender = false;

// Lists what the cron would send right now, without sending anything or recording it.
export const POST: APIRoute = async ({ locals }) => {
  const denied = await requireRoot(locals);
  if (denied) return denied;
  return notifierResponse(await callNotifier('/preview/dry-run', {}, { url: NOTIFIER_URL, secret: NOTIFIER_SECRET }));
};
