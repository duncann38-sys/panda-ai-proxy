import {
  applyVenueGuard,
  findNearestTransitStation,
  readCoordinates,
  sendVenueError,
} from '../../_venue-live.js';

export default async function handler(req, res) {
  if (applyVenueGuard(req, res)) return;

  const location = readCoordinates(req.query);
  if (!location) {
    res.status(400).json({ error: 'A valid current location is required.' });
    return;
  }

  try {
    const station = await findNearestTransitStation(location.latitude, location.longitude);
    if (!station) {
      res.status(404).json({ error: 'Nearby rail or Underground stations were not found.' });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.status(200).json({ station, source: 'google_places' });
  } catch (error) {
    sendVenueError(res, error, 'Live station information could not be loaded right now.');
  }
}