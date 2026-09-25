// @ts-check
import { defineConfig, envField } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  session: false, // auth lives in Supabase's cookie; without this the adapter adds a SESSION KV binding

  adapter: cloudflare({ imageService: 'passthrough' }), // no images used → skip the IMAGES binding
  vite: {
    plugins: [tailwindcss()],
  },
  env: {
    schema: {
      // 'secret' = read at runtime from the Worker env; 'public' would be inlined at build time (baking in .dev.vars' localhost URL).
      SUPABASE_URL: envField.string({ context: 'server', access: 'secret' }),
      SUPABASE_PUBLISHABLE_KEY: envField.string({ context: 'server', access: 'secret' }),
      // Service-role key: bypasses RLS. Only src/lib/supabase-admin.ts may read it, and only root-only routes may call that.
      SUPABASE_SECRET_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      // Public key read at runtime, forwarded via /api/me. Private key belongs only to cron.
      VAPID_PUBLIC_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
});
