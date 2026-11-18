import { createHash, randomUUID } from 'node:crypto';

export class ReservationError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ReservationError(code, status); };
const digest = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const email = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
const confirmationNumber = value => /^[1-9]\d{0,19}$/.test(String(value ?? '')) ? String(value) : null;

export function bookingManageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname.length > 1
      && ['www.opentable.com','www.opentable.co.uk'].includes(url.hostname)
      ? url.href : null;
  } catch { return null; }
}

/** Reject nonexistent/ambiguous local DST times rather than silently changing them. */
export function localBookingInstant(value, timeZone = 'Europe/London') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(value)) {
    return fail('invalid_booking_time');
  }
  const base = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0,16) !== value) return fail('invalid_booking_time');
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',
    day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}); }
  catch { return fail('invalid_booking_timezone'); }
  const candidates = [];
  // Enumerate modern IANA offsets, including quarter-hour zones.
  for (let offset = -12 * 60; offset <= 14 * 60; offset += 15) {
    const instant = base - offset * 60_000;
    const parts = formatter.formatToParts(new Date(instant));
    const part = type => parts.find(item=>item.type===type)?.value;
    if (`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}` === value) {
      candidates.push(instant);
    }
  }
  if (candidates.length !== 1) return fail(candidates.length ? 'ambiguous_booking_time' : 'invalid_booking_time');
  return candidates[0];
}

function identity(user) {
  if (!id(user?.uid) || !email(user.email) || user.emailVerified !== true) return fail('sign_in_required',401);
  return user;
}
function selection(input, now, timeZone, floatingSandboxTimes = false, blockedSelections = []) {
  // No production RID, paid experience or card-hold flow can reach this service.
  if (Number(input?.rid) !== 264001 || !Number.isInteger(input.partySize)
    || input.partySize < 1 || input.partySize > 20) return fail('invalid_sandbox_selection');
  if (blockedSelections.includes(`264001|${input.startDateTime}|${input.partySize}`)) {
    return fail('slot_no_longer_available',409);
  }
  if ((!timeZone || typeof timeZone !== 'string') && !floatingSandboxTimes) return fail('restaurant_timezone_not_verified',503);
  const orderingTime = localBookingInstant(input.startDateTime,timeZone || 'Etc/UTC');
  // With no verified zone, the earliest possible UTC instant is local minus
  // fourteen hours. This permits tomorrow evening without guessing London.
  // This ordering value is NOT presented as a verified UTC reservation instant.
  const minimum = timeZone ? now : now + 14 * 3_600_000;
  if (orderingTime <= minimum || orderingTime > now + 90 * 86_400_000) return fail('invalid_booking_time');
  return {rid:264001,partySize:input.partySize,startDateTime:input.startDateTime,
    timeZone:timeZone || null,scheduledAt:timeZone ? orderingTime : null,localTimeOrder:input.startDateTime,
    floatingRestaurantLocalTimes:!timeZone,venueName:'OpenTable Sandbox — 264001'};
}
function guestDetails(guest, user) {
  if (!name(guest?.firstName) || !name(guest?.lastName) || !email(guest?.email)
    || guest.email.toLowerCase() !== user.email.toLowerCase()
    || !/^\d{7,15}$/.test(guest?.phoneNumber ?? '') || !/^[A-Z]{2}$/.test(guest?.phoneCountry ?? '')) {
    return fail('invalid_guest_details');
  }
  return {firstName:guest.firstName.trim(),lastName:guest.lastName.trim(),
    email:user.email,phoneNumber:guest.phoneNumber,phoneCountry:guest.phoneCountry};
}
export function verifiedSandboxConfirmation(response, requested) {
  const number = confirmationNumber(response?.confirmation_number);
  const manageUrl = bookingManageUrl(response?.manage_reservation_url);
  const action = response?.post_booking_required_action;
  return number && manageUrl && response.party_size === requested.partySize
    && response.date_time?.slice(0,16) === requested.startDateTime
    && !response.payment && (action === undefined || action === null || action === '' || action === 'None')
    ? {confirmationNumber:number,manageUrl} : null;
}

