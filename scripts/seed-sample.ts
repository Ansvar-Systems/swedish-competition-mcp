/**
 * Seed the Konkurrensverket (Swedish Competition Authority) database with sample
 * decisions, mergers, and sectors for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["KKV_DB_PATH"] ?? "data/kkv.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted existing database at ${DB_PATH}`); }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

interface SectorRow { id: string; name: string; name_en: string; description: string; decision_count: number; merger_count: number; }

const sectors: SectorRow[] = [
  { id: "digital_economy", name: "Digital ekonomi", name_en: "Digital economy",
    description: "Onlineplattformar, digitala marknadsplatser, sokmotorer och app-butiker pa den svenska marknaden.", decision_count: 2, merger_count: 1 },
  { id: "food_retail", name: "Dagligvaruhandel", name_en: "Food retail",
    description: "Dagligvaruhandel, livsmedelsbutiker, grossister och leverantorsrelationer i Sverige.", decision_count: 2, merger_count: 1 },
  { id: "energy", name: "Energi", name_en: "Energy",
    description: "El- och gasproduktion, transmission, distribution och handel pa den svenska energimarknaden.", decision_count: 1, merger_count: 2 },
  { id: "financial_services", name: "Finansiella tjanster", name_en: "Financial services",
    description: "Banker, forsekring, betalningslosningar och finansmarknadsinfrastruktur i Sverige.", decision_count: 1, merger_count: 1 },
  { id: "telecommunications", name: "Telekommunikation", name_en: "Telecommunications",
    description: "Mobil, bredband, fast telefoni och telekommunikationsinfrastruktur i Sverige.", decision_count: 1, merger_count: 1 },
  { id: "healthcare", name: "Halso- och sjukvard", name_en: "Healthcare",
    description: "Sjukhus, lakemedel, medicinteknik och sjukforsakring i Sverige.", decision_count: 1, merger_count: 1 },
  { id: "construction", name: "Byggindustri", name_en: "Construction",
    description: "Byggmaterial, byggtjanster och fastighetsutveckling i Sverige.", decision_count: 1, merger_count: 0 },
  { id: "media", name: "Medier", name_en: "Media",
    description: "Press, television, streamingstjanster och nyhetsmedia i Sverige.", decision_count: 1, merger_count: 0 },
];

const insertSector = db.prepare("INSERT OR IGNORE INTO sectors (id, name, name_en, description, decision_count, merger_count) VALUES (?, ?, ?, ?, ?, ?)");
for (const s of sectors) { insertSector.run(s.id, s.name, s.name_en, s.description, s.decision_count, s.merger_count); }
console.log(`Inserted ${sectors.length} sectors`);

interface DecisionRow { case_number: string; title: string; date: string; type: string; sector: string; parties: string; summary: string; full_text: string; outcome: string; fine_amount: number | null; gwb_articles: string; status: string; }

const decisions: DecisionRow[] = [
  {
    case_number: "KKV/2022/001",
    title: "ICA Gruppen — Missbruk av dominerande stallning i dagligvaruhandeln",
    date: "2022-06-15", type: "abuse_of_dominance", sector: "food_retail",
    parties: JSON.stringify(["ICA Gruppen AB", "ICA Sverige AB"]),
    summary: "Konkurrensverket undersoke om ICA Gruppen missbrukade sin dominerande stallning pa den svenska dagligvarumarknaden genom villkor i franchiseavtal som begransade franchisetagarnas mojligheter att tacka in fran alternativa leverantorer.",
    full_text: "Konkurrensverket oppnade en undersookning av ICA Gruppen AB:s beteende gentemot sina franchisetagare pa den svenska dagligvarumarknaden. ICA ar den storsta dagligvaruhandlaren i Sverige med en marknadsandel pa nara 50 procent. Konkurrensverket undersokte om ICA:s franchiseavtal inneholl klausuler som otillborligen begransade franchisetagarnas ratt att kopa in varor fran alternativa leverantorer utanfor ICA:s egna grossistledet. Spesifika fragor: (1) Exklusivitetsklausuler — om franchisetagarna kraevdes att kopa en viss andel av sina inkoep via ICA:s grossistverksamhet, vilket begransade konkurrensen pa grossistmarknaden. (2) Prissattningskontroll — om ICA satte tak for vilka priser franchisetagarna fick ta ut, vilket paverkade priskonkurrensen i butiksledet. (3) Sortimentsrestriktioner — om ICA begransade franchisetagarnas ratt att erbjuda konkurrerande produkter. Konkurrensverket konstaterade att ICA:s dominerande stallning pa dagligvarumarknaden innebar ett sarskilt ansvar att inte begransa konkurrensen via sina franchiseavtal. ICA accepterade att modifiera sina franchiseavtal i enlighet med Konkurrensverkets synpunkter. Konkurrensverket avslutade arenodet utan att utdoma natgot forelaggande, men meddelade att det skulle foljandes upp.",
    outcome: "cleared_with_conditions", fine_amount: null,
    gwb_articles: JSON.stringify(["2 kap. 7 SS KL (2008:579)", "Artikel 102 FEUF"]), status: "final",
  },
  {
    case_number: "KKV/2022/002",
    title: "Byggbranschen — kartell om anbudssamarbete i offentlig upphandling",
    date: "2022-09-20", type: "cartel", sector: "construction",
    parties: JSON.stringify(["NCC Sverige AB", "Skanska Sverige AB", "Peab AB"]),
    summary: "Konkurrensverket forelade NCC, Skanska och Peab konkurrensrattliga saektionsforelagganden for deltagande i anbudssamarbete (bid rigging) vid offentliga byggnadsupphandlingar i Sverige. Forelagen omfatade skadestandskrav och forbud mot framtida kartellbeteende.",
    full_text: "Konkurrensverket genomforde en utredning av anbudssamarbete i den svenska byggbranschen. Undersookningen, som inleddes efter anmalan fran en offentlig upphandlare, avslojede ett systematiskt muster av koordinering mellan de stora byggforetagen vid offentliga anbudsprocesser. Det konstaterade beteendet: (1) Forhands-samordning av vilka foretag som skulle lagga det vinnande anbud pa respektive upphandling. (2) Inlamning av lock-bud (forstabud med for hog pris) fran de foretag som inte skulle vinna det specifika kontraktet. (3) Roterande system for att sakersta att alla deltagare fick sin andel av kontrakten over tid. Berorda upphandlingar: Vag- och anlaggningsarbeten, offentliga byggnader och kommunal infrastruktur. Det uppskattade skadan for offentliga upphandlare beloptes sig till hundratals miljoner kronor i overpriser over en period pa fem ar. Konkurrensverket forelade foretagsbots och konkurrensforbudsforelagganden. Arendet anmaldes aven till Ekobrottsmyndigheten (EBM) for utredning av eventuella straffrattliga pafooljder mot enskilda personer.",
    outcome: "fine", fine_amount: 85_000_000,
    gwb_articles: JSON.stringify(["2 kap. 1 SS KL (2008:579)", "Artikel 101 FEUF"]), status: "appealed",
  },
  {
    case_number: "KKV/2023/001",
    title: "Digital plattform — marknadsstudie av onlineplattformar",
    date: "2023-03-10", type: "sector_inquiry", sector: "digital_economy",
    parties: JSON.stringify(["Onlineplattformsoperatorer pa den svenska marknaden"]),
    summary: "Konkurrensverket genomforde en marknadsstudie av onlineplattformar pa den svenska marknaden, med fokus pa marknadsplatser for e-handel, bokningsplattformar och digitala annonseringsmarknader. Studien analyserade strukturen, barriarer och datainsamling.",
    full_text: "Konkurrensverket genomforde en marknadsstudie av onlineplattformar i Sverige i enlighet med 6 kap. 1 SS konkurrenslagen (2008:579). Sverige ar en av Europas mest digitaliserade ekonomier med hog e-handelsandel och hogst andel av befolkningen som anvander onlinetjanster. Studien tackte tre marknadsomraden: (1) E-handelsplattformar — marknadsstrukturen for plattformar som Cdon, Tradera och internationella plattformar som Amazon och eBay. Studien analyserade provisionsstrukturer, rankningsalgoritmer och anvandning av handlardata. (2) Bokningsplattformar for boende och resor — fokus pa vertikalt integrerade aktorer som Booking.com och Expedia, och deras paverkan pa oberoende hotell och resebyrers konkurrensforutsattningar. (3) Digitala annonsmarknader — programmatisk annonsering och rollerna for dataintermediarer pa den svenska marknaden. Konkurrensverket fann att digitala plattformar uppvisar narket av tippling points och lock-in-effekter. Studien ledde till rekommendationer om transparenskrav i rankningsalgoritmer, dataportabilitet och interoperabilitetsskrav. Studien informerade aven Sveriges inmarkning i EU:s Digital Markets Act.",
    outcome: "cleared", fine_amount: null,
    gwb_articles: JSON.stringify(["6 kap. 1 SS KL (2008:579)"]), status: "final",
  },
  {
    case_number: "KKV/2023/002",
    title: "Telekommunikation — prissamarbete for mobilabonnemang",
    date: "2023-11-08", type: "cartel", sector: "telecommunications",
    parties: JSON.stringify(["Tele2 Sverige AB", "Telenor Sverige AB"]),
    summary: "Konkurrensverket utredde om Tele2 och Telenor koordinerade sina prisstrategier for mobilabonnemang till foretag. Utredningen bygde pa vittnesmal och e-postkommunikation som visade koordination kring prissattning vid stora fore tagskunder.",
    full_text: "Konkurrensverket oppnade en utredning av Tele2 Sverige AB och Telenor Sverige AB avseende misstankt koordination av prisstrategier pa marknaden for mobiltelefonabonnemang till foretagskunder. Den svenska marknaden for mobiltelefoni ar ett oligopol med fyra natsoperatorer: Telia, Tele2, Telenor och Hi3G (3). Konkurrensverkets utredning baserades pa: (1) Vittnesmal fran nuvarande och tidigare anstallda om informationsutbyten pa branschorganisationsniva. (2) E-postkommunikation som visade direkta kontakter mellan forforetagskundssansvariga for att koordinera prissatning vid stora fore tagskunder. (3) Statistisk analys av prisrorelsmoner som visade hog korrelation i prissatningsforandringar. Konkurrensverket fann att kontakterna i tillracklig grad visade pa ett forbjudet informationsutbyte. Bada foretagen accepterade att betala foretagsboter och genomfora internutbildningar i konkurrensratt. Konkurrensverket bedode att ett formellt ageende var noadvandig for att sanda en tydlig signal till telecombranschen.",
    outcome: "fine", fine_amount: 32_000_000,
    gwb_articles: JSON.stringify(["2 kap. 1 SS KL (2008:579)", "Artikel 101 FEUF"]), status: "final",
  },
  {
    case_number: "KKV/2024/001",
    title: "Halso- och sjukvard — Marknadsstudie av privata vardgivare",
    date: "2024-04-20", type: "sector_inquiry", sector: "healthcare",
    parties: JSON.stringify(["Privata vardgivare i Sverige"]),
    summary: "Konkurrensverket lanserade en marknadsstudie av privata vardgivarmarknaden i Sverige, med fokus pa privaraklagsval, specialiserade kliniker och digitala vardtjanster. Studien undersoker konkurrensstrukturen och konsumenternas valmojligheter.",
    full_text: "Konkurrensverket inledde en marknadsstudie av marknaden for privat halso- och sjukvard i Sverige. Studien initierades som ett resultat av den snabba tillvaxten av privata vardgivare inom ramen for systemet for valfrihet (LOV och LOU). Svenska patienter har ratt att valja vardgivare, vilket skapar konkurrens pa vardmarknaden. Studien tackte: (1) Primarvard och halso- och sjukvardscentraler — konkurrens mellan offentliga och privata aktorer. (2) Specialistvard — marknadsdynamik for privata specialistmottagningar inkl. ortopedi, ogon och dermatologi. (3) Digitala vardtjanster — tillvaxten av digitala vardtjanster (t.ex. Kry, Min Doktor) och deras paverkan pa traditionell primarvard. (4) Prisvardsforsakkring — samspelet mellan privat fordsakring och valet av vard. Konkurrensverket studerade aven konsolideringen i branschen — ett begransen antal privata vardforetag har vaxt sig stora genom forvarv av mindre kliniker, vilket kan paverka konkurrens och mangfald i utbudet.",
    outcome: "cleared", fine_amount: null,
    gwb_articles: JSON.stringify(["6 kap. 1 SS KL (2008:579)"]), status: "ongoing",
  },
];

const insertDecision = db.prepare("INSERT OR IGNORE INTO decisions (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertDecisionsAll = db.transaction(() => { for (const d of decisions) { insertDecision.run(d.case_number, d.title, d.date, d.type, d.sector, d.parties, d.summary, d.full_text, d.outcome, d.fine_amount, d.gwb_articles, d.status); } });
insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

interface MergerRow { case_number: string; title: string; date: string; sector: string; acquiring_party: string; target: string; summary: string; full_text: string; outcome: string; turnover: number | null; }

const mergers: MergerRow[] = [
  {
    case_number: "KKV/2022/M/001",
    title: "Telia Company / Bonnier Broadcasting — Mediesektorn",
    date: "2022-07-05", sector: "media",
    acquiring_party: "Telia Company AB", target: "Bonnier Broadcasting AB (TV4, C More)",
    summary: "Konkurrensverket godkande med villkor Telia Company:s forvarv av Bonnier Broadcasting (TV4, C More). Foretagskoncentrationen godkandes under forutsattning att Telia avyttrar TV4:s distributionskanaler och garanterar distributionsparitet for konkurrenter.",
    full_text: "Konkurrensverket granskade Telia Company AB:s forvarv av Bonnier Broadcasting AB, som ager TV4-gruppen (TV4, C More, och ett antal kabelkanaler). Telia ar Sveriges storsta teleoperator med en dominerande stallning inom bredbands- och pay-TV-distribution. Transaktionen skapade vertikal integration mellan en dominant TV-distributoor och en av de storsta TV-innehallsleverantorerna. Konkurrensverkets analys identifierade tva huvud farhgor: (1) Stangningsrisker — Telia skulle kunna diskriminera konkurrerade distributionsfotretag (bland andra Comviq, Bahnhof, Boxer) genom att ge sina egna distributionskanaler fordelaktigare villkor for att distribuera TV4-kanalerna. (2) Inputstangning — TV4:s attraktiva innehall (bland annat Melodifestivalen och Allsvenskan) skulle kunna hallas utanfor konkurrenter till fordelaktiga villkor. Godkannande med villkor: Telia maste (1) tillhandahalla TV4:s kanalpaket pa icke-diskriminerande villkor till alla distributorer under sju ar. (2) Salja eller separat redovisa TV4:s reklamforsaljningsverksamhet. (3) Inte koppla ihop bredbandserbjudanden med exklusivt TV4-innehall.",
    outcome: "cleared_with_conditions", turnover: 22_000_000_000,
  },
  {
    case_number: "KKV/2023/M/001",
    title: "Vattenfall / Fortum — Forvarv av nordiska energitillgangar",
    date: "2023-05-18", sector: "energy",
    acquiring_party: "Vattenfall AB", target: "Fortum Distribution (nordiska distributionsnat)",
    summary: "Konkurrensverket godkande Vattenfall AB:s forvarv av Fortums nordiska eldistributionsnet. Transaktionen godkandes i fas 1 efter att Konkurrensverket konstaterade att de inblandade verksamheterna inte overlappar pa relevanta marknader.",
    full_text: "Konkurrensverket granskade Vattenfall AB:s forvarv av Fortum Distributions nordiska eldistributionsnat. Vattenfall ar ett av de storsta energiforetagen i Norden med stora verksamheter inom elproduktion, -handel och -distribution. Fortum ar ett finskt energibolag med nordiska eldistributionsnat som det ville avyttra som ett led i en strategisk omstrukturering. Transaktionen avsag distribution av el till enskilda kunder i Sverige, Finland och Norge via lagnatsnat. Konkurrensverkets analys: (1) Eldistribution ar reglerat monopol — eldistributionsnaten ar naturliga monopol och regleras av Energimarknadsombudsmannen (Ei) i Sverige. Konkurrensen pa denna del av marknaden ar begransad av natur. (2) Ingen horisontell overlap — Vattenfall och Fortum driver sina distributionsnat i olika geografiska omraden. Ingen direkt horisontell overlap identifierades. (3) Vertikala effekter — Konkurrensverket undersokte om den kombinerade enheten kunde diskriminera alternativa elproducenter pa natverksniva. Ei:s regleringsram bedomdes som tillracklig for att forhindra sadant missbruk. Konkurrensverket godkande transaktionen i fas 1 utan villkor.",
    outcome: "cleared_phase1", turnover: 18_000_000_000,
  },
  {
    case_number: "KKV/2023/M/002",
    title: "Axfood / Bergendahls — Forvarv av City Gross-kjedjan",
    date: "2023-09-12", sector: "food_retail",
    acquiring_party: "Axfood AB", target: "City Gross (Bergendahls Food AB)",
    summary: "Konkurrensverket godkande med villkor Axfood AB:s forvarv av City Gross. Transaktionen godkandes pa villkoret att Axfood avyttrar ett antal City Gross-butiker i lokala marknader dar de kombinerade marknadsandelarna vaekte konkurrensmal.",
    full_text: "Konkurrensverket granskade Axfood AB:s forvarv av City Gross-kedjan fran Bergendahls Food AB. Axfood ar ett av Sveriges storsta dagligvaruforetag och aager butikskedjorna Willys och Hemkop. City Gross ar en storskalig matkedja med fokus pa lagpris och stora butiksformat. Den svenska dagligvarumarknaden domineras av ICA (marknadsandel nara 50%), Coop och Axfood/Willys. Forvarvet av City Gross skulle ytterligare starka Axfoods position. Konkurrensverkets analys: Dagligvarumarknader definieras lokalt — relevant geografi ar ett upptagningsomrade pa 10-20 minuters restid. I ett antal lokala marknader, sarskilt i sorra Sverige dar City Gross ar starkt representerat, skulle den kombinerade butiksdensiteten for Axfood och City Gross medfora konkurrensproblem. Godkannande med villkor: Axfood maste avyttra 8 City Gross-butiker i utpekade lokala marknader till en godkand uppkorare inom 12 manader fran transaktionens genomforande. Konkurrensverket godkande transaktionen i ovrigt.",
    outcome: "cleared_with_conditions", turnover: 62_000_000_000,
  },
];

const insertMerger = db.prepare("INSERT OR IGNORE INTO mergers (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertMergersAll = db.transaction(() => { for (const m of mergers) { insertMerger.run(m.case_number, m.title, m.date, m.sector, m.acquiring_party, m.target, m.summary, m.full_text, m.outcome, m.turnover); } });
insertMergersAll();
console.log(`Inserted ${mergers.length} mergers`);

const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const mergerCount = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
const sectorCount = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;
console.log("\nDatabase summary:");
console.log(`  Sectors:    ${sectorCount}`);
console.log(`  Decisions:  ${decisionCount}`);
console.log(`  Mergers:    ${mergerCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);
db.close();
