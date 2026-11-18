// Server-only sandbox transport. The default factory remains read-only.
// Credentials and OAuth tokens must never be returned to a Panda client.
export const OPENTABLE_SANDBOX = Object.freeze({
  oauth: 'https://oauth-pp.opentable.com',
  api: 'https://platform.otqa.com',
});

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SANDBOX_BOOKING_CAPABILITY = Symbol('sandbox-booking');
export { readJson as readOpenTableJson };
const ERROR_MESSAGES = Object.freeze({
  configuration_error: 'OpenTable sandbox configuration is invalid.',
  unauthorized: 'OpenTable sandbox authentication was rejected.',
  permission_denied: 'OpenTable has not permitted this sandbox request.',
  not_found: 'OpenTable could not find this sandbox resource.',
  rate_limited: 'OpenTable has temporarily limited sandbox requests.',
  provider_error: 'OpenTable sandbox could not complete this request.',
  invalid_response: 'OpenTable sandbox returned an invalid response.',
  response_too_large: 'OpenTable sandbox returned too much data.',
  timeout: 'OpenTable sandbox did not respond in time.',
  network_error: 'OpenTable sandbox could not be reached.',
  invalid_input: 'The OpenTable sandbox request parameters are invalid.',
});

export class OpenTableSandboxError extends Error {
  constructor(code, status = 502, { requestId, retryAfterSeconds } = {}) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.provider_error);
    this.name = 'OpenTableSandboxError';
    this.code = code;
    this.status = status;
    if (typeof requestId === 'string' && /^[\w-]{1,100}$/.test(requestId)) this.requestId = requestId;
    if (Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 0) {
      this.retryAfterSeconds = Math.min(retryAfterSeconds, 3600);
    }
  }
}

function integer(value, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new OpenTableSandboxError('invalid_input', 400);
  }
  return value;
}

function restaurantId(value) {
  // Partner codes, names, Google Place IDs and model guesses are not RIDs.
  if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) value = Number(value);
  return integer(value, 1);
}

function localStart(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(value)) {
    throw new OpenTableSandboxError('invalid_input', 400);
  }
  const day = value.slice(0, 10);
  const parsed = Date.parse(day);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day) {
    throw new OpenTableSandboxError('invalid_input', 400);
  }
  return value;
}

async function readJson(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new OpenTableSandboxError('response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new OpenTableSandboxError('invalid_response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OpenTableSandboxError('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object') throw new Error('Invalid JSON object');
    return data;
  } catch {
    throw new OpenTableSandboxError('invalid_response');
  }
}

