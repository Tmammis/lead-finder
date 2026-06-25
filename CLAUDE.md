# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Next.js dev server (Turbopack) on :3000
npm run build        # Production build
npm run lint         # ESLint
npm run db:generate  # Generate Drizzle migration from schema changes (see gotcha below)
npm run db:migrate   # Apply migrations and seed (runs src/lib/db/migrate.ts)

# CLI must run with the react-server condition, or it throws on `server-only`:
NODE_OPTIONS="--conditions=react-server" npm run cli -- <cmd>  # discover | enrich | status
```

There is no test suite in this repo.

The CLI imports `src/lib/*` code that transitively pulls in `server-only` (e.g. [src/lib/apify/coerce-input.ts](src/lib/apify/coerce-input.ts)), which throws under plain `tsx`. Run it (and any ad-hoc `tsx` script that imports pipeline/lib code) with `NODE_OPTIONS="--conditions=react-server"` so `server-only` resolves to its empty stub. The bare `npm run cli` currently fails.

### Migrations are hand-managed — `db:generate` is unreliable here

Migrations `0001`+ were hand-written and have **no drizzle meta snapshots** (only `drizzle/meta/0000_snapshot.json` exists). So `npm run db:generate` diffs the schema against the stale `0000` snapshot and re-emits **already-applied columns**, producing a migration that fails with "duplicate column name" on `db:migrate`.

After editing [src/lib/db/schema.ts](src/lib/db/schema.ts), prefer to **hand-write the migration** to match the existing style: a one-line `ALTER TABLE … ADD …` file in `drizzle/`, plus a matching entry in `drizzle/meta/_journal.json` (the migrator keys off the journal + file hash, not the snapshots), then `npm run db:migrate`. The SQLite file `lead-finder.db` lives at the repo root and is gitignored.

## Gotchas

### Tailwind CSS parse error referencing line 2000+

If the dev server fails with `Parsing CSS source code failed` at a high line number in `src/app/globals.css` (the file itself is ~125 lines), with a garbled selector like `.data-\[2\1 \3 ...\]\:h-\[1\.15rem\]`, the cause is **build-cache directories at the project root being scanned by Tailwind v4's class extractor**. Tailwind reads binary `.sst` Turbopack cache files and pulls byte sequences out as fake "class candidates," some of which contain control bytes that crash the CSS parser.

[next.config.ts](next.config.ts) sets `distDir` to `os.tmpdir()/lead-finder-dashboard-next` (absolute), so the real cache lives outside the project. But a stray `./var/` or `./.next/` at the project root has appeared before. Three layers of protection are in place:

1. `/var/` and `/.next/` in [.gitignore](.gitignore) (Tailwind respects gitignore).
2. `@source not` directives in [src/app/globals.css](src/app/globals.css) (Tailwind explicitly skips them).
3. [start.command](start.command) deletes both dirs on boot.

If it ever recurs anyway, the manual playbook is:

```bash
rm -rf .next var
rm -rf "$TMPDIR/lead-finder-dashboard-next"
npm run dev
```

Do **not** "fix" this by editing `globals.css` to escape the bad selector — the CSS is generated, the source is the cache directory.

## Architecture

Next.js 16 App Router app that discovers leads via Apify scrapers, enriches them with more Apify actors, then scores them with an AI provider. Local-first: data lives in a SQLite file at the repo root; the only network calls are to Apify and the AI provider.

### The discovery → enrichment → scoring pipeline

1. **Campaign** ([src/lib/db/schema.ts:25](src/lib/db/schema.ts#L25)) holds the niche, list of Apify actor IDs (`apifyActors`), per-actor input (`actorConfigs`), KPI definitions, custom lead field definitions, and Bokadirekt sources.
2. **Discovery** ([src/lib/apify/discovery.ts](src/lib/apify/discovery.ts)) iterates the campaign's `find`-phase actors, runs each via [src/lib/apify/runner.ts](src/lib/apify/runner.ts), AI-normalizes results ([src/lib/apify/normalizer.ts](src/lib/apify/normalizer.ts)), dedupes by website/email, and inserts rows into `leads`. Bokadirekt sources are handled separately by [src/lib/bokadirekt/discovery.ts](src/lib/bokadirekt/discovery.ts) (HTML scraper, no Apify).
3. **Enrichment** ([src/lib/enrichment/pipeline.ts](src/lib/enrichment/pipeline.ts)) runs the campaign's `enrich`-phase actors per lead. For each actor: an AI call resolves which lead fields map to that actor's required inputs ([src/lib/ai/field-resolver.ts](src/lib/ai/field-resolver.ts)), the actor runs, and a second AI call extracts the campaign's custom lead fields and KPI values ([src/lib/ai/lead-extractor.ts](src/lib/ai/lead-extractor.ts)).
4. **Scoring** ([src/lib/ai/lead-scorer.ts](src/lib/ai/lead-scorer.ts)) produces a 0–100 score, pain points, and personalization summary based on the agency profile, then writes to `lead_personalization`.
5. If `campaign.autoEnrich` is true, discovery automatically chains into enrichment for newly inserted leads.

### Campaign targeting lives inside the search-terms string

There is **no separate location/country field**. A campaign's geographic targeting is embedded in each find actor's search-terms string-array field (`searchStringsArray` for the Google Maps actors, `queries` for `apify/google-search-scraper`). A find actor run with empty search terms makes the Apify scraper fall back to **its own default geography (the US)** — silently ignoring the campaign's intent.

`runSingleActorDiscovery` guards against this via `applyCampaignTargeting` ([src/lib/apify/discovery.ts](src/lib/apify/discovery.ts)): when the actor being run has no search terms, it **inherits** them from another configured find actor in the same campaign (`getSearchTermsField` resolves the right field per actor — required string-array first). If no targeting exists anywhere, the run is **refused** with `errorType: "no-search-terms"` rather than scraping blind. When adding a new find actor, give its location-bearing input field `type: "string-array"` so this inheritance keeps working.

### Non-Apify sources and lead filtering

Two Swedish data sources bypass Apify entirely and are special-cased rather than going through the actor registry:

- **Bokadirekt** (find phase) — the HTML scraper invoked from `discovery.ts` (see step 2 above).
- **allabolag.se** (enrich phase) — [src/lib/allabolag/](src/lib/allabolag/) looks up each lead's employees, latest-year revenue, and owner by parsing the site's `__NEXT_DATA__` JSON (no Apify, no API key; mirrors the Bokadirekt fetch/parse pattern). It's wired into `enrichLead` via `applyAllabolag`, which runs **before** the Apify enrich actors so leads that fail the filter never incur Apify/AI cost. Enabled per-campaign by `campaign.allabolagConfig` (JSON column: `enabled` + employee/revenue ranges; revenue stored in SEK, shown in the UI as MSEK).

This is the **only place the pipeline drops leads**: companies outside the employee/revenue ranges (or with no revenue filed) are set to `status: "archived"` rather than deleted, so a wrong match is recoverable. Matched data lands on the lead's `mappedData` under `allabolag*` keys; unmatched leads are flagged `allabolagMatch: "needs_review"` and kept. The campaign UI control is the shared [src/components/campaigns/allabolag-settings.tsx](src/components/campaigns/allabolag-settings.tsx), used by both the new-campaign wizard and the campaign settings dialog.

### Actor registry pattern

Built-in actors are static in [src/lib/apify/registry.ts](src/lib/apify/registry.ts). User-added actors live in the `custom_actors` table. **Always read actors via [src/lib/apify/registry-server.ts](src/lib/apify/registry-server.ts) (`getActorById`, `getAllActors`)** — it merges both sources. Each actor has a `phase` (`"find"` or `"enrich"`) that gates where in the pipeline it runs. Adding a new built-in actor: append to `ACTOR_REGISTRY`, define `requiredInputFields` and `inputFieldDescriptions`, and add a normalizer branch in `normalizer.ts` if needed.

### AI provider abstraction

All LLM calls go through `generateCompletion()` in [src/lib/ai/provider.ts](src/lib/ai/provider.ts) — never import `openai` or `@anthropic-ai/sdk` directly elsewhere. The provider is selected per-campaign (`campaign.aiProvider`) with a global default in `settings`. Always call `logLlmCost()` after a completion so per-operation costs land in the `llm_costs` table; the costs page depends on this. Models and pricing are hardcoded in `MODEL_PRICING` — update there when models change.

### Database

SQLite via `better-sqlite3` + Drizzle ORM. Access the singleton via `getDb()` from [src/lib/db/index.ts](src/lib/db/index.ts) — never instantiate `Database` directly. JSON columns use `{ mode: "json" }` with `$type<T>()` for typing. WAL mode is on, so dev sees `lead-finder.db-shm`/`-wal` files alongside the main DB.

API routes must call `getDb()` inside the handler, not at module scope, so the DB doesn't initialize during build.

### Real-time updates (SSE)

[src/lib/events/emitter.ts](src/lib/events/emitter.ts) is a typed `EventEmitter` singleton on `globalThis`. Discovery and enrichment emit events (`lead:discovered`, `lead:enrichment-completed`, `lead:deleted`, `campaign:discovery-progress`, etc.); the SSE route at [src/app/api/events/leads/route.ts](src/app/api/events/leads/route.ts) streams them to the dashboard. Adding a new event type touches **three** files: define + add it to `LeadEventMap` in `emitter.ts`, list it in the `eventTypes` array in the SSE route, and add an `addEventListener` + handler prop in [src/hooks/use-lead-events.ts](src/hooks/use-lead-events.ts).

### Deleting a lead

`DELETE /api/leads/[id]` ([src/app/api/leads/[id]/route.ts](src/app/api/leads/[id]/route.ts)) removes a lead **from the local DB only** — no Apify/external call. It deletes the lead plus its dependent `leadPersonalization` and `analyticsEvents` rows, then emits `lead:deleted` so every open dashboard tab drops the row live. Unlike the allabolag filter (which archives), this is a hard delete; the lead can be re-discovered on the next run. The per-row delete button in the campaign page removes the row optimistically and restores it on failure.

### Cancellation & hard stop

Two in-process `Set<number>` flags on `globalThis` gate long-running work — they only work in single-process dev/prod, so a multi-instance deployment would need DB state instead:

- `cancelledEnrichments` (`cancelEnrichment` in [src/lib/enrichment/pipeline.ts](src/lib/enrichment/pipeline.ts)) — soft cancel between leads in the enrichment loop.
- `stoppedApifyCampaigns` (`markCampaignStopped`/`clearCampaignStopped`/`isCampaignStopped` in [src/lib/apify/runner.ts](src/lib/apify/runner.ts)) — hard stop checked at the top of the Apify poll loop and inside both the discovery and enrichment loops, so no further actors launch.

`POST /api/campaigns/[id]/stop` is the unified Stop button endpoint: it sets the stop flag, calls `cancelEnrichment`, then calls `abortRun` (Apify `POST /actor-runs/{id}/abort`) for every run still marked `running` so the cloud run halts immediately and stops billing, and resets any `enriching` leads back to `new`. Each fresh discovery/enrichment run calls `clearCampaignStopped` at its start so a stale flag never blocks the next run. Note: the `apifyRuns.status` enum has no `"aborted"` value — aborted runs are recorded as `"failed"`.

### CLI

[cli/index.ts](cli/index.ts) (Commander) is a thin wrapper that imports the same `src/lib/*` modules as the API routes. Run via `npm run cli -- <subcommand>` (note the `--` to pass args through tsx). The CLI loads `.env` via `dotenv/config` — the Next.js app does not (it relies on Next's built-in env handling).

## Conventions

- TypeScript strict, no `any` (use `unknown` + narrow).
- Path alias `@/` → `src/`.
- UI components come from `@/components/ui/` (shadcn/ui generated) — don't hand-edit; regenerate with `npx shadcn add` if needed.
- Forms: `react-hook-form` + `zod`. Toasts: `sonner`. Dates: `date-fns`. Styling: Tailwind v4.
- Copy-to-clipboard: use the [src/components/copy-button.tsx](src/components/copy-button.tsx) `CopyButton` (or `copyToClipboardSafe` from [src/lib/utils/clipboard.ts](src/lib/utils/clipboard.ts)) — **not** `navigator.clipboard` directly. The helper falls back to a legacy `execCommand` path on insecure origins (plain-HTTP, e.g. accessing the dashboard over a Tailscale IP), where the modern clipboard API is unavailable.
- Secrets in `.env` (gitignored). API keys can also be set through the Settings UI, which writes to the `settings` table — code that needs a key should check both `process.env` and the settings table (existing code already does this; follow the pattern).
