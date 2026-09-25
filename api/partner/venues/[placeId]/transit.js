import {
    applyVenueGuard,
    getVenueProfile,
    getTransitRoute,
    isValidPlaceId,
    readCoordinates,
    sendVenueError,
    } from '../../../_venue-live.js';

    const TRANSIT_CACHE_TTL_MS = 60_000;
    const transitCache = new Map();
    const inFlightTransitRoutes = new Map();

    function stationFromTransitStop(name, location) {
    if (!name || !location || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90
      || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180) return null;
    return {
      name,
      latitude: location.latitude,
      longitude: location.longitude,
      googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=' + location.latitude + ',' + location.longitude,
      source: 'google_routes',
    };
    }

    function walkingRouteFromSteps(steps) {
    if (!steps.length || steps.some((step) => step.mode !== 'WALK' || !step.endLocation)) return null;
    const walkingSteps = steps.map((step) => ({
      instruction: step.instruction,
      distanceMeters: step.distanceMeters,
      durationMinutes: step.durationMinutes,
      endLocation: step.endLocation,
      ...(step.polyline ? { polyline: step.polyline } : {}),
    }));
    return {
      distanceMeters: walkingSteps.reduce((total, step) => total + step.distanceMeters, 0),
      durationMinutes: walkingSteps.reduce((total, step) => total + step.durationMinutes, 0),
      endLocation: walkingSteps[walkingSteps.length - 1].endLocation,
      steps: walkingSteps,
      ...(walkingSteps.length === 1 && walkingSteps[0].polyline ? { polyline: walkingSteps[0].polyline } : {}),
      source: 'google_routes',
    };
    }

    function removeExpiredLivePrediction(result) {
    const route = result.transitRoute;
    if (!route) return result;
    let removed = false;
    const steps = route.steps.map((step) => {
      if (!step.liveUpdatedAt || Date.now() - Date.parse(step.liveUpdatedAt) < TRANSIT_CACHE_TTL_MS) return step;
      const { liveDepartureTime, liveUpdatedAt, ...estimate } = step;
      removed = true;
      return estimate;
    });
    if (!removed) return result;
    return {
      ...result,
      timingSource: 'google_estimate',
      transitRoute: { ...route, steps, timingSource: 'google_estimate' },
    };
    }

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

    const cacheKey = placeId + ':' + location.latitude.toFixed(4) + ':' + location.longitude.toFixed(4);
    const cached = transitCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const result = removeExpiredLivePrediction(cached.result);
      res.setHeader('Cache-Control', result.timingSource === 'tfl_live' ? 'private, max-age=0' : 'private, max-age=30');
      res.status(200).json(result);
      return;
    }

    try {
      let request = inFlightTransitRoutes.get(cacheKey);
      if (!request) {
        request = (async () => {
          const venue = await getVenueProfile(placeId);
          if (!venue || venue.latitude === null || venue.longitude === null) {
            const error = new Error('Google does not have coordinates for this venue.');
            error.status = 404;
            throw error;
          }
          const transitRoute = await getTransitRoute(location, { latitude: venue.latitude, longitude: venue.longitude });
          const firstTransitIndex = transitRoute?.steps.findIndex((step) => step.mode === 'TRANSIT') ?? -1;
          const lastTransitIndex = transitRoute
            ? transitRoute.steps.reduce((last, step, index) => step.mode === 'TRANSIT' ? index : last, -1)
            : -1;
          if (!transitRoute || firstTransitIndex < 0 || lastTransitIndex < firstTransitIndex) {
            const error = new Error('A complete public transport route was not found.');
            error.status = 404;
            throw error;
          }
          const originStation = stationFromTransitStop(
            transitRoute.steps[firstTransitIndex].departureStop,
            transitRoute.steps[firstTransitIndex].departureLocation,
          );
          const destinationStation = stationFromTransitStop(
            transitRoute.steps[lastTransitIndex].arrivalStop,
            transitRoute.steps[lastTransitIndex].arrivalLocation,
          );
          if (!originStation || !destinationStation) {
            const error = new Error('Google did not return reliable boarding and alighting station locations.');
            error.status = 404;
            throw error;
          }
          const updatedAt = new Date().toISOString();
          transitRoute.updatedAt = updatedAt;
          const result = {
            originStation,
            destinationStation,
            originWalk: walkingRouteFromSteps(transitRoute.steps.slice(0, firstTransitIndex)),
            transitRoute,
            venueWalk: walkingRouteFromSteps(transitRoute.steps.slice(lastTransitIndex + 1)),
            source: 'google_places',
            updatedAt,
            timingSource: transitRoute.timingSource || 'google_estimate',
          };
          transitCache.set(cacheKey, { expiresAt: Date.now() + TRANSIT_CACHE_TTL_MS, result });
          return result;
        })().finally(() => inFlightTransitRoutes.delete(cacheKey));
        inFlightTransitRoutes.set(cacheKey, request);
      }
      const result = await request;
      res.setHeader('Cache-Control', result.timingSource === 'tfl_live' ? 'private, max-age=0' : 'private, max-age=30');
      res.status(200).json(result);
    } catch (error) {
      if (Number.isInteger(error?.status)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      sendVenueError(res, error, 'Live transit information could not be loaded right now.');
    }
    }