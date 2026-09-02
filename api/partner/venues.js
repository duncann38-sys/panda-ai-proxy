import {
  applyVenueGuard,
  searchVenueListings,
  sendVenueError,
} from '../_venue-live.js';

export default async function handler(req, res) {
  if (applyVenueGuard(req, res, { limit: true })) return;

  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
  if (query.length < 2 || query.length > 120) {
    res.status(400).json({ error: 'Enter a venue name or UK area between 2 and 120 characters.' });
    return;
  }

  try {
    const results = await searchVenueListings(query);
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600');
    res.status(200).json({ query, results });
  } catch (error) {
    sendVenueError(res, error, 'Venue search could not complete right now. Please try again.');
  }
}