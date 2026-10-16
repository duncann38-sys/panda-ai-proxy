import { createHash } from 'node:crypto';
export const PANDA_CATEGORIES = [
  'All', 'Indian', 'Italian', 'Chinese', 'Spanish', 'French', 'British',
  'Japanese', 'Mexican', 'Turkish', 'American', 'Meat', 'Bar', 'Lebanese',
  'Thai', 'Chicken', 'Pizza', 'Burgers', 'Dessert', 'Coffee', 'Breakfast',
  'Lunch', 'Brunch', 'Bottomless', 'Pubs', 'Dinner', 'Drinks', 'Sports',
  'Live Music', 'Nightlife', 'Clubs', 'Shops', 'Places of Interest',
];
const CATEGORY_QUERIES = {
  All: 'restaurants bars pubs cafes', Meat: 'steakhouses barbecue restaurants',
  Bar: 'bars cocktail bars', Chicken: 'chicken restaurants', Pizza: 'pizzerias',
  Burgers: 'burger restaurants', Dessert: 'dessert shops bakeries ice cream',
  Coffee: 'coffee shops cafes', Breakfast: 'breakfast restaurants cafes',
  Lunch: 'lunch restaurants', Brunch: 'brunch restaurants',
  Bottomless: 'bottomless brunch restaurants', Pubs: 'pubs',
  Dinner: 'dinner restaurants', Drinks: 'cocktail bars wine bars',
  Sports: 'sports bars pubs showing sport', 'Live Music': 'live music venues pubs bars',
  Nightlife: 'nightlife bars clubs', Clubs: 'nightclubs',
  Shops: 'food shops delicatessens wine shops',
  'Places of Interest': 'tourist attractions museums landmarks',
};
export const LONDON_CLUSTERS = [
  { name: 'battersea_nine_elms', lat: 51.4791, lng: -0.1420 },
  { name: 'clapham_wandsworth', lat: 51.4617, lng: -0.1382 },
  { name: 'soho_covent_garden', lat: 51.5137, lng: -0.1312 },
  { name: 'mayfair_marylebone', lat: 51.5118, lng: -0.1472 },
  { name: 'shoreditch_hoxton', lat: 51.5282, lng: -0.0781 },
  { name: 'southbank_london_bridge', lat: 51.5045, lng: -0.0865 },
  { name: 'chelsea_kensington', lat: 51.4875, lng: -0.1687 },
  { name: 'notting_hill_chiswick', lat: 51.5091, lng: -0.1961 },
  { name: 'camden_kentish_town', lat: 51.5390, lng: -0.1426 },
  { name: 'islington_angel', lat: 51.5362, lng: -0.1030 },
  { name: 'hackney_dalston', lat: 51.5450, lng: -0.0553 },
  { name: 'brixton_peckham', lat: 51.4613, lng: -0.1156 },
  { name: 'canary_wharf_greenwich', lat: 51.5054, lng: -0.0275 },
  { name: 'hammersmith_fulham', lat: 51.4927, lng: -0.2238 },
  { name: 'hampstead_highgate', lat: 51.5562, lng: -0.1781 },
  { name: 'wimbledon_richmond', lat: 51.4214, lng: -0.2067 },
  { name: 'stratford_city', lat: 51.5431, lng: -0.0072 },
  { name: 'kingston_surbiton', lat: 51.4122, lng: -0.3007 },
];
export const LONDON_SEED_TASKS = LONDON_CLUSTERS.flatMap(cluster =>
  PANDA_CATEGORIES.map(category => ({ ...cluster, category,
    query: CATEGORY_QUERIES[category] || `${category} restaurants` })));
// Never resume a cursor against a changed category/cluster ordering.
export const LONDON_SEED_PLAN = 'google-photo-' + createHash('sha256')
  .update(JSON.stringify({ tasks: LONDON_SEED_TASKS, pages: 1 })).digest('hex').slice(0, 12);
