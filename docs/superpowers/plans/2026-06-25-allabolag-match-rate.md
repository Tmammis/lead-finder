# Allabolag Match-Rate & Auto-Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the allabolag match rate for messy Google Maps company names with deterministic heuristics, gate matches safely by city (except when the name itself contains a place), and decouple allabolag into its own independently-toggleable pass with a re-check button.

**Architecture:** allabolag stops being a step inside `enrichLead` and becomes a standalone pass (`runCampaignAllabolag`) shared by post-discovery auto-run and a manual re-check button. Matching is improved via search-term cleaning, spacing-insensitive name comparison, and a Swedish place gazetteer that decides whether the city gate applies. A new `allabolagConfig.autoEnrich` flag controls automatic running, independent of the campaign's global `autoEnrich` (which now governs only the paid Apify enrichers).

**Tech Stack:** Next.js 16 App Router, TypeScript (strict, no `any`), Drizzle + better-sqlite3, Tailwind v4, shadcn/ui, sonner toasts. Network calls to allabolag.se via `fetch` + `__NEXT_DATA__` parsing.

## Global Constraints

- TypeScript strict, no `any` (use `unknown` + narrow). Copied from CLAUDE.md.
- Path alias `@/` → `src/`.
- Access the DB via `getDb()` from `src/lib/db` — never instantiate `Database`. API routes call `getDb()` inside the handler, not at module scope.
- All allabolag access goes through `src/lib/allabolag/*`; no Apify, no API key.
- SSE event types are fixed for this work — **reuse `lead:status-changed` and existing handlers; do not add a new event type.**
- **No test framework exists in this repo.** "Tests" in this plan are ad-hoc TypeScript verification scripts run with `NODE_OPTIONS="--conditions=react-server" npx tsx <file>`. Create each script at the **repo root** (so the `@/` alias and relative imports resolve), named `_verify-*.ts`, and delete it in the final step of its task. For wiring/UI tasks, verification is `npx tsc --noEmit` + `npm run lint` (expect only pre-existing warnings) plus the stated manual check.
- The SQLite DB is `lead-finder.db` at the repo root. Campaign 8 ("skåne - 3-50 miljoner Takläggare & takmålare") is the live acceptance fixture: 30 leads, 24 currently `needs_review`.
- `allabolagConfig` is a JSON column — adding a field needs **no migration**. A missing `autoEnrich` is treated as `true`.
- Commit after each task. Work on a branch off `main` (not directly on `main`).

---

## File Structure

- `src/lib/allabolag/swedish-places.ts` *(new)* — place gazetteer + `nameContainsPlace`.
- `src/lib/allabolag/enricher.ts` *(modify)* — `buildSearchTerms`, spacing-insensitive `nameSimilarity`, `matchLead` multi-term search.
- `src/lib/allabolag/pass.ts` *(new)* — `getLeadCity`, `applyAllabolag`, `mergeMappedData`, `runCampaignAllabolag` (moved out of `pipeline.ts`).
- `src/lib/enrichment/pipeline.ts` *(modify)* — remove allabolag block from `enrichLead`; drop moved helpers.
- `src/lib/apify/discovery.ts` *(modify)* — post-discovery orchestration of the two independent auto-runs.
- `src/lib/db/schema.ts` *(modify)* — add `autoEnrich?: boolean` to `AllabolagConfig`.
- `src/app/api/campaigns/[id]/recheck-allabolag/route.ts` *(new)* — POST endpoint.
- `src/components/campaigns/allabolag-settings.tsx` *(modify)* — auto-run toggle + `ALLABOLAG_DEFAULTS`.
- `src/app/(dashboard)/campaigns/[id]/page.tsx` *(modify)* — re-check button + handler.

---

### Task 1: Swedish place gazetteer + `nameContainsPlace`

**Files:**
- Create: `src/lib/allabolag/swedish-places.ts`
- Test: `_verify-places.ts` (repo root, deleted at end)

**Interfaces:**
- Consumes: nothing.
- Produces: `nameContainsPlace(name: string): boolean` — true when the name contains a Swedish municipality or region as a whole token (single-word places) or substring (multi-word places), excluding an ambiguous-word denylist.

- [ ] **Step 1: Write the failing verification script**

Create `_verify-places.ts` at the repo root:

```ts
import assert from "node:assert";
import { nameContainsPlace } from "./src/lib/allabolag/swedish-places";

assert.equal(nameContainsPlace("Takmålning Helsingborg - Decatak AB"), true, "helsingborg");
assert.equal(nameContainsPlace("Lomma Tak AB"), true, "lomma");
assert.equal(nameContainsPlace("TAKREPARATION SKÅNE AB"), true, "skåne region");
assert.equal(nameContainsPlace("Tak & Fasadtvätt i Lund"), true, "lund");
assert.equal(nameContainsPlace("RenaTak Syd"), false, "syd is not a place");
assert.equal(nameContainsPlace("Berg & Söner Tak AB"), false, "berg is denylisted");
assert.equal(nameContainsPlace("Skåne Hus & Takvård"), true, "skåne in name");
console.log("OK places");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_OPTIONS="--conditions=react-server" npx tsx _verify-places.ts`
Expected: FAIL — `Cannot find module './src/lib/allabolag/swedish-places'`.

- [ ] **Step 3: Create the gazetteer**