/** Store is a protected, transactional DAO. Model output never authorises a write. */
export function createSandboxReservationService({store,provider,sendConfirmation,timeZone,floatingSandboxTimes=false,blockedSelections=[],now=Date.now}) {
  async function availability(user, input) {
    identity(user);
    const chosen = selection(input,now(),timeZone,floatingSandboxTimes);
    const result = await provider.availability({rid:264001,partySize:chosen.partySize,
      startDateTime:chosen.startDateTime,forwardMinutes:120,backwardMinutes:120});
    if (result.rid !== 264001 || result.party_size !== chosen.partySize || !Array.isArray(result.times)) {
      return fail('availability_unverified',502);
    }
    const times = [...new Set(result.times.filter(time =>
      typeof time === 'string' && time.slice(0,10) === chosen.startDateTime.slice(0,10)
      && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(time)
      && !blockedSelections.includes(`264001|${time}|${chosen.partySize}`)))].sort();
    return {environment:'sandbox',rid:264001,times,partySize:chosen.partySize,
      timeZone:chosen.timeZone,checkedAt:now(),expiresAt:now()+30_000};
  }
  async function review(user,input) {
    identity(user);
    const chosen = selection(input,now(),timeZone,floatingSandboxTimes,blockedSelections);
    const guest = guestDetails(input.guest,user);
    const available = await availability(user,input);
    if (!available.times.includes(chosen.startDateTime)) return fail('slot_no_longer_available',409);
    const reviewId=randomUUID();
    const record={...chosen,guest,ownerUid:user.uid,reviewId,expiresAt:now()+300_000,environment:'sandbox'};
    await store.saveReview(user.uid,reviewId,record);
    return {reviewId,...chosen,guest,environment:'sandbox',expiresAt:record.expiresAt,confirmationRequired:true};
  }
  async function confirm(user,input) {
    identity(user);
    if (input?.confirmed !== true || !id(input.reviewId)) return fail('explicit_confirmation_required');
    const review = await store.getReview(user.uid,input.reviewId);
    if (!review || review.ownerUid !== user.uid) return fail('review_not_found',404);
    if (review.expiresAt <= now()) return fail('review_expired',409);
    const chosen=selection(review,now(),timeZone,floatingSandboxTimes,blockedSelections);
    guestDetails(review.guest,user);
    const key=digest(`${user.uid}|sandbox|264001|${chosen.startDateTime}|${chosen.partySize}`);
    const attempt={id:key,ownerUid:user.uid,environment:'sandbox',status:'locking',
      ...chosen,createdAt:now(),lockRequestId:randomUUID(),bookingRequestId:randomUUID()};
    const claimed=await store.claimAttempt(user.uid,key,attempt);
    if (!claimed.created) {
      if (claimed.record?.status==='confirmed') {
        return store.getBooking(user.uid,key);
      }
      return fail('booking_already_submitted_do_not_retry',409);
    }
    let phase='locking';
    try {
      const locked=await provider.lockSlot({...chosen,requestId:attempt.lockRequestId});
      if (typeof locked.reservation_token !== 'string' || !locked.reservation_token
        || !Number.isFinite(Date.parse(locked.expires_at)) || Date.parse(locked.expires_at)<=now()+5000
        || locked.payment_method) return fail('slot_lock_unverified',409);
      phase='submitting';
      await store.updateAttempt(user.uid,key,{status:phase});
      const response=await provider.createReservation({rid:264001,reservationToken:locked.reservation_token,
        guest:review.guest,requestId:attempt.bookingRequestId});
      // Save reconciliation identifiers BEFORE validating all confirmation fields.
      await store.updateAttempt(user.uid,key,{status:'response_received',
        providerConfirmation:confirmationNumber(response?.confirmation_number),
        providerManageUrl:bookingManageUrl(response?.manage_reservation_url)});
      const verified=verifiedSandboxConfirmation(response,chosen);
      if (!verified) {
        phase='needs_review';
        return fail('provider_details_require_review_do_not_retry',409);
      }
      const booking={id:key,ownerUid:user.uid,environment:'sandbox',status:'confirmed',...chosen,
        ...verified,createdAt:now(),emailStatus:'not_requested'};
      // Persist first; a mail outage must never trigger another reservation.
      await store.saveBooking(user.uid,key,booking);
      phase='confirmed';
      await store.updateAttempt(user.uid,key,{status:'confirmed'});
      if (sendConfirmation) {
        // At most once: claim before sending, never silently retry an uncertain email.
        const mailClaimed=await store.claimEmail(user.uid,key);
        if (mailClaimed) {
          try {
            await sendConfirmation({booking,email:user.email,idempotencyKey:`sandbox-${key}`});
            booking.emailStatus='sent';
          } catch { booking.emailStatus='unknown_do_not_resend'; }
          await store.updateBooking(user.uid,key,{emailStatus:booking.emailStatus});
        }
      }
      return booking;
    } catch (error) {
      if (phase !== 'confirmed') {
        await store.updateAttempt(user.uid,key,{
          status:phase==='submitting'?'unknown_do_not_retry':phase==='needs_review'?'needs_review':'stopped',
        }).catch(()=>{});
      }
      if (error instanceof ReservationError) throw error;
      return fail('booking_status_requires_verification_do_not_retry',503);
    }
  }
  return {availability,review,confirm,
    async history(user) { identity(user);return store.listBookings(user.uid); }};
}

export function createFirestoreReservationStore(firestore) {
  const owner = uid => firestore.collection('panda_consumer_reservations_v1').doc(digest(uid));
  const ref = (uid,collection,key) => owner(uid).collection(collection).doc(key);
  const read = async reference => {const snap=await reference.get();return snap.exists?snap.data():null;};
  return {
    saveReview:(uid,key,data)=>ref(uid,'sandbox_reviews',key).set(data),
    getReview:(uid,key)=>read(ref(uid,'sandbox_reviews',key)),
    claimAttempt:(uid,key,data)=>firestore.runTransaction(async transaction=>{
      const reference=ref(uid,'sandbox_attempts',key),snapshot=await transaction.get(reference);
      if(snapshot.exists)return {created:false,record:snapshot.data()};
      transaction.create(reference,data);return {created:true,record:data};
    }),
    updateAttempt:(uid,key,data)=>ref(uid,'sandbox_attempts',key).set(data,{merge:true}),
    saveBooking:(uid,key,data)=>ref(uid,'sandbox_bookings',key).set(data),
    getBooking:(uid,key)=>read(ref(uid,'sandbox_bookings',key)),
    updateBooking:(uid,key,data)=>ref(uid,'sandbox_bookings',key).update(data),
    claimEmail:(uid,key)=>firestore.runTransaction(async transaction=>{
      const reference=ref(uid,'sandbox_bookings',key),snapshot=await transaction.get(reference);
      if(!snapshot.exists||snapshot.data().emailClaimed)return false;
      transaction.update(reference,{emailClaimed:true,emailStatus:'sending'});return true;
    }),
    listBookings:async uid=>{
      const snapshot=await owner(uid).collection('sandbox_bookings').orderBy('localTimeOrder','desc').limit(100).get();
      return snapshot.docs.map(doc=>doc.data()).filter(record=>record.ownerUid===uid);
    },
  };
}
