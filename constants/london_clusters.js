export const PANDA_CATEGORIES = [
  'restaurant', 'bar', 'pub', 'cafe', 'cocktail_bar', 'brunch', 'nightclub',
];
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
  PANDA_CATEGORIES.map(category => ({ ...cluster, category })));
