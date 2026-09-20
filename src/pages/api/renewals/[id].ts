import type { APIRoute } from 'astro';

export const DELETE: APIRoute = async ({ locals, params }) => {
  const db = locals.DB;
  const id = params.id!;

  await db.prepare('DELETE FROM renewals WHERE id = ?').bind(id).run();

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
