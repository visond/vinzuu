'use strict';
/**
 * The model line in a Hyundai or Kia VIN.
 *
 * After the maker code (characters 1-3), Hyundai and Kia put the model line in character 4:
 * KMH J ... is a Tucson, KNA P ... a Sportage. Characters 5-8 then give the trim, body, safety
 * system and engine, but those tables are not published for Korean-market cars, so only the model
 * is read here. The generation follows from the model year (character 10) when only one generation
 * was sold that year, and the engine when that generation had only one.
 *
 * STARTER list of the lines common in Rwanda, written from public VIN examples. The customer is
 * always asked to check the result, and a car saved by an owner always wins over this list.
 */

// maker code -> { character 4: model name in our lineup }
const LINES = {
  KMH: { C: 'Accent', D: 'Elantra', E: 'Sonata', F: 'Grandeur', J: 'Tucson', S: 'Santa Fe', T: 'Veloster' },
  KM8: { J: 'Tucson', K: 'Kona', R: 'Palisade', S: 'Santa Fe' },
  KNA: { B: 'Picanto', D: 'Rio', F: 'Cerato', G: 'K5', K: 'Sorento', M: 'Carnival', P: 'Sportage' },
  KND: { J: 'Soul', M: 'Carnival', P: 'Sportage' },
};

const MAKERS = { KMH: 'Hyundai', KM8: 'Hyundai', KNA: 'Kia', KND: 'Kia' };

/** { make, model } for a VIN's model line, or null. */
function lineOf(vin) {
  const wmi = String(vin || '').slice(0, 3).toUpperCase();
  const model = LINES[wmi] && LINES[wmi][String(vin)[3]];
  return model ? { make: MAKERS[wmi], model } : null;
}

module.exports = { LINES, lineOf };
