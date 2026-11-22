import admin from 'firebase-admin';
import { applyGuard } from './_guard.js';
import { NEW_OPENINGS_CACHE_MS } from './_panda-new-openings.js';

function storage() {
  if (!admin.apps.length) {
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
    if (typeof account.private_key === 'string') account.private_key = account.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(account) });
  }
  return admin.firestore();
}
function bearer(req) {
  const value = String(req.headers.authorization || '');
  if (!value.startsWith('Bearer ')) return '';
  const token = value.slice(7).trim();
  return token.length <= 16_000 ? token : '';
}
function validSlug(value) {
  return typeof value === 'string' && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && Number.isFinite(value._seconds)) return value._seconds * 1000;
  return 0;
}
export const NEW_OPENINGS_TEST_COOLDOWN_MS = 60_000;

export function validateSingleDeviceTest(user, token, now = Date.now()) {
  if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /\s/.test(token)) {
    return { status: 'invalid_device_token' };
  }
  if (!user || user.newOpeningsPushEnabled !== true) return { status: 'notifications_not_enabled' };
  const registeredTokens = Array.isArray(user.fcmTokens) ? user.fcmTokens : [];
  if (!registeredTokens.includes(token)) return { status: 'device_not_registered' };
  const lastTest = toMillis(user.lastNewOpeningsTestAt);
  if (lastTest && now - lastTest < NEW_OPENINGS_TEST_COOLDOWN_MS) {
    return { status: 'test_cooldown', retryAfterSeconds: Math.max(1, Math.ceil((NEW_OPENINGS_TEST_COOLDOWN_MS - (now - lastTest)) / 1000)) };
  }
  return { status: 'ready' };
}

export function buildSingleDeviceTestMessage(token) {
  return {
    token,
    notification: { title: 'Panda test: new openings', body: 'Your new-openings alert is working. Tap to browse current openings.' },
    data: { type: 'NEW_OPENINGS_WEEKLY_TEST', deepLink: 'panda-mobile://new-restaurants' },
    android: { priority: 'high', notification: { channelId: 'default' } },
    apns: { payload: { aps: { sound: 'default' } } },
  };
}

