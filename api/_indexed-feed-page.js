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
  const requestedPageSize = Number.isFinite(parsedPageSize) && parsedPageSize > 0
    ? Math.max(1, Math.min(maxPageSize, Math.floor(parsedPageSize)))
    : maxPageSize;
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

  // Continue through stored ID pages until the customer page is full or the
  // index, Google budget, or provider makes further hydration unavailable.
  // Failed category/photo checks never count toward the requested page size.
  while (venues.length < requestedPageSize) {
    const wanted = Math.min(maxPageSize, requestedPageSize - venues.length);
    const page = await readPage({
      lat, lng, radius, category, cursor, pageSize: wanted,
    });
    cursor = page.nextCursor;
    indexExhausted = page.indexExhausted;
    expandedArea ||= page.expandedArea === true;
    if (!page.identities.length) break;
    const batch = await mapWithConcurrency(page.identities, 6, identity =>
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
  }

  if (!venues.length && (budgetExceeded || providerFailure)) {
    const status = budgetExceeded ? 503
      : providerFailure.providerStatus === 429 ? 429
        : providerFailure.providerStatus === 403 ? 403 : 502;
    return {
      status,
      body: {
        error: budgetExceeded ? 'places_daily_budget_exceeded' : 'places_card_lookup_failed',
        nextCursor: cursor,
        indexExhausted,
        expandedArea,
      },
    };
  }
  return {
    status: 200,
    body: {
      venues, nextCursor: cursor, indexExhausted,
      dataMode: 'indexed_feed_live_google_card_fields',
      expandedArea,
      ...(budgetExceeded ? { budgetExceeded: true } : {}),
      ...(venues.length < requestedPageSize ? { partial: true } : {}),
    },
  };
}
