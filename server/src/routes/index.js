import { router as auth } from './auth.js';
import { router as notifications } from './notifications.js';
import { router as catalog } from './catalog.js';
import { router as bookings } from './bookings.js';
import { router as payments } from './payments.js';
import { router as fleet } from './fleet.js';
import { router as callcentre } from './callcentre.js';
import { router as enquiries, staffRouter as staffEnquiries } from './enquiries.js';
import { router as dispatch } from './dispatch.js';
import { router as reviews, staffRouter as staffReviews } from './reviews.js';
import { customerRouter as offers, staffRouter as staffLoyalty } from './loyalty.js';
import { router as admin } from './admin.js';
import { router as pricing } from './pricing.js';
import { router as receipts, staffRouter as staffReceipts } from './receipts.js';
import { router as journey, publicRouter as track, staffRouter as staffJourney } from './journey.js';
import { router as driver } from './driver.js';
import { router as support, staffRouter as staffSupport } from './support.js';
import { router as business, staffRouter as staffBusiness } from './business.js';

/** Every mounted router, so the API reference can list the endpoints (development only, DoD line 12). */
export const mounts = [];

/** Central route registry. Each module adds its router here (see docs/SPRINTS.md). */
export function registerRoutes(api) {
  mounts.length = 0;
  const use = api.use.bind(api);
  api = { use: (path, router) => (mounts.push([path, router]), use(path, router)) };
  api.use('/auth', auth);
  api.use('/notifications', notifications);
  api.use('/catalog', catalog);
  api.use('/bookings', bookings);
  api.use('/bookings', reviews);
  api.use('/offers', offers);
  api.use('/payments', payments);
  api.use('/staff', fleet);
  api.use('/enquiries', enquiries);
  api.use('/staff', callcentre);
  api.use('/staff', staffEnquiries);
  api.use('/staff', dispatch);
  api.use('/staff', staffReviews);
  api.use('/staff', staffLoyalty);
  api.use('/staff', pricing);
  api.use('/receipts', receipts);
  api.use('/bookings', journey);
  api.use('/track', track);
  api.use('/staff', staffJourney);
  api.use('/staff', staffReceipts);
  api.use('/driver', driver);
  api.use('/support', support);
  api.use('/staff', staffSupport);
  api.use('/business', business);
  api.use('/staff', staffBusiness);
  api.use('/admin', admin);
}

/** List of [METHOD, path] for every endpoint, read from the routers themselves. */
export function listEndpoints() {
  const out = [];
  for (const [base, router] of mounts) {
    for (const layer of router.stack || []) {
      if (!layer.route) continue;
      for (const m of Object.keys(layer.route.methods)) out.push([m.toUpperCase(), `/api/v1${base}${layer.route.path}`]);
    }
  }
  return out.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
}
