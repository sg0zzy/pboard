import { browser } from '../platform/browser';
import { googleDrive } from './browser';
import { drivePollDelay } from './syncPolicy';

export const DRIVE_POLL_ALARM = 'pboard-drive-poll';
const ATTEMPT_KEY = 'pboard-drive-poll-attempt';

/** Browser alarms survive sidebar closure and service-worker suspension. */
export function registerDriveAccountPolling() {
  let running = false;
  const schedule = async (attempt: number, cooldown = 0) => {
    await browser.alarms.create(DRIVE_POLL_ALARM, { when: Date.now() + Math.max(cooldown, drivePollDelay(attempt)) });
  };
  browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (alarm.name !== DRIVE_POLL_ALARM || running) return;
    running = true;
    void (async () => {
      let attempt = Number((await browser.storage.local.get(ATTEMPT_KEY))[ATTEMPT_KEY]) || 0;
      let cooldown = 0;
      try {
        if (await googleDrive.getConnectionState() === 'connected') {
          await googleDrive.reconcileAll();
          attempt = 0;
        }
      } catch (error) {
        attempt = Math.min(attempt + 1, 6);
        if (error instanceof Error && 'waitMs' in error) cooldown = Number(error.waitMs) || 0;
      } finally {
        await browser.storage.local.set({ [ATTEMPT_KEY]: attempt });
        await schedule(attempt, cooldown);
        running = false;
      }
    })();
  });
  void (async () => {
    if (await browser.alarms.get?.(DRIVE_POLL_ALARM)) return;
    const attempt = Number((await browser.storage.local.get(ATTEMPT_KEY))[ATTEMPT_KEY]) || 0;
    await schedule(attempt);
  })();
}
