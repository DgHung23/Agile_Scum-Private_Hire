import { router as auth } from './auth.js';
import { router as notifications } from './notifications.js';

/** Central route registry. Each module adds its router here (see docs/SPRINTS.md). */
export function registerRoutes(api) {
  api.use('/auth', auth);
  api.use('/notifications', notifications);
}
