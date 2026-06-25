import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { campaigns, leads, apifyRuns, analyticsEvents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchDatasetItems } from "@/lib/apify/runner";
import { normalizeSingleItem } from "@/lib/apify/normalizer";
import { getDefaultAIProvider, type AIProvider } from "@/lib/ai/provider";
import { leadEmitter } from "@/lib/events/emitter";

export async function POST(req: NextRequest) {
  const { datasetId, actorId, campaignId } = await req.json() as {
    datasetId: string;
    actorId: string;
    campaignId: number;
  };

  if (!datasetId || !actorId || !campaignId) {
    return NextResponse.json({ error: "Missing datasetId, actorId, or campaignId" }, { status: 400 });
  }

  const db = getDb();
  const campaign = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const items = await fetchDatasetItems(datasetId);
  const provider: AIProvider = (campaign.aiProvider as AIProvider) ?? getDefaultAIProvider();
  const totalItems = items.length;
  let inserted = 0;
  let deduplicated = 0;

  // Record a synthetic run entry so the UI shows the import
  const syntheticRunId = `imported-${datasetId}`;
  db.insert(apifyRuns).values({
    campaignId,
    actorId,
    runId: syntheticRunId,
    status: "succeeded",
    datasetId,
    resultCount: totalItems,
    finishedAt: new Date().toISOString(),
  }).run();

  for (let i = 0; i < totalItems; i++) {
    const { lead } = await normalizeSingleItem(actorId, items[i], campaignId, syntheticRunId, provider);

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

    const row = db.insert(leads).values(lead).returning().get();
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
      source: actorId,
      index: i + 1,
      totalItems,
    });
  }

  db.insert(analyticsEvents).values({
    eventType: "apify_run_completed",
    campaignId,
    metadata: { actorId, datasetId, totalResults: totalItems, inserted, deduplicated },
  }).run();

  return NextResponse.json({ success: true, totalResults: totalItems, inserted, deduplicated });
}
