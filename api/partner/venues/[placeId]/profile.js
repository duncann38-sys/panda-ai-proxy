import {
  applyVenueGuard,
  getVenueProfile,
  isValidPlaceId,
  sendVenueError,
} from '../../../_venue-live.js';

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
    sendVenueError(res, error, 'Google venue details could not be loaded right now.');
  }
}