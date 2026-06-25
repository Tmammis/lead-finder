import type { BokadirektSource } from "../db/schema";
import {
  parseBokadirektHtml,
  type BokadirektListing,
  type BokadirektParseResult,
} from "./parser";

const USER_AGENT =
  "Lead-finder-dashboard/1.0 (+https://smartclick.se/contact; terry.mammis@smartclick.se)";
const PAGE_DELAY_MS = 500;

export class BokadirektError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BokadirektError";
    this.cause = cause;
  }
}

export function buildSourceUrl(source: BokadirektSource, page = 1): string {
  const path = source.category
    ? `/${source.category}/${source.city}`
    : `/vad/${source.city}`;
  const qs = page > 1 ? `?page=${page}` : "";
  return `https://www.bokadirekt.se${path}${qs}`;
}

async function fetchPage(url: string): Promise<BokadirektParseResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.5",
      },
    });
  } catch (err) {
    throw new BokadirektError(`Network error fetching ${url}`, err);
  }
  if (!res.ok) {
    throw new BokadirektError(`HTTP ${res.status} fetching ${url}`);
  }
  const html = await res.text();
  try {
    return parseBokadirektHtml(html);
  } catch (err) {
    throw new BokadirektError(
      `Parse error for ${url}: ${(err as Error).message}`,
      err,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function scrapeBokadirektSource(
  source: BokadirektSource,
): Promise<{ listings: BokadirektListing[]; totalResults: number }> {
  const maxPages = Math.max(1, Math.min(source.maxPages ?? 3, 50));
  const all: BokadirektListing[] = [];
  let totalResults = 0;
  const seenIds = new Set<number>();

  for (let page = 1; page <= maxPages; page++) {
    const url = buildSourceUrl(source, page);
    const { listings, totalResults: pageTotal } = await fetchPage(url);
    if (page === 1) totalResults = pageTotal;

    let newOnPage = 0;
    for (const l of listings) {
      if (seenIds.has(l.id)) continue;
      seenIds.add(l.id);
      all.push(l);
      newOnPage++;
    }

    if (listings.length === 0 || all.length >= totalResults || newOnPage === 0) {
      break;
    }
    if (page < maxPages) await sleep(PAGE_DELAY_MS);
  }

  return { listings: all, totalResults };
}
