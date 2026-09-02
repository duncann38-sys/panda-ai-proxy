import {
  applyVenueGuard,
  findNearestTransitStation,
  getVenueProfile,
  getTransitRoute,
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

    const [originStation, destinationStation] = await Promise.all([
      findNearestTransitStation(location.latitude, location.longitude),
      findNearestTransitStation(venue.latitude, venue.longitude),
    ]);
    if (!originStation || !destinationStation) {
      res.status(404).json({ error: 'Nearby rail or Underground stations were not found.' });
      return;
    }

    const [originWalk, transitRoute, venueWalk] = await Promise.all([
      getWalkingRoute(
        { latitude: location.latitude, longitude: location.longitude },
        {
          latitude: originStation.latitude,
          longitude: originStation.longitude,
        },
      ).catch(() => null),
      getTransitRoute(
        {
          latitude: originStation.latitude,
          longitude: originStation.longitude,
        },
        {
          latitude: destinationStation.latitude,
          longitude: destinationStation.longitude,
        },
      ).catch(() => null),
      getWalkingRoute(
        {
          latitude: destinationStation.latitude,
          longitude: destinationStation.longitude,
        },
        { latitude: venue.latitude, longitude: venue.longitude },
      ).catch(() => null),
    ]);

    res.setHeader('Cache-Control', 'private, max-age=120');
    res.status(200).json({
      originStation,
      destinationStation,
      originWalk,
      transitRoute,
      venueWalk,
      source: 'google_places',
    });
  } catch (error) {
    sendVenueError(res, error, 'Live transit information could not be loaded right now.');
  }
}