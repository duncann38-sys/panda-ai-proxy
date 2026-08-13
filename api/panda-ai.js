
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

async function searchVenues(query,lat,lng){
  if(!MAPS_KEY||!query) return [];
  try{
    const r=await fetch('https://places.googleapis.com/v1/places:searchText',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Goog-Api-Key':MAPS_KEY,
        'X-Goog-FieldMask':['places.id','places.displayName','places.formattedAddress','places.shortFormattedAddress','places.location','places.rating','places.userRatingCount','places.priceLevel','places.primaryTypeDisplayName','places.googleMapsUri','places.websiteUri','places.nationalPhoneNumber','places.currentOpeningHours.openNow','places.photos'].join(',')},
      body:JSON.stringify({textQuery:query,maxResultCount:12,rankPreference:'DISTANCE',locationBias:{circle:{center:{latitude:lat,longitude:lng},radius:6000.0}}})
    });
    if(!r.ok) return [];
    const data=await r.json();
    const places=data.places||[];
    return places.map(p=>{
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
  }catch{return []}
}

function fmtDist(m){return m==null?'':(m<1000?`${m} m`:`${(m/1000).toFixed(1)} km`);}
function venuesToText(v){if(!v.length)return 'No matching venues found nearby.';return v.slice(0,8).map((x,i)=>{const bits=[x.type,fmtDist(x.distanceMeters),x.rating?`${x.rating}\u2605`:'',x.price,x.openNow===true?'open now':x.openNow===false?'closed':''].filter(Boolean).join(' \u00b7 ');return `${i+1}. ${x.name}${bits?' \u2014 '+bits:''}`;}).join('\n');}
function latestUserText(contents){if(!Array.isArray(contents))return '';for(let i=contents.length-1;i>=0;i--){const c=contents[i];if(c?.role==='user'&&Array.isArray(c.parts))return c.parts.map(p=>p.text||'').join(' ').trim();}return '';}

const FIND_PLACES_TOOL={function_declarations:[{
  name:'find_places',
  description:"Search for real restaurants, bars, cafes, pubs and venues near the user's current location. Call this ONLY when the user is asking for somewhere to eat, drink, or go out, or for recommendations. Do NOT call it for greetings, thanks, small talk, or general questions.",
  parameters:{type:'object',properties:{query:{type:'string',description:"What to look for, e.g. 'breakfast', 'cocktail bars', 'italian restaurants', 'late night food'."}},required:['query']}
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
    if(body.venuesOnly){const venues=await searchVenues(body.query,lat,lng);res.status(200).json({venues});return;}

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
    let resp=await gemini(token,projectId,baseBody);
    if(!resp.ok){res.status(resp.status).json({error:resp.data?.error?.message||'Gemini error',detail:resp.data});return;}

    let rounds=0;
    while(rounds<3){
      const cand=resp.data.candidates?.[0];
      const parts=cand?.content?.parts||[];
      const fc=parts.find(p=>p.functionCall);
      if(!fc) break;
      const q=fc.functionCall.args?.query||latestUserText(contents);
      const found=await searchVenues(q,lat,lng);
      if(found.length) venues=found;
      convo.push(cand.content);
      convo.push({role:'user',parts:[{functionResponse:{name:'find_places',response:{venues:venuesToText(found)}}}]});
      const nextBody={contents:convo,tools:[FIND_PLACES_TOOL]};
      if(baseBody.systemInstruction)nextBody.systemInstruction=baseBody.systemInstruction;
      if(generationConfig)nextBody.generationConfig=generationConfig;
      resp=await gemini(token,projectId,nextBody);
      if(!resp.ok){res.status(resp.status).json({error:resp.data?.error?.message||'Gemini error',detail:resp.data});return;}
      rounds++;
    }
    const text=(resp.data.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('');
    res.status(200).json({text,venues});
  }catch(err){res.status(500).json({error:err.message});}
}
