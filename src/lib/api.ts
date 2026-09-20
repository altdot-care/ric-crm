import type { z } from 'zod';

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function fail(message: string, status: number): Response {
  return json({ error: message }, status);
}

/** Parse and validate a JSON request body. Returns the data, or a ready-to-return 400 Response. */
export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T> | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('Invalid JSON body', 400);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return json({ error: 'Validation failed', issues: result.error.issues }, 400);
  }
  return result.data;
}

/** Log the real database error server-side; never leak it to the client. */
export function dbError(error: { message: string }): Response {
  console.error('[db]', error.message);
  return fail('Database error', 500);
}
