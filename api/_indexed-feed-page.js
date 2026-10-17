async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export async function buildIndexedFeedPage(body, {
  maxPageSize = 200,
  readPage,
  hydratePlace,
} = {}) {
  if (typeof readPage !== 'function' || typeof hydratePlace !== 'function'
    || !Number.isInteger(maxPageSize) || maxPageSize < 1) {
    throw new TypeError('Indexed feed page loaders and a positive page limit are required.');
  }

  const lat = Number(body.location?.lat);
  const lng = Number(body.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { status: 400, body: { error: 'valid_location_required' } };
  }
  const category = typeof body.category === 'string' ? body.category.trim() : 'All';
  const parsedPageSize = Number(body.pageSize);
  const isCategoryFeed = category !== 'All';
  if (isCategoryFeed && Number.isFinite(parsedPageSize) && parsedPageSize > 0
    && Math.floor(parsedPageSize) !== maxPageSize) {
    return {
      status: 400,
      body: { error: 'category_feed_page_size_must_be_200', requiredCount: maxPageSize },
    };
  }
  const requestedPageSize = isCategoryFeed
    ? maxPageSize
    : Number.isFinite(parsedPageSize) && parsedPageSize > 0
      ? Math.max(1, Math.min(maxPageSize, Math.floor(parsedPageSize)))
      : maxPageSize;
  const hasHydrationLimit = body.maxHydrations !== undefined && body.maxHydrations !== null;
  const parsedHydrationLimit = Number(body.maxHydrations);
  if (hasHydrationLimit && (!Number.isInteger(parsedHydrationLimit)
    || parsedHydrationLimit < 1 || parsedHydrationLimit > maxPageSize)) {
    return { status: 400, body: { error: 'invalid_hydration_limit', maxAllowed: maxPageSize } };
  }
  const maxHydrations = hasHydrationLimit ? parsedHydrationLimit : Number.POSITIVE_INFINITY;
  const parsedRadius = Number(body.radiusMeters);
  const radius = Number.isFinite(parsedRadius)
    ? Math.max(500, Math.min(20_000, parsedRadius))
    : (category === 'All' ? 6000 : 20_000);
  let cursor = body.cursor || null;
  let indexExhausted = false;
  let expandedArea = false;
  const venues = [];
  let budgetExceeded = false;
  let providerFailure;
  let hydrationAttempts = 0;
  let hydrationLimitReached = false;

  // Continue through stored ID pages until the customer page is full or the
  // index, Google budget, or provider makes further hydration unavailable.
  // Failed category/photo checks never count toward the requested page size.
  while (venues.length < requestedPageSize && hydrationAttempts < maxHydrations) {
    const wanted = Math.min(
      maxPageSize,
      requestedPageSize - venues.length,
      maxHydrations - hydrationAttempts,
    );
    const page = await readPage({
      lat, lng, radius, category, cursor, pageSize: wanted,
    });
    cursor = page.nextCursor;
    indexExhausted = page.indexExhausted;
    expandedArea ||= page.expandedArea === true;
    if (!page.identities.length) break;
    const identities = page.identities.slice(0, wanted);
    hydrationAttempts += identities.length;
    const batch = await mapWithConcurrency(identities, 6, identity =>
      hydratePlace(identity.place_id, identity, category));
    for (const result of batch) {
      if (result.budgetExceeded) budgetExceeded = true;
      if (result.providerFailed) {
        providerFailure ||= result;
        if ([403, 429, 500, 502, 503, 504].includes(result.providerStatus)) {
          providerFailure = result;
          break;
        }
      }
      const matchesCategory = category === 'All'
        || result.venue?.categories?.includes(category);
      if (result.venue?.name && result.venue.photoName && matchesCategory) {
        venues.push(result.venue);
        if (venues.length >= requestedPageSize) break;
      }
    }
    if (venues.length >= requestedPageSize || indexExhausted
      || budgetExceeded || [403, 429, 500, 502, 503, 504].includes(providerFailure?.providerStatus)) break;
    if (hydrationAttempts >= maxHydrations && venues.length < requestedPageSize) {
      hydrationLimitReached = true;
      break;
    }
  }

  const incompleteCategoryPage = isCategoryFeed && venues.length < requestedPageSize;
  if (incompleteCategoryPage || (!venues.length && (budgetExceeded || providerFailure))) {
    const status = budgetExceeded ? 503
      : providerFailure?.providerStatus === 429 ? 429
        : providerFailure?.providerStatus === 403 ? 403
          : providerFailure ? 502 : 503;
    const error = budgetExceeded
      ? 'places_daily_budget_exceeded'
      : providerFailure
        ? 'places_card_lookup_failed'
        : hydrationLimitReached
          ? 'hydration_attempt_limit_reached'
          : 'insufficient_google_verified_venues';
    return {
      status,
      body: {
        error,
        ...(isCategoryFeed ? { requiredCount: requestedPageSize } : {}),
        matchedCount: venues.length,
        nextCursor: cursor,
        indexExhausted,
        expandedArea,
        ...(hasHydrationLimit ? { hydrationAttempts, hydrationLimitReached } : {}),
      },
    };
  }
  return {
    status: 200,
    body: {
      venues, nextCursor: cursor, indexExhausted,
      dataMode: 'indexed_feed_live_google_card_fields',
      expandedArea,
      pageSize: requestedPageSize,
      ...(hasHydrationLimit ? { hydrationAttempts, hydrationLimitReached } : {}),
      ...(venues.length < requestedPageSize
        ? { partial: true, matchedCount: venues.length, requiredCount: requestedPageSize }
        : {}),
    },
  };
}


