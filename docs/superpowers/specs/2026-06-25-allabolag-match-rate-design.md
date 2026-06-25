# Allabolag match-rate improvement — design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)

## Problem

Campaign 8 ("skåne - 3-50 miljoner Takläggare & takmålare") discovered and
enriched 30 leads, but only 6 received allabolag financial data
(employees/revenue). The other 24 are flagged `allabolagMatch: "needs_review"`
with no data. Investigation confirmed:

- The allabolag scrape **runs correctly** and the campaign config is valid
  (`enabled`, employees 3–50, revenue 3M–80M SEK). This is **not** a settings
  error.
- The 24 misses are caused by the matcher in
  [src/lib/allabolag/enricher.ts](../../../src/lib/allabolag/enricher.ts),
  which can't resolve Google Maps **marketing names** to allabolag's
  **registered company names**. Two distinct failures, both verified live:
  1. **Search-term pollution.** Names with separators/prefixes return zero
     hits. `"Takmålning Helsingborg - Decatak AB"` → 0 results, but `"Decatak"`
     → finds *Decatak AB*. `"Taktvätt | Skåne Hus & Takvård"` → 0 results, but
     `"Skåne Hus & Takvård"` → finds *Skåne Hus & Takvård AB*.
  2. **Name comparison too strict on spacing.** Even when the right company is
     returned, a spacing difference scores below the 0.5 cutoff and is
     discarded: `"RenaTak Syd"` vs `"RenaTakSyd AB"` scores 0, so the lead
     (which would qualify at 5 emp / 8.29 MSEK in Malmö) was dropped to
     `needs_review`.

There is also no way to re-process existing leads without rediscovering the
whole campaign.

## Goals

1. Raise the allabolag match rate for messy Google Maps names, using
   deterministic heuristics only (no AI calls, no cost).
2. Avoid acting on a wrong company's financials (a wrong match can archive a
   genuinely good lead).
3. Let the user re-run the allabolag step on existing leads from the campaign
   page, cheaply (allabolag is free — no Apify/AI cost).
4. Give allabolag its **own** auto-run toggle, independent of the global
   auto-enrich toggle that controls the paid Apify enrichers.

## Non-goals

- No AI-assisted name resolution (explicitly rejected — deterministic only).
- No change to Apify enrich actors or the cost model itself.
- Re-check never downgrades leads that are already `matched` or `dropped`.

Note: the pipeline shape **does** change — allabolag is removed from `enrichLead`
and becomes an independent pass (see "Decoupling allabolag from enrichment").

## Decisions (from brainstorming)

- **Match method:** heuristics only — free, deterministic, fast.
- **Safety model:** city confirmation is required **except** when the business
  name itself contains a Swedish place (see gate logic).
- **Place detection:** a built-in Swedish gazetteer (~290 municipalities + 21
  regions/län), deterministic and free.
- **Re-run trigger:** a button on the campaign page (no CLI).
- **Allabolag auto-run:** a dedicated per-campaign toggle, **fully independent**
  of the global auto-enrich toggle.
- **Cost guard:** **fully decoupled** — when the allabolag auto-toggle is OFF,
  allabolag does not run as a pre-filter; the paid Apify enrichers may run on
  unfiltered leads. allabolag runs only via its own auto-toggle or the re-check
  button. (User accepted the cost implication.)

## Matching logic (final)

For each lead with allabolag search candidates:

1. **Search with fallback.** Try the full business name; if it yields no usable
   candidates, try a cleaned variant (split on `|`, `–`, `-`, `:`; strip
   leading service-word prefixes). Cap at **2 searches** per lead to bound
   network calls.
2. **Score candidates** by name similarity. Similarity is the max of:
   - token-overlap (existing Jaccard behavior), and
   - **spacing-insensitive** comparison (compare normalized names with all
     spaces removed, so `"renatak syd"` ↔ `"renataksyd"` matches).
   Discard candidates below the existing `0.5` threshold.
3. **Pick the best name match.** Soft tiebreaker only: when two candidates tie
   on name score, prefer the one whose `municipality`/`postPlace` matches a
   place found in the lead name or the lead's city. This is a tiebreaker, never
   a gate.
