#!/usr/bin/env npx tsx
/**
 * Konkurrensverket (Swedish Competition Authority) ingestion crawler.
 *
 * Crawls konkurrensverket.se to populate the KKV MCP database with:
 *   - Competition decisions (kartell, missbruk, avskrivning)
 *   - Merger control decisions (företagskoncentrationer)
 *   - Sector investigations / market studies
 *
 * Data sources (in crawl order):
 *   1. Diary search  — information.konkurrensverket.se/Diariet/resultat.asp
 *      Returns structured case metadata (dnr, title, dates, type, status).
 *   2. Case pages    — konkurrensverket.se/konkurrens/tillsyn-arenden-och-beslut/arendelista/{slug}/
 *      HTML detail pages with summaries and decision text.
 *   3. Decision PDFs — konkurrensverket.se/globalassets/dokument/konkurrens/beslut/{subdir}/{id}.pdf
 *      Full decision text (parsed via PDF-to-text).
 *
 * The crawler uses the diary as the primary index, then enriches each case
 * from the HTML detail page and/or PDF when available.
 *
 * Usage:
 *   npx tsx scripts/ingest-konkurrensverket.ts
 *   npx tsx scripts/ingest-konkurrensverket.ts --resume
 *   npx tsx scripts/ingest-konkurrensverket.ts --dry-run
 *   npx tsx scripts/ingest-konkurrensverket.ts --force
 *   npx tsx scripts/ingest-konkurrensverket.ts --year-start 2020 --year-end 2025
 *   npx tsx scripts/ingest-konkurrensverket.ts --limit 50
 *
 * Flags:
 *   --resume      Skip cases already in the database (default: false)
 *   --dry-run     Log what would be ingested without writing to the DB
 *   --force       Drop and recreate tables before ingesting
 *   --year-start  First year to crawl (default: 2008)
 *   --year-end    Last year to crawl  (default: current year)
 *   --limit       Max number of cases to process (0 = unlimited)
 *
 * Requirements:
 *   npm install cheerio better-sqlite3
 *   (better-sqlite3 already in dependencies; cheerio must be added)
 *
 * Environment:
 *   KKV_DB_PATH — SQLite database path (default: data/kkv.db)
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DB_PATH = process.env["KKV_DB_PATH"] ?? "data/kkv.db";
const RATE_LIMIT_MS = 1_500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3_000;
const USER_AGENT =
  "Swedish-Competition-MCP/0.1.0 (https://github.com/Ansvar-Systems/swedish-competition-mcp; bot; research)";

/** Diary search endpoint on the information subdomain. */
const DIARY_SEARCH_URL = "https://information.konkurrensverket.se/Diariet/resultat.asp";

/** Base URL for HTML case detail pages. */
const CASE_BASE_URL =
  "https://www.konkurrensverket.se/konkurrens/tillsyn-arenden-och-beslut/arendelista/";

/** Base URL for decision PDFs. */
const PDF_BASE_URL =
  "https://www.konkurrensverket.se/globalassets/dokument/konkurrens/beslut/";

/** State file for resume support. */
const STATE_FILE = resolve(dirname(DB_PATH), ".ingest-state.json");

/**
 * Dossier group ranges that correspond to competition cases.
 * Groups 11-19 cover competition enforcement cases;
 * groups 20-29 cover merger/concentration reviews.
 */
const DOSSIER_GROUPS = [
  { from: "11", to: "19", category: "competition" },
  { from: "20", to: "29", category: "merger" },
] as const;

/**
 * PDF subdirectories by decision type.
 * Konkurrensverket organises decision PDFs in typed subdirectories.
 */
const PDF_SUBDIRS = [
  "avskrivningsbeslut",
  "atagande",
  "forelaggande",
  "",             // some PDFs sit directly under beslut/
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CliOptions {
  resume: boolean;
  dryRun: boolean;
  force: boolean;
  yearStart: number;
  yearEnd: number;
  limit: number;
}

/** Raw case metadata from the diary search results. */
interface DiaryEntry {
  dnr: string;           // e.g. "740/2024"
  title: string;
  regDate: string | null;
  decisionDate: string | null;
  caseType: string | null;
  status: string | null;
  sender: string | null;
  hasDecisionLink: boolean;
  decisionUrl: string | null;
}

/** Enriched case after fetching detail page + PDF. */
interface EnrichedCase {
  case_number: string;   // Normalised: "KKV/YYYY/NNN" format
  dnr: string;           // Original diary number
  title: string;
  date: string | null;
  type: string | null;
  sector: string | null;
  parties: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  fine_amount: number | null;
  kl_articles: string | null;  // stored in gwb_articles column (Swedish KL references)
  status: string;
  source_url: string | null;
  is_merger: boolean;
}

interface IngestState {
  lastDnr: string | null;
  processedDnrs: string[];
  lastRun: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    resume: false,
    dryRun: false,
    force: false,
    yearStart: 2008,
    yearEnd: new Date().getFullYear(),
    limit: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--resume":
        options.resume = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--year-start":
        options.yearStart = parseInt(args[++i]!, 10);
        break;
      case "--year-end":
        options.yearEnd = parseInt(args[++i]!, 10);
        break;
      case "--limit":
        options.limit = parseInt(args[++i]!, 10);
        break;
      default:
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
    }
  }

  return options;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch a URL with retry logic and rate limiting.
 * Returns null on 403/404 (non-retryable) or after exhausting retries.
 */
