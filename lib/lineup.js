'use strict';
/**
 * Every model name a customer can pick for the three makes Vinzuu covers, including models we do
 * not have part numbers for yet. Picking one of those still registers the car, and a part search
 * for it is logged as a gap for the admin to research, which is how the fitment table grows.
 * Names are the ones used on export and grey-import cars seen in East Africa, with the home-market
 * name alongside where it differs (Elantra / Avante). Add new models here; order does not matter.
 */
const LINEUP = {
  Hyundai: [
    'Accent', 'Alcazar', 'Atos', 'Avante', 'Azera', 'Bayon', 'Casper', 'County', 'Creta', 'Elantra',
    'Equus', 'Galloper', 'Genesis', 'Getz', 'Grand i10', 'Grand Starex', 'Grandeur', 'H-1', 'H100',
    'i10', 'i20', 'i30', 'i40', 'Ioniq', 'Ioniq 5', 'Ioniq 6', 'ix35', 'Kona', 'Matrix', 'Mighty',
    'Palisade', 'Porter', 'Santa Cruz', 'Santa Fe', 'Sonata', 'Staria', 'Starex', 'Terracan',
    'Trajet', 'Tucson', 'Veloster', 'Venue', 'Veracruz', 'Verna',
  ],
  Kia: [
    'Bongo', 'Cadenza', 'Carens', 'Carnival', 'Ceed', 'Cerato', 'EV3', 'EV6', 'EV9', 'Forte',
    'K2700', 'K3', 'K5', 'K7', 'K8', 'K9', 'Mohave', 'Morning', 'Niro', 'Opirus', 'Optima',
    'Picanto', 'Pregio', 'Pride', 'Ray', 'Rio', 'Sedona', 'Seltos', 'Sonet', 'Sorento', 'Soul',
    'Spectra', 'Sportage', 'Stinger', 'Stonic', 'Telluride', 'XCeed',
  ],
  Toyota: [
    '4Runner', 'Allion', 'Alphard', 'Auris', 'Avalon', 'Avanza', 'Axio', 'Aygo', 'bZ4X', 'C-HR',
    'Caldina', 'Camry', 'Coaster', 'Corolla', 'Corolla Cross', 'Corolla Fielder', 'Crown', 'Dyna',
    'Estima', 'Fortuner', 'Harrier', 'Hiace', 'Highlander', 'Hilux', 'Ist', 'Land Cruiser',
    'Land Cruiser Prado', 'Mark X', 'Noah', 'Passo', 'Premio', 'Prius', 'Probox', 'RAV4', 'Raum',
    'Rush', 'Sequoia', 'Sienna', 'Spacio', 'Succeed', 'Tacoma', 'Tundra', 'Vanguard', 'Venza',
    'Vitz', 'Voxy', 'Wish', 'Yaris',
  ],
};

/** Logos shown instead of the make's name on the customer page. */
const LOGOS = {
  Hyundai: '/img/makes/hyundai.svg',
  Kia: '/img/makes/kia.svg',
  Toyota: '/img/makes/toyota.svg',
};

/**
 * Adds the full lineup and the logo to the catalog built from the fitment table. Models that have
 * part numbers keep their generations and engines; the rest come with empty lists. A make the
 * fitment table knows but the lineup does not (added by an admin) is kept as it is.
 */
function withLineup(catalogMakes) {
  const byMake = new Map(catalogMakes.map((m) => [m.make.toLowerCase(), m]));
  for (const make of Object.keys(LINEUP)) {
    if (!byMake.has(make.toLowerCase())) byMake.set(make.toLowerCase(), { make, models: [] });
  }
  const out = [];
  for (const entry of byMake.values()) {
    const known = new Set(entry.models.map((m) => m.model.toLowerCase()));
    const lineupKey = Object.keys(LINEUP).find((k) => k.toLowerCase() === entry.make.toLowerCase());
    const extra = (LINEUP[lineupKey] || [])
      .filter((name) => !known.has(name.toLowerCase()))
      .map((model) => ({ model, generations: [], engines: [] }));
    const models = [...entry.models, ...extra]
      .sort((a, b) => a.model.localeCompare(b.model, 'en', { sensitivity: 'base' }));
    out.push({ make: entry.make, logo: LOGOS[lineupKey] || null, models });
  }
  return out.sort((a, b) => a.make.localeCompare(b.make));
}

module.exports = { LINEUP, LOGOS, withLineup };
