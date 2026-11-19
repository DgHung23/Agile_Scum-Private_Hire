import { expireHolds } from './services/availability.js';

/**
 * Background jobs (simulated scheduler). Each job is also safe to run on demand, so tests and demos can trigger it.
 * - every minute: release cabs held by bookings whose payment never finished (ID-53)
 */
export const JOBS = {
  expireHolds: () => expireHolds(),
};

export function startJobs() {
  const run = async () => {
    for (const [name, job] of Object.entries(JOBS)) {
      try {
        await job();
      } catch (e) {
        console.error(`[jobs] ${name} failed:`, e.message);
      }
    }
  };
  const timer = setInterval(run, 60_000);
  timer.unref();
  return timer;
}
