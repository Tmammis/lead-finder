// Sweden's 21 regions/län + 290 municipalities (kommuner), lowercased.
// Used to decide whether a business name already encodes its location — when it
// does, the allabolag city gate is skipped (a company's registered municipality
// is often a different town than where it operates).

const REGIONS = [
  "stockholm", "uppsala", "södermanland", "östergötland", "jönköping",
  "kronoberg", "kalmar", "gotland", "blekinge", "skåne", "halland",
  "västra götaland", "värmland", "örebro", "västmanland", "dalarna",
  "gävleborg", "västernorrland", "jämtland", "västerbotten", "norrbotten",
];

const MUNICIPALITIES = [
  // Stockholm
  "upplands väsby", "vallentuna", "österåker", "värmdö", "järfälla", "ekerö",
  "huddinge", "botkyrka", "salem", "haninge", "tyresö", "upplands-bro",
  "nykvarn", "täby", "danderyd", "sollentuna", "stockholm", "södertälje",
  "nacka", "sundbyberg", "solna", "lidingö", "vaxholm", "norrtälje", "sigtuna",
  "nynäshamn",
  // Uppsala
  "håbo", "älvkarleby", "knivsta", "heby", "tierp", "uppsala", "enköping",
  "östhammar",
  // Södermanland
  "vingåker", "gnesta", "nyköping", "oxelösund", "flen", "katrineholm",
  "eskilstuna", "strängnäs", "trosa",
  // Östergötland
  "ödeshög", "ydre", "kinda", "boxholm", "åtvidaberg", "finspång",
  "valdemarsvik", "linköping", "norrköping", "söderköping", "motala",
  "vadstena", "mjölby",
  // Jönköping
  "aneby", "gnosjö", "mullsjö", "habo", "gislaved", "vaggeryd", "jönköping",
  "nässjö", "värnamo", "sävsjö", "vetlanda", "eksjö", "tranås",
  // Kronoberg
  "uppvidinge", "lessebo", "tingsryd", "alvesta", "älmhult", "markaryd",
  "växjö", "ljungby",
  // Kalmar
  "högsby", "torsås", "mörbylånga", "hultsfred", "mönsterås", "emmaboda",
  "kalmar", "nybro", "oskarshamn", "västervik", "vimmerby", "borgholm",
  // Gotland
  "gotland",
  // Blekinge
  "olofström", "karlskrona", "ronneby", "karlshamn", "sölvesborg",
  // Skåne
  "svalöv", "staffanstorp", "burlöv", "vellinge", "östra göinge",
  "örkelljunga", "bjuv", "kävlinge", "lomma", "svedala", "skurup", "sjöbo",
  "hörby", "höör", "tomelilla", "bromölla", "osby", "perstorp", "klippan",
  "åstorp", "båstad", "malmö", "lund", "landskrona", "helsingborg", "höganäs",
  "eslöv", "ystad", "trelleborg", "kristianstad", "simrishamn", "ängelholm",
  "hässleholm",
  // Halland
  "hylte", "halmstad", "laholm", "falkenberg", "varberg", "kungsbacka",
  // Västra Götaland
  "härryda", "partille", "öckerö", "stenungsund", "tjörn", "orust", "sotenäs",
  "munkedal", "tanum", "dals-ed", "färgelanda", "ale", "lerum", "vårgårda",
  "bollebygd", "grästorp", "essunga", "karlsborg", "gullspång", "tranemo",
  "bengtsfors", "mellerud", "lilla edet", "mark", "svenljunga", "herrljunga",
  "vara", "götene", "tibro", "töreboda", "göteborg", "mölndal", "kungälv",
  "lysekil", "uddevalla", "strömstad", "vänersborg", "trollhättan", "alingsås",
  "borås", "ulricehamn", "åmål", "mariestad", "lidköping", "skara", "skövde",
  "hjo", "tidaholm", "falköping",
  // Värmland
  "kil", "eda", "torsby", "storfors", "hammarö", "munkfors", "forshaga",
  "grums", "årjäng", "sunne", "karlstad", "kristinehamn", "filipstad",
  "hagfors", "arvika", "säffle",
  // Örebro
  "lekeberg", "laxå", "hallsberg", "degerfors", "hällefors", "ljusnarsberg",
  "örebro", "kumla", "askersund", "karlskoga", "nora", "lindesberg",
  // Västmanland
  "skinnskatteberg", "surahammar", "kungsör", "hallstahammar", "norberg",
  "västerås", "sala", "fagersta", "köping", "arboga",
  // Dalarna
  "vansbro", "malung-sälen", "gagnef", "leksand", "rättvik", "orsa",
  "älvdalen", "smedjebacken", "mora", "falun", "borlänge", "säter", "hedemora",
  "avesta", "ludvika",
  // Gävleborg
  "ockelbo", "hofors", "ovanåker", "nordanstig", "ljusdal", "gävle",
  "sandviken", "söderhamn", "bollnäs", "hudiksvall",
  // Västernorrland
  "ånge", "timrå", "härnösand", "sundsvall", "kramfors", "sollefteå",
  "örnsköldsvik",
  // Jämtland
  "ragunda", "bräcke", "krokom", "strömsund", "åre", "berg", "härjedalen",
  "östersund",
  // Västerbotten
  "nordmaling", "bjurholm", "vindeln", "robertsfors", "norsjö", "malå",
  "storuman", "sorsele", "dorotea", "vännäs", "vilhelmina", "åsele", "umeå",
  "lycksele", "skellefteå",
  // Norrbotten
  "arvidsjaur", "arjeplog", "jokkmokk", "överkalix", "kalix", "övertorneå",
  "pajala", "gällivare", "älvsbyn", "luleå", "piteå", "boden", "haparanda",
  "kiruna",
];

// Place names that are also common Swedish words or surnames; matching on these
// causes false positives, so we exclude them and let the city gate handle those
// leads instead (the safe fallback).
const DENYLIST = new Set([
  "mark", "vara", "ale", "berg", "mora", "sala", "kil", "åre", "ed", "habo",
]);

const SINGLE = new Set<string>();
const MULTI: string[] = [];
for (const p of [...REGIONS, ...MUNICIPALITIES]) {
  if (DENYLIST.has(p)) continue;
  if (p.includes(" ") || p.includes("-")) MULTI.push(p);
  else SINGLE.add(p);
}

// Lowercase, strip accents-insensitively NO — keep Swedish chars; only split on
// non-letter separators so "Helsingborg-" and "Lund," tokenize cleanly.
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-zà-öø-ÿ0-9]+/)
    .filter(Boolean);
}

export function nameContainsPlace(name: string): boolean {
  if (!name) return false;
  const toks = tokens(name);
  for (const t of toks) {
    if (SINGLE.has(t)) return true;
  }
  const normalized = name.toLowerCase();
  for (const m of MULTI) {
    if (normalized.includes(m)) return true;
  }
  return false;
}
