export type BokadirektAddress = {
  street?: string;
  city?: string;
  zipcode?: string;
};

export type BokadirektRating = {
  score: number;
  count: number;
};

export type BokadirektService = {
  id: number;
  name: string;
  description?: string;
  durationLabel?: string;
  priceLabel?: string;
};

export type BokadirektSettings = {
  hasKlarna?: boolean;
  hasQliro?: boolean;
  hasCampaigns?: boolean;
  sellsGiftCard?: boolean;
  wellness?: boolean;
  subscriptionType?: string;
};

export type BokadirektListing = {
  id: number;
  slug: string;
  name: string;
  detailUrl: string;
  address: BokadirektAddress;
  position?: { lat: number; lon: number };
  rating?: BokadirektRating;
  profileImageURL?: string | null;
  images: string[];
  services: BokadirektService[];
  settings: BokadirektSettings;
  badges: string[];
  promoText?: string;
  portalId?: number;
};

export type BokadirektParseResult = {
  totalResults: number;
  listings: BokadirektListing[];
};

const STATE_KEY = "window.__PRELOADED_STATE__ = ";

function extractPreloadedStateJson(html: string): string | null {
  const start = html.indexOf(STATE_KEY);
  if (start === -1) return null;
  let i = start + STATE_KEY.length;
  if (html[i] !== "{") return null;
  const startJ = i;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
  }
  return html.slice(startJ, i);
}

type RawPlace = {
  id: number;
  slug: string;
  name: string;
  address?: { street?: string; city?: string; zipcode?: string };
  position?: { lat: number; lon: number };
  rating?: { score: number; count: number };
  profileImageURL?: string | null;
  images?: string[];
  matchedServices?: Array<{
    id: number;
    name: string;
    description?: string;
    durationLabel?: string;
    priceLabel?: string;
  }>;
  associations?: Array<{ slug?: string; name?: string }>;
  settings?: BokadirektSettings;
  about?: { settings?: BokadirektSettings };
  searchResultText?: string;
  portalId?: number;
};

function mapPlace(p: RawPlace): BokadirektListing {
  const settings = { ...(p.about?.settings ?? {}), ...(p.settings ?? {}) };
  const badges: string[] = [];
  if (settings.hasCampaigns) badges.push("Kampanj");
  if (settings.sellsGiftCard) badges.push("Presentkort");
  if (settings.wellness) badges.push("Friskvård");
  if (settings.hasKlarna) badges.push("Klarna");
  if (settings.hasQliro) badges.push("Qliro");
  for (const a of p.associations ?? []) {
    if (a.slug) badges.push(a.slug);
  }

  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    detailUrl: `https://www.bokadirekt.se/places/${p.slug}`,
    address: {
      street: p.address?.street,
      city: p.address?.city,
      zipcode: p.address?.zipcode,
    },
    position: p.position,
    rating: p.rating,
    profileImageURL: p.profileImageURL ?? null,
    images: p.images ?? [],
    services: (p.matchedServices ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      durationLabel: s.durationLabel,
      priceLabel: s.priceLabel,
    })),
    settings,
    badges,
    promoText: p.searchResultText,
    portalId: p.portalId,
  };
}

export function parseBokadirektHtml(html: string): BokadirektParseResult {
  const json = extractPreloadedStateJson(html);
  if (!json) {
    throw new Error("Could not locate window.__PRELOADED_STATE__ in HTML");
  }
  let state: {
    searchV2?: {
      results?: number;
      places?: Record<string, RawPlace[]>;
    };
  };
  try {
    state = JSON.parse(json);
  } catch (err) {
    throw new Error(`Failed to parse __PRELOADED_STATE__ JSON: ${(err as Error).message}`);
  }

  const searchV2 = state.searchV2;
  if (!searchV2 || !searchV2.places) {
    return { totalResults: 0, listings: [] };
  }

  const pageKeys = Object.keys(searchV2.places);
  const listings: BokadirektListing[] = [];
  for (const key of pageKeys) {
    for (const raw of searchV2.places[key] ?? []) {
      listings.push(mapPlace(raw));
    }
  }

  return {
    totalResults: searchV2.results ?? listings.length,
    listings,
  };
}
