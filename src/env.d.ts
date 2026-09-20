/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

type D1Database = import('@cloudflare/workers-types').D1Database;

interface Env {
  DB: D1Database;
}

declare namespace App {
  interface Locals extends Env {}
}
