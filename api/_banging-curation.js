// Independent editorial eligibility, not stored Google ratings/photos.
// Source checked 2026-10-10. Names match listings only inside Greater London;
// current Google facts, photos and journey proofs are resolved separately.
export const RESTAURANT_SOURCE = 'https://guide.michelin.com/ae-du/en/article/michelin-guide-ceremony/every-michelin-star-restaurant-in-london-full-list';
export const BAR_SOURCE = 'https://guide.michelin.com/en/article/travel/london-s-best-hotel-cocktail-bars';
const restaurants = [
  ['Alain Ducasse at The Dorchester', 'Mayfair'],
  ['CORE by Clare Smyth', 'Notting Hill'],
  ['Hélène Darroze at The Connaught', 'Mayfair'],
  ['Restaurant Gordon Ramsay', 'Chelsea'],
  ['Sketch, The Lecture Room & Library', 'Mayfair'],
  ['The Ledbury', 'Notting Hill'],
  ['A.Wong', 'Pimlico'], ['Alex Dilling at Hotel Café Royal', 'Soho'],
  ['Bonheur by Matt Abé', 'Mayfair'], ['Brooklands by Claude Bosi', 'Belgravia'],
  ['Da Terra', 'Bethnal Green'], ['Dinner by Heston Blumenthal', 'Knightsbridge'],
  ['Gymkhana', 'Mayfair'], ['Humble Chicken', 'Soho'], ['Ikoyi', 'Strand'],
  ['Kitchen Table', 'Bloomsbury'], ['Restaurant Story', 'Southwark'],
  ['Row on 5', 'Mayfair'], ['The Clove Club', 'Shoreditch'],
  ['The Ritz Restaurant', "St James's"], ['Trivet', 'Southwark'],
  ['1890 by Gordon Ramsay', 'Strand'], ['64 Goodge Street', 'Fitzrovia'],
  ['Akoko', 'Fitzrovia'], ['Amaya', 'Belgravia'], ['Ambassadors Clubhouse', 'Mayfair'],
  ['Angler', 'City of London'], ['AngloThai', 'Marylebone'], ['Aulis', 'Soho'],
  ['Behind', 'London Fields'], ['Benares', 'Mayfair'], ['Brat', 'Shoreditch'],
  ['Caractère', 'Notting Hill'], ['Casa Fofō', 'Dalston'], ['Chez Bruce', 'Wandsworth'],
  ['Chishuru', 'Fitzrovia'], ['Corenucopia by Clare Smyth', 'Belgravia'],
  ['Cornus', 'Belgravia'], ['Cycene', 'Shoreditch'],
  ['Dining Room at The Goring', 'Westminster'], ['Dorian', 'Notting Hill'],
  ['Dysart Petersham', 'Richmond'], ['Elystan Street', 'Chelsea'],
  ["Evelyn's Table", 'Soho'], ['Frog by Adam Handling', 'Covent Garden'],
  ['Galvin La Chapelle', 'City of London'], ['HIDE', 'Mayfair'], ['Jamavar', 'Mayfair'],
  ['Kerfield Arms', 'Camberwell'], ['Kitchen W8', 'Kensington'], ['KOL', 'Marylebone'],
  ['La Trompette', 'Chiswick'], ['Labombe by Trivet', 'Mayfair'],
  ['Legado', 'Shoreditch'], ['Lita', 'Marylebone'], ['Luca', 'Clerkenwell'],
  ['Mauro Colagreco at Raffles London at The OWO', 'Whitehall'],
  ['Michael Caines at The Stafford', "St James's"], ['Mountain', 'Soho'],
  ['Murano', 'Mayfair'], ['Muse by Tom Aikens', 'Belgravia'], ['OMA', 'Borough Market'],
  ['Ormer Mayfair', 'Mayfair'], ['Pavyllon London', 'Mayfair'],
  ['Pétrus by Gordon Ramsay', 'Belgravia'], ['Pied à Terre', 'Bloomsbury'],
  ['Plates London', 'Hoxton'], ['Portland', 'Marylebone'], ['Quilon', 'Westminster'],
  ['Restaurant Gordon Ramsay High', 'City of London'], ['River Café', 'Hammersmith'],
  ['Sabor', 'Mayfair'], ['Sollip', 'Southwark'], ['St. Barts', 'City of London'],
  ['St. JOHN', 'Clerkenwell'], ['Sushi Kanesaka', 'Mayfair'], ['The Harwood Arms', 'Fulham'],
  ['The Ninth', 'Bloomsbury'], ['Tom Brown at The Capital', 'Knightsbridge'],
  ['Trinity', 'Clapham'], ['Trishna', 'Marylebone'], ['Umu', 'Mayfair'],
  ['Veeraswamy', 'Mayfair'], ['Wild Honey St James', "St James's"],
];
const bars = [
  ['American Bar', 'Strand'], ['Artesian', 'Marylebone'], ['Brooklands Bar', 'Belgravia'],
  ['Dean Street Townhouse', 'Soho'], ['Le Magritte', 'Mayfair'], ['Lyaness', 'South Bank'],
  ['Punch Room', 'Fitzrovia'], ['Side Hustle', 'Covent Garden'], ['Connaught Bar', 'Mayfair'],
  ['Thirteen', 'Soho'],
];
export function normalizeLuxuryName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '').replace(/^the/, '');
}
const aliases = new Map([
  ['sketchlecture roomandlibrary', 'Sketch, The Lecture Room & Library'],
  ['thelecture roomandlibrary', 'Sketch, The Lecture Room & Library'],
  ['brooklands', 'Brooklands by Claude Bosi'], ['thestory', 'Restaurant Story'],
  ['thedysartpetersham', 'Dysart Petersham'], ['therivercafe', 'River Café'],
  ['artesianbar', 'Artesian'], ['theamericanbar', 'American Bar'],
  ['theconnaughtbar', 'Connaught Bar'],
].map(([key, value]) => [normalizeLuxuryName(key), normalizeLuxuryName(value)]));
export function luxuryEvidence(venue) {
  const london = venue.latitude >= 51.25 && venue.latitude <= 51.75 &&
    venue.longitude >= -0.6 && venue.longitude <= 0.3 && /\blondon\b/i.test(venue.address);
  const name = aliases.get(normalizeLuxuryName(venue.name)) || normalizeLuxuryName(venue.name);
  if (london) {
    for (const [pool, source] of [[restaurants, RESTAURANT_SOURCE], [bars, BAR_SOURCE]]) {
      const found = pool.find(([label]) => normalizeLuxuryName(label) === name);
      // These common bar names must bind to the hotel in the independent
      // source, not a different London business with the same name.
      if (found && source === BAR_SOURCE && name === 'americanbar' && !/\bsavoy\b|\bstrand\b/i.test(venue.address)) continue;
      if (found && source === BAR_SOURCE && name === 'artesian' && !/\blangham\b|\bportland place\b/i.test(venue.address)) continue;
      if (found) return { luxurySource: source, neighborhood: found[1] };
    }
  }
  // A provider's explicit fine-dining classification is meaningful; a generic
  // expensive pub, chain, or "luxury" word in a search result is not proof.
  if (/fine dining restaurant/i.test(venue.category) && venue.price === '££££' && Number(venue.rating) >= 4.5) {
    return { luxurySource: 'google_primary_type:fine_dining_restaurant', neighborhood: '' };
  }
  return null;
}

export function qualifiesLuxuryResult(venue) {
  return Boolean(venue?.id && Number(venue.rating) >= 4.3 &&
    Number.isFinite(venue.latitude) && Number.isFinite(venue.longitude) &&
    venue.photoNames?.length && luxuryEvidence(venue));
}