async function fetchWithRetry(
  url: string,
  options: { retries?: number; accept?: string } = {},
): Promise<string | null> {
  const maxRetries = options.retries ?? MAX_RETRIES;
  const accept = options.accept ?? "text/html, application/xhtml+xml";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: accept,
          "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.5",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 403 || response.status === 404) {
        // Non-retryable — resource blocked or missing
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        console.warn(
          `  [retry ${attempt}/${maxRetries}] ${url} — ${msg} (waiting ${backoff}ms)`,
        );
        await sleep(backoff);
      } else {
        console.error(`  [failed] ${url} — ${msg} (exhausted ${maxRetries} retries)`);
        return null;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Diary search — discover cases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query the Konkurrensverket diary for cases decided in a given year range.
 *
 * The diary at information.konkurrensverket.se exposes a classic ASP search
 * form. We submit GET requests with the relevant parameters.
 */
async function searchDiary(
  yearStart: number,
  yearEnd: number,
  dossierFrom: string,
  dossierTo: string,
): Promise<DiaryEntry[]> {
  const entries: DiaryEntry[] = [];

  // The diary returns up to `traffar_per_sokning` results.
  // We paginate by year to stay under the limit.
  for (let year = yearEnd; year >= yearStart; year--) {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;

    const params = new URLSearchParams({
      nav: "2",
      sok: "Sök",
      arendetitel: "",
      avs_mottagare: "",
      regdatum_from: from,
      regdatum_to: to,
      beslutsdatum_from: "",
      beslutsdatum_to: "",
      dossiergrupp_from: dossierFrom,
      dossiergrupp_to: dossierTo,
      traffar_per_sida: "50",
      sortera_efter: "Regdatum",
      traffar_per_sokning: "500",
      sort_order: "Fallande",
    });

    // The diary uses checkboxes; append each status filter.
    params.append("avslutade", "1");
    params.append("publicerade", "1");

    const url = `${DIARY_SEARCH_URL}?${params.toString()}`;
    console.log(`  [diary] Searching ${dossierFrom}-${dossierTo} for ${year}...`);

    const html = await fetchWithRetry(url);
    await sleep(RATE_LIMIT_MS);

    if (!html) {
      console.warn(`  [diary] No response for ${year}, skipping`);
      continue;
    }

    const yearEntries = parseDiaryResults(html);
    if (yearEntries.length > 0) {
      console.log(`  [diary] ${year}: ${yearEntries.length} cases found`);
      entries.push(...yearEntries);
    } else {
      console.log(`  [diary] ${year}: 0 cases`);
    }
  }

  return entries;
}

/** Parse the diary search results HTML into DiaryEntry records. */
function parseDiaryResults(html: string): DiaryEntry[] {
  const $ = cheerio.load(html);
  const entries: DiaryEntry[] = [];

  // The diary renders results as table rows.
  // Columns: Diarienr | Status | Beslut | Ärendemening | Ärendetyp | Reg. datum | Avsändare/mottagare
  $("table tr").each((_i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 6) return; // skip header rows

    const dnr = $(cells[0]).text().trim();
    if (!dnr || dnr === "Diarienr") return; // skip headers

    const statusText = $(cells[1]).text().trim();
    const decisionCell = $(cells[2]);
    const decisionLink = decisionCell.find("a").attr("href") ?? null;
    const titleText = $(cells[3]).text().trim();
    const caseType = $(cells[4]).text().trim();
    const regDate = $(cells[5]).text().trim() || null;
    const sender = cells.length >= 7 ? $(cells[6]).text().trim() : null;

    entries.push({
      dnr,
      title: titleText || `Ärende ${dnr}`,
      regDate: normaliseDate(regDate),
      decisionDate: null, // diary doesn't always show this separately
      caseType: caseType || null,
      status: mapStatus(statusText),
      sender: sender || null,
      hasDecisionLink: !!decisionLink,
      decisionUrl: decisionLink
        ? resolveDecisionUrl(decisionLink)
        : null,
    });
  });

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Enrich from case detail pages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to fetch the HTML case detail page for a given diary entry.
 *
 * Konkurrensverket's main site (www.konkurrensverket.se) returns 403 for
 * automated requests. We try anyway, but gracefully handle the block.
 */
async function fetchCaseDetailPage(entry: DiaryEntry): Promise<string | null> {
  // Build a slug from the title (Konkurrensverket uses company names as slugs).
  const slug = titleToSlug(entry.title);
  if (!slug) return null;

  const url = `${CASE_BASE_URL}${slug}/`;
  return fetchWithRetry(url, { retries: 1 }); // single attempt — 403 expected
}

/** Parse the HTML case detail page for summary, full text, and metadata. */
function parseCaseDetailPage(
  html: string,
): { summary: string | null; fullText: string | null; outcome: string | null; fineAmount: number | null; klArticles: string[] } {
  const $ = cheerio.load(html);

  // The case page typically has a main content area with the case description.
  const mainContent = $("main, .main-content, article, .page-content");
  const bodyText = mainContent.length > 0 ? mainContent.text() : $("body").text();

  // Extract summary from meta description or first paragraph
  const metaSummary =
    $('meta[name="description"]').attr("content")?.trim() ?? null;
  const firstParagraph = mainContent.find("p").first().text().trim() || null;
  const summary = metaSummary || firstParagraph;

  // Extract full text from all paragraphs
  const paragraphs: string[] = [];
  mainContent.find("p, li").each((_i, el) => {
    const text = $(el).text().trim();
    if (text.length > 20) paragraphs.push(text);
  });
  const fullText = paragraphs.length > 0 ? paragraphs.join("\n\n") : null;

  // Look for fine amounts in the text
  const fineAmount = extractFineAmount(bodyText);

  // Look for outcome keywords
  const outcome = extractOutcome(bodyText);

  // Look for legal references (KL, FEUF)
  const klArticles = extractKlArticles(bodyText);

  return { summary, fullText, outcome, fineAmount, klArticles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Fetch decision PDFs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to find and fetch the decision PDF for a diary entry.
 *
 * PDF naming convention: YY-NNNN.pdf where YY = last 2 digits of year,
 * NNNN = zero-padded case number from the dnr.
 * Example: dnr "740/2024" → "24-0740.pdf"
 */
async function fetchDecisionPdf(entry: DiaryEntry): Promise<string | null> {
  const pdfName = dnrToPdfFilename(entry.dnr);
  if (!pdfName) return null;

  // Try each known subdirectory
  for (const subdir of PDF_SUBDIRS) {
    const sep = subdir ? `${subdir}/` : "";
    const url = `${PDF_BASE_URL}${sep}${pdfName}`;
    const response = await fetchWithRetry(url, {
      retries: 1,
      accept: "application/pdf",
    });
    if (response) {
      // We got a response, but it may be binary PDF data.
      // For now, we store the URL reference; full PDF text extraction
      // requires a separate PDF parsing library (pdf-parse).
      // Return the URL so we can record it.
      return url;
    }
    await sleep(500); // lighter delay between PDF probes
  }

  // Also try the URL from the diary if present
  if (entry.decisionUrl) {
    const response = await fetchWithRetry(entry.decisionUrl, { retries: 1 });
    if (response) return entry.decisionUrl;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation and extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Convert dnr "740/2024" to normalised case_number "KKV/2024/740". */
function dnrToCaseNumber(dnr: string): string {
  const match = dnr.match(/^(\d+)\/(\d{4})$/);
  if (!match) return `KKV/${dnr.replace(/\//g, "/")}`;
  return `KKV/${match[2]}/${match[1]}`;
}

/** Convert dnr "740/2024" to PDF filename "24-0740.pdf". */
function dnrToPdfFilename(dnr: string): string | null {
  const match = dnr.match(/^(\d+)\/(\d{4})$/);
  if (!match) return null;
  const num = match[1]!.padStart(4, "0");
  const yearShort = match[2]!.slice(2);
  return `${yearShort}-${num}.pdf`;
}

/** Normalise a date string to YYYY-MM-DD. Handles DD.MM.YYYY and YYYY-MM-DD. */
function normaliseDate(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // DD.MM.YYYY or DD-MM-YYYY
  const dmyMatch = trimmed.match(/^(\d{2})[.\-/](\d{2})[.\-/](\d{4})$/);
  if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;

  // YYYY.MM.DD
  const ymdDot = trimmed.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (ymdDot) return `${ymdDot[1]}-${ymdDot[2]}-${ymdDot[3]}`;

  return trimmed; // return as-is if format unknown
}

/** Map Swedish status text to a normalised status string. */
function mapStatus(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("avslut")) return "final";
  if (lower.includes("pågående") || lower.includes("pagaende")) return "ongoing";
  if (lower.includes("överklag") || lower.includes("overklag")) return "appealed";
  if (lower.includes("publicer")) return "final";
  if (lower.includes("inkom")) return "ongoing";
  return "final";
}

/** Classify case type from diary case type text and title. */
function classifyCaseType(
  caseType: string | null,
  title: string,
  category: string,
): string {
  const combined = `${caseType ?? ""} ${title}`.toLowerCase();

  if (category === "merger") return "merger";

  if (
    combined.includes("kartell") ||
    combined.includes("horisontell") ||
    combined.includes("anbudssamarbete") ||
    combined.includes("prissamarbete") ||
    combined.includes("samordnat förfarande") ||
    combined.includes("bid rigging")
  ) {
    return "cartel";
  }

  if (
    combined.includes("missbruk") ||
    combined.includes("dominerande") ||
    combined.includes("abuse")
  ) {
    return "abuse_of_dominance";
  }

  if (
    combined.includes("sektorsundersökning") ||
    combined.includes("marknadsstudie") ||
    combined.includes("marknadsundersökning") ||
    combined.includes("utredning")
  ) {
    return "sector_inquiry";
  }

  if (
    combined.includes("vertikal") ||
    combined.includes("återförsäljning") ||
    combined.includes("selektiv distribution")
  ) {
    return "vertical_restraint";
  }

  return "other";
}

/** Extract a sector from the title or case type text. */
function classifySector(title: string, caseType: string | null): string | null {
  const combined = `${title} ${caseType ?? ""}`.toLowerCase();

  const sectorMap: Array<[string[], string]> = [
    [["dagligvaru", "livsmedel", "mat", "food", "grocery"], "food_retail"],
    [["digital", "plattform", "e-handel", "online", "app"], "digital_economy"],
    [["energi", "el", "gas", "fjärrvärme", "vindkraft"], "energy"],
    [["telekomm", "mobil", "bredband", "tele"], "telecommunications"],
    [["bank", "finans", "betalning", "försäkring"], "financial_services"],
    [["hälso", "sjukvård", "vård", "läkemedel", "apotek", "medicintek"], "healthcare"],
    [["bygg", "entreprenad", "fastighet", "anläggning"], "construction"],
    [["media", "tv", "press", "streaming", "radio"], "media"],
    [["transport", "järnväg", "flyg", "buss", "logistik", "frakt"], "transport"],
    [["jordbruk", "lantbruk", "skog"], "agriculture"],
    [["fordon", "bil", "motor"], "automotive"],
    [["avfall", "återvinning", "miljö"], "waste_environment"],
  ];

  for (const [keywords, sectorId] of sectorMap) {
    if (keywords.some((kw) => combined.includes(kw))) {
      return sectorId;
    }
  }

  return null;
}

/** Extract fine amount from text, looking for Swedish kronor patterns. */
function extractFineAmount(text: string): number | null {
  // "XX miljoner kronor" or "XX 000 000 kr"
  const millionMatch = text.match(
    /(\d[\d\s,.]*)(?:\s+)miljon(?:er)?\s+(?:svenska\s+)?kr(?:onor)?/i,
  );
  if (millionMatch) {
    const num = parseFloat(millionMatch[1]!.replace(/[\s]/g, "").replace(",", "."));
    if (!isNaN(num)) return num * 1_000_000;
  }

  // "XX 000 000 kr"
  const rawMatch = text.match(
    /(\d[\d\s]{2,})\s*kr(?:onor)?/i,
  );
  if (rawMatch) {
    const num = parseInt(rawMatch[1]!.replace(/[\s]/g, ""), 10);
    if (!isNaN(num) && num >= 100_000) return num;
  }

  // "konkurrensskadeavgift om X kr" or "böter om X kr"
  const feeMatch = text.match(
    /(?:konkurrensskadeavgift|företagsbot|böter|sanktionsavgift)\s+(?:om|på|uppgår till)\s+(\d[\d\s,]*)\s*kr/i,
  );
  if (feeMatch) {
    const num = parseInt(feeMatch[1]!.replace(/[\s]/g, ""), 10);
    if (!isNaN(num)) return num;
  }

  return null;
}

/** Extract outcome from body text. */
function extractOutcome(text: string): string | null {
  const lower = text.toLowerCase();

  if (lower.includes("förbjud") || lower.includes("förbud")) return "prohibited";
  if (lower.includes("godkänn") && lower.includes("villkor")) return "cleared_with_conditions";
  if (lower.includes("åtagande") && lower.includes("acceptera")) return "cleared_with_conditions";
  if (lower.includes("konkurrensskadeavgift") || lower.includes("företagsbot") || lower.includes("böter")) return "fine";
  if (lower.includes("godkänn") || lower.includes("lämnas utan åtgärd")) return "cleared";
  if (lower.includes("avskriv") || lower.includes("avsluta")) return "cleared";
  if (lower.includes("fas 1") || lower.includes("fase 1")) return "cleared_phase1";
  if (lower.includes("fas 2") || lower.includes("fase 2") || lower.includes("särskild undersökning")) return "cleared_phase2";

  return null;
}

/** Extract Swedish Competition Law references from text. */
function extractKlArticles(text: string): string[] {
  const refs: Set<string> = new Set();

  // "2 kap. 1 § KL" or "2 kap. 7 § konkurrenslagen"
  const klMatches = text.matchAll(
    /(\d+\s*kap\.\s*\d+\s*§)\s*(?:KL|konkurrenslagen)/gi,
  );
  for (const m of klMatches) {
    refs.add(`${m[1]} KL (2008:579)`);
  }

  // "Artikel 101 FEUF" or "Art. 102 FEUF"
  const feufMatches = text.matchAll(
    /Art(?:ikel)?\.?\s*(\d+)\s*FEUF/gi,
  );
  for (const m of feufMatches) {
    refs.add(`Artikel ${m[1]} FEUF`);
  }

  // "6 kap. 1 § KL" format for sector inquiries
  const chapMatches = text.matchAll(
    /(\d+\s*kap\.\s*\d+\s*§)\s*(?:KL|konkurrenslagen\s*\(\d{4}:\d+\))/gi,
  );
  for (const m of chapMatches) {
    refs.add(`${m[1]} KL (2008:579)`);
  }

  return Array.from(refs);
}

/** Convert a case title to a URL slug (best effort). */
function titleToSlug(title: string): string | null {
  if (!title || title.length < 3) return null;

  return title
    .toLowerCase()
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/é/g, "e")
    .replace(/ü/g, "u")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/** Resolve a potentially relative decision URL from the diary. */
function resolveDecisionUrl(href: string): string {
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `https://information.konkurrensverket.se${href}`;
  return `https://information.konkurrensverket.se/Diariet/${href}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// State persistence (resume support)
// ─────────────────────────────────────────────────────────────────────────────

function loadState(): IngestState {
  if (existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(raw) as IngestState;
    } catch {
      // corrupt state file — start fresh
    }
  }
  return { lastDnr: null, processedDnrs: [], lastRun: new Date().toISOString() };
}

function saveState(state: IngestState): void {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Database operations
// ─────────────────────────────────────────────────────────────────────────────

function openDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function caseExists(db: Database.Database, caseNumber: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM decisions WHERE case_number = ? UNION SELECT 1 FROM mergers WHERE case_number = ?")
    .get(caseNumber, caseNumber);
  return !!row;
}

function insertDecision(db: Database.Database, c: EnrichedCase): void {
  db.prepare(
    `INSERT OR REPLACE INTO decisions
     (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.case_number,
    c.title,
    c.date,
    c.type,
    c.sector,
    c.parties,
    c.summary,
    c.full_text,
    c.outcome,
    c.fine_amount,
    c.kl_articles,
    c.status,
  );
}

function insertMerger(db: Database.Database, c: EnrichedCase): void {
  // For mergers, try to split parties into acquiring/target
  const parties = c.parties ? safeParseJsonArray(c.parties) : [];
  const acquiringParty = parties[0] ?? null;
  const target = parties.length > 1 ? parties.slice(1).join(", ") : null;

  db.prepare(
    `INSERT OR REPLACE INTO mergers
     (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.case_number,
    c.title,
    c.date,
    c.sector,
    acquiringParty,
    target,
    c.summary,
    c.full_text,
    c.outcome,
    null, // turnover — not reliably extractable from public data
  );
}

function updateSectorCounts(db: Database.Database): void {
  // Upsert sectors based on actual data
  const sectorDecisions = db
    .prepare("SELECT sector, COUNT(*) as cnt FROM decisions WHERE sector IS NOT NULL GROUP BY sector")
    .all() as Array<{ sector: string; cnt: number }>;

  const sectorMergers = db
    .prepare("SELECT sector, COUNT(*) as cnt FROM mergers WHERE sector IS NOT NULL GROUP BY sector")
    .all() as Array<{ sector: string; cnt: number }>;

  const sectorNames: Record<string, { name: string; name_en: string; description: string }> = {
    food_retail: { name: "Dagligvaruhandel", name_en: "Food retail", description: "Dagligvaruhandel, livsmedelsbutiker, grossister och leverantörsrelationer i Sverige." },
    digital_economy: { name: "Digital ekonomi", name_en: "Digital economy", description: "Onlineplattformar, digitala marknadsplatser, sökmotorer och app-butiker på den svenska marknaden." },
    energy: { name: "Energi", name_en: "Energy", description: "El- och gasproduktion, transmission, distribution och handel på den svenska energimarknaden." },
    telecommunications: { name: "Telekommunikation", name_en: "Telecommunications", description: "Mobil, bredband, fast telefoni och telekommunikationsinfrastruktur i Sverige." },
    financial_services: { name: "Finansiella tjänster", name_en: "Financial services", description: "Banker, försäkring, betalningslösningar och finansmarknadsinfrastruktur i Sverige." },
    healthcare: { name: "Hälso- och sjukvård", name_en: "Healthcare", description: "Sjukhus, läkemedel, medicinteknik och sjukförsäkring i Sverige." },
    construction: { name: "Byggindustri", name_en: "Construction", description: "Byggmaterial, byggtjänster och fastighetsutveckling i Sverige." },
    media: { name: "Medier", name_en: "Media", description: "Press, television, streamingtjänster och nyhetsmedia i Sverige." },
    transport: { name: "Transport", name_en: "Transport", description: "Järnväg, flyg, busstrafik och logistiktjänster i Sverige." },
    agriculture: { name: "Jordbruk", name_en: "Agriculture", description: "Jordbruk, skogsbruk och lantbruksprodukter i Sverige." },
    automotive: { name: "Fordon", name_en: "Automotive", description: "Fordonsindustri, bilhandel och fordonstjänster i Sverige." },
    waste_environment: { name: "Avfall och miljö", name_en: "Waste & environment", description: "Avfallshantering, återvinning och miljötjänster i Sverige." },
  };

  const allSectors = new Set<string>();
  for (const { sector } of sectorDecisions) allSectors.add(sector);
  for (const { sector } of sectorMergers) allSectors.add(sector);

  const upsert = db.prepare(
    `INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       decision_count = excluded.decision_count,
       merger_count = excluded.merger_count`,
  );

  const decisionMap = Object.fromEntries(sectorDecisions.map((r) => [r.sector, r.cnt]));
  const mergerMap = Object.fromEntries(sectorMergers.map((r) => [r.sector, r.cnt]));

  for (const sectorId of allSectors) {
    const info = sectorNames[sectorId] ?? {
      name: sectorId,
      name_en: sectorId,
      description: "",
    };
    upsert.run(
      sectorId,
      info.name,
      info.name_en,
      info.description,
      decisionMap[sectorId] ?? 0,
      mergerMap[sectorId] ?? 0,
    );
  }
}

function safeParseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // not JSON — treat as single entry
  }
  return [raw];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log("=== Konkurrensverket Ingestion Crawler ===\n");
  console.log(`  Database:   ${DB_PATH}`);
  console.log(`  Years:      ${opts.yearStart}–${opts.yearEnd}`);
  console.log(`  Resume:     ${opts.resume}`);
  console.log(`  Dry run:    ${opts.dryRun}`);
  console.log(`  Force:      ${opts.force}`);
  console.log(`  Limit:      ${opts.limit || "unlimited"}`);
  console.log();

  // ── Database ──────────────────────────────────────────────────────────
  const db = opts.dryRun ? null : openDb(opts.force);
  const state = opts.resume ? loadState() : { lastDnr: null, processedDnrs: [] as string[], lastRun: new Date().toISOString() };
  const processedSet = new Set(state.processedDnrs);

  // ── Phase 1: Discover cases via diary search ──────────────────────────
  console.log("── Phase 1: Diary Discovery ──\n");

  const allEntries: Array<DiaryEntry & { category: string }> = [];

  for (const group of DOSSIER_GROUPS) {
    console.log(`\nSearching dossier group ${group.from}–${group.to} (${group.category})...`);
    const entries = await searchDiary(opts.yearStart, opts.yearEnd, group.from, group.to);
    for (const e of entries) {
      allEntries.push({ ...e, category: group.category });
    }
  }

  console.log(`\nTotal diary entries discovered: ${allEntries.length}`);

  // If the diary search returned nothing (common if the form parameters
  // differ from what we guessed), fall back to crawling known case listing
  // pages via search engine results.
  if (allEntries.length === 0) {
    console.log("\nDiary returned no results. Falling back to case listing crawl...\n");
    const fallbackEntries = await crawlCaseListingFallback(opts.yearStart, opts.yearEnd);
    for (const e of fallbackEntries) {
      allEntries.push(e);
    }
    console.log(`Fallback discovered: ${allEntries.length} cases`);
  }

  // Deduplicate by dnr
  const seen = new Set<string>();
  const uniqueEntries = allEntries.filter((e) => {
    if (seen.has(e.dnr)) return false;
    seen.add(e.dnr);
    return true;
  });

  console.log(`Unique cases after dedup: ${uniqueEntries.length}`);

  // ── Phase 2 & 3: Enrich and insert ───────────────────────────────────
  console.log("\n── Phase 2: Enrich & Insert ──\n");

  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of uniqueEntries) {
    if (opts.limit > 0 && processed >= opts.limit) {
      console.log(`\nReached limit of ${opts.limit} cases. Stopping.`);
      break;
    }

    const caseNumber = dnrToCaseNumber(entry.dnr);

    // Resume support
    if (opts.resume && processedSet.has(entry.dnr)) {
      skipped++;
      continue;
    }

    if (opts.resume && db && caseExists(db, caseNumber)) {
      skipped++;
      processedSet.add(entry.dnr);
      continue;
    }

    processed++;

    const type = classifyCaseType(entry.caseType, entry.title, entry.category);
    const sector = classifySector(entry.title, entry.caseType);
    const isMerger = entry.category === "merger" || type === "merger";

    console.log(
      `[${processed}] ${entry.dnr} — ${entry.title.slice(0, 60)}${entry.title.length > 60 ? "..." : ""}`,
    );

    // Try to fetch HTML detail page
    let summary: string | null = null;
    let fullText: string | null = null;
    let outcome: string | null = null;
    let fineAmount: number | null = null;
    let klArticles: string[] = [];

    const detailHtml = await fetchCaseDetailPage(entry);
    if (detailHtml) {
      const parsed = parseCaseDetailPage(detailHtml);
      summary = parsed.summary;
      fullText = parsed.fullText;
      outcome = parsed.outcome;
      fineAmount = parsed.fineAmount;
      klArticles = parsed.klArticles;
      console.log(`    Detail page: fetched`);
    } else {
      console.log(`    Detail page: unavailable (403 or not found)`);
    }

    await sleep(RATE_LIMIT_MS);

    // Try to find decision PDF
    const pdfUrl = await fetchDecisionPdf(entry);
    if (pdfUrl) {
      console.log(`    Decision PDF: ${pdfUrl}`);
      // If we had no full text from the detail page, note the PDF location
      if (!fullText) {
        fullText = `[Beslut tillgängligt som PDF: ${pdfUrl}]`;
      }
    }

    await sleep(RATE_LIMIT_MS);

    // Build the enriched case record
    if (!fullText) {
      // Minimum content from diary metadata
      fullText = buildMinimalFullText(entry);
    }

    const enriched: EnrichedCase = {
      case_number: caseNumber,
      dnr: entry.dnr,
      title: entry.title,
      date: entry.decisionDate ?? entry.regDate,
      type,
      sector,
      parties: entry.sender ? JSON.stringify([entry.sender]) : null,
      summary,
      full_text: fullText,
      outcome: outcome ?? extractOutcome(fullText),
      fine_amount: fineAmount ?? extractFineAmount(fullText),
      kl_articles: klArticles.length > 0 ? JSON.stringify(klArticles) : null,
      status: entry.status ?? "final",
      source_url: pdfUrl ?? entry.decisionUrl,
      is_merger: isMerger,
    };

    if (opts.dryRun) {
      console.log(`    [dry-run] Would insert as ${isMerger ? "merger" : "decision"}`);
      console.log(`    Type: ${type} | Sector: ${sector ?? "—"} | Status: ${enriched.status}`);
    } else {
      try {
        if (isMerger) {
          insertMerger(db!, enriched);
        } else {
          insertDecision(db!, enriched);
        }
        inserted++;
        processedSet.add(entry.dnr);
        console.log(`    Inserted as ${isMerger ? "merger" : "decision"}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    Insert failed: ${msg}`);
        errors++;
      }
    }

    // Save state periodically (every 25 records)
    if (opts.resume && processed % 25 === 0) {
      state.processedDnrs = Array.from(processedSet);
      state.lastDnr = entry.dnr;
      state.lastRun = new Date().toISOString();
      saveState(state);
    }
  }

  // ── Finalise ──────────────────────────────────────────────────────────

  if (!opts.dryRun && db) {
    console.log("\n── Updating sector counts ──\n");
    updateSectorCounts(db);

    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
    ).cnt;
    const mergerCount = (
      db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }
    ).cnt;
    const sectorCount = (
      db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }
    ).cnt;

    console.log("Database summary:");
    console.log(`  Decisions: ${decisionCount}`);
    console.log(`  Mergers:   ${mergerCount}`);
    console.log(`  Sectors:   ${sectorCount}`);
    db.close();
  }

  // Save final state
  if (opts.resume) {
    state.processedDnrs = Array.from(processedSet);
    state.lastRun = new Date().toISOString();
    saveState(state);
    console.log(`\nState saved to ${STATE_FILE}`);
  }

  console.log(`\n=== Ingestion complete ===`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Inserted:  ${inserted}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Errors:    ${errors}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback: crawl known case listing URLs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When the diary search returns zero results (form parameter mismatch or
 * connectivity), use a static list of known case listing page slugs
 * discovered from search engine results.
 *
 * This is a best-effort fallback. The diary is the preferred source.
 */
async function crawlCaseListingFallback(
  _yearStart: number,
  _yearEnd: number,
): Promise<Array<DiaryEntry & { category: string }>> {
  const entries: Array<DiaryEntry & { category: string }> = [];

  // Known case slugs from search engine indexing.
  // This list is static and should be updated periodically.
  const knownSlugs: Array<{ slug: string; category: string }> = [
    // Mergers
    { slug: "apotekstjanst-sverige-ab-och-svensk-dos-ab", category: "merger" },
    { slug: "euroapotheca-holding-swe-ab-och-oriola-oyj", category: "merger" },
    { slug: "vestum-ab-isodran-ab-och-mdt-markvaruhuset-aktiebolag", category: "merger" },
    { slug: "viaplay-group-jv-holding-ab-och-allente-group-ab", category: "merger" },
    { slug: "EON-Energiinfrastruktur-AB-och-Solor-Bioenergi-Fjarrvarme-AB", category: "merger" },
    { slug: "ardagh-glass-limmared-ab-och-svensk-glasatervinning-aktiebolag", category: "merger" },
    { slug: "buss-i-vast-ab-och-connect-bus-sverige-ab", category: "merger" },
    { slug: "lantmannen-ek-for.-m.fl", category: "merger" },
    // Competition enforcement
    { slug: "teliasonera", category: "competition" },
    { slug: "nasdaq-stockholm-aktiebolag", category: "competition" },
    { slug: "sj-ab2", category: "competition" },
    { slug: "AFAB-m.fl", category: "competition" },
    { slug: "green-cargo-ab", category: "competition" },
    { slug: "generiska-lakemedel", category: "competition" },
    { slug: "apotekstjanster", category: "competition" },
    { slug: "friskvardsportal", category: "competition" },
    { slug: "statistik-om-bostadsforsaljningar", category: "competition" },
  ];

  for (const { slug, category } of knownSlugs) {
    const url = `${CASE_BASE_URL}${slug}/`;
    console.log(`  [fallback] Fetching ${slug}...`);

    const html = await fetchWithRetry(url, { retries: 1 });
    await sleep(RATE_LIMIT_MS);

    if (!html) {
      console.log(`    Unavailable (403/404)`);
      continue;
    }

    const $ = cheerio.load(html);
    const title = $("h1").first().text().trim() || slug.replace(/-/g, " ");

    // Try to extract dnr from the page
    const bodyText = $("main, .main-content, article, body").text();
    const dnrMatch = bodyText.match(/[Dd]nr\s*:?\s*(\d+\/\d{4})/);
    const dnr = dnrMatch ? dnrMatch[1]! : `0/${new Date().getFullYear()}`;

    // Try to extract date
    const dateMatch = bodyText.match(/(\d{4}-\d{2}-\d{2})/);

    entries.push({
      dnr,
      title,
      regDate: dateMatch ? dateMatch[1]! : null,
      decisionDate: null,
      caseType: null,
      status: "final",
      sender: null,
      hasDecisionLink: false,
      decisionUrl: null,
      category,
    });

    console.log(`    Found: ${title} (${dnr})`);
  }

  return entries;
}

/** Build minimal full_text from diary metadata when no detail content is available. */
function buildMinimalFullText(entry: DiaryEntry): string {
  const parts: string[] = [];
  parts.push(`Ärende hos Konkurrensverket.`);
  parts.push(`Diarienummer: ${entry.dnr}.`);
  if (entry.title) parts.push(`Ärendemening: ${entry.title}.`);
  if (entry.caseType) parts.push(`Ärendetyp: ${entry.caseType}.`);
  if (entry.regDate) parts.push(`Registreringsdatum: ${entry.regDate}.`);
  if (entry.sender) parts.push(`Avsändare/mottagare: ${entry.sender}.`);
  if (entry.status) parts.push(`Status: ${entry.status}.`);
  if (entry.decisionUrl) parts.push(`Beslut: ${entry.decisionUrl}`);
  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
