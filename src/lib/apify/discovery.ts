import { getDb } from "../db";
import { leads, campaigns, analyticsEvents, apifyRuns, type BokadirektSource, type AllabolagConfig } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { runCampaignAllabolag } from "../allabolag/pass";
import { coerceActorInput } from "./coerce-input";
import { runActorAndCollect, ApifyError, isCampaignStopped, clearCampaignStopped } from "./runner";
import { normalizeSingleItem } from "./normalizer";
import { getActorById } from "./registry-server";
import { enrichCampaignLeads } from "../enrichment/pipeline";
import { getDefaultAIProvider, type AIProvider } from "../ai/provider";
import { leadEmitter } from "../events/emitter";
import { runBokadirektSourceDiscovery } from "../bokadirekt/discovery";

export interface ActorRunResult {
  actorId: string;
  status: "succeeded" | "failed";
  runId?: string;
  totalResults: number;
  inserted: number;
  deduplicated: number;
  error?: string;
  errorType?: string;
  actionUrl?: string;
  actionLabel?: string;
}

export interface DiscoveryResult {
  results: ActorRunResult[];
  totalInserted: number;
  totalDeduplicated: number;
}

// Returns the input field a find actor uses to hold its location-bearing search
// terms (e.g. "searchStringsArray" for Google Maps, "queries" for Google Search).
// Prefers a required string-array field, then any string-array field.
function getSearchTermsField(actor: ReturnType<typeof getActorById>): string | undefined {
  if (!actor?.inputFieldDescriptions) return undefined;
  for (const field of actor.requiredInputFields || []) {
    if (actor.inputFieldDescriptions[field]?.type === "string-array") return field;
  }
  for (const [name, desc] of Object.entries(actor.inputFieldDescriptions)) {
    if (desc.type === "string-array") return name;
  }
  return undefined;
}

function hasValue(v: unknown): boolean {
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return v != null;
}

// The campaign's location targeting lives inside each find actor's search-terms
// string (there is no separate location field). When a newly added/started actor
// has no search terms of its own, it would go to Apify empty and the scraper
// would fall back to its default geography (the US) — silently ignoring the
// campaign's targeting. To prevent that, inherit the search terms from another
// configured find actor in the same campaign. Returns null if no targeting can
// be determined anywhere (caller refuses to run rather than scrape blind).
function applyCampaignTargeting(
  actorId: string,
  input: Record<string, unknown>,
  campaign: { apifyActors?: unknown; actorConfigs?: unknown } | undefined,
): Record<string, unknown> | null {
  const actor = getActorById(actorId);
  if (actor?.phase !== "find") return input;

  const field = getSearchTermsField(actor);
  if (!field) return input;
  if (hasValue(input[field])) return input;

  const configs = (campaign?.actorConfigs as Record<string, Record<string, unknown>>) || {};
  const actorIds = (campaign?.apifyActors as string[]) || [];

  for (const otherId of actorIds) {
    if (otherId === actorId) continue;
    const otherActor = getActorById(otherId);
    if (otherActor?.phase !== "find") continue;
    const otherField = getSearchTermsField(otherActor);
    if (!otherField) continue;
    const val = configs[otherId]?.[otherField];
    if (hasValue(val)) {
      return { ...input, [field]: val };
    }
  }

  return null;
}

