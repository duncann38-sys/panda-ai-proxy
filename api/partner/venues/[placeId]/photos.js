import {
  applyVenuePhotoGuard,
  getVenuePhotos,
  isValidPlaceId,
  sendVenuePhotoError,
} from '../../../_venue-photos.js';
import { createHash } from 'node:crypto';

export default async function handler(req, res) {
  if (applyVenuePhotoGuard(req, res)) return;

  const placeId = req.query.placeId;
  if (!isValidPlaceId(placeId)) {
    res.status(400).json({ error: 'Choose a valid Google venue.' });
    return;
  }

  try {
    const refresh = req.query.refresh === '1';
    const photos = await getVenuePhotos(placeId, { refresh });
    const encodedPlaceId = encodeURIComponent(placeId);
    res.setHeader('Cache-Control', refresh ? 'private, no-store'
      : 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=604800');
    res.status(200).json({
      photos: photos.map((photo, index) => ({
        path: '/api/partner/venues/' + encodedPlaceId + '/photos/' + index + '/image?revision='
          + createHash('sha256').update(photo.name).digest('hex').slice(0, 16),
        attribution: photo.attribution,
      })),
    });
  } catch (error) {
    sendVenuePhotoError(res, error);
  }
}
