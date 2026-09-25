// Local Workers-runtime smoke test: real encryption/crypto, intercepted outbound delivery.
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { sendPush } from '../src/notifications.ts';

export default {
  async fetch() {
    const keys = webpush.generateVAPIDKeys();
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const original = globalThis.fetch;
    let encrypted = false, signed = false;
    globalThis.fetch = async (_url, options) => {
      encrypted = options?.body instanceof Uint8Array && options.body.length > 30;
      signed = new Headers(options?.headers).get('authorization')?.startsWith('vapid t=') ?? false;
      return new Response(null, { status: 201 });
    };
    try {
      const status = await sendPush({ SUPABASE_URL: '', SUPABASE_SECRET_KEY: '', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }, {
        endpoint: 'https://fcm.googleapis.com/runtime-test',
        keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
      }, JSON.stringify({ title: 'Runtime smoke test', body: 'No real delivery' }));
      return Response.json({ status, encrypted, signed });
    } finally { globalThis.fetch = original; }
  },
};
