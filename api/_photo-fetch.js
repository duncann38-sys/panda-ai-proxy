import { providerQuotaInfo } from './_london-index.js';

// Bound requests within each warm API instance. This is not a replacement for
// Google's project-wide quota, and must never retry an exhausted daily quota.
export function createPhotoFetch({
  fetchImpl = fetch, now = Date.now, random = Math.random,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  concurrency = 2, staggerMs = 75, retries = 2,
} = {}) {
  let active = 0;
  let nextStart = 0;
  const pending = [];
  const maximum = Math.min(2, Math.max(1, concurrency));
  const spacing = Math.min(100, Math.max(50, staggerMs));
  async function dispatch(input, init) {
    while (active >= maximum) await new Promise(resolve => pending.push(resolve));
    active++;
    try {
      const start = Math.max(nextStart, now());
      nextStart = start + spacing;
      if (start > now()) await wait(start - now());
      return await fetchImpl(input, init);
    } finally {
      active--;
      pending.shift()?.();
    }
  }
  return async function fetchPhoto(input, init) {
    const attempts = Math.min(2, Math.max(0, retries));
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await dispatch(input, init);
      } catch (error) {
        if (attempt >= attempts || init?.signal?.aborted || error?.name === 'AbortError') throw error;
        await wait(250 * 2 ** attempt + Math.floor(random() * 100));
        continue;
      }
      if (attempt >= attempts || ![429, 500, 502, 503, 504].includes(response.status)) return response;
      if (response.status === 429) {
        const payload = await response.clone().json().catch(() => ({}));
        if (providerQuotaInfo(payload.error || {}).period === 'day') return response;
      }
      const retryAfter = response.headers.get('retry-after');
      const seconds = Number(retryAfter);
      const suggested = !retryAfter ? 0 : Number.isFinite(seconds)
        ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - now());
      // Do not retry before a long provider cooldown or hold an API invocation
      // open for a minute. Let the caller surface the original response.
      if (suggested > 5000) return response;
      await wait(Math.max(Number.isFinite(suggested) ? suggested : 0,
        250 * 2 ** attempt + Math.floor(random() * 100)));
    }
  };
}

export const fetchPhoto = createPhotoFetch();
