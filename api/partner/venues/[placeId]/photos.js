import {
  applyVenuePhotoGuard,
  getVenuePhotos,
  isValidPlaceId,
  sendVenuePhotoError,
} from '../../../_venue-photos.js';

export default async function handler(req, res) {
  if (applyVenuePhotoGuard(req, res)) return;

  const placeId = req.query.placeId;
  if (!isValidPlaceId(placeId)) {
    res.status(400).json({ error: 'Choose a valid Google venue.' });
    return;
  }

  try {
    const photos = await getVenuePhotos(placeId);
    const encodedPlaceId = encodeURIComponent(placeId);
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400');
    res.status(200).json({
      photos: photos.map((photo, index) => ({
        path: '/api/partner/venues/' + encodedPlaceId + '/photos/' + index + '/image',
        attribution: photo.attribution,
      })),
    });
  } catch (error) {
    sendVenuePhotoError(res, error);
  }
}
