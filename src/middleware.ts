import { defineMiddleware } from 'astro:middleware';
import { createClient } from '@/lib/supabase';
import { fail } from '@/lib/api';

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login']);

export const onRequest = defineMiddleware(async ({ request, cookies, locals, url, redirect }, next) => {
  const supabase = createClient(request, cookies);
  locals.supabase = supabase;

  // getClaims() verifies the JWT; getSession() alone would trust an unverified cookie.
  const { data } = await supabase.auth.getClaims();
  locals.user = data?.claims ? { id: data.claims.sub, email: data.claims.email } : null;

  if (!locals.user && !PUBLIC_PATHS.has(url.pathname)) {
    return url.pathname.startsWith('/api/') ? fail('Unauthorized', 401) : redirect('/login');
  }

  const response = await next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
});
