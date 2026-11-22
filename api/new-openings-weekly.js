import admin from 'firebase-admin';
import { applyGuard } from './_guard.js';
import { verifySeedJob } from './_seed-job-auth.js';
import { NEW_OPENINGS_CACHE_MS } from './_panda-new-openings.js';

const WEEK_MS = 7 * 86_400_000;
function storage() {
  if (!admin.apps.length) {
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
    if (typeof account.private_key === 'string') account.private_key = account.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(account) });
  }
  return admin.firestore();
}
function epoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && Number.isFinite(value._seconds)) return value._seconds * 1000;
  return 0;
}
function londonNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return { weekday: get('weekday'), year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}
function validSlug(value) { return typeof value === 'string' && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value); }
function verifiedOpening(venue, now) {
  if (!venue || venue.openingDesignation !== 'panda-verified-new' || !venue.id || !venue.name
    || !venue.openingSourceName || typeof venue.openingSourceUrl !== 'string'
    || !venue.openingSourceUrl.startsWith('https://') || typeof venue.openingDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(venue.openingDate)) return false;
  const date = Date.parse(venue.openingDate + 'T12:00:00Z');
  return Number.isFinite(date) && date <= now && now - date <= 60 * 86_400_000;
}
function isUnregistered(error) {
  return ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error?.code);
}
function dateKey(local) { return local.year + '-' + local.month + '-' + local.day; }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (applyGuard(req, res, { methods: ['POST', 'OPTIONS'], limit: true })) return;
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 'method_not_allowed' });
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '').trim();
  const auth = await verifySeedJob(token);
  if (!auth || !auth.scheduled || auth.manual) return res.status(401).json({ status: 'authorized_schedule_required' });
  const now = Date.now();
  const local = londonNow(new Date(now));
  if (local.weekday !== 'Friday' || local.hour !== '15') {
    return res.status(200).json({ status: 'outside_schedule_window' });
  }
  let store;
  try { store = storage(); }
  catch { return res.status(503).json({ status: 'storage_unavailable' }); }
  const runId = dateKey(local);
  const runRef = store.collection('new_openings_weekly_runs').doc(runId);
  let acquired = false;
  try {
    acquired = await store.runTransaction(async transaction => {
      const snapshot = await transaction.get(runRef);
      const data = snapshot.exists ? snapshot.data() || {} : {};
      if (data.status === 'complete' || epoch(data.leaseUntil) > now) return false;
      transaction.set(runRef, { status: 'running', startedAt: now, leaseUntil: now + 60 * 60_000 }, { merge: true });
      return true;
    });
  } catch { return res.status(503).json({ status: 'run_lock_unavailable' }); }
  if (!acquired) return res.status(200).json({ status: 'already_running_or_sent' });
  let deliveredUsers = 0, sentTokens = 0, invalidTokens = 0, skippedUsers = 0, cityCount = 0, sendFailures = 0;
  try {
    const users = await store.collection('users').where('newOpeningsPushEnabled', '==', true).get();
    const groups = new Map();
    for (const doc of users.docs) {
      const user = doc.data() || {};
      const lastSent = epoch(user.lastNewOpeningsPushAt);
      const citySlug = user.lastCitySlug;
      const tokens = [...new Set((Array.isArray(user.fcmTokens) ? user.fcmTokens : []).filter(value => typeof value === 'string' && value.length > 0 && value.length <= 4096))];
      if (lastSent && now - lastSent < WEEK_MS || !validSlug(citySlug) || !tokens.length) { skippedUsers++; continue; }
      const group = groups.get(citySlug) || [];
      group.push({ ref: doc.ref, uid: doc.id, tokens });
      groups.set(citySlug, group);
    }
    const date = new Date(now);
    for (const [citySlug, recipients] of groups) {
      const citySnap = await store.collection('new_openings_by_city').doc(citySlug).get();
      const pool = citySnap.exists ? citySnap.data() || {} : {};
      if (!pool.venues?.length || !epoch(pool.updatedAt) || now - epoch(pool.updatedAt) > NEW_OPENINGS_CACHE_MS) { skippedUsers += recipients.length; continue; }
      const venues = pool.venues.filter(venue => verifiedOpening(venue, now))
        .sort((a, b) => String(b.openingDate).localeCompare(String(a.openingDate))).slice(0, 15);
      if (!venues.length) { skippedUsers += recipients.length; continue; }
      const venueIds = venues.map(venue => venue.id);
      const city = String(pool.city || citySlug).slice(0, 100);
      const entries = recipients.flatMap(user => user.tokens.map(pushToken => ({ user, pushToken })));
      cityCount++;
      for (let start = 0; start < entries.length; start += 500) {
        const batch = entries.slice(start, start + 500);
        const message = {
          tokens: batch.map(entry => entry.pushToken),
          notification: { title: 'New openings in ' + city, body: venues.length + ' recently opened high-end places to explore. Tap to see them in Panda.' },
          data: { type: 'NEW_OPENINGS_WEEKLY', citySlug, limit: '15', deepLink: 'panda-mobile://ai' },
          android: { priority: 'high', notification: { channelId: 'default' } },
          apns: { payload: { aps: { sound: 'default' } } },
        };
        let result;
        try { result = await admin.messaging().sendEachForMulticast(message); }
        catch { sendFailures++; continue; }
        const delivered = new Map();
        const invalid = new Map();
        result.responses.forEach((response, index) => {
          const entry = batch[index];
          if (!entry) return;
          if (response.success) delivered.set(entry.user.uid, entry.user);
          else if (isUnregistered(response.error)) {
            const values = invalid.get(entry.user.uid) || { user: entry.user, tokens: [] };
            values.tokens.push(entry.pushToken); invalid.set(entry.user.uid, values); invalidTokens++;
          }
        });
        sentTokens += result.successCount || 0;
        await Promise.all([...new Set([...delivered.keys(), ...invalid.keys()])].map(async uid => {
          const recipient = delivered.get(uid) || invalid.get(uid)?.user;
          const rejected = invalid.get(uid)?.tokens || [];
          const update = {};
          if (delivered.has(uid)) update.lastNewOpeningsPushAt = admin.firestore.Timestamp.fromDate(new Date(now));
          if (rejected.length) update.fcmTokens = admin.firestore.FieldValue.arrayRemove(...rejected);
          try {
            if (Object.keys(update).length) await recipient.ref.set(update, { merge: true });
            if (delivered.has(uid)) {
              const noticeId = 'new-openings-' + runId;
              await recipient.ref.collection('notifications').doc(noticeId).set({
                type: 'NEW_OPENINGS_WEEKLY', title: 'New openings in ' + city,
                body: venues.length + ' recently opened high-end places to explore.',
                citySlug, venueIds, limit: 15, deepLink: 'panda-mobile://new-restaurants',
                createdAt: admin.firestore.Timestamp.fromDate(new Date(now)),
                seenInChat: false,
              }, { merge: true });
              deliveredUsers++;
            }
          } catch {}
        }));
      }
    }
    if (sendFailures > 0 && sentTokens === 0) {
      await runRef.set({ status: 'failed', leaseUntil: 0, sendFailures, failedAt: Date.now() }, { merge: true });
      return res.status(503).json({ status: 'weekly_send_unavailable' });
    }
    await runRef.set({ status: 'complete', completedAt: admin.firestore.Timestamp.fromDate(new Date(now)),
      deliveredUsers, sentTokens, invalidTokens, skippedUsers, cityCount, sendFailures }, { merge: true });
    return res.status(200).json({ status: 'complete', deliveredUsers, sentTokens, invalidTokens, skippedUsers, cityCount, sendFailures });
  } catch {
    try { await runRef.set({ status: 'failed', leaseUntil: 0, failedAt: Date.now() }, { merge: true }); } catch {}
    return res.status(503).json({ status: 'weekly_send_unavailable' });
  }
}
