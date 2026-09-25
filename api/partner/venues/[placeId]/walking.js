import {
  applyVenueGuard,
  getVenueProfile,
  getWalkingRoute,
  isValidPlaceId,
  readCoordinates,
  sendVenueError,
} from '../../../_venue-live.js';

export default async function handler(req, res) {
  if (applyVenueGuard(req, res)) return;

  const placeId = req.query.placeId;
  const location = readCoordinates(req.query);
  if (!isValidPlaceId(placeId)) {
    res.status(400).json({ error: 'Choose a valid Google venue.' });
    return;
  }
  if (!location) {
    res.status(400).json({ error: 'A valid current location is required.' });
    return;
  }

  try {
    const venue = await getVenueProfile(placeId);
    if (!venue || venue.latitude === null || venue.longitude === null) {
      res.status(404).json({ error: 'Google does not have coordinates for this venue.' });
      return;
    }

    const route = await getWalkingRoute(
      location,
      { latitude: venue.latitude, longitude: venue.longitude },
    );
    if (!route) {
      res.status(404).json({ error: 'Walking directions are unavailable right now.' });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.status(200).json(route);
  } catch (error) {
    sendVenueError(res, error, 'Walking directions are unavailable right now.');
  }
}