/**
 * Serve the indexed Place ID candidate page without calling Google Places.
 * Google names, photos, hours, ratings, and other rich fields are hydrated live
 * only when the customer opens or views an individual venue.
 */
export async function buildIndexedIdCandidatePage(body, {
  maxPageSize = 200,
  readPage,
} = {}) {
  if (typeof readPage !== 'function' || !Number.isInteger(maxPageSize) || maxPageSize < 1) {
    throw new TypeError('An indexed feed reader and positive page limit are required.');
  }
  const lat = Number(body.location?.lat);
  const lng = Number(body.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { status: 400, body: { error: 'valid_location_required' } };
  }
  const category = typeof body.category === 'string' ? body.category.trim() : 'All';
  const parsedPageSize = Number(body.pageSize);
  const isCategoryFeed = category !== 'All';
  if (isCategoryFeed && Number.isFinite(parsedPageSize) && parsedPageSize > 0
    && Math.floor(parsedPageSize) !== maxPageSize) {
    return { status: 400, body: { error: 'category_feed_page_size_must_be_200', requiredCount: maxPageSize } };
  }
  const pageSize = isCategoryFeed ? maxPageSize
    : Number.isFinite(parsedPageSize) && parsedPageSize > 0
      ? Math.max(1, Math.min(maxPageSize, Math.floor(parsedPageSize))) : maxPageSize;
  const parsedRadius = Number(body.radiusMeters);
  const radius = Number.isFinite(parsedRadius)
    ? Math.max(500, Math.min(20_000, parsedRadius))
    : (category === 'All' ? 6000 : 20_000);
  const page = await readPage({
    lat, lng, radius, category, cursor: body.cursor || null, pageSize,
  });
  const unique = new Set();
  const venues = (Array.isArray(page.identities) ? page.identities : []).flatMap(identity => {
    const id = typeof identity?.place_id === 'string' ? identity.place_id : '';
    const candidateLat = Number(identity?.lat);
    const candidateLng = Number(identity?.lng);
    if (!id || unique.has(id) || !Number.isFinite(candidateLat) || !Number.isFinite(candidateLng)) return [];
    unique.add(id);
    return [{
      id, lat: candidateLat, lng: candidateLng,
      distanceMeters: Number.isFinite(Number(identity.distanceMeters)) ? Number(identity.distanceMeters) : undefined,
      type: 'Venue', detailsDeferred: true,
      categories: isCategoryFeed ? [category] : [],
      sourceQueries: [`indexed:${category}`],
    }];
  });
  const nextCursor = page.nextCursor || null;
  const indexExhausted = page.indexExhausted === true;
  const expandedArea = page.expandedArea === true;
  if (isCategoryFeed && venues.length < pageSize) {
    return { status: 503, body: {
      error: 'insufficient_indexed_category_candidates', requiredCount: pageSize,
      matchedCount: venues.length, nextCursor, indexExhausted, expandedArea,
    } };
  }
  return { status: 200, body: {
    venues, nextCursor, indexExhausted, expandedArea, pageSize,
    dataMode: 'indexed_feed_id_candidates',
    ...(venues.length < pageSize ? { partial: true, matchedCount: venues.length } : {}),
  } };
}
