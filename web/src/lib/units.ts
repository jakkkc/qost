// The internal system reports the same unit in many spellings (PCS, PC, PIECE, piece...).
const ALIASES: Record<string, string> = {
  PC: "PCS", PCS: "PCS", PIECE: "PCS", PIECES: "PCS", PCE: "PCS", EACH: "PCS",
  PKT: "PKTS", PKTS: "PKTS", PACKET: "PKTS", PACKETS: "PKTS",
  KG: "KGS", KGS: "KGS", KILO: "KGS",
  LTR: "LTRS", LTRS: "LTRS", LITRE: "LTRS", LITRES: "LTRS", L: "LTRS",
  BTL: "BTL", BOTTLE: "BTL", BOTTLES: "BTL",
};

export function normalizeUnit(raw: unknown): string {
  const u = String(raw ?? "").trim().toUpperCase();
  return ALIASES[u] ?? u;
}
