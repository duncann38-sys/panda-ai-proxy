// One operator-approved temporary boost, not a permanent increase. Expiry is
// the next Google daily reset (08:00 London on 17 October 2026).
export const TEMPORARY_INDEX_BOOST_END = Date.parse('2026-10-17T07:00:00Z');
const BOOST_START = Date.parse('2026-10-16T19:00:00Z');
export function discoveryDailyLimit(env = process.env, now = Date.now()) {
  const explicit = Number.parseInt(env.PANDA_DAILY_PLACES_LIMIT || '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return now >= BOOST_START && now < TEMPORARY_INDEX_BOOST_END ? 2000 : 1000;
}
