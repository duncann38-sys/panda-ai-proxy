import admin from 'firebase-admin';
import { applyGuard } from './_guard.js';

const TOKEN_LIMIT = 4096;
const TEST_COOLDOWN_MS = 60_000;

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

function validToken(value) {
  return typeof value === 'string' && value.trim().length > 0
    && value.length <= TOKEN_LIMIT && !/\s/.test(value);
}

function validDocumentId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 150
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function safeName(value) {
  if (typeof value !== 'string') return 'A Panda friend';
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return clean || 'A Panda friend';
}

function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && Number.isFinite(value._seconds)) return value._seconds * 1000;
  return 0;
}

export function validateMessageTest(user, token, now = Date.now()) {
  if (!validToken(token)) return { status: 'invalid_device_token' };
  if (!user || user.messageNotificationsEnabled !== true) {
    return { status: 'notifications_not_enabled' };
  }
  const registered = Array.isArray(user.fcmTokens) ? user.fcmTokens : [];
  if (!registered.includes(token)) return { status: 'device_not_registered' };
  const lastTest = toMillis(user.lastPandaMessageTestAt);
  if (lastTest && now - lastTest < TEST_COOLDOWN_MS) {
    return {
      status: 'test_cooldown',
      retryAfterSeconds: Math.max(1, Math.ceil((TEST_COOLDOWN_MS - (now - lastTest)) / 1000)),
    };
  }
  return { status: 'ready' };
}

export function buildMessageTest(token) {
  return {
    token,
    notification: {
      title: 'Panda message alerts',
      body: 'Sound and vibration are working on this device.',
    },
    data: { type: 'PANDA_MESSAGE_TEST' },
    android: {
      priority: 'high',
      notification: { channelId: 'panda-messages', sound: 'default' },
    },
    apns: { payload: { aps: { sound: 'default' } } },
  };
}

