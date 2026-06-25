import type { AllabolagCompany } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class AllabolagError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AllabolagError";
    this.cause = cause;
  }
}

async function fetchHtml(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.5",
      },
      redirect: "follow",
    });
  } catch (err) {
    throw new AllabolagError(`Network error fetching ${url}`, err);
  }
  if (!res.ok) {
    throw new AllabolagError(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

// allabolag.se is a Next.js app: structured data ships inside a
// <script id="__NEXT_DATA__"> JSON tag. Parse it rather than scraping HTML.
function extractNextData(html: string): unknown {
  const m = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) {
    throw new AllabolagError("Could not locate __NEXT_DATA__ in HTML");
  }
  try {
    return JSON.parse(m[1]);
  } catch (err) {
    throw new AllabolagError("Failed to parse __NEXT_DATA__ JSON", err);
  }
}

type RawCompany = {
  orgnr?: string;
  companyId?: string;
  name?: string;
  legalName?: string;
  displayName?: string;
  employees?: string | number | null;
  numberOfEmployees?: string | number | null;
  revenue?: string | number | null;
  homePage?: string | null;
  liquidationDate?: string | null;
  location?: { municipality?: string | null } | null;
  postalAddress?: { postPlace?: string | null } | null;
};

function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/\s/g, ""));
  return Number.isFinite(n) ? n : null;
}

function mapCompany(c: RawCompany): AllabolagCompany | null {
  const orgnr = c.orgnr ?? c.companyId;
  const name = c.name ?? c.legalName ?? c.displayName;
  if (!orgnr || !name) return null;

  const employees = toNumber(c.employees ?? c.numberOfEmployees);
  const revenueTkr = toNumber(c.revenue);

  return {
    orgnr: String(orgnr),
    name,
    legalName: c.legalName,
    employees,
    // allabolag reports revenue in tkr (thousands of SEK)
    revenueSek: revenueTkr == null ? null : revenueTkr * 1000,
    municipality: c.location?.municipality ?? null,
    postPlace: c.postalAddress?.postPlace ?? null,
    homePage: c.homePage ?? null,
    url: `https://www.allabolag.se/${orgnr}`,
    active: !c.liquidationDate,
  };
}

// Search allabolag for a company name and return all candidate matches
// (active first, then by-name and inactive buckets), each with employees +
// revenue already populated from the search payload.
export async function searchCompanies(term: string): Promise<AllabolagCompany[]> {
  const url = `https://www.allabolag.se/what/${encodeURIComponent(term)}`;
  const data = extractNextData(await fetchHtml(url)) as {
    props?: {
      pageProps?: {
        hydrationData?: {
          searchStore?: Record<string, { companies?: RawCompany[] } | unknown>;
        };
      };
    };
  };

  const store = data.props?.pageProps?.hydrationData?.searchStore;
  if (!store) return [];

  const out: AllabolagCompany[] = [];
  const seen = new Set<string>();
  for (const bucketName of ["companiesByName", "companies", "inactiveCompanies"]) {
    const bucket = store[bucketName] as { companies?: RawCompany[] } | undefined;
    for (const raw of bucket?.companies ?? []) {
      const mapped = mapCompany(raw);
      if (mapped && !seen.has(mapped.orgnr)) {
        seen.add(mapped.orgnr);
        out.push(mapped);
      }
    }
  }
  return out;
}

type RawPerson = { name?: string; role?: string };
type CompanyRoles = {
  manager?: RawPerson | null;
  chairman?: RawPerson | null;
};

// Fetch a company's detail page and return its primary owner/decision-maker:
// VD (CEO) if present, otherwise the board chairman (Ordförande).
export async function fetchOwner(
  orgnr: string,
): Promise<{ name: string; role: string } | null> {
  const data = extractNextData(
    await fetchHtml(`https://www.allabolag.se/${encodeURIComponent(orgnr)}`),
  ) as {
    props?: {
      pageProps?: {
        company?: { roles?: CompanyRoles; contactPerson?: RawPerson | null };
      };
    };
  };

  const company = data.props?.pageProps?.company;
  const candidates = [
    company?.roles?.manager,
    company?.roles?.chairman,
    company?.contactPerson,
  ];
  for (const p of candidates) {
    if (p?.name) return { name: p.name, role: p.role ?? "" };
  }
  return null;
}
