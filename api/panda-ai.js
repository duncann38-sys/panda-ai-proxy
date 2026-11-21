// Panda AI proxy — Vercel serverless function.
// - venuesOnly mode: direct Google Places search for the Discover feed (no Gemini).
// - chat mode: Gemini decides (via function calling) WHEN to search venues.
// CACHING: every Google Places lookup goes through searchVenues(), cached ~10 min.
// HARDENED: origin allow-list + rate limiting via ./_guard.js.
// UPGRADE: find_places accepts optional `area` (e.g. "Mayfair"), geocoded so the
//   search centres on that place, not the user's GPS.
import { GoogleAuth } from 'google-auth-library';
import { venueCardReply } from './_panda-card-reply.js';
import { quickVenueShortcut, matchesQuickVenueShortcut, compareQuickVenueRatings } from './_panda-shortcuts.js';
import admin from 'firebase-admin';
import { createSandboxHttpHandler, isSandboxReservationRequest } from './_panda-sandbox-http.js';
import { applyGuard } from './_guard.js';
import { answerOutingRequest } from './_panda-outing-intent.js';
import { officialProgrammes } from './_panda-programmes.js';
import { quickChatReply, shouldUseConversationalModel, wantsOpenNow, ambiguousClub, buildChatInstruction, safeProviderFailure, redactedProviderMessage, safeDegradedText, isDirectVenueRequest, isWeatherQuestion, extractWeatherArea, isEventSearchQuestion, isPriceLookupQuestion, isFeelGoodNewsQuestion, reserveEventGroundingBudget, settleEventGroundingBudget, sessionVenueQuery, filterSessionVenues, maySearchVenues, isSessionVenueTransitFollowUp } from './_panda-chat-policy.js';
import { loadSharedVenueDirectory, VenueDirectoryError } from './_venue-directory.js';
import { createDiscoveryService } from './_discovery-lite.js';
import { indexPlaceIdentities, nearbyPlaceIdentities, nearbySeededPlacePage, MAX_INDEXED_FEED_PAGE_SIZE } from './_london-index.js';
import { buildIndexedFeedPage, buildIndexedIdCandidatePage } from './_indexed-feed-page.js';
import { currentWeatherResponse, weatherFallbackSummary } from './_current-weather.js';
import { groundingQueryCount, groundingSources, groundedEventText, buildLiveShowSearchInstruction, buildOfficialArtistWebsiteFallbackInstruction, buildOfficialArtistCandidateVerificationInstruction, buildPriceSearchInstruction, buildPriceSourceFallbackInstruction, buildFeelGoodNewsSearchInstruction, isFlightPriceQuestion, extractFlightRoute, extractPriceSearchArea, extractArtistName, extractArtistWebsiteCandidate, isArtistClarification, isVerifiedOfficialArtistSource, shouldSearchOfficialArtistSite, stripRawUrls } from './_panda-event-search.js';
import { resolveEventSearchArea } from './_panda-event-location.js';
import { parseRideRequest, pickRideDestination, rankRideDestinations } from './_panda-ride-request.js';
import { googleCategoryTags } from './_google-category-tags.js';
import { classifyIndexedFeedCategory } from './_venue-taxonomy.js';
import { conciergeTurn, conciergeInstruction, conciergeArea, conciergeTimeWindow, conciergeVenuePage, CONCIERGE_RESULT_LIMIT } from './_panda-concierge-turn.js';
import { venueOpenAtRequestedTime } from './_panda-dining-hours.js';
import { createNewRestaurantFeed, createFirestoreNewPool, newVenueDistance } from './_panda-new-restaurants.js';
import { getVenueProfile } from './_venue-live.js';
import { OT_BINDINGS } from './_opentable-match.js';
import {
  boundedInteger,
  cacheablePlacesResult,
  cacheableGeminiFunctionCall,
  clientFingerprint,
  compactConversation,
  consumeClientDailyBudget,
  consumeDailyBudget,
  placesMemoryEntry,
  recordCostEvent,
  readSharedGeminiCall,
  requestFingerprint,
  writeSharedGeminiCall,
} from './_cost-controls.js';
const MODELS = [...new Set([
  !/^gemini-(?:1\.5|2\.0|2\.5)-/.test(process.env.PANDA_MODEL || '') && process.env.PANDA_MODEL,
  'gemini-3.1-flash-lite',
].filter(Boolean))];
const LOCATION = process.env.PANDA_LOCATION || 'us-central1';
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
let coverDiscovery;
let newRestaurantFeed;
function sharedNewFeed() {
  return newRestaurantFeed ||= createNewRestaurantFeed({
    readPool: createFirestoreNewPool(db()),
    hydrateVenue: async row => {
      const snap = await db().collection(OT_BINDINGS).doc(row.placeId).get();
      const binding = snap.exists ? snap.data() : null;
      if (!binding || binding.environment !== 'production' || binding.placeId !== row.placeId
        || String(binding.rid) !== row.rid || Number(binding.expiresAt) <= Date.now()) {
        throw new Error('new_selection_binding_unavailable');
      }
      const budget = await consumeDailyBudget(db(), 'places', process.env.PANDA_DAILY_PLACES_LIMIT);
      if (!budget.allowed) throw new Error('new_selection_budget_unavailable');
      const venue = await getVenueProfile(row.placeId);
      if (!venue || venue.id !== row.placeId || !Number.isFinite(venue.latitude)
        || !Number.isFinite(venue.longitude)
        || newVenueDistance(row, { lat: venue.latitude, lng: venue.longitude }) > 150) return null;
      return { ...venue, type: venue.primaryType, lat: venue.latitude, lng: venue.longitude,
        photoName: venue.photoNames?.[0]?.name, photoCount: venue.photoNames?.length ?? 0,
        photoAttribution: venue.photoNames?.[0]?.attribution ?? '' };
    },
  });
}
const DEFAULT_LAT = 51.5074, DEFAULT_LNG = -0.1278;
let nextIndexedDetailRequestAt = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const PRICE = {PRICE_LEVEL_INEXPENSIVE:'\u00a3',PRICE_LEVEL_MODERATE:'\u00a3\u00a3',PRICE_LEVEL_EXPENSIVE:'\u00a3\u00a3\u00a3',PRICE_LEVEL_VERY_EXPENSIVE:'\u00a3\u00a3\u00a3\u00a3'};
const CACHE_TTL_MS   = 30 * 60 * 1000;
const QUOTA_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_GRID     = 1000;
const CACHE_COLLECTION = 'places_cache_v2';
const GEO_COLLECTION = 'geocode_cache_v2';
const MEMORY_CACHE_LIMIT = 250;
const memoryCache = new Map();
const inFlightSearches = new Map();
let placesQuotaBlockedUntil = 0;
const inFlightGemini = new Map();
const recentGemini = new Map();
let vertexAuth;
let vertexDeniedAuthDiagnostic;
const GEMINI_RETRY_CACHE_MS = 15 * 1000;
const GEMINI_CACHE_LIMIT = 100;
const SHARED_GEMINI_CACHE_MS = 5 * 60 * 1000;
let _db = null, _dbTried = false;
let _dbInitFailure = 'shared_storage_not_configured';
function db(){
  if(_dbTried) return _db;
  _dbTried = true;
  let stage='parse';
  try{
    if(!process.env.FIREBASE_SERVICE_ACCOUNT) return (_db=null);
    const account=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    // Accept the common Vercel representation with literal escaped PEM newlines.
    if(typeof account.private_key==='string' && account.private_key.includes('\\n')){
      account.private_key=account.private_key.replace(/\\n/g,'\n');
    }
    stage='credential';
    if(!admin.apps.length){
      const credential=admin.credential.cert(account);
      stage='initialize';
      admin.initializeApp({ credential });
    }
    stage='firestore';
    _db = admin.firestore();
  }catch(e){
    _db = null;
    // Only expose a failure class, never the credential or the exception text.
    _dbInitFailure = e instanceof SyntaxError
      ? 'shared_storage_invalid_configuration'
      : `shared_storage_${stage}_failed`;
  }
  return _db;
}
function distMeters(aLat,aLng,bLat,bLng){const R=6371000,toRad=x=>x*Math.PI/180;const dLat=toRad(bLat-aLat),dLng=toRad(bLng-aLng);const s=Math.sin(dLat/2)**2+Math.cos(toRad(aLat))*Math.cos(toRad(bLat))*Math.sin(dLng/2)**2;return Math.round(2*R*Math.asin(Math.sqrt(s)));}
async function geocodeArea(area){
  if(!area || !MAPS_KEY) return null;
  const clean = String(area).trim().toLowerCase();
  if(!clean || clean.length > 80) return null;
  const store = db();
  const id = Buffer.from(clean).toString('base64').replace(/\//g,'_').slice(0,480);
  if(store){
    try{
      const snap = await store.collection(GEO_COLLECTION).doc(id).get();
      if(snap.exists){ const d = snap.data(); if(d && d.lat!=null) return {lat:d.lat, lng:d.lng}; }
    }catch(e){}
  }
  try{
    // Do not bias or restrict geocoding to the UK. Panda AI accepts named
    // cities, neighbourhoods, landmarks and postcodes worldwide.
    const q = area;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${MAPS_KEY}`;
    const r = await fetch(url);
    if(!r.ok) return null;
    const data = await r.json();
    const loc = data.results?.[0]?.geometry?.location;
    if(!loc) return null;
    const out = {lat:loc.lat, lng:loc.lng};
    if(store){ try{ await store.collection(GEO_COLLECTION).doc(id).set({...out, area:clean, ts:Date.now()}); }catch(e){} }
    return out;
  }catch(e){ return null; }
}
function cacheKey(query,lat,lng,openNow,pageToken){
  const gLat=Math.round(lat*CACHE_GRID)/CACHE_GRID;
  const gLng=Math.round(lng*CACHE_GRID)/CACHE_GRID;
  const raw=`hours-v1|${(query||'').toLowerCase().trim()}|${gLat},${gLng}|o${openNow===true?1:0}|p${pageToken||''}`;
  return Buffer.from(raw).toString('base64').replace(/\//g,'_').slice(0,480);
}
function withDistances(rawVenues,lat,lng){
  return (rawVenues||[]).map(v=>({
    ...v,
    distanceMeters: (v.lat!=null && v.lng!=null) ? distMeters(lat,lng,v.lat,v.lng) : null
  })).sort((a,b)=>(a.distanceMeters??9e9)-(b.distanceMeters??9e9));
}
function readMemoryCache(key,lat,lng){
  const cached=memoryCache.get(key);
  if(!cached||Date.now()-cached.ts>=CACHE_TTL_MS){if(cached)memoryCache.delete(key);return null;}
  memoryCache.delete(key);memoryCache.set(key,cached);
  recordCostEvent('places_cache_hit',{layer:'memory'});
  return {venues:withDistances(cached.venues,lat,lng),nextPageToken:cached.nextPageToken||null,cached:true};
}
function writeMemoryCache(key,result,sourceTimestamp=Date.now()){
  memoryCache.delete(key);
  memoryCache.set(key,placesMemoryEntry(result,sourceTimestamp));
  while(memoryCache.size>MEMORY_CACHE_LIMIT)memoryCache.delete(memoryCache.keys().next().value);
}
async function googleSearch(query,lat,lng,pageToken,openNow){
  if(!MAPS_KEY||!query) return {venues:[],nextPageToken:null};
  try{
    if(Date.now()<placesQuotaBlockedUntil)return {venues:[],nextPageToken:null,providerFailed:true,providerStatus:429};
    const budget=await consumeDailyBudget(db(),'places',process.env.PANDA_DAILY_PLACES_LIMIT);
    if(!budget.allowed)return {venues:[],nextPageToken:null,budgetExceeded:true};
    recordCostEvent('places_provider_call',{openNow:openNow===true,page:Boolean(pageToken)});
    const reqBody={textQuery:query,maxResultCount:20,rankPreference:'DISTANCE',locationBias:{circle:{center:{latitude:lat,longitude:lng},radius:6000.0}}};
    if(openNow===true) reqBody.openNow=true;
    if(pageToken) reqBody.pageToken=pageToken;
    const r=await fetch('https://places.googleapis.com/v1/places:searchText',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Goog-Api-Key':MAPS_KEY,
        'X-Goog-FieldMask':['places.id','places.displayName','places.formattedAddress','places.shortFormattedAddress','places.location','places.rating','places.userRatingCount','places.priceLevel','places.priceRange','places.primaryType','places.primaryTypeDisplayName','places.types','places.googleMapsUri','places.websiteUri','places.nationalPhoneNumber','places.currentOpeningHours.openNow','places.currentOpeningHours.weekdayDescriptions','places.currentOpeningHours.periods','places.regularOpeningHours.weekdayDescriptions','places.regularOpeningHours.periods','places.businessStatus','places.photos','nextPageToken'].join(',')},
      body:JSON.stringify(reqBody)
    });
    if(!r.ok){
      if(r.status===429)placesQuotaBlockedUntil=Date.now()+5*60*1000;
      recordCostEvent('places_provider_failure',{status:r.status});
      return {venues:[],nextPageToken:null,providerFailed:true,providerStatus:r.status};
    }
    const data=await r.json();
    const places=data.places||[];
    const venues=places.map(p=>{
      const loc=p.location||{};const placePhotos=Array.isArray(p.photos)?p.photos:[];const photo=placePhotos[0]||null;
      const attr=photo&&photo.authorAttributions&&photo.authorAttributions[0]?photo.authorAttributions[0].displayName:'';
      const musicIntent=/\b(live music|dj|music)\b/i.test(query||'');
      const typeText=p.primaryTypeDisplayName?.text||'';
      const typeMusic=/\b(night ?club|music|karaoke|concert)\b/i.test(`${typeText} ${(p.types||[]).join(' ')}`);
      const musicBadge=(musicIntent||typeMusic)?'🎵 Live Music / DJ':'';
      return {id:p.id,name:p.displayName?.text||'Unknown',type:typeText,primaryType:p.primaryType||'',
        address:p.shortFormattedAddress||p.formattedAddress||'',fullAddress:p.formattedAddress||'',
        rating:p.rating||null,ratingCount:p.userRatingCount||null,price:PRICE[p.priceLevel]||'',
        priceRange:p.priceRange||null,
        openNow:(p.currentOpeningHours&&typeof p.currentOpeningHours.openNow==='boolean')?p.currentOpeningHours.openNow:null,
        openingHours:p.regularOpeningHours?.weekdayDescriptions||p.currentOpeningHours?.weekdayDescriptions||[],
        openingPeriods:p.currentOpeningHours?.periods?.length?p.currentOpeningHours.periods:p.regularOpeningHours?.periods||[],
        businessStatus:p.businessStatus||'',types:p.types||[],hasMusic:!!musicBadge,musicBadge,
        lat:loc.latitude??null,lng:loc.longitude??null,
        phone:p.nationalPhoneNumber||'',website:p.websiteUri||'',menuLink:p.websiteUri||'',
        mapsUri:p.googleMapsUri||'',directionsLink:p.googleMapsUri||'',
         photoName:photo?photo.name:'',photoAttribution:attr,photoCount:Math.min(10,placePhotos.length),
         photoNames:placePhotos.slice(0,10).map(p=>({name:p.name,attribution:(p.authorAttributions||[]).map(a=>a.displayName).filter(Boolean).join(' · ')})),
         categories:googleCategoryTags({...p,hasMusic:!!musicBadge},query)};
    });
    return {venues,nextPageToken:data.nextPageToken||null};
  }catch{return {venues:[],nextPageToken:null,providerFailed:true}}
}

async function hydrateIndexedPlace(placeId, identity, category) {
  if (!MAPS_KEY) return { providerFailed: true, providerStatus: 503 };
  if (Date.now() < placesQuotaBlockedUntil) {
    return { providerFailed: true, providerStatus: 429 };
  }
  const budget = await consumeDailyBudget(db(), 'places', process.env.PANDA_DAILY_PLACES_LIMIT);
  if (!budget.allowed) return { budgetExceeded: true };

  const startAt = Math.max(Date.now(), nextIndexedDetailRequestAt);
  nextIndexedDetailRequestAt = startAt + 75;
  await wait(Math.max(0, startAt - Date.now()));
  recordCostEvent('places_indexed_card_details_call', { category });
  const fields = [
    'id', 'displayName', 'formattedAddress', 'shortFormattedAddress', 'location',
    'primaryType', 'primaryTypeDisplayName', 'types', 'photos',
  ].join(',');
  try {
    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: { 'X-Goog-Api-Key': MAPS_KEY, 'X-Goog-FieldMask': fields },
    });
    if (!response.ok) {
      if (response.status === 429) placesQuotaBlockedUntil = Date.now() + 5 * 60 * 1000;
      recordCostEvent('places_indexed_card_details_failure', { status: response.status });
      return { providerFailed: true, providerStatus: response.status };
    }
    const place = await response.json();
    const photos = Array.isArray(place.photos) ? place.photos : [];
    const primaryPhoto = photos[0];
    const location = place.location || {};
    const typeText = place.primaryTypeDisplayName?.text || '';
    const types = Array.isArray(place.types) ? place.types : [];
    return {
      venue: {
        id: place.id || placeId,
        name: place.displayName?.text || '',
        type: typeText,
        primaryType: place.primaryType || '',
        types,
        address: place.shortFormattedAddress || place.formattedAddress || '',
        fullAddress: place.formattedAddress || '',
        lat: location.latitude ?? identity.lat,
        lng: location.longitude ?? identity.lng,
        photoName: primaryPhoto?.name || '',
        photoAttribution: (primaryPhoto?.authorAttributions || [])
          .map(item => item.displayName).filter(Boolean).join(' · '),
        photoCount: Math.min(10, photos.length),
        detailsDeferred: true,
          // Use exact Google type verification for meal, offer, and activity
          // categories; only strict categories may rely on their saved search context.
          categories: classifyIndexedFeedCategory(place, category, identity.searchContexts),
        sourceQueries: [`indexed:${category}`],
      },
    };
  } catch {
    recordCostEvent('places_indexed_card_details_failure', { status: 'network' });
    return { providerFailed: true };
  }
}

async function indexedFeedPage(body) {
  let feedBody = body;
  const lat = Number(body.location?.lat);
  const lng = Number(body.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const area = typeof body.area === 'string' ? body.area.trim() : '';
    const resolved = area ? await geocodeArea(area) : null;
    if (!resolved) {
      return { status: 400, body: { error: 'valid_location_or_area_required' } };
    }
    feedBody = { ...body, location: resolved };
  }
  return buildIndexedFeedPage(feedBody, {
    maxPageSize: MAX_INDEXED_FEED_PAGE_SIZE,
    readPage: options => nearbySeededPlacePage(db(), options),
    hydratePlace: (placeId, identity, category) =>
      hydrateIndexedPlace(placeId, identity, category),
  });
}
async function indexedIdCandidatePage(body) {
  let feedBody = body;
  const lat = Number(body.location?.lat);
  const lng = Number(body.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const area = typeof body.area === 'string' ? body.area.trim() : '';
    const resolved = area ? await geocodeArea(area) : null;
    if (!resolved) return { status: 400, body: { error: 'valid_location_or_area_required' } };
    feedBody = { ...body, location: resolved };
  }
  return buildIndexedIdCandidatePage(feedBody, {
    maxPageSize: MAX_INDEXED_FEED_PAGE_SIZE,
    readPage: options => nearbySeededPlacePage(db(), options),
  });
}
async function searchVenues(query,lat,lng,pageToken,openNow){
  if(!MAPS_KEY||!query) return {venues:[],nextPageToken:null};
  const store=db();
  const key = store ? cacheKey(query,lat,lng,openNow,pageToken) : null;
  const memoryKey=cacheKey(query,lat,lng,openNow,pageToken);
  const warm=readMemoryCache(memoryKey,lat,lng);
  if(warm)return warm;
  if(inFlightSearches.has(memoryKey))return inFlightSearches.get(memoryKey);
  const searchPromise=(async()=>{
  let staleResult=null;
  if(store && key){
    try{
      const snap=await store.collection(CACHE_COLLECTION).doc(key).get();
      if(snap.exists){
        const d=snap.data();
        const sourceTimestamp=Number(d?.ts);
        const age=Date.now()-sourceTimestamp;
        if(d && Array.isArray(d.venues) && d.venues.length
          && Number.isFinite(sourceTimestamp) && age>=0 && age<QUOTA_STALE_TTL_MS){
          staleResult={venues:withDistances(d.venues,lat,lng),nextPageToken:null,cached:true,staleAt:sourceTimestamp};
        }
        if(d && Number.isFinite(sourceTimestamp) && age>=0 && age<CACHE_TTL_MS){
          const result={venues:withDistances(d.venues,lat,lng),nextPageToken:d.nextPageToken||null,cached:true};
          writeMemoryCache(memoryKey,result,sourceTimestamp);
          recordCostEvent('places_cache_hit',{layer:'firestore'});
          return result;
        }
      }
    }catch(e){ }
  }
  const fresh=await googleSearch(query,lat,lng,pageToken,openNow);
  if(!cacheablePlacesResult(fresh)){
    if((fresh.providerStatus===429||fresh.budgetExceeded)&&staleResult){
      recordCostEvent('places_quota_stale_cache_hit');
      return staleResult;
    }
    return {venues:[],nextPageToken:null,cached:false,
      ...(fresh.budgetExceeded?{budgetExceeded:true}:{}),
      ...(fresh.providerStatus?{providerStatus:fresh.providerStatus}:{})};
  }
  const fetchedAt=Date.now();
  writeMemoryCache(memoryKey,fresh,fetchedAt);
  if(store && key && fresh.venues.length){
    try{
      await store.collection(CACHE_COLLECTION).doc(key).set({
        ts: fetchedAt,
        venues: fresh.venues,
        nextPageToken: fresh.nextPageToken||null,
        q: (query||'').slice(0,120)
      });
    }catch(e){ }
  }
  return { venues: withDistances(fresh.venues, lat, lng), nextPageToken: fresh.nextPageToken||null, cached:false };
  })();
  inFlightSearches.set(memoryKey,searchPromise);
  try{return await searchPromise;}finally{inFlightSearches.delete(memoryKey);}
}
async function mapLimited(values,limit,callback){
  const output=new Array(values.length);let nextIndex=0;
  await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{
    while(nextIndex<values.length){const index=nextIndex;nextIndex+=1;output[index]=await callback(values[index]);}
  }));
  return output;
}
function compactBatchVenue(venue){
  const todayIndex=(new Date().getUTCDay()+6)%7;
  const openingHours=Array.isArray(venue.openingHours)
    ? venue.openingHours.map((value,index)=>index===todayIndex?value:'')
    : undefined;
  return {
    id:venue.id,name:venue.name,type:venue.type,primaryType:venue.primaryType,
    address:venue.address,fullAddress:venue.fullAddress,rating:venue.rating,
    ratingCount:venue.ratingCount,price:venue.price,openNow:venue.openNow,
    openingHours,lat:venue.lat,lng:venue.lng,phone:venue.phone,
    website:venue.website||venue.menuLink,mapsUri:venue.directionsLink||venue.mapsUri,
    photoName:venue.photoName,photoAttribution:venue.photoAttribution,
    photoCount:venue.photoCount,types:venue.types,hasMusic:venue.hasMusic,
    categories:venue.categories,distanceMeters:venue.distanceMeters,
    sourceQueries:venue.sourceQueries,cachedAt:venue.cachedAt
  };
}
async function searchVenueBatch(queries,lat,lng){
  const normalized=[...new Set((Array.isArray(queries)?queries:[])
    .map(value=>String(value||'').trim())
    .filter(Boolean))].slice(0,14);
  const batches=await mapLimited(normalized,4,async query=>{
    const result=await searchVenues(query,lat,lng);
    return {
      venues:result.venues.map(venue=>({
        ...venue,
        cachedAt:result.staleAt,
        sourceQueries:[...new Set([...(venue.sourceQueries||[]),query])]
      })),
      quotaExceeded:result.providerStatus===429||result.budgetExceeded===true,
    };
  });
  const merged=new Map();
  batches.flatMap(batch=>batch.venues).forEach(venue=>{
    if(!venue?.id)return;
    const existing=merged.get(venue.id);
    merged.set(venue.id,existing?{
      ...existing,...venue,
      categories:[...new Set([...(existing.categories||[]),...(venue.categories||[])])],
      sourceQueries:[...new Set([...(existing.sourceQueries||[]),...(venue.sourceQueries||[])])]
    }:venue);
  });
  return {
    venues:withDistances([...merged.values()].filter(venue=>venue.photoName&&Number(venue.photoCount)>=5),lat,lng)
      .slice(0,40).map(compactBatchVenue),
    quotaExceeded:batches.length>0&&batches.every(batch=>batch.quotaExceeded),
  };
}
function expansionCenters(lat,lng,radiusKm){
  const centers=[],dLat=radiusKm/111,dLng=radiusKm/(111*Math.cos(lat*Math.PI/180));
  for(let angle=0;angle<360;angle+=60){
    const radians=angle*Math.PI/180;
    centers.push({lat:lat+dLat*Math.sin(radians),lng:lng+dLng*Math.cos(radians)});
  }
  return centers;
}
async function searchVenueRing(query,lat,lng,radiusKm){
  const batches=await Promise.all(expansionCenters(lat,lng,radiusKm).map(async center=>{
    const venues=[];let pageToken;
    for(let page=0;page<3;page+=1){
      const result=await searchVenues(query,center.lat,center.lng,pageToken);
      venues.push(...result.venues);
      pageToken=result.nextPageToken;
      if(!pageToken)break;
    }
    return venues;
  }));
  const merged=new Map();
  batches.flat().forEach(venue=>{
    if(!venue?.id)return;
    const existing=merged.get(venue.id);
    merged.set(venue.id,existing?{
      ...existing,...venue,
      categories:[...new Set([...(existing.categories||[]),...(venue.categories||[])])]
    }:venue);
  });
  return withDistances([...merged.values()],lat,lng);
}
const STRICT_LOCATION_RULES={
  chelsea:['chelsea','sw3','sw10'],
  battersea:['battersea','sw11','sw8'],
  mayfair:['mayfair','w1j','w1k','w1s'],
  soho:['soho','w1d','w1f'],
  shoreditch:['shoreditch','e1','ec2a'],
  kensington:['kensington','w8','sw5','sw7'],
  camden:['camden','nw1'],
  brixton:['brixton','sw2','sw9']
};
function strictRequestedArea(value){
  const text=String(value||'').toLowerCase();
  return Object.keys(STRICT_LOCATION_RULES).find(area=>new RegExp(`\\b${area}\\b`,'i').test(text))||'';
}
function strictLocationResult(result,requestedArea){
  const target=strictRequestedArea(requestedArea);
  if(!target)return result;
  const rules=STRICT_LOCATION_RULES[target];
  const venues=(result?.venues||[]).filter(venue=>{
    const text=[venue?.name,venue?.address,venue?.fullAddress,venue?.area].filter(Boolean).join(' ').toLowerCase();
    return rules.some(rule=>new RegExp(`\\b${rule}\\b`,'i').test(text));
  });
  return {...result,venues,strictArea:target};
}
async function searchVenuesSmart(query,userLat,userLng,area,openNow){
  let lat=userLat, lng=userLng;
  if(area){
    const geo = await geocodeArea(area);
    if(geo){
      // Geocoding worked: centre the search on the area's coordinates.
      lat=geo.lat; lng=geo.lng;
    } else {
      // Geocoding failed (e.g. API disabled). Fall back to a TEXT-based area
      // search so we still search the named area, NOT the user's GPS. We append
      // the area to the query and widen the bias radius so Places finds it.
      const q2 = `${query} in ${area}`;
      const viaText = strictLocationResult(await searchVenues(q2, userLat, userLng, null, openNow),area);
      if(viaText.venues && viaText.venues.length) return { ...viaText, searchContext: {query:q2,lat:userLat,lng:userLng} };
      // last resort: text search without location weighting removed — still area-tagged
      return { ...strictLocationResult(await searchVenues(`${query} ${area}`, userLat, userLng, null, openNow),area),
        searchContext: {query:`${query} ${area}`,lat:userLat,lng:userLng} };
    }
  }
  return { ...strictLocationResult(await searchVenues(query,lat,lng,null,openNow),area),
    searchContext: {query,lat,lng} };
}
function fmtDist(m){return m==null?'':(m<1000?`${m} m`:`${(m/1000).toFixed(1)} km`);}
function dayHours(v){
  const list=Array.isArray(v&&v.openingHours)?v.openingHours:[];
  if(!list.length)return '';
  const index=(new Date().getDay()+6)%7;
  return String(list[index]||list[0]||'').replace(/^[^:]+:\s*/,'').trim();
}
function dayClosing(v){
  const hours=dayHours(v);
  if(!hours)return '';
  if(/closed/i.test(hours))return 'closed today';
  if(/24\s*hours/i.test(hours))return 'open 24 hours';
  const match=hours.match(/(?:–|—|-)\s*(.+)$/);
  return match?`closes ${match[1]} today`:hours;
}
function asksClosingTime(text){return /\b(when|what time|time)\b[^.!?]{0,70}\b(close|closes|closing|shut|last orders)\b|\b(close|closes|closing|shut|last orders)\b/i.test(String(text||''));}
function venuesToText(v,context){if(!v.length)return 'No matching venues found nearby.';const includeClosing=asksClosingTime(context);return v.slice(0,15).map((x,i)=>{const bits=[x.type,fmtDist(x.distanceMeters),x.rating?`${x.rating}\u2605`:'',x.price,x.openNow===true?'open now':x.openNow===false?'closed':'',x.hasMusic?'live music/DJ':'',includeClosing?dayClosing(x):''].filter(Boolean).join(' \u00b7 ');return `${i+1}. ${x.name}${bits?' \u2014 '+bits:''}`;}).join('\n');}
function extractArea(text){
  return conciergeArea(text);
}
function isThemedRequest(text){return /\b(pub crawl|crawl|cozy|cosy|cheap|expensive|christmas|theme|live music|dj|music)\b/i.test(String(text||''));}
const CHAT_CARD_LIMIT=20;
const CHAT_MAX_DISTANCE_METERS=60000;
function nearbyChatVenues(venues,compare=(a,b)=>a.distanceMeters-b.distanceMeters,minPhotoCount=5){
  const unique=new Map();
  for(const venue of venues||[]){
    if(!venue?.id||!venue.photoName||Number(venue.photoCount)<minPhotoCount)continue;
    if(!Number.isFinite(venue.distanceMeters)||venue.distanceMeters<0||venue.distanceMeters>CHAT_MAX_DISTANCE_METERS)continue;
    if(!unique.has(venue.id))unique.set(venue.id,venue);
  }
  return [...unique.values()].sort(compare).slice(0,CHAT_CARD_LIMIT);
}
async function searchChatVenues(query,lat,lng,area,openNow,fast=false,excludedPlaceIds=[],acceptVenue=()=>true,compare,minPhotoCount=5){
  const first=await searchVenuesSmart(query,lat,lng,area,openNow);
  const excluded = new Set(excludedPlaceIds);
  let all = first.venues || [];
  let venues=nearbyChatVenues(all.filter(venue => !excluded.has(venue.id) && acceptVenue(venue)),compare,minPhotoCount);
  let cursor = first.nextPageToken;
  const searchContext = first.searchContext;
  const used = new Set();
  for (let page=0; page<2 && venues.length<CONCIERGE_RESULT_LIMIT && cursor && searchContext; page++) {
    if (used.has(cursor)) break;
    used.add(cursor);
    const next = await searchVenues(searchContext.query,searchContext.lat,searchContext.lng,cursor,openNow);
    all = [...all, ...(strictLocationResult(next,area).venues || [])];
    venues=nearbyChatVenues(all.filter(venue => !excluded.has(venue.id) && acceptVenue(venue)),compare,minPhotoCount);
    cursor = next.nextPageToken;
  }
  return venues;
}
function limitChatVenues(venues,userText,query){return conciergeVenuePage(venues);}
function latestUserText(contents){if(!Array.isArray(contents))return '';for(let i=contents.length-1;i>=0;i--){const c=contents[i];if(c?.role==='user'&&Array.isArray(c.parts)){const t=c.parts.map(p=>p.text||'').join(' ').trim();if(t)return t;}}return '';}
function isPubCrawlRequest(text){return /\b(?:pub|bar|drinks?)?\s*crawl\b/i.test(String(text||''));}
function pubCrawlLimit(){return 8;}
function pubCrawlThemes(text){
  const query=String(text||'').toLowerCase();
  return {
    cheap:/\bcheap|budget|inexpensive\b|(?:^|\s)£(?:\s|$)/i.test(query),
    expensive:/\bexpensive|fancy|upmarket|premium\b|£££/i.test(query),
    cozy:/\bcozy|cosy\b/i.test(query),
    music:/\blive music|dj|band|music\b/i.test(query)
  };
}
function isPubBarVenue(venue){
  const typeText=[venue?.type,...(Array.isArray(venue?.types)?venue.types:[])].filter(Boolean).join(' ');
  return /\b(pub|bar|tavern|brewery|beer|taproom|night club|nightclub)\b/i.test(typeText);
}
function pubCrawlThemeMatch(venue,themes){
  if(themes.cheap && venue.price!=='£')return false;
  if(themes.expensive && venue.price!=='£££' && venue.price!=='££££')return false;
  if(themes.music && !venue.hasMusic)return false;
  return true;
}
function pubCrawlQueries(themes){
  const preferred=themes.music?'live music pubs and bars':themes.cozy?'cosy pubs':themes.cheap?'inexpensive pubs and bars':themes.expensive?'upmarket pubs and cocktail bars':'pubs and bars';
  return [...new Set([preferred,'pubs','bars','gastropubs','cocktail bars','traditional pubs'])];
}
function orderPubCrawl(venues,limit){
  const remaining=venues.slice();
  const ordered=[];
  while(remaining.length&&ordered.length<limit){
    if(!ordered.length){ordered.push(remaining.shift());continue;}
    const previous=ordered[ordered.length-1];
    let bestIndex=0,bestDistance=Infinity;
    remaining.forEach((venue,index)=>{
      const distance=(previous.lat!=null&&previous.lng!=null&&venue.lat!=null&&venue.lng!=null)
        ?distMeters(previous.lat,previous.lng,venue.lat,venue.lng)
        :(venue.distanceMeters??Infinity);
      if(distance<bestDistance){bestDistance=distance;bestIndex=index;}
    });
    ordered.push(remaining.splice(bestIndex,1)[0]);
  }
  return ordered;
}
async function buildCustomPubCrawl(userText,lat,lng){
  const area=extractArea(userText);
  const themes=pubCrawlThemes(userText);
  const limit=pubCrawlLimit();
  const batches=await Promise.all(pubCrawlQueries(themes).map(query=>searchVenuesSmart(query,lat,lng,area,false)));
  const unique=new Map();
  batches.forEach(batch=>(batch.venues||[]).forEach(venue=>{
    if(venue?.id&&!unique.has(venue.id)&&isPubBarVenue(venue))unique.set(venue.id,venue);
  }));
  const all=[...unique.values()];
  const themed=all.filter(venue=>pubCrawlThemeMatch(venue,themes));
  const themedIds=new Set(themed.map(venue=>venue.id));
  const pool=[...themed,...all.filter(venue=>!themedIds.has(venue.id))];
  const selected=orderPubCrawl(pool,limit).map((venue,index)=>{
    const address=venue.fullAddress||venue.address||area||'';
    const directionsLink=venue.directionsLink||venue.mapsUri||`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${venue.name} ${address}`)}`;
    const menuLink=venue.menuLink||venue.website||`https://www.google.com/search?q=${encodeURIComponent(`${venue.name} menu`)}`;
    return {...venue,stopLabel:`Stop ${index+1} of ${Math.min(limit,pool.length)}`,directionsLink,menuLink};
  });
  const place=area||'your area';
  const theme=themes.music?'live-music ':themes.cozy?'cosy ':themes.cheap?'budget ':themes.expensive?'premium ':'';
  const text=selected.length
    ?`Absolutely — I built you a ${selected.length}-stop ${theme}pub crawl in ${place}. Start at Stop 1 and follow the route from there.`
    :`I couldn't find enough real pubs in ${place} to build a crawl just yet. Try a nearby area and I'll map one out.`;
  return {text,venues:selected,richMetadata:true,customPubCrawl:true};
}
const GREET_RE=/^\s*(hi+|hey+|hello+|yo+|sup|hiya|howdy|heya|good\s?(morning|afternoon|evening|day)|thanks|thank\s?you|cheers|ta|nice one|ok(ay)?|cool|nice|lol|haha|hah| | | )\s*[!.?]*\s*$/i;
const PLACE_RE=/\b(eat|food|lunch|dinner|breakfast|brunch|coffee|drink|drinks|bar|pub|wine|beer|cocktail|restaurant|cafe|takeaway|book|table|rooftop|club|night|date|hungry|thirsty|steak|meat|pizza|sushi|burger|ramen|curry|tapas|football|match|watch|near|nearby|around|open|cheap|budget|fancy|vegan|halal|music|dj|crawl|cozy|cosy|christmas|theme|£|\$)\b/i;
function isGreeting(t){return GREET_RE.test((t||'').trim());}
const SMALL_TALK_RE=/^(?:thanks|thank you|cheers|nice one|how are you|who are you|what can you do|help)[!.?\s]*$/i;
function wantsPlaces(t){
  const value=String(t||'').trim();
  return isDirectVenueRequest(value) || /\b(?:find|look for|show me|recommend|near(?:by)?|around here)\b/i.test(value);
}
function fallbackQuery(text){
  const raw=String(text||'').trim();
  const withoutArea=raw.replace(/\b(?:in|near|around|at)\s+(.+?)(?:\s+(?:tonight|today|tomorrow|please|for me))?\s*[,.!?]*$/i,'').trim();
  const specific=withoutArea
    .replace(/^(?:can you|could you|would you|please)\s+/i,'')
    .replace(/^(?:find|show|recommend)(?:\s+me)?\s+/i,'')
    .replace(/^(?:i(?:'d| would) like|i want|looking for)\s+/i,'')
    .replace(/[,.!?]+$/g,'')
    .trim();
  if(/^(?:what(?:'s| is) open(?: now)?|open now)$/i.test(specific)) return 'restaurants bars cafes';
  if(specific.length>=2 && specific.length<=120) return specific;
  return 'restaurants and bars';
}
function pick(a){return a[Math.floor(Math.random()*a.length)];}
const GREET_LINES=[
  "Hey hey \uD83D\uDC3C what are we feeling — food, drinks, or full send?",
  "Well hello bestie. Hungry, thirsty, or just being polite? Tell me the vibe.",
  "Yo! I\u2019m all ears (and paws). What\u2019s the mission — lunch, drinks, big night?",
  "Hiya \uD83D\uDC3C give me a craving and I\u2019ll give you a plan.",
  "Alright legend \u2014 what are we hunting? Cheap eats? A fancy pants dinner? Say the word."
];
const NORESULT_LINES=[
  "Hmm, drew a blank on that one \u2014 want me to widen the net or try a different vibe?",
  "Nothing jumped out for that exact thing. Give me a cuisine or a budget and I\u2019ll dig again.",
  "That one\u2019s playing hard to get \u2014 rephrase it and I\u2019ll have another go \uD83D\uDC3C"
];
async function gemini(token,projectId,body,cacheContext={},options={}){
  const modelLimit=Number.isInteger(options.modelLimit)
    ?Math.max(1,Math.min(MODELS.length,options.modelLimit))
    :MODELS.length;
  const timeoutMs=Number.isInteger(options.timeoutMs)
    ?Math.max(6500,Math.min(15_000,options.timeoutMs))
    :6500;
  const selectedModels=MODELS.slice(0,modelLimit);
  const key=requestFingerprint({body,cacheContext,modelLimit});
  const cached=recentGemini.get(key);
  if(cached&&cached.expiresAt>Date.now()){
    recordCostEvent('gemini_cache_hit',{layer:'memory'});
    return cached.result;
  }
  if(cached)recentGemini.delete(key);
  if(inFlightGemini.has(key)){
    recordCostEvent('gemini_coalesced',{layer:'memory'});
    return inFlightGemini.get(key);
  }
  const request=(async()=>{
  const sharedCacheEnabled=process.env.PANDA_SHARED_GEMINI_CACHE==='true';
  if(sharedCacheEnabled){
    const shared=await readSharedGeminiCall(db(),key,SHARED_GEMINI_CACHE_MS);
    if(shared){
      recordCostEvent('gemini_cache_hit',{layer:'firestore',responseType:'function_call'});
      return shared;
    }
  }
  const budget=await consumeDailyBudget(db(),'gemini',process.env.PANDA_DAILY_GEMINI_LIMIT);
  if(!budget.allowed)return {ok:false,status:429,data:{},budgetExceeded:true};
  recordCostEvent('gemini_provider_call',{modelCount:selectedModels.length});
  let last={ok:false,status:0,data:{}};
  for(const model of selectedModels){
    try{
      const region=model.startsWith('gemini-3')?'global':LOCATION;
      const host=region==='global'?'aiplatform.googleapis.com':`${region}-aiplatform.googleapis.com`;
      const url=`https://${host}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
      const requestBody={...body,generationConfig:{...body.generationConfig,thinkingConfig:model.startsWith('gemini-3')?{thinkingLevel:'MINIMAL'}:{thinkingBudget:0}}};
      const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(requestBody),signal:AbortSignal.timeout(timeoutMs)});
      const data=await r.json().catch(()=>({}));
      if(r.ok) {
        const result={ok:true,status:r.status,data};
        if(sharedCacheEnabled&&cacheableGeminiFunctionCall(result)){
          await writeSharedGeminiCall(db(),key,result);
        }
        return result;
      }
      last={ok:false,status:r.status,data,failure:safeProviderFailure(data)};
      if(r.status===403){
        const details=Array.isArray(data?.error?.details)?data.error.details:[];
        const providerReason=details.map(d=>d?.reason).find(x=>typeof x==='string'&&/^[A-Z0-9_]{1,96}$/.test(x));
        const deniedPermission=String(data?.error?.message||'').match(/\b(?:aiplatform|serviceusage|resourcemanager)\.[a-zA-Z.]+/)?.[0];
        if(!vertexDeniedAuthDiagnostic){
          vertexDeniedAuthDiagnostic=(async()=>{
            const client=await vertexAuth.getClient();
            const info=await Promise.race([
              client.getTokenInfo(token),
              new Promise((_,reject)=>setTimeout(()=>reject(new Error('token-info-timeout')),2000)),
            ]);
            return {hasCloudPlatformScope:info.scopes.includes('https://www.googleapis.com/auth/cloud-platform')};
          })().catch(()=>({tokenInfoUnavailable:true}));
        }
        const authDiagnostic=await vertexDeniedAuthDiagnostic;
        // Private logs only; redact the actual token and recognizable credential formats.
        console.info(JSON.stringify({
          event:'panda_vertex_denial',
          model:/^gemini-[a-z0-9.-]{1,64}$/.test(model)?model:'custom',
          classification:last.failure,
          providerReason,
          deniedPermission,
          message:redactedProviderMessage(data,token),
          ...authDiagnostic,
        }));
      }
      if(r.status!==404 && r.status!==400) return last;
    }catch(e){ last={ok:false,status:e?.name==='TimeoutError'?504:500,data:{},failure:e?.name==='TimeoutError'?'timeout':'network'}; }
  }
  return last;
  })();
  inFlightGemini.set(key,request);
  try{
    const result=await request;
    if(result.ok){
      recentGemini.delete(key);
      recentGemini.set(key,{result,expiresAt:Date.now()+GEMINI_RETRY_CACHE_MS});
      while(recentGemini.size>GEMINI_CACHE_LIMIT)recentGemini.delete(recentGemini.keys().next().value);
    }
    return result;
  }finally{inFlightGemini.delete(key);}
}
const FIND_PLACES_TOOL={functionDeclarations:[{
  name:'find_places',
  description:"Search real venues for ANY going-out intent — restaurants, bars, wine bars, pubs, cafes; lunch/brunch/dinner; cheap eats and budget spots; date-night; specific cuisines or drinks; places to WATCH FOOTBALL or sport; live music; rooftops; themed nights; pub crawls. Call it whenever the user wants somewhere to go, eat, drink, or something to do out. Do NOT call it for pure greetings, thanks or small talk. If the user names a SPECIFIC venue, pass that exact name as the query. If the user names a CITY, COUNTRY, NEIGHBOURHOOD, area, postcode or place (e.g. 'in Manchester', 'in New York', 'near London Bridge', 'SW1'), pass it in `area`. Area searches are worldwide; never assume the UK. For themed or pub-crawl requests, return the best six venues and include live music/DJ matches where relevant. If the user asks when a specific venue closes, answer with that venue's closing time for today; do not recite the weekly schedule unless explicitly requested. If the user refers to a saved place like 'near my work' or 'near home' and coordinates for it were provided in the conversation, you may pass that area name too.",
  parameters:{type:'object',properties:{
    query:{type:'string',description:"A concise Google Places query capturing the food/drink intent, e.g. 'french restaurants', 'affordable lunch', 'rooftop cocktail bars', 'sports bars showing football'."},
    area:{type:'string',description:"Optional. A neighbourhood, area, postcode or landmark to centre the search on, e.g. 'Mayfair', 'Shoreditch', 'SW1A', 'near Borough Market'. Omit entirely for 'near me' searches."}
  },required:['query']}
}]};
export default async function handler(req,res){
  if(applyGuard(req,res,{methods:['GET','POST','OPTIONS'],limit:true})) return;
  if (isSandboxReservationRequest(req)) {
    return createSandboxHttpHandler({getDb:db,verifyIdToken:token=>admin.auth().verifyIdToken(token,true)})(req,res);
  }
  if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
  try{
    const body=req.body||{};
    const {contents,generationConfig,location}=body;
    const lat=location?.lat??DEFAULT_LAT, lng=location?.lng??DEFAULT_LNG;
    const turn = conciergeTurn(contents, body.shownVenueIds);
    if (body.newOpeningsOnly === true || (!body.venuesOnly && turn.wantsNew)) {
      res.setHeader('Cache-Control','private, no-store');
      const area = typeof body.area === 'string' ? body.area.slice(0,120) : extractArea(turn.searchText);
      const centre = area ? await geocodeArea(area) : location;
      if (area && !centre) return res.status(200).json({status:'area_unavailable',
        newOpeningsSearch:true,venues:[],text:`I couldn’t locate ${area} reliably. Please give me the town or postcode.`});
      try {
        const result = await sharedNewFeed()({location:centre,excludedPlaceIds:turn.excludedPlaceIds});
        return res.status(200).json({...result,area:area || null});
      } catch {
        return res.status(503).json({status:'verification_unavailable',newOpeningsSearch:true,venues:[],
          text:'The OpenTable New selection could not be verified just now. Please try again shortly; I won’t substitute ordinary restaurants.'});
      }
    }
    if(body.weatherOnly===true){
      const result=await currentWeatherResponse({
        location,
        store:db(),
        limit:process.env.PANDA_DAILY_WEATHER_LIMIT||1000,
        fetchImpl:fetch,
        recordUsage:recordCostEvent,
      });
      res.setHeader('Cache-Control','private, no-store');
      res.status(result.status).json(result.body);
      return;
    }
    if(body.venuesOnly){
      if(body.discoveryMode === 'indexed-id-page'){
        try{
          const result=await indexedIdCandidatePage(body);
          res.setHeader('Cache-Control','private, no-store');
          res.status(result.status).json(result.body);
        }catch(error){
          res.status(503).json({error:'indexed_id_discovery_unavailable'});
        }
        return;
      }
      if(body.discoveryMode === 'indexed-feed'){
        try{
          const result=await indexedFeedPage(body);
          res.setHeader('Cache-Control','private, no-store');
          res.status(result.status).json(result.body);
        }catch(error){
          res.status(503).json({error:'indexed_discovery_unavailable'});
        }
        return;
      }
      // Opt-in: old Android builds and AI/Planner retain their existing contract.
      if(body.discoveryMode === 'cover' && body.directoryOnly!==true){
        coverDiscovery ||= createDiscoveryService({
          store:db(),apiKey:MAPS_KEY,consumeBudget:consumeDailyBudget,
          persistFullContent:false,
          indexIdentities:venues=>indexPlaceIdentities(db(),venues,{
            arrayUnion:admin.firestore.FieldValue.arrayUnion,
          }),
          readIndex:request=>nearbyPlaceIdentities(db(),request),
        });
        try{
          res.setHeader('Cache-Control','private, no-store');
          res.status(200).json(await coverDiscovery(body));
        }catch(error){
          res.status(error?.status || 503).json({error:error?.status === 400 ? error.message : 'Discovery is temporarily unavailable.'});
        }
        return;
      }
      if(body.directoryOnly===true){
        res.status(410).json({error:'independent_directory_disabled',
          message:'Panda discovery uses verified Google venues and Panda Partner data only.'});
        return;
      }
      if(Array.isArray(body.queries)){
        const {venues,quotaExceeded}=await searchVenueBatch(body.queries,lat,lng);
        if(!venues.length&&quotaExceeded){
          res.status(503).json({error:'places_quota_exhausted'});
          return;
        }
        res.status(200).json({venues,nextPageToken:null,batched:true,queryCount:Math.min(body.queries.length,14)});
        return;
      }
      const ringKm=Number(body.expansionRingKm);
      if(Number.isFinite(ringKm)&&ringKm>=0.1&&ringKm<=20){
        const venues=await searchVenueRing(body.query,lat,lng,ringKm);
        res.status(200).json({venues,nextPageToken:null,expansionRingKm:ringKm});
        return;
      }
      const {venues,nextPageToken}=await searchVenues(body.query,lat,lng,body.pageToken);
      res.status(200).json({venues,nextPageToken});
      return;
    }
    const userText=turn.continuation ? turn.searchText : latestUserText(contents);
    const eventSearchQuestion=isEventSearchQuestion(userText);
    const priceSearchQuestion=!eventSearchQuestion&&isPriceLookupQuestion(userText);
    const feelGoodNewsQuestion=!eventSearchQuestion&&!priceSearchQuestion&&isFeelGoodNewsQuestion(userText);
    const groundedLookupQuestion=eventSearchQuestion||priceSearchQuestion||feelGoodNewsQuestion;
    const rideRequest=parseRideRequest(userText);
    const shortcut=quickVenueShortcut(userText);
    if(shortcut&&(!location||!Number.isFinite(Number(location.lat))||!Number.isFinite(Number(location.lng)))){
      return res.status(200).json({text:'Allow location access so I can find the best-rated places near you, or tell me an area to search.',venues:[],aiMode:'clarification'});
    }
    if (turn.more && !turn.continuation) return res.status(200).json({venues:[],aiMode:'clarification',
      text:'Of course—which area and kind of place shall I find more of?'});
    const requestedWindow = conciergeTimeWindow(turn.searchText,body.chatContext);
    const onlyOpenNow = wantsOpenNow(userText);
    const searchForTurn = async (query,latitude,longitude,area,openNow,fast=false) => {
      const scheduled = /\b(?:tomorrow|tonight|at \d|after \d|before \d)\b/i.test(turn.searchText);
      return searchChatVenues(shortcut?.query||query,latitude,longitude,shortcut?'':area,
        onlyOpenNow|| (shortcut?shortcut.openNow:scheduled?false:openNow),
        turn.more||requestedWindow.lateDinner?false:fast,turn.excludedPlaceIds,
        venue=>filterSessionVenues([venue],contents).length>0
          &&(!onlyOpenNow || venue.openNow === true)
          && matchesQuickVenueShortcut(venue,shortcut)
          &&(!requestedWindow.lateDinner||venueOpenAtRequestedTime(venue,requestedWindow)),
        shortcut?compareQuickVenueRatings:undefined);
    };
    if(rideRequest){
      const hasPickupLocation=Number.isFinite(Number(location?.lat))
        &&Number.isFinite(Number(location?.lng))
        &&Math.abs(Number(location.lat))<=90
        &&Math.abs(Number(location.lng))<=180;
      if(!hasPickupLocation){
        res.status(200).json({
          text:'Allow location access so I can estimate the ride from your current pickup point, or share your pickup area.',
          venues:[],
          aiMode:'clarification',
          rideRequest:true,
        });
        return;
      }
      if(!rideRequest.destination){
        const options=await searchChatVenues(
          'popular bars pubs restaurants cafes',
          Number(location.lat),
          Number(location.lng),
          rideRequest.area,
          false,
          true,
          [],
          ()=>true,
          undefined,
          1,
        );
        res.status(200).json({
          text:options.length
            ?'Of course 🚗 Choose a nearby place below and tap its Uber estimate. If you have a destination in mind, tell me its name instead.'
            :'Where would you like to go? Tell me a venue or area and I’ll find a confirmed destination.',
          venues:options.slice(0,4),
          aiMode:options.length?'ride-options':'clarification',
        });
        return;
      }
      const searchResult=await searchVenuesSmart(
        rideRequest.destination,
        Number(location.lat),
        Number(location.lng),
        rideRequest.area,
        false,
      );
      const destination=pickRideDestination(searchResult.venues,rideRequest.destination);
      if(!destination){
        const ranked=rankRideDestinations(searchResult.venues,rideRequest.destination);
        const topScore=ranked[0]?.score;
        const ambiguous=Number.isFinite(topScore)
          ?ranked.filter(candidate=>candidate.score===topScore).slice(0,4)
          :[];
        if(ambiguous.length>1){
          const choices=ambiguous.map(({venue})=>{
            const hasCoordinates=Number.isFinite(Number(venue.lat))&&Number.isFinite(Number(venue.lng));
            return {
              ...venue,
              ...(hasCoordinates?{
                distanceMeters:distMeters(Number(location.lat),Number(location.lng),Number(venue.lat),Number(venue.lng)),
              }:{}),
            };
          });
          res.status(200).json({
            text:`I found a few places matching “${rideRequest.destination}” 🚗 Choose the right venue card below, then tap its Uber estimate.`,
            venues:choices,
            richMetadata:true,
            aiMode:'ride-choices',
          });
          return;
        }
        res.status(200).json({
          text:`I couldn’t confirm “${rideRequest.destination}” as a real destination nearby. Try the full venue name or add its city, and I’ll show one confirmed place rather than guess.`,
          venues:[],
          aiMode:'ride-destination-unavailable',
          rideRequest:true,
        });
        return;
      }
      const hasDestinationCoordinates=Number.isFinite(Number(destination.lat))
        &&Number.isFinite(Number(destination.lng))
        &&Math.abs(Number(destination.lat))<=90
        &&Math.abs(Number(destination.lng))<=180;
      const rideDistance=hasDestinationCoordinates
        ?distMeters(Number(location.lat),Number(location.lng),Number(destination.lat),Number(destination.lng))
        :NaN;
      if(!Number.isFinite(rideDistance)||rideDistance<=0||rideDistance>250000){
        res.status(200).json({
          text:`I found ${destination.name}, but I can’t make a reliable local ride estimate for that distance. Try a nearer destination and I’ll keep the fare estimate clearly labelled.`,
          venues:[],
          aiMode:'ride-estimate-unavailable',
          rideRequest:true,
        });
        return;
      }
      const destinationVenue={
        ...destination,
        distanceMeters:rideDistance,
      };
      res.status(200).json({
        text:`I found ${destination.name} 🚗 Tap the Uber estimate on its card to check the live fare and continue in Uber. I haven’t requested a ride.`,
        venues:[destinationVenue],
        richMetadata:true,
        aiMode:'ride-destination',
        rideRequest:true,
      });
      return;
    }
    const sessionVenueTransitFollowUp=isSessionVenueTransitFollowUp(userText,body.sessionVenueContext);
    const quick=quickChatReply(userText,body.chatContext,contents);
    if(quick&&!shouldUseConversationalModel(userText,contents)){res.status(200).json({text:quick,venues:[],aiMode:'quick'});return;}
    if(!sessionVenueTransitFollowUp&&!groundedLookupQuestion){
      const outing=await answerOutingRequest({
        text:userText,contents,area:extractArea(userText),context:body.chatContext,
        location:{lat,lng},hasLocation:Number.isFinite(body.location?.lat)&&Number.isFinite(body.location?.lng),
      },{
        search:async(query,area,wantOpen)=>filterSessionVenues(limitChatVenues(await searchForTurn(query,lat,lng,area,wantOpen),userText,query),contents),
        programmes:officialProgrammes,
      });
      if(outing){res.status(200).json(outing);return;}
    }
    if(maySearchVenues(userText)&&ambiguousClub(userText,contents)){
      res.status(200).json({text:'Do you mean a nightclub for dancing, a private members’ club, or a sports/social club?',venues:[],aiMode:'clarification'});return;
    }
    if(!groundedLookupQuestion&&maySearchVenues(userText)&&(shortcut||isDirectVenueRequest(userText))&&!extractArea(userText)&&(!location||!Number.isFinite(Number(location.lat))||!Number.isFinite(Number(location.lng)))){
      res.status(200).json({text:'Tell me your city or area, or allow location access, so I can find real nearby venues.',venues:[],aiMode:'clarification'});return;
    }
    if(maySearchVenues(userText)&&isPubCrawlRequest(userText)){res.status(200).json(await buildCustomPubCrawl(userText,lat,lng));return;}
    let prefetchedVenues=null;
    let weather=null;
    let weatherStatus=null;
    let weatherArea='';
    if(isWeatherQuestion(userText)){
      weatherArea=extractWeatherArea(userText);
      const point=weatherArea?await geocodeArea(weatherArea):location;
      if(!point||!Number.isFinite(Number(point.lat))||!Number.isFinite(Number(point.lng))){
        res.status(200).json({text:'Which city or area should I check the weather for?',venues:[],aiMode:'clarification'});return;
      }
      // Only explicit weather questions use MET Norway; ordinary chat and venue searches do not.
      const result=await currentWeatherResponse({
        location:point,
        store:db(),
        limit:process.env.PANDA_DAILY_WEATHER_LIMIT||1000,
        fetchImpl:fetch,
        recordUsage:recordCostEvent,
      });
      if(result.status===200)weather=result.body.weather;
      else weatherStatus=result.body.error||'weather_unavailable';
    }
    const eventTarget=eventSearchQuestion
      ? await resolveEventSearchArea({text:userText,location,apiKey:MAPS_KEY,fetchImpl:fetch})
      : null;
    const flightPriceQuestion=priceSearchQuestion&&isFlightPriceQuestion(userText);
    const flightRoute=flightPriceQuestion?extractFlightRoute(userText):'';
    const explicitPriceArea=priceSearchQuestion?extractPriceSearchArea(userText):'';
    const priceTarget=priceSearchQuestion
      ? flightRoute
        ? {area:flightRoute,source:'explicit'}
        : explicitPriceArea
        ? {area:explicitPriceArea,source:'explicit'}
        : await resolveEventSearchArea({
          text:'',
          location,
          apiKey:MAPS_KEY,
          fetchImpl:fetch,
        })
      : null;
    if(eventSearchQuestion&&!eventTarget?.area){
      res.status(200).json({
        text:'Which city or area should I check for upcoming performances? I couldn’t identify your current area, and I won’t guess.',
        venues:[],
        sources:[],
        aiMode:'clarification',
        eventSearchStatus:'location_unavailable',
      });
      return;
    }
    if(priceSearchQuestion&&!priceTarget?.area){
      res.status(200).json({
        text:flightPriceQuestion
          ?'Which departure city and destination should I price? If you only give me a destination, allow location access and I can use your city as the origin.'
          :'Which city or country should I use for the price? Bottle and restaurant prices vary by market.',
        venues:[],
        sources:[],
        aiMode:'clarification',
        priceSearchStatus:'location_unavailable',
      });
      return;
    }
    async function degrade(reason='unknown'){
      if(prefetchedVenues!==null){
        res.status(200).json({text:safeDegradedText(userText,prefetchedVenues),venues:prefetchedVenues,richMetadata:true,aiMode:'fallback',aiFallbackReason:reason});return;
      }
      if(isWeatherQuestion(userText)){
        const summary=weather
          ?weatherFallbackSummary(weather,weatherArea,userText)
          :'I couldn’t retrieve a reliable forecast just now, so I won’t guess. Please try again shortly.';
        res.status(200).json({text:summary,venues:[],aiMode:'fallback',aiFallbackReason:reason,weatherStatus,weather});return;
      }
      if(!maySearchVenues(userText)||isGreeting(userText) || !wantsPlaces(userText)){
        res.status(200).json({text:quick || 'I’m having trouble connecting just now. We can try again in a moment; your conversation is still here.',venues:[],aiMode:'fallback',aiFallbackReason:reason});
        return;
      }
      const wantOpen=/\bopen\b/i.test(userText);
      const q=fallbackQuery(userText),area=extractArea(userText);
      let found=await searchForTurn(q,lat,lng,area,wantOpen);
      found=filterSessionVenues(limitChatVenues(found,userText,q),contents);
      res.status(200).json({text:onlyOpenNow&&!found.length?'I couldn’t confirm anywhere matching that nearby is open right now. Shall we try another area?':safeDegradedText(userText,found),venues:found,richMetadata:true,aiMode:'fallback',aiFallbackReason:reason});
    }
    const clientBudget=await consumeClientDailyBudget(
      db(),
      clientFingerprint(req),
      process.env.PANDA_DAILY_CLIENT_AI_LIMIT,
    );
    if(!clientBudget.allowed){await degrade('client-daily-budget');return;}
    let credentials;
    try{ credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT); }
    catch(e){ await degrade('credentials-config'); return; }
    if(!vertexAuth){
      // Private runtime logs identify the IAM principal without exposing any credential/key.
      console.info(JSON.stringify({
        event:'panda_vertex_identity',
        projectId:credentials.project_id,
        serviceAccountEmail:credentials.client_email,
      }));
      vertexAuth=new GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/cloud-platform']});
    }
    const client=await vertexAuth.getClient();
    const tokenPromise=client.getAccessToken().then(result=>({result}),()=>({failed:true}));
    const projectId=credentials.project_id;
    const convo=compactConversation(contents,{maxItems:12,maxChars:7000});
    const baseBody={contents:convo,tools:[FIND_PLACES_TOOL]};
    baseBody.systemInstruction={parts:[{text:buildChatInstruction(contents,body.chatContext,weather,body.sessionPreferences,body.sessionVenueContext,weatherArea)}]};
    baseBody.systemInstruction.parts[0].text += '\n' + conciergeInstruction(turn,body.chatContext);
    if(isWeatherQuestion(userText)&&!isDirectVenueRequest(userText))delete baseBody.tools;
    if(!maySearchVenues(userText)||sessionVenueTransitFollowUp||groundedLookupQuestion)delete baseBody.tools;
    const maxOutputTokens=boundedInteger(process.env.PANDA_MAX_OUTPUT_TOKENS,320,96,512);
    if(generationConfig||maxOutputTokens){
      baseBody.generationConfig={...(generationConfig||{})};
      if(maxOutputTokens){
        const requested=Number(baseBody.generationConfig.maxOutputTokens);
        baseBody.generationConfig.maxOutputTokens=Number.isFinite(requested)
          ?Math.min(requested,maxOutputTokens)
          :maxOutputTokens;
      }
    }
    if(groundedLookupQuestion){
      // Vertex Google Search grounding cannot be combined with Panda's venue function tool.
      baseBody.tools=[{googleSearch:{}}];
      baseBody.generationConfig={...(baseBody.generationConfig||{}),temperature:1.0};
      baseBody.systemInstruction.parts[0].text+='\n'+(
        eventSearchQuestion
          ?buildLiveShowSearchInstruction(eventTarget.area,eventTarget.source)
          :priceSearchQuestion
            ?buildPriceSearchInstruction(priceTarget.area,priceTarget.source,flightPriceQuestion)
            :buildFeelGoodNewsSearchInstruction(extractEventArea(userText),extractEventArea(userText)?'explicit':'global')
      );
    }
    let venues=[];
    // An explicit venue request needs one grounded model reply, not a model decision plus
    // a second/third inference. Keep the established guarded, shared Places search.
    if(!groundedLookupQuestion&&maySearchVenues(userText)&&(shortcut||isDirectVenueRequest(userText))&&!isWeatherQuestion(userText)&&!sessionVenueTransitFollowUp){
      const area=extractArea(userText);
      const q=sessionVenueQuery(fallbackQuery(userText),contents);
      prefetchedVenues=filterSessionVenues(limitChatVenues(await searchForTurn(q,lat,lng,area,/\bopen\b/i.test(userText),!/\b(all|more|another|different)\b/i.test(userText)),userText,q),contents);
      venues=prefetchedVenues;
      delete baseBody.tools;
      baseBody.systemInstruction.parts[0].text+=`\nVerified venue shortlist: ${venuesToText(venues,userText)}\nAnswer only from this shortlist. If empty, say no matching venues were verified.`;
      if(shortcut)baseBody.systemInstruction.parts[0].text+='\nThese results are within 5 km and ranked by rating in the requested category. Do not claim that dinner opening hours prove kitchen service or table availability. If empty, offer another area; never pad with distant or wrong-category places.';
    }
    const tokenResult=await tokenPromise;
    if(tokenResult.failed){await degrade('vertex-auth-unavailable');return;}
    const {token}=tokenResult.result;
    const cacheLocation={
      lat:Math.round(lat*10000)/10000,
      lng:Math.round(lng*10000)/10000,
      stage:'initial',
    };
    if(groundedLookupQuestion){
      const configuredLookupLimit=process.env.PANDA_LIVE_LOOKUP_MONTHLY_LIMIT
        ??process.env.PANDA_EVENT_GROUNDING_MONTHLY_LIMIT;
      const monthlyLimit=boundedInteger(configuredLookupLimit,10000,1,10000);
      // One shared monthly cap covers grounded show, price and positive-news searches.
      const reservation=await reserveEventGroundingBudget(db(),monthlyLimit,20);
      const statusField=eventSearchQuestion
        ?'eventSearchStatus'
        :priceSearchQuestion
          ?'priceSearchStatus'
          :'newsSearchStatus';
      if(!reservation.allowed){
        const limited=reservation.reason==='limit';
        res.status(limited?200:503).json({
          text:limited
            ?`I’ve reached Panda’s monthly live-search allowance of ${monthlyLimit.toLocaleString()} lookups, so I won’t guess at current information. Please try again next month.`
            :'I can’t verify current information right now, so I won’t guess. Please try again shortly.',
          venues:[],
          sources:[],
          aiMode:limited?'live-search-limit':'fallback',
          [statusField]:limited?'monthly_limit':'unavailable',
        });
        return;
      }
      const lookupResponse=await gemini(
        token,
        projectId,
        baseBody,
        {...cacheLocation,stage:eventSearchQuestion?'grounded-events':priceSearchQuestion?'grounded-prices':'grounded-feel-good-news'},
        {modelLimit:1,timeoutMs:15_000},
      );
      if(!lookupResponse.ok){
        // Keep a conservative charge on provider failure rather than risk an uncounted retry.
        await settleEventGroundingBudget(db(),reservation,10);
        res.status(200).json({
          text:eventSearchQuestion
            ?'I couldn’t verify the artist’s latest or next performance just now, so I won’t guess.'
            :priceSearchQuestion
              ?'I couldn’t verify a current price just now, so I won’t guess. Please try again shortly.'
              :'I couldn’t verify a recent positive news story just now, so I won’t invent one. Please try again shortly.',
          venues:[],
          sources:[],
          aiMode:'fallback',
          [statusField]:'unavailable',
        });
        return;
      }
      const candidate=lookupResponse.data?.candidates?.[0];
      const searches=groundingQueryCount(candidate);
      await settleEventGroundingBudget(db(),reservation,searches);
      recordCostEvent('event_grounding_query_count',{count:searches});
      if(!searches){
        res.status(200).json({
          text:eventSearchQuestion
            ?'Live show search wasn’t available for that request, so I can’t verify dates or ticket prices. I won’t guess.'
            :priceSearchQuestion
              ?'I couldn’t access live price sources for that request, so I won’t guess at a current price.'
              :'I couldn’t access live news sources for that request, so I won’t invent a current story.',
          venues:[],
          sources:[],
          aiMode:'fallback',
          [statusField]:'unavailable',
        });
        return;
      }
      let text=groundedEventText(candidate);
      let sources=groundingSources(candidate);
      let lookupStatus='verified_search';
      const initialSourceCount=sources.length;
      const artistName=eventSearchQuestion?extractArtistName(userText):'';
      const artistClarification=eventSearchQuestion&&isArtistClarification(text);
      const needsOfficialArtistSite=eventSearchQuestion&&Boolean(artistName)&&!artistClarification
        &&(shouldSearchOfficialArtistSite(text)||!sources.length);
      let officialSiteAdded=false;
      const attachOfficialArtistSource=officialSiteSource=>{
        if(!officialSiteSource)return false;
        sources=[
          ...sources.filter(source=>source.url!==officialSiteSource.url).slice(0,5),
          officialSiteSource,
        ];
        officialSiteAdded=true;
        if(!initialSourceCount){
          text=`I couldn’t confirm the performer’s latest or next show in ${eventTarget.area} from live event sources. The verified official artist page is linked below for current dates. 🎟️`;
          lookupStatus='official_site_fallback';
        }
        return true;
      };
      if(needsOfficialArtistSite){
        const officialSiteReservation=await reserveEventGroundingBudget(db(),monthlyLimit,5);
        if(officialSiteReservation.allowed){
          const officialSiteQuestion={
            role:'user',
            parts:[{
              text:`Find the verified first-party official website or official tour page for ${JSON.stringify(artistName)}. Search specifically for “${artistName} official website”. Return no performance dates or prices.`,
            }],
          };
          const officialSiteBody={
            ...baseBody,
            contents:[officialSiteQuestion],
            systemInstruction:{
              parts:[{
                text:buildOfficialArtistWebsiteFallbackInstruction(eventTarget.area,artistName),
              }],
            },
          };
          const officialSiteResponse=await gemini(
            token,
            projectId,
            officialSiteBody,
            {...cacheLocation,stage:'official-site-fallback'},
            {modelLimit:1,timeoutMs:15_000},
          );
          const officialSiteCandidate=officialSiteResponse.data?.candidates?.[0];
          const officialSiteSearches=groundingQueryCount(officialSiteCandidate);
          const chargedSearches=officialSiteResponse.ok?officialSiteSearches:5;
          await settleEventGroundingBudget(db(),officialSiteReservation,chargedSearches);
          recordCostEvent('event_grounding_query_count',{count:chargedSearches});
          const officialSiteSources=groundingSources(officialSiteCandidate);
          const officialSiteSource=officialSiteSources.find(source=>isVerifiedOfficialArtistSource(source,artistName));
          if(officialSiteResponse.ok&&officialSiteSearches>0)attachOfficialArtistSource(officialSiteSource);
        }
        if(!officialSiteAdded){
          const candidateHost=extractArtistWebsiteCandidate(text,artistName);
          const verificationReservation=await reserveEventGroundingBudget(db(),monthlyLimit,5);
          if(verificationReservation.allowed){
            const verificationBody={
              ...baseBody,
              contents:[{
                role:'user',
                parts:[{
                  text:`Verify the official website for ${JSON.stringify(artistName)}. Candidate domain: ${JSON.stringify(candidateHost||'none supplied')}. Search this domain with the artist name; if it is not official, search independently for the official first-party site. Return no performance dates or prices.`,
                }],
              }],
              systemInstruction:{
                parts:[{
                  text:buildOfficialArtistCandidateVerificationInstruction(eventTarget.area,artistName,candidateHost),
                }],
              },
            };
            const verificationResponse=await gemini(
              token,
              projectId,
              verificationBody,
              {...cacheLocation,stage:'official-site-verification-retry'},
              {modelLimit:1,timeoutMs:15_000},
            );
            const verificationCandidate=verificationResponse.data?.candidates?.[0];
            const verificationSearches=groundingQueryCount(verificationCandidate);
            const chargedSearches=verificationResponse.ok?verificationSearches:5;
            await settleEventGroundingBudget(db(),verificationReservation,chargedSearches);
            recordCostEvent('event_grounding_query_count',{count:chargedSearches});
            const verificationSources=groundingSources(verificationCandidate);
            const verifiedSource=verificationSources.find(source=>isVerifiedOfficialArtistSource(source,artistName));
            if(verificationResponse.ok&&verificationSearches>0)attachOfficialArtistSource(verifiedSource);
          }
        }
        text=stripRawUrls(text);
        if(officialSiteAdded){
          if(initialSourceCount)text=`${text} The verified official artist page is linked below.`.trim();
        }else if(initialSourceCount){
          text=`${text} I couldn’t verify a clickable official artist page just now.`.trim();
        }
      }
      if(priceSearchQuestion&&!sources.length){
        const priceRetryReservation=await reserveEventGroundingBudget(db(),monthlyLimit,5);
        if(priceRetryReservation.allowed){
          const priceRetryBody={
            ...baseBody,
            systemInstruction:{
              parts:[{
                text:baseBody.systemInstruction.parts[0].text+'\n'+buildPriceSourceFallbackInstruction(priceTarget.area,flightPriceQuestion),
              }],
            },
          };
          const priceRetryResponse=await gemini(
            token,
            projectId,
            priceRetryBody,
            {...cacheLocation,stage:'grounded-price-recheck'},
            {modelLimit:1,timeoutMs:15_000},
          );
          const priceRetryCandidate=priceRetryResponse.data?.candidates?.[0];
          const priceRetrySearches=groundingQueryCount(priceRetryCandidate);
          const chargedSearches=priceRetryResponse.ok?priceRetrySearches:5;
          await settleEventGroundingBudget(db(),priceRetryReservation,chargedSearches);
          recordCostEvent('event_grounding_query_count',{count:chargedSearches});
          const retrySources=groundingSources(priceRetryCandidate);
          if(priceRetryResponse.ok&&priceRetrySearches>0&&retrySources.length){
            text=groundedEventText(priceRetryCandidate);
            sources=retrySources;
            lookupStatus='verified_price_recheck';
          }
        }
      }
      text=stripRawUrls(text);
      if(!sources.length){
        res.status(200).json({
          text:eventSearchQuestion
            ?artistClarification&&text
              ?text
              :'I couldn’t verify the artist’s last or next performance, ticket prices, or an official website link just now, so I won’t guess. Please try again shortly or tell me the artist’s full name.'
            :priceSearchQuestion
              ?'I couldn’t verify a current price or a reliable price range just now, so I won’t guess. Try again with a city, route or date if you have one.'
              :'I couldn’t verify a recent positive news story just now, so I won’t invent one. Try again shortly.',
          venues:[],
          sources:[],
          aiMode:'fallback',
          [statusField]:'sources_unavailable',
        });
        return;
      }
      res.status(200).json({
        text:text||(
          eventSearchQuestion
            ?'I found live show sources but couldn’t verify a performance clearly enough to give you a date.'
            :priceSearchQuestion
              ?'I found live price sources but couldn’t verify a price clearly enough to quote one.'
              :'I found live news sources but couldn’t verify a positive story clearly enough to share.'
        ),
        venues:[],
        sources,
        aiMode:eventSearchQuestion?'grounded-events':priceSearchQuestion?'grounded-prices':'grounded-news',
        [statusField]:lookupStatus,
      });
      return;
    }
    let resp=await gemini(token,projectId,baseBody,cacheLocation);
    if(!resp.ok){ await degrade(resp.budgetExceeded?'gemini-daily-budget':`vertex-${resp.status||'network'}${resp.failure?':'+resp.failure:''}`); return; }
    let rounds=0;
    const maxToolRounds=boundedInteger(process.env.PANDA_MAX_TOOL_ROUNDS,1,0,1);
    while(rounds<maxToolRounds){
      const cand=resp.data.candidates?.[0];
      const parts=cand?.content?.parts||[];
      const fc=parts.find(p=>p.functionCall);
      if(!fc) break;
      const args=fc.functionCall.args||{};
      const q=args.query||userText;
      const area=extractArea(userText)||args.area||'';
      const wantOpen=/\bopen\b/i.test(q)||/\bopen\b/i.test(userText);
      let found=await searchForTurn(q,lat,lng,area,wantOpen);
      if(found.length) venues=filterSessionVenues(limitChatVenues(found,userText,q),contents);
      convo.push(cand.content);
      convo.push({role:'user',parts:[{functionResponse:{name:'find_places',response:{venues:venuesToText(found,userText)}}}]});
      const nextBody={contents:convo,tools:[FIND_PLACES_TOOL]};
      if(baseBody.systemInstruction)nextBody.systemInstruction=baseBody.systemInstruction;
      if(baseBody.generationConfig)nextBody.generationConfig=baseBody.generationConfig;
      resp=await gemini(token,projectId,nextBody,{...cacheLocation,stage:`tool-${rounds+1}`});
      if(!resp.ok) break;
      rounds++;
    }
    let text=(resp.data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
    if(maySearchVenues(userText)&&prefetchedVenues===null&&!venues.length&&wantsPlaces(userText)&&!isGreeting(userText)&&!isWeatherQuestion(userText)){
      const fallbackArea=extractArea(userText);
      const found=await searchForTurn(fallbackQuery(userText),lat,lng,fallbackArea,false);
      venues=filterSessionVenues(limitChatVenues(found,userText,userText),contents);
    }
    if(!text) text=venues.length?"Here's what I dug up near you \uD83D\uDC3C":pick(NORESULT_LINES);
    venues=limitChatVenues(venues,userText,userText);
    text=venueCardReply(text,venues,turn.searchText || userText);
    if (onlyOpenNow && maySearchVenues(userText) && !venues.length) {
      text = 'I couldn’t confirm anywhere matching that nearby is open right now. Shall we try another area?';
    }
    if (requestedWindow.lateDinner && venues.length && !/\bkitchen\b/i.test(text)) {
      text += ' These are venue opening hours; kitchen service at that time still needs confirmation.';
    }
    res.status(200).json({text,venues,richMetadata:true,aiMode:'vertex',weatherStatus,weather});
  }catch(err){
    try{
      const b=req.body||{};const loc=b.location||{};const lat=loc.lat??DEFAULT_LAT,lng=loc.lng??DEFAULT_LNG;
      if (b.newOpeningsOnly === true || conciergeTurn(b.contents).wantsNew) {
        res.status(503).json({status:'verification_unavailable',newOpeningsSearch:true,venues:[],
          text:'The OpenTable New selection could not be verified just now. I won’t substitute ordinary restaurants.'});return;
      }
      if (conciergeTimeWindow(conciergeTurn(b.contents).searchText,b.chatContext).lateDinner) {
        res.status(503).json({venues:[],text:'I couldn’t verify the late-night opening hours just now. I won’t guess which kitchens are still serving.'});return;
      }
      const ut=latestUserText(b.contents);
      if(isWeatherQuestion(ut)){res.status(200).json({text:'Live weather is unavailable right now, so I won’t guess.',venues:[],aiMode:'fallback',aiFallbackReason:'backend_error'});return;}
      if(maySearchVenues(ut)&&isPubCrawlRequest(ut)){res.status(200).json(await buildCustomPubCrawl(ut,lat,lng));return;}
      if(!maySearchVenues(ut)||isGreeting(ut)||!wantsPlaces(ut)){res.status(200).json({text:quickChatReply(ut,b.chatContext,b.contents)||'The conversational AI is temporarily unavailable. I can still help with verified venue searches and directions.',venues:[],aiMode:'fallback',aiFallbackReason:'backend_error'});return;}
      const openOnly=wantsOpenNow(ut);
      const candidates=(await searchVenuesSmart(fallbackQuery(ut),lat,lng,extractArea(ut),openOnly)).venues || [];
      const found=limitChatVenues(openOnly?candidates.filter(venue=>venue.openNow===true):candidates,ut,ut);
      res.status(200).json({text:safeDegradedText(ut,found),venues:found,richMetadata:true,aiMode:'fallback',aiFallbackReason:'backend_error'});
    }
    catch(e){res.status(200).json({text:"I glitched for a second \u2014 give that another go.",venues:[]});}
  }
}