export function createOpenTableSandboxClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 10_000,
  mutationCapability,
} = {}) {
  const clientId = env.OPENTABLE_CLIENT_ID;
  const clientSecret = env.OPENTABLE_CLIENT_SECRET;
  const normalized = (value) => typeof value === 'string' ? value.replace(/\/$/, '') : value;
  if (typeof clientId !== 'string' || !clientId.trim() || /[:\r\n]/.test(clientId)
    || typeof clientSecret !== 'string' || !clientSecret.trim() || /[\r\n]/.test(clientSecret)
    || (env.OPENTABLE_ENVIRONMENT && env.OPENTABLE_ENVIRONMENT !== 'sandbox')
    || (env.OPENTABLE_API_BASE_URL && normalized(env.OPENTABLE_API_BASE_URL) !== OPENTABLE_SANDBOX.api)
    || (env.OPENTABLE_OAUTH_BASE_URL && normalized(env.OPENTABLE_OAUTH_BASE_URL) !== OPENTABLE_SANDBOX.oauth)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000) {
    throw new OpenTableSandboxError('configuration_error', 503);
  }
  let cachedToken = null;
  let tokenFlight = null;
  const canBook = mutationCapability === SANDBOX_BOOKING_CAPABILITY;
  if (canBook && env.OPENTABLE_SANDBOX_BOOKING_ENABLED !== 'true') {
    throw new OpenTableSandboxError('configuration_error', 503);
  }

  async function fetchJson(url, authorization, { method = 'GET', payload, requestId } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { Accept: 'application/json', Authorization: authorization,
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...(requestId ? { 'X-Request-Id': requestId } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        const details = {
          requestId: response.headers.get('ot-requestid'),
          retryAfterSeconds: /^\d+$/.test(response.headers.get('retry-after') ?? '')
            ? Number(response.headers.get('retry-after')) : undefined,
        };
        await response.body?.cancel();
        const code = status === 401 ? 'unauthorized' : status === 403 ? 'permission_denied' : status === 404 ? 'not_found'
          : status === 429 ? 'rate_limited' : 'provider_error';
        // Never include provider response text, Authorization or credentials in errors.
        throw new OpenTableSandboxError(code, status, details);
      }
      if (response.status === 204 && method === 'DELETE') return { released: true };
      return await readJson(response);
    } catch (error) {
      if (error instanceof OpenTableSandboxError) throw error;
      throw new OpenTableSandboxError(controller.signal.aborted ? 'timeout' : 'network_error',
        controller.signal.aborted ? 504 : 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async function token() {
    if (cachedToken && cachedToken.expiresAt > now()) return cachedToken;
    if (tokenFlight) return tokenFlight;
    tokenFlight = (async () => {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const data = await fetchJson(`${OPENTABLE_SANDBOX.oauth}/api/v2/oauth/token?grant_type=client_credentials`,
        `Basic ${basic}`);
      const seconds = Number(data.expires_in);
      if (typeof data.access_token !== 'string' || !data.access_token || /[\r\n]/.test(data.access_token)
        || !Number.isFinite(seconds) || seconds <= 0) {
        throw new OpenTableSandboxError('invalid_response');
      }
      // Use the provider expiry, with skew and a one-hour local cache ceiling.
      const ttl = Math.min(seconds * 1000, 60 * 60 * 1000);
      cachedToken = {
        value: data.access_token,
        expiresAt: now() + ttl - Math.min(60_000, ttl / 10),
      };
      return cachedToken;
    })().finally(() => { tokenFlight = null; });
    return tokenFlight;
  }

  async function get(path, params) {
    // Only the fixed methods below can construct paths; there is no arbitrary URL method.
    const url = `${OPENTABLE_SANDBOX.api}${path}${params ? `?${params}` : ''}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const used = await token();
      try {
        return await fetchJson(url, `Bearer ${used.value}`);
      } catch (error) {
        // Only retry a read after one expired-token response. Never retry 403/429.
        if (error.code !== 'unauthorized' || attempt > 0) throw error;
        if (cachedToken === used) cachedToken = null;
      }
    }
  }

  function safeBookingRid(rid) {
    // Only the explicitly selected no-payment test restaurant can be mutated.
    // Advanced, payment-bearing and production restaurants remain unavailable.
    if (!canBook || restaurantId(rid) !== 264001) throw new OpenTableSandboxError('invalid_input', 400);
    return 264001;
  }
  async function mutate(method, path, payload, requestId) {
    if (!canBook || typeof requestId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      throw new OpenTableSandboxError('invalid_input', 400);
    }
    const used = await token();
    // Never automatically retry a mutation, including after timeouts or 401.
    return fetchJson(`${OPENTABLE_SANDBOX.api}${path}`, `Bearer ${used.value}`,
      { method, payload, requestId });
  }

  return Object.freeze({
    ...(canBook ? {
      lockSlot({ rid, startDateTime, partySize, requestId }) {
        rid = safeBookingRid(rid);
        return mutate('POST', `/v2/booking/${rid}/slot_locks`, {
          party_size: integer(partySize, 1, 20), date_time: localStart(startDateTime),
          reservation_attribute: 'default',
        }, requestId);
      },
      createReservation({ rid, reservationToken, guest, requestId }) {
        rid = safeBookingRid(rid);
        const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
        if (typeof reservationToken !== 'string' || !reservationToken || reservationToken.length > 8000
          || !name(guest?.firstName) || !name(guest?.lastName)
          || typeof guest?.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email)
          || guest.email.length > 254 || !/^\d{7,15}$/.test(guest?.phoneNumber ?? '')
          || !/^[A-Z]{2}$/.test(guest?.phoneCountry ?? '')) {
          throw new OpenTableSandboxError('invalid_input', 400);
        }
        return mutate('POST', `/v2/booking/${rid}/reservations`, {
          reservation_token: reservationToken,
          first_name: guest.firstName.trim(), last_name: guest.lastName.trim(),
          email_address: guest.email, phone: { number: guest.phoneNumber,
            country_code: guest.phoneCountry, phone_type: 'mobile' },
          reservation_attribute: 'default', restaurant_email_marketing_opt_in: false,
          special_request: 'Panda integration test — SANDBOX ONLY, not a real reservation.',
        }, requestId);
      },
      releaseSlot({ rid, reservationToken, requestId }) {
        rid = safeBookingRid(rid);
        if (typeof reservationToken !== 'string' || !reservationToken || reservationToken.length > 8000) {
          throw new OpenTableSandboxError('invalid_input', 400);
        }
        return mutate('DELETE', `/v2/booking/${rid}/slot_locks/${encodeURIComponent(reservationToken)}`,
          undefined, requestId);
      },
      cancelReservation({ rid, confirmationNumber, requestId }) {
        rid = safeBookingRid(rid);
        if (!/^[1-9]\d{0,19}$/.test(String(confirmationNumber))) {
          throw new OpenTableSandboxError('invalid_input', 400);
        }
        return mutate('PUT', `/v2/booking/${rid}/reservations/${rid}-${confirmationNumber}`,
          { status: 'CancelledWeb' }, requestId);
      },
    } : {}),
    async authenticate() {
      const entry = await token();
      return { authenticated: true, environment: 'sandbox', tokenCacheExpiresAt: entry.expiresAt };
    },
    async directory({ limit = 25, offset = 0, country, rid } = {}) {
      // This is a page-size bound, not a cap on a consumer venue feed.
      const params = new URLSearchParams({
        limit: String(integer(limit, 1, 100)), offset: String(integer(offset, 0)),
      });
      if (country !== undefined) {
        if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) {
          throw new OpenTableSandboxError('invalid_input', 400);
        }
        params.set('country', country);
      }
      if (rid !== undefined) params.set('rid', String(restaurantId(rid)));
      const data = await get('/sync/directory', params);
      if (!Array.isArray(data.items)) throw new OpenTableSandboxError('invalid_response');
      return data;
    },
    availabilityMetadata(rid) {
      return get(`/v2/availability-metadata/${restaurantId(rid)}`);
    },
    availability({ rid, startDateTime, partySize, forwardMinutes = 120, backwardMinutes = 0 } = {}) {
      const id = restaurantId(rid);
      const params = new URLSearchParams({
        start_date_time: localStart(startDateTime),
        party_size: String(integer(partySize, 1, 100)),
        forward_minutes: String(integer(forwardMinutes, 0, 720)),
        backward_minutes: String(integer(backwardMinutes, 0, 720)),
        include_credit_card_results: 'false',
        include_experiences: 'false',
      });
      return get(`/v2/availability/${id}`, params);
    },
  });
}

/** Separate, explicitly enabled server-only capability; never used by discovery. */
export function createOpenTableSandboxBookingClient(options = {}) {
  return createOpenTableSandboxClient({ ...options, mutationCapability: SANDBOX_BOOKING_CAPABILITY });
}
