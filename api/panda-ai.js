// Panda AI proxy — Vercel serverless function.
// - venuesOnly mode: direct Google Places search for the Discover feed (no Gemini).
// - chat mode: Gemini decides (via function calling) WHEN to search venues.
// CACHING: every Google Places lookup goes through searchVenues(), cached ~10 min.
// HARDENED: origin allow-list + rate limiting via ./_guard.js.
// UPGRADE: find_places accepts optional `area` (e.g. "Mayfair"), geocoded so the
//   search centres on that place, not the user's GPS.
import { GoogleAuth } from 'google-auth-library';
import admin from 'firebase-admin';
import { applyGuard } from './_guard.js';
const MODELS = (process.env.PANDA_MODEL
  ? [process.env.PANDA_MODEL]
  : ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']);
const LOCATION = process.env.PANDA_LOCATION || 'us-central1';
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DEFAULT_LAT = 51.5074, DEFAULT_LNG = -0.1278;
const PRICE = {PRICE_LEVEL_INEXPENSIVE:'\u00a3',PRICE_LEVEL_MODERATE:'\u00a3\u00a3',PRICE_LEVEL_EXPENSIVE:'\u00a3\u00a3\u00a3',PRICE_LEVEL_VERY_EXPENSIVE:'\u00a3\u00a3\u00a3\u00a3'};
const CACHE_TTL_MS   = 10 * 60 * 1000;
const CACHE_GRID     = 100;
const CACHE_COLLECTION = 'places_cache';
const GEO_COLLECTION = 'geocode_cache';
let _db = null, _dbTried = false;
function db(){
  if(_dbTried) return _db;
  _dbTried = true;
  try{
    if(!process.env.FIREBASE_SERVICE_ACCOUNT) return (_db=null);
    if(!admin.apps.length){
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    _db = admin.firestore();
  }catch(e){ _db = null; }
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
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(area)}&key=${MAPS_KEY}`;
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
  const raw=`${(query||'').toLowerCase().trim()}|${gLat},${gLng}|o${openNow===true?1:0}|p${pageToken||''}`;
  return Buffer.from(raw).toString('base64').replace(/\//g,'_').slice(0,480);
}
function withDistances(rawVenues,lat,lng){
  return (rawVenues||[]).map(v=>({
    ...v,
    distanceMeters: (v.lat!=null && v.lng!=null) ? distMeters(lat,lng,v.lat,v.lng) : null
  })).sort((a,b)=>(a.distanceMeters??9e9)-(b.distanceMeters??9e9));
}
async function googleSearch(query,lat,lng,pageToken,openNow){
  if(!MAPS_KEY||!query) return {venues:[],nextPageToken:null};
  try{
    const reqBody={textQuery:query,maxResultCount:20,rankPreference:'DISTANCE',locationBias:{circle:{center:{latitude:lat,longitude:lng},radius:6000.0}}};
    if(openNow===true) reqBody.openNow=true;
    if(pageToken) reqBody.pageToken=pageToken;
    const r=await fetch('https://places.googleapis.com/v1/places:searchText',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Goog-Api-Key':MAPS_KEY,
        'X-Goog-FieldMask':['places.id','places.displayName','places.formattedAddress','places.shortFormattedAddress','places.location','places.rating','places.userRatingCount','places.priceLevel','places.primaryTypeDisplayName','places.googleMapsUri','places.websiteUri','places.nationalPhoneNumber','places.currentOpeningHours.openNow','places.photos','nextPageToken'].join(',')},
      body:JSON.stringify(reqBody)
    });
    if(!r.ok) return {venues:[],nextPageToken:null};
    const data=await r.json();
    const places=data.places||[];
    const venues=places.map(p=>{
      const loc=p.location||{};const photo=(p.photos&&p.photos[0])||null;
      const attr=photo&&photo.authorAttributions&&photo.authorAttributions[0]?photo.authorAttributions[0].displayName:'';
      return {id:p.id,name:p.displayName?.text||'Unknown',type:p.primaryTypeDisplayName?.text||'',
        address:p.shortFormattedAddress||p.formattedAddress||'',fullAddress:p.formattedAddress||'',
        rating:p.rating||null,ratingCount:p.userRatingCount||null,price:PRICE[p.priceLevel]||'',
        openNow:(p.currentOpeningHours&&typeof p.currentOpeningHours.openNow==='boolean')?p.currentOpeningHours.openNow:null,
        lat:loc.latitude??null,lng:loc.longitude??null,
        phone:p.nationalPhoneNumber||'',website:p.websiteUri||'',mapsUri:p.googleMapsUri||'',
        photoName:photo?photo.name:'',photoAttribution:attr};
    });
    return {venues,nextPageToken:data.nextPageToken||null};
  }catch{return {venues:[],nextPageToken:null}}
}
async function searchVenues(query,lat,lng,pageToken,openNow){
  if(!MAPS_KEY||!query) return {venues:[],nextPageToken:null};
  const store=db();
  const key = store ? cacheKey(query,lat,lng,openNow,pageToken) : null;
  if(store && key){
    try{
      const snap=await store.collection(CACHE_COLLECTION).doc(key).get();
      if(snap.exists){
        const d=snap.data();
        if(d && (Date.now()-d.ts) < CACHE_TTL_MS){
          return { venues: withDistances(d.venues, lat, lng), nextPageToken: d.nextPageToken||null, cached:true };
        }
      }
    }catch(e){ }
  }
  const fresh=await googleSearch(query,lat,lng,pageToken,openNow);
  if(store && key && fresh.venues.length){
    try{
      await store.collection(CACHE_COLLECTION).doc(key).set({
        ts: Date.now(),
        venues: fresh.venues,
        nextPageToken: fresh.nextPageToken||null,
        q: (query||'').slice(0,120)
      });
    }catch(e){ }
  }
  return { venues: withDistances(fresh.venues, lat, lng), nextPageToken: fresh.nextPageToken||null, cached:false };
}
async function searchVenuesSmart(query,userLat,userLng,area,openNow){
  let lat=userLat, lng=userLng;
  if(area){
    const geo = await geocodeArea(area);
    if(geo){ lat=geo.lat; lng=geo.lng; }
  }
  return searchVenues(query,lat,lng,null,openNow);
}
function fmtDist(m){return m==null?'':(m<1000?`${m} m`:`${(m/1000).toFixed(1)} km`);}
function venuesToText(v){if(!v.length)return 'No matching venues found nearby.';return v.slice(0,15).map((x,i)=>{const bits=[x.type,fmtDist(x.distanceMeters),x.rating?`${x.rating}\u2605`:'',x.price,x.openNow===true?'open now':x.openNow===false?'closed':''].filter(Boolean).join(' \u00b7 ');return `${i+1}. ${x.name}${bits?' \u2014 '+bits:''}`;}).join('\n');}
function latestUserText(contents){if(!Array.isArray(contents))return '';for(let i=contents.length-1;i>=0;i--){const c=contents[i];if(c?.role==='user'&&Array.isArray(c.parts)){const t=c.parts.map(p=>p.text||'').join(' ').trim();if(t)return t;}}return '';}
const GREET_RE=/^\s*(hi+|hey+|hello+|yo+|sup|hiya|howdy|heya|good\s?(morning|afternoon|evening|day)|thanks|thank\s?you|cheers|ta|nice one|ok(ay)?|cool|nice|lol|haha|hah| | | )\s*[!.?]*\s*$/i;
const PLACE_RE=/\b(eat|food|lunch|dinner|breakfast|brunch|coffee|drink|drinks|bar|pub|wine|beer|cocktail|restaurant|cafe|takeaway|book|table|rooftop|club|night|date|hungry|thirsty|steak|pizza|sushi|burger|ramen|curry|tapas|brunch|football|match|watch|near|nearby|around|open|cheap|budget|fancy|vegan|halal|£|\$)\b/i;
function isGreeting(t){return GREET_RE.test((t||'').trim());}
function wantsPlaces(t){return PLACE_RE.test(t||'');}
function fallbackQuery(text){
  const t=(text||'').toLowerCase();
  const map=[
    [/\b(club|clubbing|night ?out|big night|rave|party|dance)\b/,'nightclubs and bars'],
    [/\b(cocktail|drinks?|pub|wine|beer|booze)\b/,'bars and pubs'],
    [/\b(coffee|cafe|espresso|flat white)\b/,'coffee shops'],
    [/\b(breakfast|brunch)\b/,'brunch and breakfast'],
    [/\b(lunch)\b/,'lunch restaurants'],
    [/\b(football|match|sport|game)\b/,'sports bars showing football'],
    [/\b(date|romantic|anniversary)\b/,'romantic restaurants'],
    [/\b(dinner|eat|food|hungry|restaurant|meal|takeaway)\b/,'restaurants'],
  ];
  for(const [re,q] of map){ if(re.test(t)) return q; }
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
async function gemini(token,projectId,body){
  let last={ok:false,status:0,data:{}};
  for(const model of MODELS){
    try{
      const url=`https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`;
      const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await r.json().catch(()=>({}));
      if(r.ok) return {ok:true,status:r.status,data};
      last={ok:false,status:r.status,data};
      if(r.status!==404 && r.status!==400) return last;
    }catch(e){ last={ok:false,status:500,data:{error:String(e)}}; }
  }
  return last;
}
const FIND_PLACES_TOOL={functionDeclarations:[{
  name:'find_places',
  description:"Search real venues for ANY going-out intent — restaurants, bars, wine bars, pubs, cafes; lunch/brunch/dinner; cheap eats and budget spots; date-night; specific cuisines or drinks; places to WATCH FOOTBALL or sport; live music; rooftops. Call it whenever the user wants somewhere to go, eat, drink, or something to do out. Do NOT call it for pure greetings, thanks or small talk. If the user names a SPECIFIC venue, pass that exact name as the query. If the user names a NEIGHBOURHOOD, area, postcode or place (e.g. 'in Mayfair', 'near London Bridge', 'SW1'), pass it in `area`. If the user refers to a saved place like 'near my work' or 'near home' and coordinates for it were provided in the conversation, you may pass that area name too.",
  parameters:{type:'object',properties:{
    query:{type:'string',description:"A concise Google Places query capturing the food/drink intent, e.g. 'french restaurants', 'affordable lunch', 'rooftop cocktail bars', 'sports bars showing football'."},
    area:{type:'string',description:"Optional. A neighbourhood, area, postcode or landmark to centre the search on, e.g. 'Mayfair', 'Shoreditch', 'SW1A', 'near Borough Market'. Omit entirely for 'near me' searches."}
  },required:['query']}
}]};
export default async function handler(req,res){
  if(applyGuard(req,res,{methods:['POST','OPTIONS'],limit:true})) return;
  try{
    const body=req.body||{};
    const {systemInstruction,contents,generationConfig,location}=body;
    const lat=location?.lat??DEFAULT_LAT, lng=location?.lng??DEFAULT_LNG;
    if(body.venuesOnly){const {venues,nextPageToken}=await searchVenues(body.query,lat,lng,body.pageToken);res.status(200).json({venues,nextPageToken});return;}
    const userText=latestUserText(contents);
    async function degrade(){
      if(isGreeting(userText) || !wantsPlaces(userText)){
        res.status(200).json({text:pick(GREET_LINES),venues:[]});
        return;
      }
      const wantOpen=/\bopen\b/i.test(userText);
      const q=fallbackQuery(userText);
      let found=(await searchVenues(q,lat,lng,null,wantOpen)).venues;
      if(!found.length){found=(await searchVenues('restaurants and bars',lat,lng)).venues;}
      res.status(200).json({text:found.length?"Grabbed a few spots near you \uD83D\uDC3C":pick(NORESULT_LINES),venues:found});
    }
    let credentials;
    try{ credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT); }
    catch(e){ await degrade(); return; }
    const auth=new GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/cloud-platform']});
    const client=await auth.getClient();
    const {token}=await client.getAccessToken();
    const projectId=credentials.project_id;
    const convo=Array.isArray(contents)?contents.slice():[];
    const baseBody={contents:convo,tools:[FIND_PLACES_TOOL]};
    if(systemInstruction)baseBody.systemInstruction=systemInstruction.parts?systemInstruction:{parts:[{text:String(systemInstruction)}]};
    if(generationConfig)baseBody.generationConfig=generationConfig;
    let venues=[];
    let resp=await gemini(token,projectId,baseBody);
    if(!resp.ok){ await degrade(); return; }
    let rounds=0;
    while(rounds<2){
      const cand=resp.data.candidates?.[0];
      const parts=cand?.content?.parts||[];
      const fc=parts.find(p=>p.functionCall);
      if(!fc) break;
      const args=fc.functionCall.args||{};
      const q=args.query||userText;
      const area=args.area||'';
      const wantOpen=/\bopen\b/i.test(q)||/\bopen\b/i.test(userText);
      let found=(await searchVenuesSmart(q,lat,lng,area,wantOpen)).venues;
      if(!found.length){const broad=(userText||q).split(' ').slice(0,4).join(' ')+' restaurants bars';found=(await searchVenuesSmart(broad,lat,lng,area,false)).venues;}
      if(found.length) venues=found;
      convo.push(cand.content);
      convo.push({role:'user',parts:[{functionResponse:{name:'find_places',response:{venues:venuesToText(found)}}}]});
      const nextBody={contents:convo,tools:[FIND_PLACES_TOOL]};
      if(baseBody.systemInstruction)nextBody.systemInstruction=baseBody.systemInstruction;
      if(generationConfig)nextBody.generationConfig=generationConfig;
      resp=await gemini(token,projectId,nextBody);
      if(!resp.ok) break;
      rounds++;
    }
    let text=(resp.data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
    if(!text) text=venues.length?"Here's what I dug up near you \uD83D\uDC3C":pick(NORESULT_LINES);
    res.status(200).json({text,venues});
  }catch(err){
    try{
      const b=req.body||{};const loc=b.location||{};const lat=loc.lat??DEFAULT_LAT,lng=loc.lng??DEFAULT_LNG;
      const ut=latestUserText(b.contents);
      if(isGreeting(ut)||!wantsPlaces(ut)){res.status(200).json({text:pick(GREET_LINES),venues:[]});return;}
      const found=(await searchVenues(fallbackQuery(ut),lat,lng)).venues;
      res.status(200).json({text:found.length?"Here are some nearby spots \uD83D\uDC3C":pick(NORESULT_LINES),venues:found});
    }
    catch(e){res.status(200).json({text:"I glitched for a second \u2014 give that another go.",venues:[]});}
  }
}
