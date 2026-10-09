import { applyVenueGuard, getVenueProfile, isValidPlaceId, sendVenueError } from '../../../_venue-live.js';
import { getOfficialVenueLinks } from '../../../_official-venue-links.js';

export default async function handler(req, res) {
  if (applyVenueGuard(req, res)) return;
  if (!isValidPlaceId(req.query.placeId)) return res.status(400).json({ error: 'Choose a valid Google venue.' });
  try {
    const profile = await getVenueProfile(req.query.placeId);
    if (!profile) return res.status(404).json({ error: 'Venue profile unavailable.' });
    const links = await getOfficialVenueLinks(profile.website);
    res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=10800');
    res.status(200).json(links);
  } catch (error) {
    sendVenueError(res, error, 'Verified official menu and reservation links are unavailable.');
  }
}
