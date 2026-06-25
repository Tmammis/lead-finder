export const BOKADIREKT_CITIES = [
  { slug: "stockholm", label: "Stockholm" },
  { slug: "goteborg", label: "Göteborg" },
  { slug: "malmo", label: "Malmö" },
  { slug: "uppsala", label: "Uppsala" },
  { slug: "lund", label: "Lund" },
  { slug: "helsingborg", label: "Helsingborg" },
  { slug: "linkoping", label: "Linköping" },
  { slug: "vasteras", label: "Västerås" },
  { slug: "orebro", label: "Örebro" },
  { slug: "norrkoping", label: "Norrköping" },
  { slug: "jonkoping", label: "Jönköping" },
  { slug: "umea", label: "Umeå" },
  { slug: "lulea", label: "Luleå" },
  { slug: "gavle", label: "Gävle" },
  { slug: "boras", label: "Borås" },
  { slug: "eskilstuna", label: "Eskilstuna" },
  { slug: "sodertalje", label: "Södertälje" },
  { slug: "karlstad", label: "Karlstad" },
  { slug: "halmstad", label: "Halmstad" },
  { slug: "vaxjo", label: "Växjö" },
] as const;

export type BokadirektCitySlug = (typeof BOKADIREKT_CITIES)[number]["slug"];