Create `src/lib/allabolag/swedish-places.ts`:

```ts
// Sweden's 21 regions/län + 290 municipalities (kommuner), lowercased.
// Used to decide whether a business name already encodes its location — when it
// does, the allabolag city gate is skipped (a company's registered municipality
// is often a different town than where it operates).

const REGIONS = [
  "stockholm", "uppsala", "södermanland", "östergötland", "jönköping",
  "kronoberg", "kalmar", "gotland", "blekinge", "skåne", "halland",
  "västra götaland", "värmland", "örebro", "västmanland", "dalarna",
  "gävleborg", "västernorrland", "jämtland", "västerbotten", "norrbotten",
];

const MUNICIPALITIES = [
  // Stockholm
  "upplands väsby", "vallentuna", "österåker", "värmdö", "järfälla", "ekerö",
  "huddinge", "botkyrka", "salem", "haninge", "tyresö", "upplands-bro",
  "nykvarn", "täby", "danderyd", "sollentuna", "stockholm", "södertälje",
  "nacka", "sundbyberg", "solna", "lidingö", "vaxholm", "norrtälje", "sigtuna",
  "nynäshamn",
  // Uppsala
  "håbo", "älvkarleby", "knivsta", "heby", "tierp", "uppsala", "enköping",
  "östhammar",
  // Södermanland
  "vingåker", "gnesta", "nyköping", "oxelösund", "flen", "katrineholm",
  "eskilstuna", "strängnäs", "trosa",
  // Östergötland
  "ödeshög", "ydre", "kinda", "boxholm", "åtvidaberg", "finspång",
  "valdemarsvik", "linköping", "norrköping", "söderköping", "motala",
  "vadstena", "mjölby",
  // Jönköping
  "aneby", "gnosjö", "mullsjö", "habo", "gislaved", "vaggeryd", "jönköping",
  "nässjö", "värnamo", "sävsjö", "vetlanda", "eksjö", "tranås",
  // Kronoberg
  "uppvidinge", "lessebo", "tingsryd", "alvesta", "älmhult", "markaryd",
  "växjö", "ljungby",
  // Kalmar
  "högsby", "torsås", "mörbylånga", "hultsfred", "mönsterås", "emmaboda",
  "kalmar", "nybro", "oskarshamn", "västervik", "vimmerby", "borgholm",
  // Gotland
  "gotland",
  // Blekinge
  "olofström", "karlskrona", "ronneby", "karlshamn", "sölvesborg",
  // Skåne
  "svalöv", "staffanstorp", "burlöv", "vellinge", "östra göinge",
  "örkelljunga", "bjuv", "kävlinge", "lomma", "svedala", "skurup", "sjöbo",
  "hörby", "höör", "tomelilla", "bromölla", "osby", "perstorp", "klippan",
  "åstorp", "båstad", "malmö", "lund", "landskrona", "helsingborg", "höganäs",
  "eslöv", "ystad", "trelleborg", "kristianstad", "simrishamn", "ängelholm",
  "hässleholm",
  // Halland
  "hylte", "halmstad", "laholm", "falkenberg", "varberg", "kungsbacka",
  // Västra Götaland
  "härryda", "partille", "öckerö", "stenungsund", "tjörn", "orust", "sotenäs",
  "munkedal", "tanum", "dals-ed", "färgelanda", "ale", "lerum", "vårgårda",
  "bollebygd", "grästorp", "essunga", "karlsborg", "gullspång", "tranemo",
  "bengtsfors", "mellerud", "lilla edet", "mark", "svenljunga", "herrljunga",
  "vara", "götene", "tibro", "töreboda", "göteborg", "mölndal", "kungälv",
  "lysekil", "uddevalla", "strömstad", "vänersborg", "trollhättan", "alingsås",
  "borås", "ulricehamn", "åmål", "mariestad", "lidköping", "skara", "skövde",
  "hjo", "tidaholm", "falköping",
  // Värmland
  "kil", "eda", "torsby", "storfors", "hammarö", "munkfors", "forshaga",
  "grums", "årjäng", "sunne", "karlstad", "kristinehamn", "filipstad",
  "hagfors", "arvika", "säffle",
  // Örebro
  "lekeberg", "laxå", "hallsberg", "degerfors", "hällefors", "ljusnarsberg",
  "örebro", "kumla", "askersund", "karlskoga", "nora", "lindesberg",
  // Västmanland
  "skinnskatteberg", "surahammar", "kungsör", "hallstahammar", "norberg",
  "västerås", "sala", "fagersta", "köping", "arboga",
  // Dalarna
  "vansbro", "malung-sälen", "gagnef", "leksand", "rättvik", "orsa",
  "älvdalen", "smedjebacken", "mora", "falun", "borlänge", "säter", "hedemora",
  "avesta", "ludvika",
  // Gävleborg
  "ockelbo", "hofors", "ovanåker", "nordanstig", "ljusdal", "gävle",
  "sandviken", "söderhamn", "bollnäs", "hudiksvall",
  // Västernorrland
  "ånge", "timrå", "härnösand", "sundsvall", "kramfors", "sollefteå",
  "örnsköldsvik",
  // Jämtland
  "ragunda", "bräcke", "krokom", "strömsund", "åre", "berg", "härjedalen",
  "östersund",
  // Västerbotten
  "nordmaling", "bjurholm", "vindeln", "robertsfors", "norsjö", "malå",
  "storuman", "sorsele", "dorotea", "vännäs", "vilhelmina", "åsele", "umeå",
  "lycksele", "skellefteå",
  // Norrbotten
  "arvidsjaur", "arjeplog", "jokkmokk", "överkalix", "kalix", "övertorneå",
  "pajala", "gällivare", "älvsbyn", "luleå", "piteå", "boden", "haparanda",
  "kiruna",
];

// Place names that are also common Swedish words or surnames; matching on these
// causes false positives, so we exclude them and let the city gate handle those
// leads instead (the safe fallback).
const DENYLIST = new Set([
  "mark", "vara", "ale", "berg", "mora", "sala", "kil", "åre", "ed", "habo",
]);

const SINGLE = new Set<string>();
const MULTI: string[] = [];
for (const p of [...REGIONS, ...MUNICIPALITIES]) {
  if (DENYLIST.has(p)) continue;
  if (p.includes(" ") || p.includes("-")) MULTI.push(p);
  else SINGLE.add(p);
}

// Lowercase, strip accents-insensitively NO — keep Swedish chars; only split on
// non-letter separators so "Helsingborg-" and "Lund," tokenize cleanly.
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-zà-öø-ÿ0-9]+/)
    .filter(Boolean);
}

export function nameContainsPlace(name: string): boolean {
  if (!name) return false;
  const toks = tokens(name);
  for (const t of toks) {
    if (SINGLE.has(t)) return true;
  }
  const normalized = name.toLowerCase();
  for (const m of MULTI) {
    if (normalized.includes(m)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `NODE_OPTIONS="--conditions=react-server" npx tsx _verify-places.ts`
Expected: prints `OK places`, exit 0.

- [ ] **Step 5: Typecheck, clean up, commit**

```bash
npx tsc --noEmit
rm -f _verify-places.ts
git add src/lib/allabolag/swedish-places.ts
git commit -m "feat(allabolag): add Swedish place gazetteer for city-gate decisions"
```

---

### Task 2: Search-term cleaning + spacing-insensitive name matching

**Files:**
- Modify: `src/lib/allabolag/enricher.ts` (`nameSimilarity` ~40-51, `matchLead` ~68-85; add `buildSearchTerms`)
- Test: `_verify-matcher.ts` (repo root, deleted at end)

**Interfaces:**
- Consumes: `searchCompanies(term)` from `./client`.
- Produces:
  - `export function buildSearchTerms(name: string): string[]` — ordered, deduped: full name first, then cleaned variant(s) (split on `|`, `–`, `-`, `:`; strip leading service words). Length ≤ 3.
  - `nameSimilarity(a, b)` now also returns 1 when the despaced normalized forms are equal and 0.85 when one despaced form contains the other.
  - `matchLead(name, city)` unchanged signature/return, but searches across `buildSearchTerms` (capped at 2 network searches), deduping candidates by `orgnr`.

- [ ] **Step 1: Write the failing verification script**

Create `_verify-matcher.ts` at the repo root:

```ts
import assert from "node:assert";
import { buildSearchTerms } from "./src/lib/allabolag/enricher";

