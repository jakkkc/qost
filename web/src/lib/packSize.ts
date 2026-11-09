export type BaseUnit = "g" | "ml" | "each";

export interface PackSizeSuggestion {
  base_unit: BaseUnit;
  factor: number; // least units per one report unit (e.g. 1 CARTON = 12000 ml)
  confidence: "high" | "check";
  note: string;
}

const MASS: Record<string, number> = { KG: 1000, KGS: 1000, G: 1, GM: 1, GMS: 1, GRAM: 1, GRAMS: 1 };
const VOLUME: Record<string, number> = { L: 1000, LT: 1000, LTR: 1000, LTRS: 1000, ML: 1 };
const MULTI_UNITS = new Set(["PACK", "CARTON", "CASE", "CRATE", "BAG", "BOX", "PARCEL", "DOZEN"]);

/**
 * Guesses the least unit and conversion factor from the item name and its report unit.
 * Examples: "MAIZE FLOUR 2KG/PACKET" -> 2000 g; "HOT TOMATO KETCHUP 380G*6" (PACK) -> 2280 g.
 * Anything not obvious is marked "check" so the user confirms it once.
 */
export function suggestPackSize(name: string, unit: string): PackSizeSuggestion | null {
  const n = name.toUpperCase();
  const u = unit.toUpperCase();

  // report unit is already a measure: KGS, LTRS
  if (MASS[u]) return { base_unit: "g", factor: MASS[u], confidence: "high", note: `1 ${u} = ${MASS[u]} g` };
  if (VOLUME[u]) return { base_unit: "ml", factor: VOLUME[u], confidence: "high", note: `1 ${u} = ${VOLUME[u]} ml` };

  // size in the name: "500ML", "2KG", "380G*6", "/KG"
  const m = n.match(/(\d+(?:\.\d+)?)\s*(KGS?|GMS?|G|LTRS?|LTR|L|ML)\b(?:\s*[*X]\s*(\d+))?/) ??
            n.match(/\/\s*()(KGS?|LTRS?|LTR|L)\b/);
  if (m) {
    const size = m[1] ? parseFloat(m[1]) : 1;
    const unitKey = m[2];
    const mult = m[3] ? parseInt(m[3], 10) : 1;
    const isMass = MASS[unitKey] !== undefined;
    const perPiece = size * (isMass ? MASS[unitKey] : VOLUME[unitKey]);
    const multiPack = MULTI_UNITS.has(u);
    const factor = multiPack && mult > 1 ? perPiece * mult : perPiece;
    const base = isMass ? "g" : "ml";
    // A multi-pack unit (CARTON, PACK...) with no "*6" in the name: we can't know the piece count.
    if (multiPack && mult === 1)
      return { base_unit: base, factor, confidence: "check",
               note: `Name says ${size}${unitKey} but the unit is ${u}: confirm how many pieces are in one ${u}` };
    return { base_unit: base, factor, confidence: "high", note: `1 ${u} = ${factor} ${base} (from the name)` };
  }

  // plain countable units
  if (["PCS", "PC", "PIECE", "PIECES", "BTL", "PKTS", "PKT", "EACH"].includes(u))
    return { base_unit: "each", factor: 1, confidence: "high", note: `1 ${u} = 1 each` };

  return null;
}
