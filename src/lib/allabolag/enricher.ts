import { searchCompanies, fetchOwner } from "./client";
import type { AllabolagCompany, AllabolagMatch } from "./types";
import { nameContainsPlace } from "./swedish-places";

export type AllabolagRanges = {
  employeesMin: number;
  employeesMax: number;
  /** Revenue bounds in SEK. */
  revenueMinSek: number;
  revenueMaxSek: number;
};

export const DEFAULT_RANGES: AllabolagRanges = {
  employeesMin: 5,
  employeesMax: 50,
  revenueMinSek: 5_000_000,
  revenueMaxSek: 50_000_000,
};

// Strip the legal-form suffix, punctuation, and accents so two spellings of
// the same company name compare equal.
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(ab|hb|kb|aktiebolag|i sverige|sweden)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Leading words that describe the service, not the company, and pollute search.
const SERVICE_PREFIXES = new Set([
  "takläggare", "takmålare", "takmålning", "taktvätt", "takvård",
  "takrenovering", "takreparation", "tak", "bygg", "byggservice", "städ",
  "städning", "fasadtvätt", "tvätt",
]);

// Build an ordered, deduped list of search terms for a messy business name.
// Full name first (often the registered name); then variants split on common
// marketing separators with leading service words stripped. Capped at 3.
export function buildSearchTerms(name: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.trim();
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  push(name);
  for (const seg of name.split(/[|–\-:]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length > 1 && SERVICE_PREFIXES.has(words[0].toLowerCase())) {
      words.shift();
    }
    // Skip single-word segments that are a bare service prefix or a bare place
    // name — they produce noise searches that crowd out the real company name.
    // Multi-word segments are always kept even if they contain a place.
    if (words.length === 1) {
      const w = words[0].toLowerCase();
      if (SERVICE_PREFIXES.has(w) || nameContainsPlace(words[0])) continue;
    }
    if (words.length) push(words.join(" "));
  }
  return out.slice(0, 3);
}

function normalizeCity(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Spacing-insensitive: "renatak syd" vs "renataksyd" should match.
  const da = na.replace(/\s+/g, "");
  const db = nb.replace(/\s+/g, "");
  if (da === db) return 1;
  if (da.includes(db) || db.includes(da)) return 0.85;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

function cityMatches(company: AllabolagCompany, leadCity: string): boolean {
  const c = normalizeCity(leadCity);
  if (!c) return false;
  const muni = company.municipality ? normalizeCity(company.municipality) : "";
  const place = company.postPlace ? normalizeCity(company.postPlace) : "";
  return (
    (!!muni && (muni.includes(c) || c.includes(muni))) ||
    (!!place && (place.includes(c) || c.includes(place)))
  );
}

// Find the best allabolag company for a lead. When a city is known, a
// same-city match is strongly preferred; matches are returned with a
// confidence score and a cityConfirmed flag so callers can flag low-quality
// matches rather than acting on a guess.
export async function matchLead(
  name: string,
  city: string | null,
): Promise<AllabolagMatch | null> {
  const terms = buildSearchTerms(name);
  const candidates: AllabolagCompany[] = [];
  const seen = new Set<string>();
  let searches = 0;
  for (const term of terms) {
    if (searches >= 2) break;
    searches++;
    const hits = await searchCompanies(term);
    for (const h of hits) {
      if (!seen.has(h.orgnr)) {
        seen.add(h.orgnr);
        candidates.push(h);
      }
    }
    // Stop early once we have a strong name match to avoid a second network call.
    if (candidates.some((c) => nameSimilarity(name, c.name) >= 0.85)) break;
  }
  if (candidates.length === 0) return null;

  let best: { company: AllabolagCompany; score: number; cityOk: boolean } | null =
    null;
  for (const company of candidates) {
    const sim = nameSimilarity(name, company.name);
    if (sim < 0.5) continue;
    const cityOk = city ? cityMatches(company, city) : false;
    // City agreement is worth more than a marginally better name match.
    const score = sim + (cityOk ? 0.5 : 0);
    if (!best || score > best.score) best = { company, score, cityOk };
  }
  if (!best) return null;

  // If we have a city but no candidate confirmed it, treat as low confidence.
  const confidence = Math.min(1, best.score) * (city && !best.cityOk ? 0.6 : 1);

  let ownerName: string | null = null;
  let ownerRole: string | null = null;
  try {
    const owner = await fetchOwner(best.company.orgnr);
    if (owner) {
      ownerName = owner.name;
      ownerRole = owner.role || null;
    }
  } catch {
    // Owner lookup is best-effort; financials still stand without it.
  }

  return {
    company: best.company,
    ownerName,
    ownerRole,
    confidence,
    cityConfirmed: best.cityOk,
  };
}

export type FilterVerdict =
  | { keep: true }
  | { keep: false; reason: string };

// Apply the employee/revenue ranges. Blank revenue is always a drop.
export function evaluate(
  company: AllabolagCompany,
  ranges: AllabolagRanges,
): FilterVerdict {
  if (company.revenueSek == null) {
    return { keep: false, reason: "no revenue data" };
  }
  if (
    company.revenueSek < ranges.revenueMinSek ||
    company.revenueSek > ranges.revenueMaxSek
  ) {
    return { keep: false, reason: "revenue out of range" };
  }
  if (company.employees != null) {
    if (
      company.employees < ranges.employeesMin ||
      company.employees > ranges.employeesMax
    ) {
      return { keep: false, reason: "employees out of range" };
    }
  }
  return { keep: true };
}