const t1 = buildSearchTerms("Takmålning Helsingborg - Decatak AB");
assert.ok(t1.includes("Takmålning Helsingborg - Decatak AB"), "keeps full");
assert.ok(t1.some((t) => t.trim().toLowerCase() === "decatak ab"), "extracts core after dash");

const t2 = buildSearchTerms("Taktvätt | Skåne Hus & Takvård");
assert.ok(t2.some((t) => t.trim().toLowerCase() === "skåne hus & takvård"), "extracts after pipe");

const t3 = buildSearchTerms("RenaTak Syd");
assert.deepEqual(t3, ["RenaTak Syd"], "no separators -> single term");

assert.ok(buildSearchTerms("a - b - c - d").length <= 3, "capped at 3");
console.log("OK matcher");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_OPTIONS="--conditions=react-server" npx tsx _verify-matcher.ts`
Expected: FAIL — `buildSearchTerms` is not exported / not a function.

- [ ] **Step 3: Add `buildSearchTerms` and update `nameSimilarity`**

In `src/lib/allabolag/enricher.ts`, add after `normalizeName` (around line 29):

```ts
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
    if (words.length) push(words.join(" "));
  }
  return out.slice(0, 3);
}
```

Replace `nameSimilarity` (currently ~lines 40-51) with:

```ts
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
```

- [ ] **Step 4: Update `matchLead` to search across terms**

Replace the candidate-gathering at the top of `matchLead` (currently `const candidates = await searchCompanies(name); if (candidates.length === 0) return null;`) with:

```ts
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
```

Add `AllabolagCompany` to the existing type import from `./types` at the top of the file if not already imported.

- [ ] **Step 5: Run the verification script to verify it passes**

Run: `NODE_OPTIONS="--conditions=react-server" npx tsx _verify-matcher.ts`
Expected: prints `OK matcher`.

- [ ] **Step 6: Live spot-check (network) — optional but recommended**

Create `_verify-live.ts`:

```ts
import { matchLead } from "./src/lib/allabolag/enricher";
for (const [n, c] of [["RenaTak Syd", "Malmö"], ["Skåne Hus & Takvård", "Kristianstad"]] as const) {
  const m = await matchLead(n, c);
  console.log(n, "->", m?.company.name, m?.company.employees, m?.company.revenueSek, "cityOk:", m?.cityConfirmed);
}
```
Run: `NODE_OPTIONS="--conditions=react-server" npx tsx _verify-live.ts`
Expected: `RenaTak Syd -> RenaTakSyd AB 5 8290000 cityOk: true` (and a Skåne match). If allabolag is unreachable, skip.

- [ ] **Step 7: Typecheck, clean up, commit**

```bash
npx tsc --noEmit
rm -f _verify-matcher.ts _verify-live.ts
git add src/lib/allabolag/enricher.ts
git commit -m "feat(allabolag): clean search terms and match names ignoring spacing"
```

---

### Task 3: Harden city extraction + apply the place/city gate

**Files:**
- Modify: `src/lib/enrichment/pipeline.ts` (`getLeadCity` ~22-42, `applyAllabolag` ~57-121)
- Test: `_verify-city.ts` (repo root, deleted at end)

**Interfaces:**
- Consumes: `nameContainsPlace` from `../allabolag/swedish-places`.
- Produces: behavior change only — `getLeadCity` also reads `businessAddress` and parses mid-string cities; `applyAllabolag` applies the new gate. Signatures unchanged.

- [ ] **Step 1: Write the failing verification script**

Create `_verify-city.ts` at the repo root. `getLeadCity` is not exported; this step also exports it. Script:

```ts
import assert from "node:assert";
import { getLeadCity } from "./src/lib/enrichment/pipeline";
import type { Lead } from "./src/lib/db/schema";

