// Keep credential diagnostics to fixed field names, never secret values.
function failure(code) {
  return Object.assign(new Error(code), { code });
}

export function parseServiceAccount(raw) {
  if (!raw?.trim()) throw failure('FIREBASE_SERVICE_ACCOUNT_missing');
  let account;
  try {
    account = JSON.parse(raw.trim().replace(/^\uFEFF/, ''));
    if (typeof account === 'string') account = JSON.parse(account);
    if (account && typeof account === 'object' && account.FIREBASE_SERVICE_ACCOUNT) {
      account = account.FIREBASE_SERVICE_ACCOUNT;
      if (typeof account === 'string') account = JSON.parse(account);
    }
  } catch {
    throw failure('FIREBASE_SERVICE_ACCOUNT_invalid_JSON');
  }
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    throw failure('FIREBASE_SERVICE_ACCOUNT_invalid_object');
  }
  const normalized = {
    project_id: account.project_id ?? account.projectId,
    client_email: account.client_email ?? account.clientEmail,
    private_key: account.private_key ?? account.privateKey,
  };
  const missing = Object.keys(normalized).filter(key =>
    typeof normalized[key] !== 'string' || !normalized[key].trim());
  if (missing.length) {
    if ((account.apiKey || account.authDomain) && missing.includes('private_key')) {
      throw failure('FIREBASE_SERVICE_ACCOUNT_contains_web_app_config_not_Admin_JSON');
    }
    throw failure(`FIREBASE_SERVICE_ACCOUNT_missing_fields_${missing.join('_and_')}`);
  }
  return { ...account, ...normalized, private_key: normalized.private_key.replace(/\\n/g, '\n') };
}
