import {
  applyVenueGuard,
  readCoordinates,
  searchVenueListings,
  sendVenueError,
} from '../_venue-live.js';
import { getBangingDirectory } from '../_banging-directory.js';
import { getPlannerPool } from '../_planner-directory.js';

export const maxDuration = 120;

export default async function handler(req, res) {
  if (applyVenueGuard(req, res, { limit: true })) return;

  if (req.query.planner_pool === '1') {
    const origin = readCoordinates(req.query);
    const area = typeof req.query.area === 'string' ? req.query.area.trim() : '';
    const mode = req.query.mode;
    const budget = Number(req.query.budget);
    if ((!origin && !area) || area.length > 80 || !['morning', 'lunch', 'night'].includes(mode) ||
      ![1, 2, 3, 4].includes(budget) || !['near', 'wide'].includes(req.query.stage)) {
      res.status(400).json({ error: 'Choose a planner area, mode and price.' });
      return;
    }
    try {
      const body = await getPlannerPool({ origin, area, mode, budget, wide: req.query.stage === 'wide' });
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.status(200).json(body);
    } catch (error) {
      res.setHeader('Retry-After', '60');
      sendVenueError(res, error, 'The nearby planner selection is refreshing. Please try again shortly.');
    }
    return;
  }

  if (req.query.banging === '1') {
    const origin = readCoordinates(req.query);
    const ids = typeof req.query.premium_ids === 'string' ? req.query.premium_ids.split(',').filter(Boolean) : [];
    if (!origin || ids.length > 10 || ids.some(id => !/^[A-Za-z0-9_-]{8,256}$/.test(id))) {
      res.status(400).json({ error: 'A current location and valid Premium venues are required.' });
      return;
    }
    try {
      const body = await getBangingDirectory(origin, [...new Set(ids)]);
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.status(200).json(body);
    } catch (error) {
      res.setHeader('Retry-After', '60');
      sendVenueError(res, error, 'The luxury Banging selection is refreshing. Please try again shortly.');
    }
    return;
  }

  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
  if (query.length < 2 || query.length > 120) {
    res.status(400).json({ error: 'Enter a venue name or UK area between 2 and 120 characters.' });
    return;
  }

  const locationBias = readCoordinates(req.query);

  try {
    const results = await searchVenueListings(query, locationBias);
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600');
    res.status(200).json({ query, results });
  } catch (error) {
    sendVenueError(res, error, 'Venue search could not complete right now. Please try again.');
  }
}