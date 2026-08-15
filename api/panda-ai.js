
// Panda AI proxy — Vercel serverless function. (for our Launch)
// - venuesOnly mode: direct Google Places search for the Discover feed (no Gemini).
// - chat mode: Gemini decides (via function calling) WHEN to search venues, so
//   "hi" gets a friendly reply and cards only appear when you actually ask for places.

import { GoogleAuth } from 'google-auth-library';

const MODEL = process.env.PANDA_MODEL || 'gemini-2.5-flash';
const LOCATION = process.env.PANDA_LOCATION || 'us-central1';
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DEFAULT_LAT = 51.5074, DEFAULT_LNG = -0.1278;

const PRICE = {PRICE_LEVEL_INEXPENSIVE:'\u00a3',PRICE_LEVEL_MODERATE:'\u00a3\u00a3',PRICE_LEVEL_EXPENSIVE:'\u00a3\u00a3\u00a3',PRICE_LEVEL_VERY_EXPENSIVE:'\u00a3\u00a3\u00a3\u00a3'};

function distMeters(aLat,aLng,bLat,bLng){const R=6371000,toRad=x=>x*Math.PI/180;const dLat=toRad(bLat-aLat),dLng=toRad(bLng-aLng);const s=Math.sin(dLat/2)**2+Math.cos(toRad(aLat))*Math.cos(toRad(bLat))*Math.sin(dLng/2)**2;return Math.round(2*R*Math.asin(Math.sqrt(s)));}

async function searchVenues(query,lat,lng,pageToken){
  if(!MAPS_KEY||!query) return {venues:[],nextPageToken:null};
  try{
    const reqBody={textQuery:query,maxResultCount:20,rankPreference:'DISTANCE',locationBias:{circle:{center:{latitude:lat,longitude:lng},radius:6000.0}}};
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
        distanceMeters:loc.latitude!=null?distMeters(lat,lng,loc.latitude,loc.longitude):null,
        phone:p.nationalPhoneNumber||'',website:p.websiteUri||'',mapsUri:p.googleMapsUri||'',
        photoName:photo?photo.name:'',photoAttribution:attr};
    }).sort((a,b)=>(a.distanceMeters??9e9)-(b.distanceMeters??9e9));
    return {venues,nextPageToken:data.nextPageToken||null};
  }catch{return {venues:[],nextPageToken:null}}
}

function fmtDist(m){return m==null?'':(m<1000?`${m} m`:`${(m/1000).toFixed(1)} km`);}
function venuesToText(v){if(!v.length)return 'No matching venues found nearby.';return v.slice(0,8).map((x,i)=>{const bits=[x.type,fmtDist(x.distanceMeters),x.rating?`${x.rating}\u2605`:'',x.price,x.openNow===true?'open now':x.openNow===false?'closed':''].filter(Boolean).join(' \u00b7 ');return `${i+1}. ${x.name}${bits?' \u2014 '+bits:''}`;}).join('\n');}
function latestUserText(contents){if(!Array.isArray(contents))return '';for(let i=contents.length-1;i>=0;i--){const c=contents[i];if(c?.role==='user'&&Array.isArray(c.parts))return c.parts.map(p=>p.text||'').join(' ').trim();}return '';}

const FIND_PLACES_TOOL={function_declarations:[{
  name:'find_places',
  description:"Search real venues near the user for ANY going-out intent — restaurants, bars, wine bars, pubs, cafes; lunch/brunch/dinner; cheap eats and budget spots; date-night; specific cuisines or drinks (rose wine, natural wine, cocktails); places to WATCH FOOTBALL or sport; live music; rooftops. Call it whenever the user wants somewhere to go, eat, drink, or something to do out. Do NOT call it for pure greetings, thanks or small talk. Also call it when the user names a SPECIFIC venue - pass that exact name as the query. Craft the query to match the intent precisely so results stay on-subject.",
  parameters:{type:'object',properties:{query:{type:'string',description:"A concise Google Places query capturing the intent, e.g. 'affordable lunch restaurants', 'rose wine bars', 'sports bars showing football', 'romantic dinner', 'rooftop cocktail bars', 'live music venues'."}},required:['query']}
}]};

