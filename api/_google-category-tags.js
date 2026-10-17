export function googleCategoryTags(place, query) {
  const types = new Set((place.types || []).map(type => String(type).toLowerCase()));
  const primaryType = String(place.primaryType || place.types?.[0] || '').toLowerCase();
  const text = `${place.displayName?.text || ''} ${place.primaryTypeDisplayName?.text || ''}`.toLowerCase();
  const hospitality = new Set(['bar', 'breakfast_restaurant', 'brunch_restaurant', 'cafe', 'coffee_shop',
    'dessert_restaurant', 'fast_food_restaurant', 'fine_dining_restaurant', 'food_court',
    'hamburger_restaurant', 'meal_delivery', 'meal_takeaway', 'night_club', 'pub', 'restaurant', 'wine_bar']);
  const shops = new Set(['candy_store', 'convenience_store', 'dessert_shop', 'grocery_store', 'ice_cream_shop',
    'liquor_store', 'market', 'shopping_mall', 'store', 'supermarket', 'wine_store']);
  const interests = new Set(['amusement_center', 'amusement_park', 'aquarium', 'art_gallery', 'botanical_garden',
    'cultural_landmark', 'garden', 'historical_landmark', 'historical_place', 'marina', 'monument', 'museum',
    'national_park', 'observation_deck', 'park', 'plaza', 'tourist_attraction', 'visitor_center', 'zoo']);
  const hasHospitality = [...types].some(type => hospitality.has(type))
    || /(restaurant|cafe|coffee|bar|pub|night club|food court|takeaway)/.test(
      String(place.primaryTypeDisplayName?.text || '').toLowerCase(),
    );
  const primaryHospitality = hospitality.has(primaryType)
    || /(restaurant|cafe|coffee|bar|pub|night club|food court|takeaway)/.test(
      String(place.primaryTypeDisplayName?.text || '').toLowerCase(),
    );
  if (!primaryHospitality && interests.has(primaryType)) return ['Places of Interest'];
  if (!primaryHospitality && (shops.has(primaryType) || primaryType === 'bakery')) return ['Shops'];
  if (!hasHospitality) {
    if ([...types].some(type => interests.has(type))) return ['Places of Interest'];
    if ([...types].some(type => shops.has(type)) || types.has('bakery')) return ['Shops'];
  }
  const tags = new Set();
  const add = (tag, ok) => { if (ok) tags.add(tag); };
  const q = String(query || '').toLowerCase();
  const cuisine = [['Indian', 'indian_restaurant'], ['Italian', 'italian_restaurant'],
    ['Chinese', 'chinese_restaurant'], ['Spanish', 'spanish_restaurant'], ['French', 'french_restaurant'],
    ['British', 'british_restaurant'], ['Japanese', 'japanese_restaurant'], ['Mexican', 'mexican_restaurant'],
    ['Turkish', 'turkish_restaurant'], ['American', 'american_restaurant'], ['Lebanese', 'lebanese_restaurant'],
    ['Thai', 'thai_restaurant'], ['Pizza', 'pizza_restaurant'], ['Burgers', 'hamburger_restaurant']];
  cuisine.forEach(([tag, type]) => add(tag, types.has(type)));
  [['Indian', 'indian'], ['Italian', 'italian'], ['Chinese', 'chinese'], ['Spanish', 'spanish|tapas'],
    ['French', 'french'], ['British', 'british'], ['Japanese', 'japanese|sushi'], ['Mexican', 'mexican'],
    ['Turkish', 'turkish'], ['American', 'american|diner|burger'], ['Lebanese', 'lebanese|middle eastern|levantine'],
    ['Thai', 'thai']].forEach(([tag, pattern]) =>
    add(tag, hasHospitality && new RegExp(`\\b(${pattern})\\b`).test(q)));
  add('Meat', types.has('steak_house') || /\b(steak|grill|barbecue|bbq|churrasco|roast)\b/.test(text)
    || (hasHospitality && /\b(meat|steak|grill)\b/.test(q)));
  add('Chicken', types.has('chicken_restaurant') || /\b((fried|grilled|roast)\s+)?chicken\b/.test(text)
    || (hasHospitality && /\bchicken\b/.test(q)));
  add('Pizza', types.has('pizza_restaurant') || /\bpizza\b/.test(text)
    || (hasHospitality && /\bpizza\b/.test(q)));
  add('Burgers', types.has('hamburger_restaurant') || /\bburger\b/.test(text)
    || (hasHospitality && /\bburgers?\b/.test(q)));
  const primaryText = String(place.primaryTypeDisplayName?.text || '').toLowerCase();
  const coffee = types.has('cafe') || types.has('coffee_shop') || /\b(cafe|coffee)\b/.test(primaryText);
  const pub = types.has('pub') || /\b(pub|gastropub)\b/.test(primaryText);
  const bar = types.has('bar') || types.has('wine_bar') || /\b(bar|cocktail)\b/.test(primaryText);
  const restaurant = hasHospitality && !coffee && !pub && !bar && !types.has('night_club');
  add('Coffee', coffee);
  add('Pubs', pub);
  add('Bar', bar || (hasHospitality && /\b(cocktail|wine bar|bars?)\b/.test(q)));
  add('Drinks', bar || pub || types.has('night_club')
    || (hasHospitality && /\b(cocktail|drinks?|wine bar)\b/.test(q)));
  add('Nightlife', types.has('night_club') || types.has('dance_hall') || types.has('event_venue')
    || types.has('performing_arts_theater')
    || (hasHospitality && /\b(nightlife|clubs?|live music|sports bars?|entertainment)\b/.test(q)));
  add('Live Music', place.hasMusic === true || /\b(live music|music venue|concert|karaoke)\b/.test(text)
    || (hasHospitality && /\b(live music|dj)\b/.test(q)));
  add('Sports', /\b(sports bar|football bar)\b/.test(text)
    || (hasHospitality && /\b(sports?|football)\b/.test(q)));
  add('Dessert', types.has('dessert_restaurant') || types.has('dessert_shop') || types.has('ice_cream_shop')
    || types.has('bakery') || ((hasHospitality || types.has('bakery'))
      && /\b(dessert|cake|ice cream|patisserie)\b/.test(q)));
  add('Breakfast', (hasHospitality || coffee)
    && (/\b(breakfast|morning food)\b/.test(q) || types.has('breakfast_restaurant')));
  add('Brunch', hasHospitality && (/\bbrunch\b/.test(q) || types.has('brunch_restaurant')));
  add('Bottomless', hasHospitality && (/\bbottomless\b/.test(q) || /\bbottomless\b/.test(text)));
  add('Lunch', restaurant || coffee || pub || /\blunch\b/.test(q));
  add('Dinner', restaurant || pub || bar || /\bdinner\b/.test(q));
  if (!tags.size && hasHospitality) {
    tags.add('Lunch');
    tags.add('Dinner');
  }
  return [...tags];
}
