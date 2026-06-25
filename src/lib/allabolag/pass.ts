import { getDb } from "../db";
import { leads, type AllabolagConfig, type Lead } from "../db/schema";
import { eq } from "drizzle-orm";
import { matchLead, evaluate } from "./enricher";
import { nameContainsPlace } from "./swedish-places";
import type { AllabolagMatch } from "./types";
import { leadEmitter } from "../events/emitter";

// Best-effort extraction of a lead's city, used to disambiguate same-named
// companies on allabolag. Returns null when no city can be determined.
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
      const candidate = parts[1].replace(/sweden/i, "").trim();
      if (candidate && !/^\d/.test(candidate)) return candidate;
    }
  }
  return null;
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

// Look the lead up on allabolag, store employees/revenue/owner, and apply the
// employee/revenue ranges. Returns "dropped" when the lead is archived,
// otherwise "kept" (matched-and-in-range, no match, or lookup failure — none of
// which should halt normal enrichment).
export async function applyAllabolag(
  leadId: number,
  lead: Lead,
  cfg: AllabolagConfig,
): Promise<"dropped" | "kept"> {
  const db = getDb();
  const city = getLeadCity(lead);

  let match: AllabolagMatch | null;
  try {
    match = await matchLead(lead.displayName as string, city);
  } catch (err) {
    console.error(`allabolag lookup failed for lead ${leadId}:`, err);
    mergeMappedData(db, leadId, { allabolagMatch: "lookup_failed" });
    return "kept";
  }

  if (!match) {
    mergeMappedData(db, leadId, { allabolagMatch: "needs_review" });
    return "kept";
  }

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
}
