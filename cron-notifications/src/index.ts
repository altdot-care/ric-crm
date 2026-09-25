import { run, type NotificationEnv } from './notifications.ts';

export default {
  async scheduled(event: ScheduledEvent, env: NotificationEnv, ctx: ExecutionContext) {
    ctx.waitUntil(run(env, { now: new Date(event.scheduledTime) }).then(result => {
      console.log('Notification run:', JSON.stringify(result));
    }));
  },
};
