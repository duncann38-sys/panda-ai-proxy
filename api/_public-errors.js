const ERROR_CODES = {
  400: 'invalid_request',
  404: 'not_found',
  429: 'rate_limited',
  503: 'service_unavailable',
  504: 'upstream_timeout',
};

const SAFE_MESSAGES = new Set([
  'Live station information could not be loaded right now.',
  'The nearby planner selection is refreshing. Please try again shortly.',
  'The luxury Banging selection is refreshing. Please try again shortly.',
  'Venue search could not complete right now. Please try again.',
  'Verified official menu and reservation links are unavailable.',
  'Google venue details could not be loaded right now.',
  'Walking directions are unavailable right now.',
  'The live journey check timed out. Please retry.',
  'Live transit information could not be loaded right now.',
  'Google venue photos are unavailable right now.',
]);
const STATUS_MESSAGES = {
  400: 'Invalid request.',
  404: 'Not found.',
  429: 'Request limit reached.',
  503: 'Service temporarily unavailable.',
  504: 'Request timed out.',
};

export function safePublicError(status, message) {
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 502;
  return {
    status: safeStatus,
    body: {
      error: SAFE_MESSAGES.has(message)
        ? message
        : STATUS_MESSAGES[safeStatus] || 'Upstream service unavailable.',
      code: ERROR_CODES[safeStatus] || 'upstream_unavailable',
    },
  };
}
