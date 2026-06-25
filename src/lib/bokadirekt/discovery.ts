import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { apifyRuns, leads, type BokadirektSource, type NewLead } from "../db/schema";
import { leadEmitter } from "../events/emitter";
import type { ActorRunResult } from "../apify/discovery";
import { BokadirektError, scrapeBokadirektSource } from "./scraper";
import type { BokadirektListing } from "./parser";

const LISTING_ACTOR_ID = "bokadirekt:listing";

function sourceLabel(source: BokadirektSource): string {
  return source.category
    ? `bokadirekt:${source.city}:${source.category}`
    : `bokadirekt:${source.city}`;
}

function listingToLead(
  listing: BokadirektListing,
  source: BokadirektSource,
  campaignId: number,
  runId: string,
): NewLead {
  const addressParts = [
    listing.address.street,
    listing.address.zipcode,
    listing.address.city,
  ].filter(Boolean);
  const fullAddress = addressParts.join(", ") || null;

  return {
    campaignId,
    source: sourceLabel(source),
    sourceRunId: runId,
    displayName: listing.name,
    email: null,
    phone: null,
    website: listing.detailUrl,
    status: "new",
    rawData: listing as unknown as Record<string, unknown>,
    mappedData: {
      address: fullAddress,
      street: listing.address.street ?? null,
      city: listing.address.city ?? null,
      zipcode: listing.address.zipcode ?? null,
      rating: listing.rating?.score ?? null,
      reviewCount: listing.rating?.count ?? null,
      badges: listing.badges,
      services: listing.services.map((s) => s.name),
      detailUrl: listing.detailUrl,
      bokadirektId: listing.id,
      bokadirektSlug: listing.slug,
    },
    apifyCostUsd: 0,
    discoveryApifyCostUsd: 0,
  };
}

function isDuplicate(
  db: ReturnType<typeof getDb>,
  listing: BokadirektListing,
  campaignId: number,
): boolean {
  const byDetail = db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.website, `https://www.bokadirekt.se/places/${listing.slug}`))
    .get();
  if (byDetail) return true;

  const street = listing.address.street;
  if (street) {
    const match = db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.campaignId, campaignId),
          eq(leads.displayName, listing.name),
          sql`json_extract(${leads.mappedData}, '$.street') = ${street}`,
        ),
      )
      .get();
    if (match) return true;
  } else {
    const match = db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(eq(leads.campaignId, campaignId), eq(leads.displayName, listing.name)),
      )
      .get();
    if (match) return true;
  }

  return false;
}

export async function runBokadirektSourceDiscovery(
  source: BokadirektSource,
  campaignId: number,
): Promise<ActorRunResult> {
  const db = getDb();
  const runId = `bokadirekt-${campaignId}-${source.id}-${Date.now()}`;

  db.insert(apifyRuns)
    .values({
      campaignId,
      actorId: LISTING_ACTOR_ID,
      runId,
      status: "running",
      inputParams: {
        city: source.city,
        category: source.category ?? null,
        maxPages: source.maxPages,
      },
      costUsd: 0,
    })
    .run();

  const label = sourceLabel(source);

  try {
    const { listings, totalResults } = await scrapeBokadirektSource(source);
    let inserted = 0;
    let deduplicated = 0;

    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      if (isDuplicate(db, listing, campaignId)) {
        deduplicated++;
        continue;
      }
      const row = db
        .insert(leads)
        .values(listingToLead(listing, source, campaignId, runId))
        .returning()
        .get();
      inserted++;

      leadEmitter.emit("lead:discovered", {
        leadId: row.id,
        campaignId,
        displayName: row.displayName,
        email: row.email,
        phone: row.phone,
        website: row.website,
        status: row.status,
        rawData: row.rawData as Record<string, unknown> | null,
        mappedData: row.mappedData as Record<string, unknown> | null,
        createdAt: row.createdAt,
        source: label,
        index: i + 1,
        totalItems: listings.length,
      });
    }

    db.update(apifyRuns)
      .set({
        status: "succeeded",
        resultCount: listings.length,
        finishedAt: new Date().toISOString(),
        datasetId: null,
      })
      .where(eq(apifyRuns.runId, runId))
      .run();

    return {
      actorId: label,
      status: "succeeded",
      runId,
      totalResults,
      inserted,
      deduplicated,
    };
  } catch (err) {
    db.update(apifyRuns)
      .set({
        status: "failed",
        finishedAt: new Date().toISOString(),
      })
      .where(eq(apifyRuns.runId, runId))
      .run();

    const message = err instanceof BokadirektError ? err.message : String(err);
    return {
      actorId: label,
      status: "failed",
      runId,
      totalResults: 0,
      inserted: 0,
      deduplicated: 0,
      error: message,
      errorType: "bokadirekt",
    };
  }
}