export function buildMessageNotification(token, senderName, threadId, messageId) {
  return {
    token,
    notification: {
      title: safeName(senderName) + ' sent you a message',
      body: 'Open Panda Me to reply.',
    },
    data: { type: 'PANDA_MESSAGE', threadId, messageId },
    android: {
      priority: 'high',
      notification: { channelId: 'panda-messages', sound: 'default' },
    },
    apns: { payload: { aps: { sound: 'default' } } },
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (applyGuard(req, res, { methods: ['GET', 'POST', 'OPTIONS'], limit: true })) return;
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: 'method_not_allowed' });
  }

  let store;
  try {
    store = storage();
  } catch {
    return res.status(503).json({ status: 'storage_unavailable' });
  }

  const idToken = bearer(req);
  if (!idToken) return res.status(401).json({ status: 'authentication_required' });
  let identity;
  try {
    identity = await admin.auth().verifyIdToken(idToken, true);
  } catch {
    return res.status(401).json({ status: 'authentication_required' });
  }
  if (!identity?.uid || identity.uid.length > 180) {
    return res.status(401).json({ status: 'authentication_required' });
  }

  const userRef = store.collection('users').doc(identity.uid);
  if (req.method === 'GET') {
    try {
      const snapshot = await userRef.get();
      return res.status(200).json({
        enabled: snapshot.exists && snapshot.data()?.messageNotificationsEnabled === true,
      });
    } catch {
      return res.status(503).json({ status: 'storage_unavailable' });
    }
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.action === 'register') {
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ status: 'invalid_preference' });
    }
    const token = typeof body.fcmToken === 'string' ? body.fcmToken.trim() : '';
    if (body.enabled && !validToken(token)) {
      return res.status(400).json({ status: 'fcm_token_required' });
    }
    try {
      await userRef.set({
        messageNotificationsEnabled: body.enabled,
        messageNotificationsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(body.enabled ? { fcmTokens: admin.firestore.FieldValue.arrayUnion(token) } : {}),
      }, { merge: true });
      return res.status(200).json({ status: 'saved', enabled: body.enabled });
    } catch {
      return res.status(503).json({ status: 'storage_unavailable' });
    }
  }

  if (body.action === 'send-test') {
    const token = typeof body.fcmToken === 'string' ? body.fcmToken.trim() : '';
    if (!validToken(token)) return res.status(400).json({ status: 'invalid_device_token' });
    const now = Date.now();
    let decision;
    try {
      decision = await store.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(userRef);
        const user = snapshot.exists ? snapshot.data() || {} : {};
        const result = validateMessageTest(user, token, now);
        if (result.status === 'ready') {
          transaction.set(userRef, {
            lastPandaMessageTestAt: admin.firestore.Timestamp.fromDate(new Date(now)),
          }, { merge: true });
        }
        return result;
      });
    } catch {
      return res.status(503).json({ status: 'notification_storage_unavailable' });
    }
    if (decision.status === 'notifications_not_enabled') return res.status(409).json(decision);
    if (decision.status === 'device_not_registered') return res.status(403).json(decision);
    if (decision.status === 'test_cooldown') {
      return res.status(429).json(decision);
    }
    if (decision.status !== 'ready') return res.status(400).json(decision);
    try {
      await admin.messaging().send(buildMessageTest(token));
      return res.status(200).json({ status: 'test_sent', target: 'signed_in_device' });
    } catch (error) {
      if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error?.code)) {
        await userRef.set({ fcmTokens: admin.firestore.FieldValue.arrayRemove(token) }, { merge: true }).catch(() => {});
      }
      await userRef.set({
        lastPandaMessageTestAt: admin.firestore.FieldValue.delete(),
      }, { merge: true }).catch(() => {});
      return res.status(503).json({ status: 'test_notification_unavailable' });
    }
  }

  if (body.action === 'send') {
    const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
    const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
    if (!validDocumentId(threadId) || !validDocumentId(messageId)) {
      return res.status(400).json({ status: 'invalid_message_reference' });
    }
    const threadRef = store.collection('threads').doc(threadId);
    let thread;
    let message;
    try {
      const [threadSnapshot, messageSnapshot] = await Promise.all([
        threadRef.get(),
        threadRef.collection('messages').doc(messageId).get(),
      ]);
      if (!threadSnapshot.exists || !messageSnapshot.exists) {
        return res.status(404).json({ status: 'message_not_found' });
      }
      thread = threadSnapshot.data() || {};
      message = messageSnapshot.data() || {};
    } catch {
      return res.status(503).json({ status: 'message_lookup_unavailable' });
    }

    const participants = Array.isArray(thread.participantUids)
      ? thread.participantUids.filter((uid) => typeof uid === 'string')
      : [];
    if (!participants.includes(identity.uid) || message.senderUid !== identity.uid) {
      return res.status(403).json({ status: 'message_sender_not_authorized' });
    }
    const recipientIds = [...new Set(participants.filter((uid) => uid !== identity.uid))].slice(0, 30);
    if (!recipientIds.length) return res.status(200).json({ status: 'no_recipients', sent: 0 });

    try {
      const snapshots = await Promise.all(recipientIds.map((uid) => store.collection('users').doc(uid).get()));
      const byToken = new Map();
      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists) return;
        const user = snapshot.data() || {};
        if (user.messageNotificationsEnabled !== true) return;
        const tokens = Array.isArray(user.fcmTokens) ? user.fcmTokens : [];
        for (const token of tokens) {
          if (!validToken(token)) continue;
          const owners = byToken.get(token) || [];
          owners.push(snapshot.ref);
          byToken.set(token, owners);
        }
      });
      const tokens = [...byToken.keys()].slice(0, 500);
      if (!tokens.length) return res.status(200).json({ status: 'no_enabled_recipients', sent: 0 });

      const claimRef = threadRef.collection('message_push_claims').doc(messageId);
      const claimed = await store.runTransaction(async (transaction) => {
        const claim = await transaction.get(claimRef);
        if (claim.exists) return false;
        transaction.set(claimRef, {
          senderUid: identity.uid,
          claimedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return true;
      });
      if (!claimed) return res.status(200).json({ status: 'already_sent', sent: 0 });

      const senderProfile = Array.isArray(thread.participantProfiles)
        ? thread.participantProfiles.find((person) => person?.uid === identity.uid)
        : null;
      const senderName = safeName(senderProfile?.name);
      let sent = 0;
      try {
        for (let offset = 0; offset < tokens.length; offset += 500) {
          const chunk = tokens.slice(offset, offset + 500);
          const result = await admin.messaging().sendEachForMulticast({
            tokens: chunk,
            notification: {
              title: senderName + ' sent you a message',
              body: 'Open Panda Me to reply.',
            },
            data: { type: 'PANDA_MESSAGE', threadId, messageId },
            android: {
              priority: 'high',
              notification: { channelId: 'panda-messages', sound: 'default' },
            },
            apns: { payload: { aps: { sound: 'default' } } },
          });
          sent += result.successCount;
          const removals = [];
          result.responses.forEach((response, index) => {
            if (response.success || ![
              'messaging/registration-token-not-registered',
              'messaging/invalid-registration-token',
            ].includes(response.error?.code)) return;
            for (const ownerRef of byToken.get(chunk[index]) || []) {
              removals.push(ownerRef.set({
                fcmTokens: admin.firestore.FieldValue.arrayRemove(chunk[index]),
              }, { merge: true }));
            }
          });
          await Promise.all(removals);
        }
        await claimRef.set({
          senderUid: identity.uid,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          sent,
        }, { merge: true });
      } catch {
        await claimRef.delete().catch(() => {});
        return res.status(503).json({ status: 'message_notification_unavailable' });
      }
      return res.status(200).json({ status: sent ? 'sent' : 'no_deliveries', sent });
    } catch {
      return res.status(503).json({ status: 'notification_storage_unavailable' });
    }
  }

  return res.status(400).json({ status: 'invalid_action' });
}
