import {
  applyVenuePhotoGuard,
  getVenuePhotoImage,
  isValidPlaceId,
  sendVenuePhotoError,
} from '../../../../../_venue-photos.js';

const MAX_VENUE_PHOTOS = 10;

export default async function handler(req, res) {
  if (applyVenuePhotoGuard(req, res)) return;

  const placeId = req.query.placeId;
  const photoIndex = Number.parseInt(req.query.photoIndex, 10);
  if (!isValidPlaceId(placeId) || !Number.isInteger(photoIndex) || photoIndex < 0 || photoIndex >= MAX_VENUE_PHOTOS) {
    res.status(400).json({ error: 'Choose a valid Google venue photo.' });
    return;
  }

  try {
    const image = await getVenuePhotoImage(placeId, photoIndex);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
    res.setHeader('Content-Type', image.contentType);
    res.status(200).send(image.body);
  } catch (error) {
    sendVenuePhotoError(res, error);
  }
}