export async function runSingleActorDiscovery(
  actorId: string,
  input: Record<string, unknown>,
  campaignId: number,
): Promise<ActorRunResult> {
  const db = getDb();
  const campaign = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();

  const targetedInput = applyCampaignTargeting(actorId, input, campaign);
  if (targetedInput === null) {
    return {
      actorId,
      status: "failed",
      totalResults: 0,
      inserted: 0,
      deduplicated: 0,
      error:
        "This actor has no search terms, and no other find actor in this campaign has search terms to inherit. Add search terms (including the location) before running, so the scraper targets the right area instead of defaulting to the US.",
      errorType: "no-search-terms",
    };
  }

  const coercedInput = coerceActorInput(targetedInput, actorId);

  db.insert(analyticsEvents).values({
    eventType: "apify_run_started",
    campaignId,
    metadata: { actorId, input },
  }).run();

  const result = await runActorAndCollect(actorId, coercedInput, campaignId);

  if (result.status === "ABORTED") {
    return {
      actorId,
      status: "failed",
      runId: result.runId,
      totalResults: 0,
      inserted: 0,
      deduplicated: 0,
      error: "Stopped by user",
      errorType: "stopped",
    };
  }

  if (result.status !== "SUCCEEDED") {
    return {
      actorId,
      status: "failed",
      runId: result.runId,
      totalResults: 0,
      inserted: 0,
      deduplicated: 0,
      error: `Apify run failed: ${result.status}`,
    };
  }

  const provider: AIProvider = (campaign?.aiProvider as AIProvider) ?? getDefaultAIProvider();

  const totalItems = result.items.length;
  let inserted = 0;
  let deduplicated = 0;

  for (let i = 0; i < totalItems; i++) {
    const { lead } = await normalizeSingleItem(actorId, result.items[i], campaignId, result.runId, provider);

    let existing = false;
    if (lead.website) {
      const found = db.select().from(leads).where(eq(leads.website, lead.website)).get();
      if (found) existing = true;
    }
    if (!existing && lead.email) {
      const found = db.select().from(leads).where(eq(leads.email, lead.email)).get();
      if (found) existing = true;
    }

    if (existing) {
      deduplicated++;
      continue;
    }

    const inserted_row = db.insert(leads).values(lead).returning().get();
    inserted++;

    leadEmitter.emit("lead:discovered", {
      leadId: inserted_row.id,
      campaignId,
      displayName: inserted_row.displayName,
      email: inserted_row.email,
      phone: inserted_row.phone,
      website: inserted_row.website,
      status: inserted_row.status,
      rawData: inserted_row.rawData as Record<string, unknown> | null,
      mappedData: inserted_row.mappedData as Record<string, unknown> | null,
      createdAt: inserted_row.createdAt,
      source: actorId,
      index: i + 1,
      totalItems,
    });
  }

  if (inserted > 0) {
    const run = db.select({ costUsd: apifyRuns.costUsd })
      .from(apifyRuns).where(eq(apifyRuns.runId, result.runId)).get();
    const runCost = run?.costUsd ?? 0;
    if (runCost > 0) {
      const perLeadApifyCost = runCost / inserted;
      db.update(leads)
        .set({
          apifyCostUsd: perLeadApifyCost,
          discoveryApifyCostUsd: perLeadApifyCost,
        })
        .where(eq(leads.sourceRunId, result.runId))
        .run();
    }
  }

  db.insert(analyticsEvents).values({
    eventType: "apify_run_completed",
    campaignId,
    metadata: {
      actorId,
      runId: result.runId,
      totalResults: totalItems,
      inserted,
      deduplicated,
    },
  }).run();

  return {
    actorId,
    status: "succeeded",
    runId: result.runId,
    totalResults: totalItems,
    inserted,
    deduplicated,
  };
}

export async function runCampaignDiscovery(campaignId: number): Promise<DiscoveryResult> {
  const db = getDb();
  const campaign = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
  if (!campaign) throw new Error("Campaign not found");

  const actorIds = (campaign.apifyActors as string[]) || [];
  const actorConfigs = (campaign.actorConfigs as Record<string, Record<string, unknown>>) || {};

  const results: ActorRunResult[] = [];

  // Clear any stale stop flag from a previous run so this fresh run starts clean.
  clearCampaignStopped(campaignId);

  leadEmitter.emit("campaign:discovery-started", {
    campaignId,
    actorIds,
  });

  for (const actorId of actorIds) {
    if (isCampaignStopped(campaignId)) break;
    const actor = getActorById(actorId);
    if (actor?.phase !== "find") continue;

    const input = { ...actorConfigs[actorId] || {} };

    try {
      const result = await runSingleActorDiscovery(actorId, input, campaignId);
      results.push(result);
    } catch (err) {
      if (err instanceof ApifyError) {
        results.push({
          actorId,
          status: "failed",
          totalResults: 0,
          inserted: 0,
          deduplicated: 0,
          error: err.message,
          errorType: err.errorType,
          actionUrl: err.actionUrl,
          actionLabel: err.actionLabel,
        });
      } else {
        results.push({
          actorId,
          status: "failed",
          totalResults: 0,
          inserted: 0,
          deduplicated: 0,
          error: String(err),
        });
      }
    }
  }

  const bokadirektSources = (campaign.bokadirektSources as BokadirektSource[] | null) ?? [];
  for (const source of bokadirektSources) {
    if (isCampaignStopped(campaignId)) break;
    try {
      const result = await runBokadirektSourceDiscovery(source, campaignId);
      results.push(result);
    } catch (err) {
      const label = source.category
        ? `bokadirekt:${source.city}:${source.category}`
        : `bokadirekt:${source.city}`;
      results.push({
        actorId: label,
        status: "failed",
        totalResults: 0,
        inserted: 0,
        deduplicated: 0,
        error: String(err),
        errorType: "bokadirekt",
      });
    }
  }

  db.update(campaigns)
    .set({
      lastDiscoveryAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(campaigns.id, campaignId))
    .run();

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

  const allSucceeded = results.every((r) => r.status === "succeeded");
  if (campaign.scheduleFrequency === "once" && allSucceeded) {
    db.update(campaigns)
      .set({ status: "completed", updatedAt: new Date().toISOString() })
      .where(eq(campaigns.id, campaignId))
      .run();
  }

  const totalDeduplicated = results.reduce((s, r) => s + r.deduplicated, 0);

  leadEmitter.emit("campaign:discovery-completed", {
    campaignId,
    totalInserted,
    totalDeduplicated,
  });

  return {
    results,
    totalInserted,
    totalDeduplicated,
  };
}
