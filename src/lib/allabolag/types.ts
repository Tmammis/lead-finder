// A single company record as it appears in allabolag.se search results
// (parsed out of the page's __NEXT_DATA__ blob).
export type AllabolagCompany = {
  orgnr: string;
  name: string;
  legalName?: string;
  /** Number of employees. Active companies use `employees`, inactive use
   * `numberOfEmployees`; we normalize to a single number here. */
  employees: number | null;
  /** Latest filed annual revenue, converted to SEK (allabolag reports tkr). */
  revenueSek: number | null;
  municipality: string | null;
  postPlace: string | null;
  homePage: string | null;
  /** Canonical allabolag URL for this company, when known. */
  url: string | null;
  active: boolean;
};

// Result of looking up + matching a lead against allabolag.
export type AllabolagMatch = {
  company: AllabolagCompany;
  ownerName: string | null;
  ownerRole: string | null;
  /** 0..1 confidence that this is the right company for the lead. */
  confidence: number;
  /** True when the matched company's city agrees with the lead's city. */
  cityConfirmed: boolean;
};
