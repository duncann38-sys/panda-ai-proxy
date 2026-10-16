import {
  applyVenueGuard,
  getVenueProfile,
  isValidPlaceId,
  sendVenueError,
} from '../../../_venue-live.js';
import admin from 'firebase-admin';
import { indexedVenueBaseline } from '../../../_london-index.js';

export default async function handler(req, res) {
  if (applyVenueGuard(req, res)) return;
  const placeId = req.query.placeId;
  if (!isValidPlaceId(placeId)) {
    res.status(400).json({ error: 'Choose a valid Google venue.' });
    return;
  }
  try {
    const profile = await getVenueProfile(placeId);
    if (!profile) {
      res.status(404).json({ error: 'Google does not have a current profile for this venue.' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=900, stale-while-revalidate=3600');
    res.status(200).json(profile);
  } catch (error) {
    if ([403, 429, 500, 502, 503, 504].includes(error?.status)) {
      try {
        if (!admin.apps.length) {
          const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
          account.private_key = account.private_key.replace(/\\n/g, '\n');
          admin.initializeApp({ credential: admin.credential.cert(account) });
        }
        const baseline = await indexedVenueBaseline(admin.firestore(), placeId);
        if (baseline) {
          res.setHeader('Cache-Control', 'no-store');
          res.status(200).json(baseline);
          return;
        }
      } catch { /* Keep the established error response if storage is also down. */ }
    }
    sendVenueError(res, error, 'Google venue details could not be loaded right now.');
  }
}