4. **Gate decision:**
   - **Lead name contains a Swedish place** (gazetteer hit) → **accept** the
     best name match and apply the filter normally (attach financials; archive
     if out of range). No city check — the registered municipality is
     unreliable when the operating location is baked into the name.
   - **No place in the name** → **require city confirmation**: if the lead's
     city confirms the candidate → accept & apply the filter; if city is
     missing or differs → `needs_review` (no data attached, **no archiving on a
     guess**).
5. No candidate above threshold → `needs_review`. Network/parse error →
   `lookup_failed`.

### Worked examples (verified against live allabolag)

| Lead name | Place in name? | Outcome |
|---|---|---|
| `RenaTak Syd` (Malmö) | no | city gate: Malmö == Malmö → **match** (5 emp / 8.29 MSEK, qualifies) |
| `Taktvätt \| Skåne Hus & Takvård` (Kristianstad) | yes (Skåne) | name accepted → *Skåne Hus & Takvård AB* (2 emp < min → **archived**, correct) |
| `Takmålning Helsingborg - Decatak AB` | yes (Helsingborg) | name accepted → *Decatak AB* (Jönköping); no revenue filed → **archived** as "no revenue data" |

The Decatak case is the deliberate consequence of trusting the name when it
carries a place: we accept a registered company in a different municipality and,
because it has no revenue on file, archive it (recoverable, not deleted).

## Decoupling allabolag from enrichment

allabolag stops being a step inside `enrichLead` and becomes an independent pass.

- **`enrichLead` becomes Apify-only.** The `applyAllabolag` block currently at
  [pipeline.ts:148–160](../../../src/lib/enrichment/pipeline.ts) is removed.
- **New per-campaign toggle:** `allabolagConfig.autoEnrich` (boolean). Controls
  whether the standalone allabolag pass runs automatically after discovery,
  independent of the campaign's global `autoEnrich` (which controls the Apify
  pass). No DB migration — `allabolagConfig` is a JSON column; a missing
  `autoEnrich` is treated as `true` to preserve current behavior.
- **Post-discovery orchestration** ([discovery.ts:314](../../../src/lib/apify/discovery.ts)):
  the two triggers fire independently, allabolag first so the Apify pass skips
  any leads allabolag archived.

| allabolag auto | global auto | After discovery |
|---|---|---|
| ON  | ON  | allabolag filters new leads → Apify runs on survivors |
| ON  | OFF | allabolag filters only; Apify waits for manual |
| OFF | ON  | Apify runs on **all** new leads (no allabolag filter) |
| OFF | OFF | nothing auto-runs |

- **Manual paths:** the existing per-lead / per-campaign enrich buttons run
  `enrichLead` (now Apify-only, no allabolag). allabolag is run manually only via
  the "Re-check allabolag" button.

## Components

### 1. Place gazetteer — `src/lib/allabolag/swedish-places.ts` (new)

- Static, lowercased `Set` of Sweden's ~290 municipalities and 21 regions/län.
- `nameContainsPlace(name: string): boolean` — tokenizes the name (same
  normalization as `normalizeName`) and checks whole-token membership against
  the set. Whole-token matching (not substring) to limit false positives from
  short ambiguous names.

### 2. Matcher changes — `src/lib/allabolag/enricher.ts`

- `buildSearchTerms(name: string): string[]` — ordered, deduped list: full name,
  then cleaned variant(s). Cap 2.
- `nameSimilarity` — add the spacing-insensitive comparison branch.
- `matchLead(name, city)` — iterate `buildSearchTerms`, accumulate/dedupe
  candidates by `orgnr` until usable matches exist (≤2 searches), then score and
  pick best with the soft place/city tiebreaker. Returns the existing
  `AllabolagMatch` shape plus enough information for the caller to apply the gate
  (e.g. `cityConfirmed`, and whether the lead name contained a place).
- `evaluate(...)` — unchanged.

### 3. Standalone allabolag pass + gate — `src/lib/allabolag/` (shared)

`applyAllabolag` and `getLeadCity` move out of `pipeline.ts` into the allabolag
module, since enrichment no longer owns them.

- `getLeadCity` — also read `businessAddress`; improve the address parse to find
  a city mid-string (e.g. `"Bals Väg 9, Kristianstad, Sweden, 29194"`), not only
  a trailing `"<postcode> City"`.
- `applyAllabolag(lead, config)` — implement the gate: when the lead name
  contains a place (gazetteer), apply the filter on a strong name match
  regardless of city; otherwise require `cityConfirmed` before applying/
  archiving, else write `needs_review`.