async function gemini(token,projectId,body){
  const url=`https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {ok:r.ok,status:r.status,data:await r.json()};
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin',process.env.ALLOWED_ORIGIN||'*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.status(204).end();return;}
  if(req.method!=='POST'){res.status(405).json({error:'POST only'});return;}

  try{
    const body=req.body||{};
    const {systemInstruction,contents,generationConfig,location}=body;
    const lat=location?.lat??DEFAULT_LAT, lng=location?.lng??DEFAULT_LNG;

    // FAST PATH: Discover feed
    if(body.venuesOnly){const {venues,nextPageToken}=await searchVenues(body.query,lat,lng,body.pageToken);res.status(200).json({venues,nextPageToken});return;}

    // CHAT PATH with function calling
    const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    const auth=new GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/cloud-platform']});
    const client=await auth.getClient();
    const {token}=await client.getAccessToken();
    const projectId=credentials.project_id;

    const convo=Array.isArray(contents)?contents.slice():[];
    const baseBody={contents:convo,tools:[FIND_PLACES_TOOL]};
    if(systemInstruction)baseBody.systemInstruction=systemInstruction.parts?systemInstruction:{parts:[{text:String(systemInstruction)}]};
    if(generationConfig)baseBody.generationConfig=generationConfig;

    let venues=[];
    async function safeGemini(b){try{return await gemini(token,projectId,b);}catch(e){return {ok:false,status:500,data:{}};}}
    let resp=await safeGemini(baseBody);
    if(!resp.ok){
      const q=latestUserText(contents)||'restaurants bars near me';
      const found=(await searchVenues(q,lat,lng)).venues;
      res.status(200).json({text:found.length?"Grabbed a few spots near you \uD83D\uDC3C":"My brain buffered for a sec \u2014 give that another go in a moment.",venues:found});
      return;
    }
    let rounds=0;
    while(rounds<2){
      const cand=resp.data.candidates?.[0];
      const parts=cand?.content?.parts||[];
      const fc=parts.find(p=>p.functionCall);
      if(!fc) break;
      const q=fc.functionCall.args?.query||latestUserText(contents);
      let found=(await searchVenues(q,lat,lng)).venues;
      if(!found.length){const broad=(latestUserText(contents)||q).split(' ').slice(0,4).join(' ')+' restaurants bars';found=(await searchVenues(broad,lat,lng)).venues;}
      if(found.length) venues=found;
      convo.push(cand.content);
      convo.push({role:'user',parts:[{functionResponse:{name:'find_places',response:{venues:venuesToText(found)}}}]});
      const nextBody={contents:convo,tools:[FIND_PLACES_TOOL]};
      if(baseBody.systemInstruction)nextBody.systemInstruction=baseBody.systemInstruction;
      if(generationConfig)nextBody.generationConfig=generationConfig;
      resp=await safeGemini(nextBody);
      if(!resp.ok) break;
      rounds++;
    }
    let text=(resp.data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
    if(!text) text=venues.length?"Here is what I dug up near you \uD83D\uDC3C":"Nothing jumped out \u2014 rephrase it and I will dig again.";
    res.status(200).json({text,venues});
  }catch(err){
    try{const b=req.body||{};const loc=b.location||{};const lat=loc.lat??DEFAULT_LAT,lng=loc.lng??DEFAULT_LNG;const q=latestUserText(b.contents)||'restaurants bars near me';const found=(await searchVenues(q,lat,lng)).venues;res.status(200).json({text:found.length?"Here are some nearby spots \uD83D\uDC3C":"I glitched for a second \u2014 give that another go.",venues:found});}
    catch(e){res.status(200).json({text:"I glitched for a second \u2014 give that another go.",venues:[]});}
  }
}
