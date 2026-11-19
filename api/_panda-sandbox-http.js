import {createHash} from 'node:crypto';
import {createOpenTableSandboxBookingClient} from './_opentable-sandbox.js';
import {createSandboxReservationService,createFirestoreReservationStore,ReservationError} from './_panda-reservations.js';

export const SANDBOX_POLICY_COLLECTION='panda_private_service_config_v1';
export const SANDBOX_POLICY_DOCUMENT='opentable_sandbox';
const isoDate = instant => new Date(instant).toISOString().slice(0,10);
const fingerprint = value => createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
export function isSandboxReservationRequest(req) {
  return req.method==='GET' && req.query?.sandboxReservations==='capabilities'
    || req.method==='POST' && typeof req.body?.sandboxReservationAction==='string';
}
/** Existing Firebase project and server-only policy; no client-supplied identity. */
export function createSandboxHttpHandler({getDb,verifyIdToken,env=process.env,now=Date.now,providerFactory=createOpenTableSandboxBookingClient,
  reservationStoreFactory=createFirestoreReservationStore}) {
  return async function handleSandbox(req,res) {
    res.setHeader('Cache-Control','private, no-store');
    const send=(status,result)=>res.status(status).json({pandaSandboxReservations:true,...result});
    try {
      const match=/^Bearer ([^\s]{20,12000})$/.exec(req.headers.authorization || '');
      if(!match)return send(401,{code:'sign_in_required'});
      const store=getDb();
      if(!store)return send(503,{code:'sandbox_not_ready'});
      let claims;
      try{claims=await verifyIdToken(match[1]);}catch{return send(401,{code:'sign_in_required'});}
      if(!claims?.uid || !claims.email || claims.email_verified!==true)return send(401,{code:'sign_in_required'});
      const action=req.method==='GET'?'capabilities':req.body.sandboxReservationAction;
      const user={uid:claims.uid,email:claims.email,emailVerified:true};
      const publicRecord=value=>{
        if(!value || typeof value!=='object')return value;
        const {manageUrl,providerManageUrl,ownerUid,emailClaimed,...safe}=value;
        return safe;
      };
      // Read saved owner-scoped records even when new sandbox bookings are paused.
      // No provider credentials, provider request or active tester policy is needed.
      if(action==='history'){
        const records=await reservationStoreFactory(store).listBookings(user.uid);
        return send(200,{result:records.filter(record=>record.ownerUid===user.uid
          && record.environment==='sandbox' && record.status==='confirmed').map(publicRecord)});
      }
      const snapshot=await store.collection(SANDBOX_POLICY_COLLECTION).doc(SANDBOX_POLICY_DOCUMENT).get();
      const policy=snapshot.exists?snapshot.data():null;
      if(!policy || policy.enabled!==true || Number(policy.expiresAt)<=now() || !Number.isFinite(Number(policy.expiresAt))) {
        return send(503,{code:'sandbox_not_ready'});
      }
      const permitted=Array.isArray(policy.allowedEmailHashes)
        && policy.allowedEmailHashes.includes(fingerprint(claims.email));
      if(!permitted)return send(403,{code:'sandbox_tester_required'});
      if(!env.OPENTABLE_CLIENT_ID || !env.OPENTABLE_CLIENT_SECRET)return send(503,{code:'sandbox_not_ready'});
      if(action==='capabilities'){
        return send(200,{result:{enabled:true,environment:'sandbox',venueName:'OpenTable Sandbox — 264001',rid:264001,
          minDate:isoDate(Math.floor(now()/86_400_000)*86_400_000+86_400_000),
          maxDate:isoDate(now()+7*86_400_000),cancellationAvailable:false,
          timeZone:policy.verifiedRestaurantTimeZone || null,floatingRestaurantLocalTimes:!policy.verifiedRestaurantTimeZone}});
      }
      if(!['availability','review','confirm','history'].includes(action))return send(400,{code:'invalid_sandbox_action'});
      const provider=providerFactory({env:{...env,OPENTABLE_SANDBOX_BOOKING_ENABLED:'true'}});
      const service=createSandboxReservationService({store:reservationStoreFactory(store),provider,
        timeZone:policy.verifiedRestaurantTimeZone || undefined,floatingSandboxTimes:!policy.verifiedRestaurantTimeZone,
        blockedSelections:Array.isArray(policy.blockedSelections)?policy.blockedSelections:[],now});
      const result=await service[action](user,req.body);
      // Private management links never leave the server in this sandbox UI.
      return send(200,{result:Array.isArray(result)?result.map(publicRecord):publicRecord(result)});
    }catch(error){
      if(error instanceof ReservationError)return send(error.status,{code:error.code});
      return send(503,{code:'sandbox_not_ready'});
    }
  };
}