- `runCampaignAllabolag(campaignId, leadIds?): Promise<Summary>` — the shared
  pass used by **both** the post-discovery auto-run and the re-check button:
  - Load the campaign's `allabolagConfig`; no-op if disabled.
  - Target leads: the given `leadIds` (post-discovery: the newly inserted leads),
    or — when no ids — that campaign's leads where `allabolagMatch` ∈
    {`needs_review`, `lookup_failed`} or absent. **Never** touches `matched` or
    `dropped`.
  - Run the (improved) match + gate on each via `applyAllabolag`; update
    `mappedData`, archive any out of range.
  - Respect the existing hard-stop flag (`isCampaignStopped`).
  - Return `{ rechecked, nowMatched, nowArchived, stillNeedsReview }`.
  - Emit `lead:enrichment-completed` per updated lead (and existing archived-lead
    handling) so open dashboards update live — no new event type.

### 4. Pipeline + discovery wiring

- `enrichLead` ([pipeline.ts](../../../src/lib/enrichment/pipeline.ts)): remove
  the allabolag block; it becomes Apify-only.
- Post-discovery ([discovery.ts:314](../../../src/lib/apify/discovery.ts)): call
  `runCampaignAllabolag(campaignId, newLeadIds)` when
  `allabolagConfig.enabled && allabolagConfig.autoEnrich`, **then** run the
  existing Apify auto-enrich when `campaign.autoEnrich` — which already operates
  on active/`new` leads, so allabolag-archived leads are skipped.

### 5. Schema type — `src/lib/db/schema.ts`

- Add `autoEnrich?: boolean` to the `allabolagConfig` `$type<>()` shape. No
  migration (JSON column). Readers treat missing as `true`.

### 6. API route — `POST /api/campaigns/[id]/recheck-allabolag`

- Calls `runCampaignAllabolag(campaignId)` (no ids → unmatched leads) and returns
  the summary. `getDb()` inside the handler per repo convention.

### 7. UI

- **Re-check button** on the campaign page, shown only when allabolag is enabled.
  Disabled + spinner while running; toasts the summary (e.g. *"Re-checked 24: 6
  matched, 2 archived, 16 still need review"*). Lead table updates live via
  existing SSE listeners in
  [src/hooks/use-lead-events.ts](../../../src/hooks/use-lead-events.ts).
- **Allabolag auto-run toggle** in the shared
  [src/components/campaigns/allabolag-settings.tsx](../../../src/components/campaigns/allabolag-settings.tsx)
  (used by both the new-campaign wizard and the settings dialog) — a switch like
  "Run allabolag automatically after discovery", persisted to
  `allabolagConfig.autoEnrich`. The existing global auto-enrich control keeps its
  place; its help text is updated to note it covers the Apify enrichers, not
  allabolag.

## Behavior change to note

The city gate is stricter than the old logic for **non-place** names, so a
currently-`matched` lead with an unconfirmed city (e.g. *Lomma Tak AB*,
`cityConfirmed=0`) would not qualify under the new rules. Because re-check leaves
`matched` leads untouched, it keeps its existing data; the new rules apply only
to fresh discovery and to leads recovered from `needs_review`. Totals therefore
may not perfectly reconcile after a re-check — expected.

## Testing

No test suite exists in this repo. Verification approach:

- Ad-hoc `tsx` scripts (run with `NODE_OPTIONS="--conditions=react-server"`)
  exercising `buildSearchTerms`, `nameSimilarity`, `nameContainsPlace`, and
  `matchLead` against the known live examples above (RenaTak Syd, Decatak, Skåne
  Hus & Takvård) and a control that should stay `needs_review`.
- Run the re-check on campaign 8 and confirm the summary and that no `matched`/
  `dropped` lead changed.
- Toggle verification: confirm each row of the auto-run table — allabolag
  on/global off auto-filters without Apify; allabolag off/global on runs Apify
  with no allabolag pass; both off auto-runs nothing — and that a manual enrich
  no longer triggers allabolag.

## Risks

- **Gazetteer false positives:** a short municipality name colliding with a
  common word would wrongly skip the city gate. Mitigated by whole-token
  matching; can exclude specific ambiguous names if observed.
- **Extra network calls:** up to 2 allabolag searches per lead. Bounded by the
  cap; re-check is manual and scoped to unmatched leads.
- **Single-process assumption:** re-check uses the same in-process stop flag as
  the rest of the pipeline (already a known repo constraint).
