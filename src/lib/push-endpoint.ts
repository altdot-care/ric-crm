/** Only browser push services may receive server-side requests. Keep this check at both
 * the API boundary and the sender: authenticated clients can also write via Supabase. */
export function isPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      !url.hash && (
        url.hostname === 'fcm.googleapis.com' ||
        url.hostname === 'updates.push.services.mozilla.com' ||
        url.hostname.endsWith('.push.services.mozilla.com') ||
        url.hostname === 'web.push.apple.com' ||
        url.hostname.endsWith('.notify.windows.com')
      );
  } catch {
    return false;
  }
}

/** The endpoint's hostname, or null when it is not a parseable URL (stored rows can be junk). */
export function endpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname || null;
  } catch {
    return null;
  }
}
