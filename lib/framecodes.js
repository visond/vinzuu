'use strict';
/**
 * Japanese chassis (frame) numbers.
 *
 * Cars built for Japan's home market have no 17-character VIN. Their papers give a frame number
 * instead, for example NZE121-3123456: a model code (NZE121), then a serial number. Many Toyotas
 * in Rwanda came from Japan as used imports, so they can only be found this way.
 *
 * Toyota builds the model code from the engine and the model line:
 *   NZ E 121  ->  NZ engine (1NZ-FE), E = Corolla line, 120 series
 *   ZR E 152  ->  ZR engine (2ZR-FE), Corolla, 150 series
 *   AC A 33   ->  AZ engine (2AZ-FE), A = RAV4, 30 series
 * The rule has too many exceptions to compute, so the codes are listed here, each pointing at a
 * model and generation of our Toyota lineup (lib/models/toyota.txt) and the engine code that
 * picks the engine. A letter after the code marks the body: G is the Fielder wagon, N the Spacio,
 * H the Auris hatchback; other letters (W, V, ...) change nothing here.
 *
 * STARTER list of the codes most common on Toyotas imported to East Africa, written from public
 * chassis-code references. A frame number gives no model year, so the customer still picks it.
 */

// code: [model, generation, engine code]
const CODES = {
  // Corolla / Axio / Allex / Runx, and the Fielder (G) and Spacio (N) on the same platforms
  NZE121: ['Corolla', 'E120', '1NZ-FE'], NZE124: ['Corolla', 'E120', '1NZ-FE'],
  ZZE122: ['Corolla', 'E120', '1ZZ-FE'], ZZE123: ['Corolla', 'E120', '2ZZ-GE'], ZZE124: ['Corolla', 'E120', '1ZZ-FE'],
  NZE121G: ['Corolla Fielder', 'E120', '1NZ-FE'], NZE124G: ['Corolla Fielder', 'E120', '1NZ-FE'],
  ZZE122G: ['Corolla Fielder', 'E120', '1ZZ-FE'], ZZE123G: ['Corolla Fielder', 'E120', '2ZZ-GE'], ZZE124G: ['Corolla Fielder', 'E120', '1ZZ-FE'],
  NZE121N: ['Corolla Spacio', 'E120N', '1NZ-FE'], ZZE122N: ['Corolla Spacio', 'E120N', '1ZZ-FE'],
  NZE141: ['Corolla', 'E140', '1NZ-FE'], NZE144: ['Corolla', 'E140', '1NZ-FE'],
  ZRE142: ['Corolla', 'E140', '2ZR-FE'], ZRE144: ['Corolla', 'E140', '2ZR-FE'],
  NZE141G: ['Corolla Fielder', 'E140', '1NZ-FE'], NZE144G: ['Corolla Fielder', 'E140', '1NZ-FE'],
  ZRE142G: ['Corolla Fielder', 'E140', '2ZR-FE'], ZRE144G: ['Corolla Fielder', 'E140', '2ZR-FE'],
  // The export Corolla sedan of these years (150 series) is listed under E140 in our lineup.
  ZRE151: ['Corolla', 'E140', '1ZR-FE'], ZRE152: ['Corolla', 'E140', '2ZR-FE'],
  NZE161: ['Corolla', 'E160', '1NZ-FE'], NZE164: ['Corolla', 'E160', '1NZ-FE'],
  NRE161: ['Corolla', 'E160', '2NR-FKE'], NKE165: ['Corolla', 'E160', '1NZ-FXE'],
  NZE161G: ['Corolla Fielder', 'E160', '1NZ-FE'], NZE164G: ['Corolla Fielder', 'E160', '1NZ-FE'],
  NRE161G: ['Corolla Fielder', 'E160', '2NR-FKE'], NKE165G: ['Corolla Fielder', 'E160', '1NZ-FXE'],
  ZRE162G: ['Corolla Fielder', 'E160', '2ZR-FAE'],
  ZRE171: ['Corolla', 'E170', '1ZR-FE'], ZRE172: ['Corolla', 'E170', '2ZR-FE'],
  ZRE212: ['Corolla', 'E210', '2ZR-FE'], ZWE211: ['Corolla', 'E210', '2ZR-FXE'], MZEA12: ['Corolla', 'E210', 'M20A-FKS'],
  NZE151H: ['Auris', 'E150', '1NZ-FE'], ZRE152H: ['Auris', 'E150', '2ZR-FE'], ZRE154H: ['Auris', 'E150', '2ZR-FE'],
  NZE181H: ['Auris', 'E180', '1NZ-FE'], ZRE186H: ['Auris', 'E180', '2ZR-FAE'],

  // Premio and Allion share their codes; Premio is used, the customer can switch to Allion.
  NZT240: ['Premio', 'T240', '1NZ-FE'], ZZT240: ['Premio', 'T240', '1ZZ-FE'], ZZT245: ['Premio', 'T240', '1ZZ-FE'],
  AZT240: ['Premio', 'T240', '1AZ-FSE'],
  NZT260: ['Premio', 'T260', '1NZ-FE'], ZRT260: ['Premio', 'T260', '2ZR-FE'], ZRT265: ['Premio', 'T260', '2ZR-FE'],
  ZRT261: ['Premio', 'T260', '3ZR-FAE'],
  AZT241: ['Caldina', 'T240', '1AZ-FSE'], ZZT241: ['Caldina', 'T240', '1ZZ-FE'],
  AZT250: ['Avensis', 'T250', '1AZ-FSE'], ZZT251: ['Avensis', 'T250', '1ZZ-FE'],

  // RAV4
  ACA20: ['RAV4', 'XA20', '1AZ-FE'], ACA21: ['RAV4', 'XA20', '1AZ-FE'], ACA26: ['RAV4', 'XA20', '1AZ-FE'],
  ZCA26: ['RAV4', 'XA20', '1ZZ-FE'],
  ACA31: ['RAV4', 'XA30', '2AZ-FE'], ACA33: ['RAV4', 'XA30', '2AZ-FE'], ACA36: ['RAV4', 'XA30', '2AZ-FE'],
  ACA38: ['RAV4', 'XA30', '2AZ-FE'], GSA33: ['RAV4', 'XA30', '2GR-FE'], ZSA30: ['RAV4', 'XA30', '3ZR-FE'],
  ZSA35: ['RAV4', 'XA30', '3ZR-FE'],
  ZSA42: ['RAV4', 'XA40', '3ZR-FAE'], ZSA44: ['RAV4', 'XA40', '3ZR-FAE'], ASA42: ['RAV4', 'XA40', '2AR-FE'],
  ASA44: ['RAV4', 'XA40', '2AR-FE'], AVA44: ['RAV4', 'XA40', '2AR-FXE'], ALA49: ['RAV4', 'XA40', '2AD-FTV'],
  MXAA52: ['RAV4', 'XA50', 'M20A-FKS'], MXAA54: ['RAV4', 'XA50', 'M20A-FKS'], AXAA54: ['RAV4', 'XA50', 'A25A-FKS'],
  AXAH54: ['RAV4', 'XA50', 'A25A-FXS'],

  // Small cars
  SCP10: ['Vitz', 'XP10', '1SZ-FE'], NCP10: ['Vitz', 'XP10', '2NZ-FE'], NCP13: ['Vitz', 'XP10', '1NZ-FE'],
  KSP90: ['Vitz', 'XP90', '1KR-FE'], SCP90: ['Vitz', 'XP90', '2SZ-FE'], NCP91: ['Vitz', 'XP90', '1NZ-FE'],
  NCP95: ['Vitz', 'XP90', '1NZ-FE'],
  KSP130: ['Vitz', 'XP130', '1KR-FE'], NSP130: ['Vitz', 'XP130', '1NR-FE'], NSP135: ['Vitz', 'XP130', '1NR-FE'],
  NCP131: ['Vitz', 'XP130', '1NZ-FE'], NHP130: ['Vitz', 'XP130', '1NZ-FXE'],
  KSP92: ['Belta', 'XP90', '1KR-FE'], SCP92: ['Belta', 'XP90', '2SZ-FE'], NCP96: ['Belta', 'XP90', '2NZ-FE'],
  NCP60: ['Ist', 'XP60', '2NZ-FE'], NCP61: ['Ist', 'XP60', '1NZ-FE'], NCP65: ['Ist', 'XP60', '1NZ-FE'],
  NCP110: ['Ist', 'XP110', '1NZ-FE'], NCP115: ['Ist', 'XP110', '1NZ-FE'], ZSP110: ['Ist', 'XP110', '2ZR-FE'],
  KGC10: ['Passo', 'C10', '1KR-FE'], QNC10: ['Passo', 'C10', 'K3-VE'],
  KGC30: ['Passo', 'C30', '1KR-FE'], KGC35: ['Passo', 'C30', '1KR-FE'], NGC30: ['Passo', 'C30', '1NR-FE'],
  M700A: ['Passo', 'M700', '1KR-FE'], M710A: ['Passo', 'M700', '1KR-FE'],
  SCP100: ['Ractis', 'P100', '2SZ-FE'], NCP100: ['Ractis', 'P100', '1NZ-FE'], NCP105: ['Ractis', 'P100', '1NZ-FE'],
  NCP120: ['Ractis', 'P120', '1NZ-FE'], NCP125: ['Ractis', 'P120', '1NZ-FE'], NSP120: ['Ractis', 'P120', '1NR-FE'],
  NCZ20: ['Raum', 'Z20', '1NZ-FE'], NCZ25: ['Raum', 'Z20', '1NZ-FE'],
  NNP10: ['Porte', 'P10', '2NZ-FE'], NNP11: ['Porte', 'P10', '1NZ-FE'], NNP15: ['Porte', 'P10', '1NZ-FE'],
  NSP140: ['Porte', 'P140', '1NR-FE'], NCP141: ['Porte', 'P140', '1NZ-FE'], NCP145: ['Porte', 'P140', '1NZ-FE'],
  NCP81: ['Sienta', 'XP80', '1NZ-FE'], NCP85: ['Sienta', 'XP80', '1NZ-FE'],
  NSP170: ['Sienta', 'XP170', '2NR-FKE'], NSP172: ['Sienta', 'XP170', '2NR-FKE'], NHP170: ['Sienta', 'XP170', '1NZ-FXE'],
  NCP50: ['Probox', 'XP50', '2NZ-FE'], NCP51: ['Probox', 'XP50', '1NZ-FE'], NCP55: ['Probox', 'XP50', '1NZ-FE'],
  NCP160: ['Probox', 'XP50', '1NZ-FE'], NSP160: ['Probox', 'XP50', '1NR-FE'], NHP160: ['Probox', 'XP50', '1NZ-FXE'],

  // Hybrids
  NHW10: ['Prius', 'XW10', '1NZ-FXE'], NHW11: ['Prius', 'XW10', '1NZ-FXE'], NHW20: ['Prius', 'XW20', '1NZ-FXE'],
  ZVW30: ['Prius', 'XW30', '2ZR-FXE'], ZVW50: ['Prius', 'XW50', '2ZR-FXE'], ZVW51: ['Prius', 'XW50', '2ZR-FXE'],
  ZVW55: ['Prius', 'XW50', '2ZR-FXE'], ZVW40: ['Prius v', 'ZVW40', '2ZR-FXE'], ZVW41: ['Prius v', 'ZVW40', '2ZR-FXE'],
  NHP10: ['Aqua', 'NHP10', '1NZ-FXE'],

  // Minivans and MPVs
  AZR60: ['Noah', 'R60', '1AZ-FSE'], AZR65: ['Noah', 'R60', '1AZ-FSE'],
  ZRR70: ['Noah', 'R70', '3ZR-FE'], ZRR75: ['Noah', 'R70', '3ZR-FE'],
  ZRR80: ['Noah', 'R80', '3ZR-FAE'], ZRR85: ['Noah', 'R80', '3ZR-FAE'], ZWR80: ['Noah', 'R80', '2ZR-FXE'],
  ZNE10: ['Wish', 'AE10', '1ZZ-FE'], ZNE14: ['Wish', 'AE10', '1ZZ-FE'], ANE10: ['Wish', 'AE10', '1AZ-FSE'],
  ZGE20: ['Wish', 'AE20', '2ZR-FAE'], ZGE21: ['Wish', 'AE20', '3ZR-FAE'], ZGE25: ['Wish', 'AE20', '2ZR-FAE'],
  ACR30: ['Estima', 'XR30', '2AZ-FE'], MCR30: ['Estima', 'XR30', '1MZ-FE'],
  ACR50: ['Estima', 'XR50', '2AZ-FE'], GSR50: ['Estima', 'XR50', '2GR-FE'],
  ANH10: ['Alphard', 'H10', '2AZ-FE'], MNH10: ['Alphard', 'H10', '1MZ-FE'],
  ANH20: ['Alphard', 'H20', '2AZ-FE'], GGH20: ['Alphard', 'H20', '2GR-FE'],

  // Sedans
  ACV30: ['Camry', 'XV30', '2AZ-FE'], MCV30: ['Camry', 'XV30', '1MZ-FE'], ACV40: ['Camry', 'XV40', '2AZ-FE'],
  ASV50: ['Camry', 'XV50', '2AR-FE'], AVV50: ['Camry', 'XV50', '2AR-FXE'],
  GRX120: ['Mark X', 'X120', '4GR-FSE'], GRX121: ['Mark X', 'X120', '3GR-FSE'],
  GRX130: ['Mark X', 'X130', '4GR-FSE'], GRX133: ['Mark X', 'X130', '2GR-FSE'],
  GRS180: ['Crown', 'S180', '4GR-FSE'], GRS182: ['Crown', 'S180', '3GR-FSE'],
  GRS200: ['Crown', 'S200', '4GR-FSE'], GRS202: ['Crown', 'S200', '3GR-FSE'], GRS210: ['Crown', 'S210', '4GR-FSE'],

  // SUVs
  ACU10: ['Harrier', 'XU10', '2AZ-FE'], MCU10: ['Harrier', 'XU10', '1MZ-FE'], SXU10: ['Harrier', 'XU10', '5S-FE'],
  ACU30: ['Harrier', 'XU30', '2AZ-FE'], ACU35: ['Harrier', 'XU30', '2AZ-FE'], MCU30: ['Harrier', 'XU30', '1MZ-FE'],
  MCU35: ['Harrier', 'XU30', '1MZ-FE'], GSU30: ['Harrier', 'XU30', '2GR-FE'], GSU35: ['Harrier', 'XU30', '2GR-FE'],
  ZSU60: ['Harrier', 'XU60', '3ZR-FAE'], ZSU65: ['Harrier', 'XU60', '3ZR-FAE'], ASU60: ['Harrier', 'XU60', '8AR-FTS'],
  ASU65: ['Harrier', 'XU60', '8AR-FTS'], AVU65: ['Harrier', 'XU60', '2AR-FXE'],
  ACU20: ['Highlander', 'XU20', '2AZ-FE'], ACU25: ['Highlander', 'XU20', '2AZ-FE'],
  MCU20: ['Highlander', 'XU20', '1MZ-FE'], MCU25: ['Highlander', 'XU20', '1MZ-FE'],
  KZJ90: ['Land Cruiser Prado', 'J90', '1KZ-TE'], KZJ95: ['Land Cruiser Prado', 'J90', '1KZ-TE'],
  RZJ95: ['Land Cruiser Prado', 'J90', '3RZ-FE'], VZJ95: ['Land Cruiser Prado', 'J90', '5VZ-FE'],
  KDJ120: ['Land Cruiser Prado', 'J120', '1KD-FTV'], KDJ125: ['Land Cruiser Prado', 'J120', '1KD-FTV'],
  TRJ120: ['Land Cruiser Prado', 'J120', '2TR-FE'], TRJ125: ['Land Cruiser Prado', 'J120', '2TR-FE'],
  GRJ120: ['Land Cruiser Prado', 'J120', '1GR-FE'], GRJ121: ['Land Cruiser Prado', 'J120', '1GR-FE'],
  RZJ120: ['Land Cruiser Prado', 'J120', '3RZ-FE'], RZJ125: ['Land Cruiser Prado', 'J120', '3RZ-FE'],
  TRJ150: ['Land Cruiser Prado', 'J150', '2TR-FE'], GRJ150: ['Land Cruiser Prado', 'J150', '1GR-FE'],
  GRJ151: ['Land Cruiser Prado', 'J150', '1GR-FE'], KDJ150: ['Land Cruiser Prado', 'J150', '1KD-FTV'],
  GDJ150: ['Land Cruiser Prado', 'J150', '1GD-FTV'], GDJ151: ['Land Cruiser Prado', 'J150', '1GD-FTV'],
  UZJ100: ['Land Cruiser', 'J100', '2UZ-FE'], HDJ100: ['Land Cruiser', 'J100', '1HD-FTE'],
  HDJ101: ['Land Cruiser', 'J100', '1HD-FTE'], HZJ105: ['Land Cruiser', 'J100', '1HZ'],
  UZJ200: ['Land Cruiser', 'J200', '2UZ-FE'], URJ200: ['Land Cruiser', 'J200', '1UR-FE'],
  URJ202: ['Land Cruiser', 'J200', '3UR-FE'], VDJ200: ['Land Cruiser', 'J200', '1VD-FTV'],
  GRJ200: ['Land Cruiser', 'J200', '1GR-FE'],
  HZJ76: ['Land Cruiser 70', 'J70', '1HZ'], HZJ78: ['Land Cruiser 70', 'J70', '1HZ'], HZJ79: ['Land Cruiser 70', 'J70', '1HZ'],
  VDJ76: ['Land Cruiser 70', 'J70', '1VD-FTV'], VDJ78: ['Land Cruiser 70', 'J70', '1VD-FTV'],
  VDJ79: ['Land Cruiser 70', 'J70', '1VD-FTV'], GRJ76: ['Land Cruiser 70', 'J70', '1GR-FE'],
  GRJ79: ['Land Cruiser 70', 'J70', '1GR-FE'],

  // Pickups, vans and minibuses
  KUN25: ['Hilux', 'AN10', '2KD-FTV'], KUN26: ['Hilux', 'AN10', '1KD-FTV'], GGN25: ['Hilux', 'AN10', '1GR-FE'],
  TGN16: ['Hilux', 'AN10', '2TR-FE'],
  GUN125: ['Hilux', 'AN120', '2GD-FTV'], GUN126: ['Hilux', 'AN120', '1GD-FTV'], TGN121: ['Hilux', 'AN120', '2TR-FE'],
  KUN51: ['Fortuner', 'AN50', '1KD-FTV'], KUN60: ['Fortuner', 'AN50', '2KD-FTV'], TGN51: ['Fortuner', 'AN50', '2TR-FE'],
  GUN155: ['Fortuner', 'AN160', '2GD-FTV'], GUN156: ['Fortuner', 'AN160', '1GD-FTV'], TGN156: ['Fortuner', 'AN160', '2TR-FE'],
  KDH200: ['Hiace', 'H200', '2KD-FTV'], KDH201: ['Hiace', 'H200', '2KD-FTV'], KDH205: ['Hiace', 'H200', '2KD-FTV'],
  KDH206: ['Hiace', 'H200', '2KD-FTV'], KDH220: ['Hiace', 'H200', '2KD-FTV'], KDH221: ['Hiace', 'H200', '2KD-FTV'],
  KDH222: ['Hiace', 'H200', '2KD-FTV'], KDH223: ['Hiace', 'H200', '2KD-FTV'],
  TRH200: ['Hiace', 'H200', '1TR-FE'], TRH214: ['Hiace', 'H200', '2TR-FE'], TRH219: ['Hiace', 'H200', '2TR-FE'],
  TRH221: ['Hiace', 'H200', '2TR-FE'], TRH223: ['Hiace', 'H200', '2TR-FE'],
};

