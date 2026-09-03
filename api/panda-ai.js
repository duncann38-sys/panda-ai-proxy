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
const CACHE_TTL_MS   = 30 * 60 * 1000;
const CACHE_GRID     = 1000;
const CACHE_COLLECTION = 'places_cache_v2';
const GEO_COLLECTION = 'geocode_cache_v2';
const MEMORY_CACHE_LIMIT = 250;
const memoryCache = new Map();
const inFlightSearches = new Map();
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
  const raw=`${(query||'').toLowerCase().trim()}|${gLat},${gLng}|o${openNow===true?1:0}|p${pageToken||''}`;
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
  return {venues:withDistances(cached.venues,lat,lng),nextPageToken:cached.nextPageToken||null,cached:true};
}
function writeMemoryCache(key,result){
  memoryCache.delete(key);
  memoryCache.set(key,{ts:Date.now(),venues:result.venues,nextPageToken:result.nextPageToken||null});
  while(memoryCache.size>MEMORY_CACHE_LIMIT)memoryCache.delete(memoryCache.keys().next().value);
}
function googleCategoryTags(place,query){
  const types=new Set((place.types||[]).map(type=>String(type).toLowerCase()));
  const primaryType=String(place.primaryType||place.types?.[0]||'').toLowerCase();
  const text=`${place.displayName?.text||''} ${place.primaryTypeDisplayName?.text||''}`.toLowerCase();
  const hospitality=new Set(['bar','breakfast_restaurant','brunch_restaurant','cafe','coffee_shop','dessert_restaurant','fast_food_restaurant','fine_dining_restaurant','food_court','hamburger_restaurant','meal_delivery','meal_takeaway','night_club','pub','restaurant','wine_bar']);
  const shops=new Set(['candy_store','convenience_store','dessert_shop','grocery_store','ice_cream_shop','liquor_store','market','shopping_mall','store','supermarket','wine_store']);
  const interests=new Set(['amusement_center','amusement_park','aquarium','art_gallery','botanical_garden','cultural_landmark','garden','historical_landmark','historical_place','marina','monument','museum','national_park','observation_deck','park','plaza','tourist_attraction','visitor_center','zoo']);
  const hasHospitality=[...types].some(type=>hospitality.has(type))||/(restaurant|cafe|coffee|bar|pub|night club|food court|takeaway)/.test(String(place.primaryTypeDisplayName?.text||'').toLowerCase());
  const primaryHospitality=hospitality.has(primaryType)||/(restaurant|cafe|coffee|bar|pub|night club|food court|takeaway)/.test(String(place.primaryTypeDisplayName?.text||'').toLowerCase());
  if(!primaryHospitality&&interests.has(primaryType))return ['Places of Interest'];
  if(!primaryHospitality&&(shops.has(primaryType)||primaryType==='bakery'))return ['Shops'];
  if(!hasHospitality){
    if([...types].some(type=>interests.has(type)))return ['Places of Interest'];
    if([...types].some(type=>shops.has(type))||types.has('bakery'))return ['Shops'];
  }
  const tags=new Set();
  const add=(tag,ok)=>{if(ok)tags.add(tag);};
  const q=String(query||'').toLowerCase();
  const cuisine=[['Indian','indian_restaurant'],['Italian','italian_restaurant'],['Chinese','chinese_restaurant'],['Spanish','spanish_restaurant'],['French','french_restaurant'],['British','british_restaurant'],['Japanese','japanese_restaurant'],['Mexican','mexican_restaurant'],['Turkish','turkish_restaurant'],['American','american_restaurant'],['Lebanese','lebanese_restaurant'],['Thai','thai_restaurant'],['Pizza','pizza_restaurant'],['Burgers','hamburger_restaurant']];
  cuisine.forEach(([tag,type])=>add(tag,types.has(type)));
  [['Indian','indian'],['Italian','italian'],['Chinese','chinese'],['Spanish','spanish|tapas'],['French','french'],['British','british'],['Japanese','japanese|sushi'],['Mexican','mexican'],['Turkish','turkish'],['American','american|diner|burger'],['Lebanese','lebanese|middle eastern|levantine'],['Thai','thai']].forEach(([tag,pattern])=>add(tag,hasHospitality&&new RegExp(`\\b(${pattern})\\b`).test(q)));
  add('Meat',types.has('steak_house')||/\b(steak|grill|barbecue|bbq|churrasco|roast)\b/.test(text)||hasHospitality&&/\b(meat|steak|grill)\b/.test(q));
  add('Chicken',types.has('chicken_restaurant')||/\b((fried|grilled|roast)\s+)?chicken\b/.test(text)||hasHospitality&&/\bchicken\b/.test(q));
  add('Pizza',types.has('pizza_restaurant')||/\bpizza\b/.test(text)||hasHospitality&&/\bpizza\b/.test(q));
  add('Burgers',types.has('hamburger_restaurant')||/\bburger\b/.test(text)||hasHospitality&&/\bburgers?\b/.test(q));
  const coffee=types.has('cafe')||types.has('coffee_shop')||/\b(cafe|coffee)\b/.test(String(place.primaryTypeDisplayName?.text||'').toLowerCase());
  const pub=types.has('pub')||/\b(pub|gastropub)\b/.test(String(place.primaryTypeDisplayName?.text||'').toLowerCase());
  const bar=types.has('bar')||types.has('wine_bar')||/\b(bar|cocktail)\b/.test(String(place.primaryTypeDisplayName?.text||'').toLowerCase());
  const restaurant=hasHospitality&&!coffee&&!pub&&!bar&&!types.has('night_club');
  add('Coffee',coffee);
  add('Pubs',pub);
  add('Bar',bar||hasHospitality&&/\b(cocktail|wine bar|bars?)\b/.test(q));
  add('Drinks',bar||pub||types.has('night_club')||hasHospitality&&/\b(cocktail|drinks?|wine bar)\b/.test(q));
  add('Nightlife',types.has('night_club')||types.has('dance_hall')||types.has('event_venue')||types.has('performing_arts_theater')||hasHospitality&&/\b(nightlife|clubs?|live music|sports bars?|entertainment)\b/.test(q));
  add('Live Music',place.hasMusic===true||/\b(live music|music venue|concert|karaoke)\b/.test(text)||hasHospitality&&/\b(live music|dj)\b/.test(q));
  add('Sports',/\b(sports bar|football bar)\b/.test(text)||hasHospitality&&/\b(sports?|football)\b/.test(q));
  add('Dessert',types.has('dessert_restaurant')||types.has('dessert_shop')||types.has('ice_cream_shop')||types.has('bakery')||(hasHospitality||types.has('bakery'))&&/\b(dessert|cake|ice cream|patisserie)\b/.test(q));
  add('Breakfast',(hasHospitality||coffee)&&(/\b(breakfast|morning food)\b/.test(q)||types.has('breakfast_restaurant')));
  add('Brunch',hasHospitality&&(/\bbrunch\b/.test(q)||types.has('brunch_restaurant')));
  add('Bottomless',hasHospitality&&(/\bbottomless\b/.test(q)||/\bbottomless\b/.test(text)));
  add('Lunch',restaurant||coffee||pub||/\blunch\b/.test(q));
  add('Dinner',restaurant||pub||bar||/\bdinner\b/.test(q));
  if(!tags.size&&hasHospitality){tags.add('Lunch');tags.add('Dinner');}
  return [...tags];
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
        'X-Goog-FieldMask':['places.id','places.displayName','places.formattedAddress','places.shortFormattedAddress','places.location','places.rating','places.userRatingCount','places.priceLevel','places.priceRange','places.primaryType','places.primaryTypeDisplayName','places.types','places.googleMapsUri','places.websiteUri','places.nationalPhoneNumber','places.currentOpeningHours.openNow','places.currentOpeningHours.weekdayDescriptions','places.regularOpeningHours.weekdayDescriptions','places.businessStatus','places.photos','nextPageToken'].join(',')},
      body:JSON.stringify(reqBody)
    });
    if(!r.ok) return {venues:[],nextPageToken:null};
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
        businessStatus:p.businessStatus||'',types:p.types||[],hasMusic:!!musicBadge,musicBadge,
        lat:loc.latitude??null,lng:loc.longitude??null,
        phone:p.nationalPhoneNumber||'',website:p.websiteUri||'',menuLink:p.websiteUri||'',
        mapsUri:p.googleMapsUri||'',directionsLink:p.googleMapsUri||'',
         photoName:photo?photo.name:'',photoAttribution:attr,photoCount:Math.min(10,placePhotos.length),categories:googleCategoryTags({...p,hasMusic:!!musicBadge},query)};
    });
    return {venues,nextPageToken:data.nextPageToken||null};
  }catch{return {venues:[],nextPageToken:null}}
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
  if(store && key){
    try{
      const snap=await store.collection(CACHE_COLLECTION).doc(key).get();
      if(snap.exists){
        const d=snap.data();
        if(d && (Date.now()-d.ts) < CACHE_TTL_MS){
          const result={venues:withDistances(d.venues,lat,lng),nextPageToken:d.nextPageToken||null,cached:true};
          writeMemoryCache(memoryKey,result);
          return result;
        }
      }
    }catch(e){ }
  }
  const fresh=await googleSearch(query,lat,lng,pageToken,openNow);
  writeMemoryCache(memoryKey,fresh);
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
  })();
  inFlightSearches.set(memoryKey,searchPromise);
  try{return await searchPromise;}finally{inFlightSearches.delete(memoryKey);}
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
      if(viaText.venues && viaText.venues.length) return viaText;
      // last resort: text search without location weighting removed — still area-tagged
      return strictLocationResult(await searchVenues(`${query} ${area}`, userLat, userLng, null, openNow),area);
    }
  }
  return strictLocationResult(await searchVenues(query,lat,lng,null,openNow),area);
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
  const match=String(text||'').match(/\b(?:in|near|around|at)\s+(.+?)(?:\s+(?:tonight|today|tomorrow|please|for me))?\s*$/i);
  const area=match?.[1]?.trim().replace(/[,.!?]+$/,'')||'';
  return /^(me|here)$/i.test(area)?'':area;
}
function isThemedRequest(text){return /\b(pub crawl|crawl|cozy|cosy|cheap|expensive|christmas|theme|live music|dj|music)\b/i.test(String(text||''));}
function limitChatVenues(venues,userText,query){return isThemedRequest(`${userText||''} ${query||''}`)?(venues||[]).slice(0,6):(venues||[]);}
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
function wantsPlaces(t){return PLACE_RE.test(t||'');}
function fallbackQuery(text){
  const t=(text||'').toLowerCase();
  const map=[
    [/\b(live music|dj|music)\b/,'live music venues and bars'],
    [/\b(pub crawl|crawl)\b/,'pubs and bars'],
    [/\b(meat|steak)\b/,'steak and meat restaurants'],
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
  description:"Search real venues for ANY going-out intent — restaurants, bars, wine bars, pubs, cafes; lunch/brunch/dinner; cheap eats and budget spots; date-night; specific cuisines or drinks; places to WATCH FOOTBALL or sport; live music; rooftops; themed nights; pub crawls. Call it whenever the user wants somewhere to go, eat, drink, or something to do out. Do NOT call it for pure greetings, thanks or small talk. If the user names a SPECIFIC venue, pass that exact name as the query. If the user names a CITY, COUNTRY, NEIGHBOURHOOD, area, postcode or place (e.g. 'in Manchester', 'in New York', 'near London Bridge', 'SW1'), pass it in `area`. Area searches are worldwide; never assume the UK. For themed or pub-crawl requests, return the best six venues and include live music/DJ matches where relevant. If the user asks when a specific venue closes, answer with that venue's closing time for today; do not recite the weekly schedule unless explicitly requested. If the user refers to a saved place like 'near my work' or 'near home' and coordinates for it were provided in the conversation, you may pass that area name too.",
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
    if(body.venuesOnly){
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
    const userText=latestUserText(contents);
    if(isPubCrawlRequest(userText)){res.status(200).json(await buildCustomPubCrawl(userText,lat,lng));return;}
    async function degrade(){
      if(isGreeting(userText) || !wantsPlaces(userText)){
        res.status(200).json({text:pick(GREET_LINES),venues:[]});
        return;
      }
      const wantOpen=/\bopen\b/i.test(userText);
      const q=fallbackQuery(userText),area=extractArea(userText);
      let found=(await searchVenuesSmart(q,lat,lng,area,wantOpen)).venues;
      if(!found.length){found=(await searchVenuesSmart('restaurants and bars',lat,lng,area,false)).venues;}
      found=limitChatVenues(found,userText,q);
      res.status(200).json({text:found.length?"Grabbed a few spots near you \uD83D\uDC3C":pick(NORESULT_LINES),venues:found,richMetadata:true});
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
      const area=extractArea(userText)||args.area||'';
      const wantOpen=/\bopen\b/i.test(q)||/\bopen\b/i.test(userText);
      let found=(await searchVenuesSmart(q,lat,lng,area,wantOpen)).venues;
      if(!found.length){const broad=(userText||q).split(' ').slice(0,4).join(' ')+' restaurants bars';found=(await searchVenuesSmart(broad,lat,lng,area,false)).venues;}
      if(found.length) venues=limitChatVenues(found,userText,q);
      convo.push(cand.content);
      convo.push({role:'user',parts:[{functionResponse:{name:'find_places',response:{venues:venuesToText(found,userText)}}}]});
      const nextBody={contents:convo,tools:[FIND_PLACES_TOOL]};
      if(baseBody.systemInstruction)nextBody.systemInstruction=baseBody.systemInstruction;
      if(generationConfig)nextBody.generationConfig=generationConfig;
      resp=await gemini(token,projectId,nextBody);
      if(!resp.ok) break;
      rounds++;
    }
    let text=(resp.data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
    if(!venues.length&&wantsPlaces(userText)&&!isGreeting(userText)){
      const fallbackArea=extractArea(userText);
      const found=(await searchVenuesSmart(fallbackQuery(userText),lat,lng,fallbackArea,false)).venues;
      venues=limitChatVenues(found,userText,userText);
    }
    if(!text) text=venues.length?"Here's what I dug up near you \uD83D\uDC3C":pick(NORESULT_LINES);
    venues=limitChatVenues(venues,userText,userText);
    res.status(200).json({text,venues,richMetadata:true});
  }catch(err){
    try{
      const b=req.body||{};const loc=b.location||{};const lat=loc.lat??DEFAULT_LAT,lng=loc.lng??DEFAULT_LNG;
      const ut=latestUserText(b.contents);
      if(isPubCrawlRequest(ut)){res.status(200).json(await buildCustomPubCrawl(ut,lat,lng));return;}
      if(isGreeting(ut)||!wantsPlaces(ut)){res.status(200).json({text:pick(GREET_LINES),venues:[]});return;}
      const found=limitChatVenues((await searchVenuesSmart(fallbackQuery(ut),lat,lng,extractArea(ut))).venues,ut,ut);
      res.status(200).json({text:found.length?"Here are some nearby spots \uD83D\uDC3C":pick(NORESULT_LINES),venues:found,richMetadata:true});
    }
    catch(e){res.status(200).json({text:"I glitched for a second \u2014 give that another go.",venues:[]});}
  }
}
