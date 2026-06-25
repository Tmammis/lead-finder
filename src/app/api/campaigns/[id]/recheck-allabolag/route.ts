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
