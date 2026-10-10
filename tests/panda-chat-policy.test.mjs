import test from 'node:test';
import assert from 'node:assert/strict';
import { localGreeting, quickChatReply, ambiguousClub, buildChatInstruction, safeProviderFailure, safeDegradedText, isDirectVenueRequest, consumeWeatherBudget, sessionVenueQuery, filterSessionVenues, maySearchVenues } from '../api/_panda-chat-policy.js';
const chat = texts => texts.map(text => ({role:'user',parts:[{text}]}));
test('greetings use current user timezone, including London DST and invalid zone fallback', () => {
  const now = new Date('2026-10-10T11:30:00Z');
  assert.equal(localGreeting({timeZone:'Europe/London'},now).greeting,'Good afternoon');
  assert.equal(localGreeting({timeZone:'America/New_York'},now).greeting,'Good morning');
  assert.equal(localGreeting({timeZone:'bad/zone'},now).greeting,'Good afternoon');
});
test('thanks is free, precise and does not swallow a venue question', () => {
  assert.match(quickChatReply('Thanks!'),/welcome/);
  assert.equal(quickChatReply('Thanks, find a pub near me'),null);
});
test('club context distinguishes dancing, social and ambiguous intent', () => {
  assert.equal(ambiguousClub('Club near me',chat(['Club near me'])),true);
  assert.equal(ambiguousClub('Club near me',chat(['I want dancing and DJs','Club near me'])),false);
  assert.equal(ambiguousClub('private members club',[]),false);
  assert.equal(isDirectVenueRequest('pub near me'),true);
  assert.equal(isDirectVenueRequest('What is a nightclub?'),false);
});
test('authoritative policy keeps explicit preferences and serious safety rules', () => {
  const prompt = buildChatInstruction(chat(['I prefer quiet wine bars; budget £££','I have a nut allergy']),{timeZone:'Europe/London'});
  assert.match(prompt,/quiet wine bars/);
  assert.match(prompt,/nut allergy/);
  assert.match(prompt,/confirm requirements directly/);
  assert.match(prompt,/No verified live weather/);
  assert.match(prompt,/THIS conversation only/);
});
test('only fixed provider classifications leave backend', () => {
  assert.equal(safeProviderFailure({error:{details:[{reason:'IAM_PERMISSION_DENIED',metadata:{secret:'not returned'}}]}}),'iam_permission_denied');
  assert.equal(safeProviderFailure({error:{message:'sensitive unrelated identifier'}}),null);
  assert.match(safeDegradedText('nut allergy',[{name:'x'}]),/not confirmed/);
  assert.match(safeDegradedText('book me a table'),/haven’t made a booking/);
});
test('weather budget fails closed and never spends the Gemini counter', async () => {
  assert.equal(await consumeWeatherBudget(null),false);
  let count=0;let collection;
  const store={collection:name=>{collection=name;return{doc:id=>({id})};},runTransaction:async fn=>fn({
    get:async()=>({data:()=>({requests:count})}),
    set:(_ref,value)=>{count=value.requests;},
  })};
  assert.equal(await consumeWeatherBudget(store,1),true);
  assert.equal(await consumeWeatherBudget(store,1),false);
  assert.equal(collection,'panda_weather_usage_v1');
});
test('session budget cap applies to cards, not just the reply',()=>{
  const contents=chat(['My budget is £££','A quiet bar near me']);
  assert.deepEqual(filterSessionVenues([{id:'a',price:'££'},{id:'b',price:'££££'},{id:'c'}],contents).map(v=>v.id),['a']);
  assert.match(sessionVenueQuery('pubs',contents),/^pubs quiet$/);
  assert.deepEqual(filterSessionVenues([{id:'a'}],[]),[{id:'a'}]);
});
test('pure conversation and explicit no-search requests never trigger paid venue fallbacks',()=>{
  assert.equal(maySearchVenues('Tell me my preferences without searching venues'),false);
  assert.equal(maySearchVenues('What is a pub crawl?'),false);
  assert.equal(maySearchVenues('How are you?'),false);
  assert.equal(maySearchVenues('Find pubs near me'),true);
});