function verifiedVenue(venue, now) {
  if (!venue || venue.openingDesignation !== 'panda-verified-new' || typeof venue.id !== 'string'
    || typeof venue.openingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(venue.openingDate)
    || !venue.openingSourceUrl || !venue.openingSourceName) return false;
  const opened = Date.parse(venue.openingDate + 'T12:00:00Z');
  return Number.isFinite(opened) && opened <= now && now - opened <= 60 * 86_400_000;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (applyGuard(req, res, { methods: ['GET', 'POST', 'OPTIONS'], limit: true })) return;
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ status: 'method_not_allowed' });
  let store;
  try { store = storage(); }
  catch { return res.status(503).json({ status: 'storage_unavailable' }); }
  const idToken = bearer(req);
  if (!idToken) return res.status(401).json({ status: 'authentication_required' });
  let identity;
  try { identity = await admin.auth().verifyIdToken(idToken, true); }
  catch { return res.status(401).json({ status: 'authentication_required' }); }
  if (!identity?.uid || identity.uid.length > 180) return res.status(401).json({ status: 'authentication_required' });
  const userRef = store.collection('users').doc(identity.uid);
  if (req.method === 'GET') {
    try {
      const snapshot = await userRef.get();
      const data = snapshot.exists ? snapshot.data() || {} : {};
      return res.status(200).json({ enabled: data.newOpeningsPushEnabled === true, citySlug: validSlug(data.lastCitySlug) ? data.lastCitySlug : null });
    } catch { return res.status(503).json({ status: 'storage_unavailable' }); }
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.action === 'send-test') {
    const token = typeof body.fcmToken === 'string' ? body.fcmToken.trim() : '';
    if (!token || token.length > 4096 || /\s/.test(token)) return res.status(400).json({ status: 'invalid_device_token' });
    const now = Date.now();
    let decision;
    try {
      decision = await store.runTransaction(async transaction => {
        const snapshot = await transaction.get(userRef);
        const user = snapshot.exists ? snapshot.data() || {} : {};
        const result = validateSingleDeviceTest(user, token, now);
        if (result.status !== 'ready') return result;
        transaction.set(userRef, { lastNewOpeningsTestAt: admin.firestore.Timestamp.fromDate(new Date(now)) }, { merge: true });
        return result;
      });
    } catch { return res.status(503).json({ status: 'notification_storage_unavailable' }); }
    if (decision.status === 'notifications_not_enabled') return res.status(409).json({ status: decision.status });
    if (decision.status === 'device_not_registered') return res.status(403).json({ status: decision.status });
    if (decision.status === 'test_cooldown') return res.status(429).json({ status: decision.status, retryAfterSeconds: decision.retryAfterSeconds });
    if (decision.status !== 'ready') return res.status(400).json({ status: decision.status });
    try {
      await admin.messaging().send(buildSingleDeviceTestMessage(token));
      return res.status(200).json({ status: 'test_sent', target: 'signed_in_device' });
    } catch (error) {
      if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error?.code)) {
        await userRef.set({ fcmTokens: admin.firestore.FieldValue.arrayRemove(token) }, { merge: true }).catch(() => {});
      }
      await userRef.set({ lastNewOpeningsTestAt: admin.firestore.FieldValue.delete() }, { merge: true }).catch(() => {});
      return res.status(503).json({ status: 'test_notification_unavailable' });
    }
  }
  if (body.action === 'consume-chat-alerts') {
    try {
      const userSnapshot = await userRef.get();
      if (userSnapshot.data()?.newOpeningsPushEnabled !== true) return res.status(200).json({ status: 'ready', venues: [], text: '' });
      const unread = await userRef.collection('notifications').where('seenInChat', '==', false).limit(30).get();
      const alerts = unread.docs.filter(doc => doc.data()?.type === 'NEW_OPENINGS_WEEKLY').slice(0, 5);
      const venues = [];
      const seen = new Set();
      const consumed = [];
      for (const alertDoc of alerts) {
        const alert = alertDoc.data() || {};
        if (!validSlug(alert.citySlug)) { consumed.push(alertDoc.ref); continue; }
        const poolSnap = await store.collection('new_openings_by_city').doc(alert.citySlug).get();
        const pool = poolSnap.exists ? poolSnap.data() || {} : {};
        const updatedAt = toMillis(pool.updatedAt);
        if (!updatedAt || Date.now() - updatedAt > NEW_OPENINGS_CACHE_MS) { consumed.push(alertDoc.ref); continue; }
        const selectedIds = new Set(Array.isArray(alert.venueIds) ? alert.venueIds.filter(id => typeof id === 'string').slice(0, 15) : []);
        for (const venue of Array.isArray(pool.venues) ? pool.venues : []) {
          if (!selectedIds.has(venue?.id) || seen.has(venue.id) || !verifiedVenue(venue, Date.now())) continue;
          seen.add(venue.id);
          venues.push({ ...venue, city: pool.city, country: pool.country, citySlug: alert.citySlug });
          if (venues.length >= 15) break;
        }
        consumed.push(alertDoc.ref);
        if (venues.length >= 15) break;
      }
      await Promise.all(consumed.map(ref => ref.set({ seenInChat: true, seenInChatAt: Date.now() }, { merge: true })));
      return res.status(200).json({ status: 'ready', newOpeningsSearch: true, venues, text: venues.length
        ? 'A few new high-end openings are worth a look ✨ Here are the latest verified picks for your city.' : '',
      });
    } catch { return res.status(503).json({ status: 'notification_storage_unavailable', venues: [] }); }
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return res.status(400).json({ status: 'invalid_preference' });
  const updates = { newOpeningsPreferenceUpdatedAt: Date.now() };
  if (body.enabled === true) {
    const token = typeof body.fcmToken === 'string' ? body.fcmToken.trim() : '';
    if (!token || token.length > 4096 || /\s/.test(token)) return res.status(400).json({ status: 'fcm_token_required' });
    updates.newOpeningsPushEnabled = true;
    updates.fcmTokens = admin.firestore.FieldValue.arrayUnion(token);
  } else if (body.enabled === false) {
    updates.newOpeningsPushEnabled = false;
  }
  if (body.citySlug !== undefined) {
    if (!validSlug(body.citySlug)) return res.status(400).json({ status: 'invalid_city' });
    updates.lastCitySlug = body.citySlug;
  }
  if (Object.keys(updates).length === 1) return res.status(400).json({ status: 'no_change' });
  try {
    await userRef.set(updates, { merge: true });
    return res.status(200).json({ status: 'saved', enabled: body.enabled === undefined ? undefined : body.enabled,
      citySlug: body.citySlug || undefined });
  } catch { return res.status(503).json({ status: 'storage_unavailable' }); }
}
