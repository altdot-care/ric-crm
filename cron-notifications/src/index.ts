import { run, type NotificationEnv } from './notifications.ts';
import { handlePreview } from './preview.ts';

export default {
  async scheduled(event: ScheduledEvent, env: NotificationEnv, ctx: ExecutionContext) {
    ctx.waitUntil(run(env, { now: new Date(event.scheduledTime) }).then(result => {
      console.log('Notification run:', JSON.stringify(result));
    }));
  },
  // Root-only test tools for the web app's /preview page; see preview.ts.
  async fetch(request: Request, env: NotificationEnv) {
    return handlePreview(request, env);
  },
};
