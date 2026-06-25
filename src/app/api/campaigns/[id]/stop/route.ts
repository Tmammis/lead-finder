import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { leads, apifyRuns } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { markCampaignStopped, abortRun } from "@/lib/apify/runner";
import { cancelEnrichment } from "@/lib/enrichment/pipeline";
import { leadEmitter } from "@/lib/events/emitter";

// Hard stop for a campaign: halts both discovery and enrichment immediately.
// Sets the per-campaign stop flag (so the in-process poll/loop bails), tells
// Apify to abort every run still marked "running" for this campaign (so the
// cloud run stops and stops billing), and resets any mid-flight "enriching"
// leads back to "new" so they can be retried.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaignId = parseInt(id);
  const db = getDb();

  // 1. Flag the campaign as stopped and cancel the enrichment loop.
  markCampaignStopped(campaignId);
  cancelEnrichment(campaignId);

  // 2. Abort every still-running Apify run for this campaign on Apify's side.
  const runningRuns = db
    .select({ runId: apifyRuns.runId })
    .from(apifyRuns)
    .where(and(eq(apifyRuns.campaignId, campaignId), eq(apifyRuns.status, "running")))
    .all();

  await Promise.allSettled(runningRuns.map((r) => abortRun(r.runId)));

  // 3. Reset leads stuck mid-enrichment back to "new".
  const enrichingLeads = db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.campaignId, campaignId), eq(leads.status, "enriching")))
    .all();

  db.update(leads)
    .set({ status: "new", updatedAt: new Date().toISOString() })
    .where(and(eq(leads.campaignId, campaignId), eq(leads.status, "enriching")))
    .run();

  for (const lead of enrichingLeads) {
    leadEmitter.emit("lead:status-changed", { leadId: lead.id, campaignId, status: "new" });
  }

  return NextResponse.json({
    stopped: true,
    abortedRuns: runningRuns.length,
    resetLeads: enrichingLeads.length,
  });
}
