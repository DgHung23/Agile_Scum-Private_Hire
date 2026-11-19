import { router as auth } from './auth.js';
import { router as notifications } from './notifications.js';
import { router as catalog } from './catalog.js';
import { router as bookings } from './bookings.js';
import { router as fleet } from './fleet.js';

/** Central route registry. Each module adds its router here (see docs/SPRINTS.md). */
export function registerRoutes(api) {
  api.use('/auth', auth);
  api.use('/notifications', notifications);
  api.use('/catalog', catalog);
  api.use('/bookings', bookings);
  api.use('/staff', fleet);
}