/** Canonical form: "NZE121-3123456". Accepts dashes and spaces, or none at all. */
function parseFrame(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length < 9 || s.length > 14) return null;
  // The longest known code at the start wins, so "ZRE152H..." is the Auris, not the sedan.
  const known = Object.keys(CODES).filter((c) => s.startsWith(c) && /^\d{5,8}$/.test(s.slice(c.length)))
    .sort((a, b) => b.length - a.length)[0];
  if (known) return { frame: `${known}-${s.slice(known.length)}`, code: known, serial: s.slice(known.length), known: true };
  // Unknown code: letters, then the 2-3 digit series and an optional body letter, then the serial.
  const m = /^([A-Z]{2,5}\d{2,3}[A-Z]?)(\d{5,8})$/.exec(s);
  return m ? { frame: `${m[1]}-${m[2]}`, code: m[1], serial: m[2], known: false } : null;
}

/** True for a Japanese frame number (and never for a 17-character VIN). */
function isFrameNumber(raw) {
  return parseFrame(raw) != null;
}

/**
 * What a frame number tells us, in the same shape as a decoded VIN. `lineupMakes` is the catalogue
 * with its lineup; the engine is the generation's own label for the code ("1.5L Petrol").
 */
function decodeFrame(raw, lineupMakes) {
  const p = parseFrame(raw);
  if (!p) return null;
  const hit = p.known ? CODES[p.code] : null;
  if (!hit) return { frame: p.frame, code: p.code, maker: null, origin: 'Japan', car: null };
  const [modelName, generation, engineCode] = hit;
  const make = (lineupMakes || []).find((m) => m.make === 'Toyota');
  const model = make && make.models.find((m) => m.model === modelName);
  const gen = model && model.generations.find((g) => g.generation === generation);
  const engine = gen && gen.engines.find((e) => e.codes.includes(engineCode));
  return {
    frame: p.frame,
    code: p.code,
    maker: 'Toyota',
    origin: 'Japan',
    car: {
      source: 'frame',
      make: 'Toyota',
      model: modelName,
      generation: gen ? gen.generation : null,
      year_start: gen ? gen.year_start : null,
      year_end: gen ? gen.year_end : null,
      engine: engine ? engine.label : null,
      engine_code: engineCode,
      origin_market: 'Japan',
      year: null,
    },
  };
}

module.exports = { CODES, parseFrame, isFrameNumber, decodeFrame };