const mk = (mapped: Record<string, unknown>, raw: Record<string, unknown> = {}) =>
  ({ mappedData: mapped, rawData: raw } as unknown as Lead);

assert.equal(getLeadCity(mk({}, { city: "Malmö" })), "Malmö", "raw.city");
assert.equal(
  getLeadCity(mk({ businessAddress: "Bals Väg 9, Kristianstad, Sweden, 29194" })),
  "Kristianstad",
  "businessAddress mid-string",
);
assert.equal(
  getLeadCity(mk({ businessAddress: "Krusegatan 42, 212 25 Malmö, Sweden" })),
  "Malmö",
  "businessAddress postcode+city",
);
console.log("OK city");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_OPTIONS="--conditions=react-server" npx tsx _verify-city.ts`
Expected: FAIL — `getLeadCity` is not exported.

- [ ] **Step 3: Export and harden `getLeadCity`**

In `src/lib/enrichment/pipeline.ts`, change `function getLeadCity` to `export function getLeadCity` and replace its body with:

```ts
export function getLeadCity(lead: Lead): string | null {
  const mapped = (lead.mappedData as Record<string, unknown>) || {};
  const raw = (lead.rawData as Record<string, unknown>) || {};
  const direct = [
    mapped.city, mapped.City,
    raw.city, raw.City,
    (raw.address as Record<string, unknown> | undefined)?.city,
  ];
  for (const c of direct) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  // Fall back to parsing a full address string from either source.
  const addr = mapped.address ?? raw.address ?? mapped.businessAddress;
  if (typeof addr === "string") {
    // "<street>, <postcode> <City>, Sweden" — city after the postcode.
    const withPostcode = addr.match(/\d{3}\s?\d{2}\s+([A-Za-zÅÄÖåäö\s-]+?)(?:,|$)/);
    if (withPostcode) return withPostcode[1].trim();
    // "<street>, <City>, Sweden[, <postcode>]" — city is the 2nd comma field.
    const parts = addr.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const candidate = parts[1].replace(/\bsweden\b/i, "").trim();
      if (candidate && !/^\d/.test(candidate)) return candidate;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the verification script to verify it passes**

Run: `NODE_OPTIONS="--conditions=react-server" npx tsx _verify-city.ts`
Expected: prints `OK city`.

- [ ] **Step 5: Apply the place/city gate in `applyAllabolag`**

Add the import near the top of `pipeline.ts`:

```ts
import { nameContainsPlace } from "../allabolag/swedish-places";
```

In `applyAllabolag`, replace the block from `const { company } = match;` down to the final `mergeMappedData(db, leadId, { ...base, allabolagMatch: "matched" }); return "kept";` with gate logic:

```ts
  const { company } = match;
  const base: Record<string, unknown> = {
    allabolagEmployees: company.employees,
    allabolagRevenueSek: company.revenueSek,
    allabolagOwner: match.ownerName,
    allabolagOwnerRole: match.ownerRole,
    allabolagOrgnr: company.orgnr,
    allabolagUrl: company.url,
    allabolagCityConfirmed: match.cityConfirmed,
  };

  // Gate: if the business name already contains a place, trust the name match
  // and skip the city check (the registered municipality is unreliable here).
  // Otherwise require city confirmation before acting on the financials.
  const nameHasPlace = nameContainsPlace(lead.displayName as string);
  if (!nameHasPlace && !match.cityConfirmed) {
    mergeMappedData(db, leadId, { allabolagMatch: "needs_review" });
    return "kept";
  }

  const verdict = evaluate(company, {
    employeesMin: cfg.employeesMin,
    employeesMax: cfg.employeesMax,
    revenueMinSek: cfg.revenueMinSek,
    revenueMaxSek: cfg.revenueMaxSek,
  });

  if (!verdict.keep) {
    mergeMappedData(db, leadId, {
      ...base,
      allabolagMatch: "dropped",
      allabolagDropReason: verdict.reason,
    });
    db.update(leads)
      .set({ status: "archived", updatedAt: new Date().toISOString() })
      .where(eq(leads.id, leadId))
      .run();
    leadEmitter.emit("lead:status-changed", {
      leadId,
      campaignId: lead.campaignId!,
      status: "archived",
    });
    return "dropped";
  }

  mergeMappedData(db, leadId, { ...base, allabolagMatch: "matched" });
  return "kept";
```

- [ ] **Step 6: Typecheck + lint, clean up, commit**

```bash
npx tsc --noEmit
npm run lint 2>&1 | grep -E "pipeline.ts|swedish-places" || echo "no new lint issues in touched files"
rm -f _verify-city.ts
git add src/lib/enrichment/pipeline.ts
git commit -m "feat(allabolag): harden city extraction and add place/city match gate"
```

---

### Task 4: Add `autoEnrich` config flag + move allabolag helpers into a pass module

**Files:**
- Modify: `src/lib/db/schema.ts:28-34` (type)
- Create: `src/lib/allabolag/pass.ts`
- Modify: `src/lib/enrichment/pipeline.ts` (remove moved helpers; import from pass)

**Interfaces:**
- Consumes: `matchLead`, `evaluate` (`./enricher`); `nameContainsPlace` (`./swedish-places`); `getDb`, `leads`, schema types; `leadEmitter`.
- Produces (from `pass.ts`):
  - `export function getLeadCity(lead: Lead): string | null`
  - `export async function applyAllabolag(leadId: number, lead: Lead, cfg: AllabolagConfig): Promise<"dropped" | "kept">`
  - (`mergeMappedData` stays private to `pass.ts`.)
- This task is a **pure move + type addition — no behavior change.** `enrichLead` still calls `applyAllabolag`, now imported from `../allabolag/pass`.

- [ ] **Step 1: Add the config field**

In `src/lib/db/schema.ts`, extend the type (lines 28-34):

```ts
export type AllabolagConfig = {
  enabled: boolean;
  employeesMin: number;
  employeesMax: number;
  revenueMinSek: number;
  revenueMaxSek: number;
  /** Auto-run allabolag after discovery, independent of campaign.autoEnrich.
   *  Missing is treated as true (preserves pre-existing behavior). */
  autoEnrich?: boolean;
};
```

- [ ] **Step 2: Create `pass.ts` with the moved helpers**

Create `src/lib/allabolag/pass.ts` by moving `getLeadCity`, `mergeMappedData`, and `applyAllabolag` out of `pipeline.ts` verbatim (as they stand after Task 3), with their own imports:

```ts
import { getDb } from "../db";
import { leads, type AllabolagConfig, type Lead } from "../db/schema";
import { eq } from "drizzle-orm";
import { matchLead, evaluate } from "./enricher";
import { nameContainsPlace } from "./swedish-places";
import type { AllabolagMatch } from "./types";
import { leadEmitter } from "../events/emitter";

export function getLeadCity(lead: Lead): string | null {
  /* ...exact body from pipeline.ts after Task 3... */
}

function mergeMappedData(
  db: ReturnType<typeof getDb>,
  leadId: number,
  patch: Record<string, unknown>,
): void {
  const fresh = db.select({ mappedData: leads.mappedData }).from(leads).where(eq(leads.id, leadId)).get();
  const existing = (fresh?.mappedData as Record<string, unknown>) || {};
  db.update(leads)
    .set({ mappedData: { ...existing, ...patch }, updatedAt: new Date().toISOString() })
    .where(eq(leads.id, leadId))
    .run();
}

export async function applyAllabolag(
  leadId: number,
  lead: Lead,
  cfg: AllabolagConfig,
): Promise<"dropped" | "kept"> {
  /* ...exact body from pipeline.ts after Task 3... */
}
```

- [ ] **Step 3: Remove the moved helpers from `pipeline.ts` and import them**

In `src/lib/enrichment/pipeline.ts`: delete the `getLeadCity`, `mergeMappedData`, and `applyAllabolag` definitions and the now-unused imports they introduced (`matchLead`, `evaluate`, `nameContainsPlace`, `AllabolagMatch` if unused elsewhere). Add:

```ts
import { applyAllabolag } from "../allabolag/pass";
```

Leave the `enrichLead` call site (`const outcome = await applyAllabolag(leadId, lead, allabolagCfg);`) untouched.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: exit 0 (no errors). Fix any "declared but never used" by removing the dead imports flagged.

Run: `npm run lint 2>&1 | grep -E "pass.ts|pipeline.ts" || echo "no new issues"`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema.ts src/lib/allabolag/pass.ts src/lib/enrichment/pipeline.ts
git commit -m "refactor(allabolag): move pass helpers to allabolag module, add autoEnrich flag"
```

---

### Task 5: Build `runCampaignAllabolag`, decouple from enrichment, wire post-discovery

**Files:**
- Modify: `src/lib/allabolag/pass.ts` (add `runCampaignAllabolag`)
- Modify: `src/lib/enrichment/pipeline.ts` (remove allabolag block from `enrichLead`)
- Modify: `src/lib/apify/discovery.ts:312-332`

**Interfaces:**
- Consumes: `isCampaignStopped` (`../apify/runner`), `campaigns`, `leads`, `applyAllabolag`, `getDb`, `inArray`/`and`/`eq` (drizzle).
- Produces:
  - `export type AllabolagRunSummary = { rechecked: number; nowMatched: number; nowArchived: number; stillNeedsReview: number }`
  - `export async function runCampaignAllabolag(campaignId: number, leadIds?: number[]): Promise<AllabolagRunSummary>`

- [ ] **Step 1: Add `runCampaignAllabolag` to `pass.ts`**

Append to `src/lib/allabolag/pass.ts` (extend imports: `campaigns`, `and`, `inArray`, `notInArray`, `isCampaignStopped`):

```ts
export type AllabolagRunSummary = {
  rechecked: number;
  nowMatched: number;
  nowArchived: number;
  stillNeedsReview: number;
};

// Shared allabolag pass. With leadIds, processes exactly those leads
// (post-discovery: the newly inserted leads). Without, processes the campaign's
// not-yet-confirmed leads (allabolagMatch needs_review / lookup_failed / absent).
// Never touches leads already "matched" or "dropped".
export async function runCampaignAllabolag(
  campaignId: number,
  leadIds?: number[],
): Promise<AllabolagRunSummary> {
  const db = getDb();
  const summary: AllabolagRunSummary = {
    rechecked: 0, nowMatched: 0, nowArchived: 0, stillNeedsReview: 0,
  };

  const campaign = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
  const cfg = (campaign?.allabolagConfig as AllabolagConfig | null) ?? null;
  if (!cfg?.enabled) return summary;

  const rows = leadIds && leadIds.length > 0
    ? db.select().from(leads).where(and(eq(leads.campaignId, campaignId), inArray(leads.id, leadIds))).all()
    : db.select().from(leads).where(eq(leads.campaignId, campaignId)).all();

  for (const lead of rows) {
    if (isCampaignStopped(campaignId)) break;
    if (!lead.displayName) continue;
    const prior = (lead.mappedData as Record<string, unknown> | null)?.allabolagMatch;
    // Skip leads with a confirmed verdict — only recover unmatched ones.
    if (prior === "matched" || prior === "dropped") continue;

    const outcome = await applyAllabolag(lead.id, lead, cfg);
    summary.rechecked++;
    if (outcome === "dropped") {
      summary.nowArchived++;
    } else {
      const after = db.select({ mappedData: leads.mappedData }).from(leads).where(eq(leads.id, lead.id)).get();
      const status = (after?.mappedData as Record<string, unknown> | null)?.allabolagMatch;
      if (status === "matched") summary.nowMatched++;
      else summary.stillNeedsReview++;
    }
    leadEmitter.emit("lead:status-changed", {
      leadId: lead.id,
      campaignId,
      status: outcome === "dropped" ? "archived" : "new",
    });
  }
  return summary;
}
```

- [ ] **Step 2: Decouple allabolag from `enrichLead`**

In `src/lib/enrichment/pipeline.ts`, delete the allabolag block in `enrichLead` (the `const campaignRow = ...` through the `if (allabolagCfg?.enabled ...) { ... }` block, currently ~lines 148-160) and the now-unused `applyAllabolag` import. `enrichLead` now goes straight from setting status `enriching` into the Apify actor loop.

- [ ] **Step 3: Orchestrate the two independent auto-runs after discovery**

In `src/lib/apify/discovery.ts`, add at top: `import { runCampaignAllabolag } from "../allabolag/pass";` and `import type { AllabolagConfig } from "../db/schema";` (if not present). Collect inserted lead IDs — the discovery results already carry inserted leads; if not exposed, query them: leads in this campaign created during this run. Replace the block at lines 312-332 with:

```ts
  const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
  const newLeadIds = db.select({ id: leads.id }).from(leads)
    .where(and(eq(leads.campaignId, campaignId), eq(leads.status, "new")))
    .all().map((r) => r.id);

  const allabolagCfg = (campaign.allabolagConfig as AllabolagConfig | null) ?? null;
  const allabolagAuto = !!allabolagCfg?.enabled && (allabolagCfg.autoEnrich ?? true);
  if (allabolagAuto && totalInserted > 0 && !isCampaignStopped(campaignId)) {
    try {
      await runCampaignAllabolag(campaignId, newLeadIds);
    } catch (err) {
      console.error(`Auto allabolag failed for campaign ${campaignId}:`, err);
    }
  }

  if (campaign.autoEnrich && totalInserted > 0 && !isCampaignStopped(campaignId)) {
    try {
      const enrichResult = await enrichCampaignLeads(
        campaignId,
        null,
        campaign.aiProvider as AIProvider
      );
      db.insert(analyticsEvents).values({
        eventType: "auto_enrichment_completed",
        campaignId,
        metadata: { enriched: enrichResult.enriched, failed: enrichResult.failed },
      }).run();
    } catch (err) {
      console.error(`Auto-enrichment failed for campaign ${campaignId}:`, err);
    }
  }
```

Ensure `and` is imported from `drizzle-orm` in `discovery.ts` (add to the existing import if missing).

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npm run lint 2>&1 | grep -E "pass.ts|pipeline.ts|discovery.ts" || echo "no new issues"`
Expected: no new errors.

- [ ] **Step 5: Manual behavior check (dev server)**

Start `npm run dev`. Confirm the app compiles and the campaign page loads. (Full toggle-matrix verification happens in Task 9 with real data.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/allabolag/pass.ts src/lib/enrichment/pipeline.ts src/lib/apify/discovery.ts
git commit -m "feat(allabolag): standalone pass, decoupled from enrichment, independent auto-run"
```

---

### Task 6: Re-check API route

**Files:**
- Create: `src/app/api/campaigns/[id]/recheck-allabolag/route.ts`

**Interfaces:**
- Consumes: `runCampaignAllabolag` (`@/lib/allabolag/pass`), `clearCampaignStopped` (`@/lib/apify/runner`).
- Produces: `POST` returning `AllabolagRunSummary` as JSON.

- [ ] **Step 1: Create the route**

Mirror the param/handler style of the sibling `stop/route.ts`. Create the file:

```ts
import { NextResponse } from "next/server";
import { runCampaignAllabolag } from "@/lib/allabolag/pass";
import { clearCampaignStopped } from "@/lib/apify/runner";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const campaignId = Number(id);
  if (!Number.isFinite(campaignId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  clearCampaignStopped(campaignId); // fresh run; clear any stale stop flag
  try {
    const summary = await runCampaignAllabolag(campaignId);
    return NextResponse.json(summary);
  } catch (err) {
    console.error(`recheck-allabolag failed for ${campaignId}:`, err);
    return NextResponse.json({ error: "recheck failed" }, { status: 500 });
  }
}
```

Confirm the `params` shape matches the sibling route (`stop/route.ts`); if that route uses `{ params: { id: string } }` without `Promise`, match it exactly.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Manual check against campaign 8 (dev server running)**

Run: `curl -s -X POST http://localhost:3000/api/campaigns/8/recheck-allabolag`
Expected: JSON like `{"rechecked":24,"nowMatched":N,"nowArchived":N,"stillNeedsReview":N}` (exact counts verified in Task 9).

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/campaigns/[id]/recheck-allabolag/route.ts"
git commit -m "feat(allabolag): POST /api/campaigns/[id]/recheck-allabolag endpoint"
```

---

### Task 7: Auto-run toggle in allabolag settings

**Files:**
- Modify: `src/components/campaigns/allabolag-settings.tsx` (`ALLABOLAG_DEFAULTS` ~9-15, card body ~56-103)

**Interfaces:**
- Consumes: `AllabolagConfig` (now has `autoEnrich?`), existing `Switch`, `setField`.
- Produces: UI writes `autoEnrich` into the config via `onChange`.

- [ ] **Step 1: Default the flag on**

Update `ALLABOLAG_DEFAULTS` to include `autoEnrich: true`:

```ts
export const ALLABOLAG_DEFAULTS: AllabolagConfig = {
  enabled: true,
  employeesMin: 5,
  employeesMax: 50,
  revenueMinSek: 5_000_000,
  revenueMaxSek: 50_000_000,
  autoEnrich: true,
};
```

- [ ] **Step 2: Add the toggle row inside the enabled block**

In the `{enabled && (<CardContent ...>` block, after the closing `</p>` of the "Current filter" line (around line 101), add:

```tsx
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="pr-4">
              <Label className="text-sm">Run automatically after discovery</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                When on, allabolag runs on new leads as soon as discovery finishes.
                This is separate from the campaign&apos;s auto-enrich (which controls
                the paid Apify enrichers).
              </p>
            </div>
            <Switch
              checked={cfg.autoEnrich ?? true}
              onCheckedChange={(on) => setField({ autoEnrich: on })}
            />
          </div>
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npm run lint 2>&1 | grep "allabolag-settings" || echo "no new issues"`
Expected: no new errors.

- [ ] **Step 4: Manual check**

With the dev server running, open a campaign's settings dialog (and the new-campaign wizard). Confirm the "Run automatically after discovery" switch appears under the allabolag ranges, toggles, and persists after save (reopen the dialog — state reflects the saved value).

- [ ] **Step 5: Commit**

```bash
git add src/components/campaigns/allabolag-settings.tsx
git commit -m "feat(allabolag): per-campaign auto-run toggle in settings"
```

---

### Task 8: "Re-check allabolag" button on the campaign page

**Files:**
- Modify: `src/app/(dashboard)/campaigns/[id]/page.tsx` (state + handler near other handlers ~329-370; button in the controls region ~810-850)

**Interfaces:**
- Consumes: `POST /api/campaigns/[id]/recheck-allabolag`; `toast` (sonner); existing `load()` refetch; `campaign.allabolagConfig`.
- Produces: a button that triggers the re-check and toasts the summary.

- [ ] **Step 1: Add handler + state**

Near the other handlers (e.g. after the stop handler ~line 350), add:

```tsx
  const [recheckingAllabolag, setRecheckingAllabolag] = useState(false);
  const handleRecheckAllabolag = async () => {
    if (!campaign) return;
    setRecheckingAllabolag(true);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/recheck-allabolag`, { method: "POST" });
      if (!res.ok) throw new Error("failed");
      const s = await res.json();
      toast.success(
        `Re-checked ${s.rechecked}: ${s.nowMatched} matched, ${s.nowArchived} archived, ${s.stillNeedsReview} still need review`,
      );
      load();
    } catch {
      toast.error("Allabolag re-check failed");
    } finally {
      setRecheckingAllabolag(false);
    }
  };
```

(If the refetch function is not named `load` in this file, use whatever the file uses — confirm by searching for the `fetch(`/api/campaigns/${params.id}`)` refetch and reuse its function.)

- [ ] **Step 2: Render the button**

In the controls region near the Discover/Enrich buttons (~line 810-850), gated on allabolag being enabled, add:

```tsx
                  {campaign.allabolagConfig?.enabled && (
                    <Button
                      variant="outline"
                      onClick={handleRecheckAllabolag}
                      disabled={recheckingAllabolag}
                    >
                      {recheckingAllabolag ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      Re-check allabolag
                    </Button>
                  )}
```

Confirm `Button` and `Loader2` are already imported in this file (they are used elsewhere here); if not, add them.

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npm run lint 2>&1 | grep "campaigns/\[id\]/page" || echo "no new issues"`
Expected: no new errors.

- [ ] **Step 4: Manual check**

With the dev server running, open campaign 8. Confirm the "Re-check allabolag" button shows (allabolag is enabled), runs with a spinner, toasts a summary, and the lead table updates without a manual refresh.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/campaigns/[id]/page.tsx"
git commit -m "feat(allabolag): re-check button on campaign page"
```

---

### Task 9: Acceptance — re-check campaign 8 and verify outcomes

**Files:**
- None (verification only). Uses `lead-finder.db` and the running app.

- [ ] **Step 1: Snapshot current state**

Run:
```bash
sqlite3 lead-finder.db "SELECT json_extract(mapped_data,'\$.allabolagMatch') m, COUNT(*) FROM leads WHERE campaign_id=8 GROUP BY m;"
```
Expected (pre-run): `dropped|3`, `matched|3`, `needs_review|24`.

- [ ] **Step 2: Trigger the re-check**

Click "Re-check allabolag" on campaign 8 in the UI (or `curl -s -X POST http://localhost:3000/api/campaigns/8/recheck-allabolag`). Note the toast/JSON summary.

- [ ] **Step 3: Verify the recovered leads**

Run:
```bash
sqlite3 lead-finder.db "SELECT json_extract(mapped_data,'\$.allabolagMatch') m, COUNT(*) FROM leads WHERE campaign_id=8 GROUP BY m;"
```
Expected: the pre-run `matched` (3) and `dropped` (3) counts are **unchanged or higher**, `needs_review` is **lower**, and at minimum *RenaTakSyd AB* (lead "RenaTak Syd") is now `matched` with `allabolagRevenueSek=8290000`, `allabolagEmployees=5`:
```bash
sqlite3 lead-finder.db "SELECT display_name, json_extract(mapped_data,'\$.allabolagMatch'), json_extract(mapped_data,'\$.allabolagRevenueSek') FROM leads WHERE campaign_id=8 AND display_name='RenaTak Syd';"
```

- [ ] **Step 4: Confirm no regression on confirmed leads**

Verify the 3 pre-existing `matched` leads (Bunkeflo Takentreprenad AB, Lomma Tak AB, Byggagenten Skåne AB) still have their data and were not touched (e.g. *Lomma Tak AB* still `matched`, not flipped to `needs_review`).

- [ ] **Step 5: Toggle-matrix sanity (optional, on a scratch campaign)**

If feasible, on a small test campaign confirm: allabolag-auto ON + global OFF auto-filters without Apify cost; allabolag-auto OFF + global ON runs Apify with no allabolag pass; and a manual lead enrich no longer triggers allabolag.

- [ ] **Step 6: Final commit (docs/notes only, if any)**

No code change expected here. If counts revealed a needed tweak, loop back to the relevant task.

---

## Self-Review

**Spec coverage:**
- Search-term cleaning → Task 2. Spacing-insensitive match → Task 2. City gate + place skip → Tasks 1, 3. Gazetteer → Task 1. `getLeadCity` hardening → Task 3. Standalone pass / `runCampaignAllabolag` → Tasks 4-5. Decouple from `enrichLead` → Task 5. Post-discovery independent orchestration → Task 5. Schema `autoEnrich` (no migration) → Task 4. API route → Task 6. Auto-run toggle UI → Task 7. Re-check button → Task 8. Behavior-change note (matched leads untouched) → Tasks 5, 9. Testing approach (tsx scripts + manual) → throughout; acceptance → Task 9. All spec sections covered.

**Type consistency:** `runCampaignAllabolag(campaignId, leadIds?)` / `AllabolagRunSummary` defined in Task 5, consumed in Tasks 6, 8, 9. `applyAllabolag(leadId, lead, cfg)` and `getLeadCity(lead)` defined/moved in Tasks 3-4, consumed in Task 5. `nameContainsPlace(name)` defined Task 1, consumed Task 3. `buildSearchTerms(name)` defined/consumed Task 2. `AllabolagConfig.autoEnrich?` defined Task 4, consumed Tasks 5, 7. Names consistent across tasks.

**Placeholder scan:** Gazetteer data is fully inlined (290 + 21). The only `/* ...exact body... */` markers are in Task 4, which is an explicit verbatim move of code defined in full in Task 3 — acceptable (the source is in this document). No TBD/TODO/"handle edge cases".
</content>
</invoke>
