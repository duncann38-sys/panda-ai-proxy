import { applyVenueGuard, db, getVenueProfile, isValidPlaceId, sendVenueError } from '../../../_venue-live.js';
import { getOfficialVenueLinks } from '../../../_official-venue-links.js';
import { createOpenTableMatcher } from '../../../_opentable-match.js';
import { createVenueReservationLinks } from '../../../_venue-reservation-links.js';

const loadLinks = createVenueReservationLinks({
  getProfile: getVenueProfile,
  getOfficialLinks: (website, name, options) => getOfficialVenueLinks(website, name, undefined, options),
  // Activated for the user's explicit Native Reserve intent only. The
  // completed production index is still required; a kill switch remains.
  getOpenTableMatch: profile => !['disabled', 'off', 'false', '0'].includes((process.env.OPENTABLE_DIRECTORY_MATCHING ?? 'enabled').toLowerCase())
    ? createOpenTableMatcher({ store: db() })(profile)
    : Promise.resolve({ status: 'disabled' }),
});

export default async function handler(req, res) {
  if (applyVenueGuard(req, res)) return;
  if (!isValidPlaceId(req.query.placeId)) return res.status(400).json({ error: 'Choose a valid Google venue.' });
  try {
    const reservationOnly = req.query.intent === 'reservation';
    const links = await loadLinks(req.query.placeId, { reservationOnly });
    if (!links) return res.status(404).json({ error: 'Venue profile unavailable.' });
    res.setHeader('Cache-Control', !reservationOnly ? 'public, max-age=900, s-maxage=10800'
      : ['unavailable', 'index_not_ready'].includes(links.openTableLookup)
        ? 'private, no-store' : 'public, max-age=60, s-maxage=300');
    res.status(200).json(links);
  } catch (error) {
    sendVenueError(res, error, 'Verified official menu and reservation links are unavailable.');
  }
}
