export const BOKADIREKT_CATEGORIES = [
  { slug: "frisor", label: "Frisör" },
  { slug: "massage", label: "Massage" },
  { slug: "naglar", label: "Naglar" },
  { slug: "hudvard", label: "Hudvård" },
  { slug: "skonhet", label: "Skönhet" },
  { slug: "halsa", label: "Hälsa" },
  { slug: "traning", label: "Träning" },
  { slug: "fotvard", label: "Fotvård" },
  { slug: "ogonfransar-och-bryn", label: "Ögonfransar & Bryn" },
  { slug: "tandvard", label: "Tandvård" },
] as const;

export type BokadirektCategorySlug = (typeof BOKADIREKT_CATEGORIES)[number]["slug"];
