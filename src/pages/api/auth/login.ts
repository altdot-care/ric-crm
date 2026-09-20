import type { APIRoute } from 'astro';
import { loginInput } from '@/lib/schemas';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const form = await request.formData();
  const parsed = loginInput.safeParse({
    email: form.get('email'),
    password: form.get('password'),
  });
  if (!parsed.success) return redirect('/login?error=1');

  const { error } = await locals.supabase.auth.signInWithPassword(parsed.data);
  if (error) return redirect('/login?error=1');
  return redirect('/');
};
