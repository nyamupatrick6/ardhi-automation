#!/usr/bin/env node
/**
 * Ardhi AI - Topic Sourcing
 *
 * Discovery layer for new content topics. Facebook's own pages can't be
 * scraped directly without API access (and won't be - that's against
 * Meta's terms). Instead this uses Google News as the discovery layer:
 * it reliably indexes press coverage of what NLC, Ardhisasa, the Ministry
 * of Lands, etc. announce or post, usually within hours.
 *
 * Flow:
 *   1. Build search queries from data/sources.json + evergreen watch terms
 *   2. Pull each query's Google News RSS feed
 *   3. Filter to the last 48h, dedupe against state/seen-topics.json
 *   4. Score each candidate against data/series-backlog.json keywords
 *   5. Write scored candidates to state/pending-topics.json for approval
 *
 * Run: node scripts/source-topics.js
 */

const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const ROOT = path.join(__dirname, "..");
const SOURCES_PATH = path.join(ROOT, "data", "sources.json");
const BACKLOG_PATH = path.join(ROOT, "data", "series-backlog.json");
const SEEN_PATH = path.join(ROOT, "state", "seen-topics.json");
const PENDING_PATH = path.join(ROOT, "state", "pending-topics.json");

const LOOKBACK_HOURS = 48; // buffer beyond the 24h cadence to catch anything missed
const MAX_ITEMS_PER_QUERY = 8;

// Used to scope generic news-outlet queries down to their land coverage
// specifically. Without this, a query like "Citizen Digital Kenya" just
// returns whatever that outlet published most recently - music festivals,
// weather, politics, anything - drowning out the land stories we actually
// want. Government/judiciary bodies (NLC, Ardhisasa, CAJ, Kenya Law) don't
// get this filter: their org name alone is already a specific-enough query,
// since (almost) everything they publish is inherently land/land-adjacent.
const LAND_QUERY_TERMS = [
  "land", "title deed", "Ardhisasa", "NLC", "land fraud", "land dispute",
  "eviction", "land grab", "surveyor", "compulsory acquisition", "land compensation"
];
const LAND_QUERY_FILTER = `(${LAND_QUERY_TERMS.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" OR ")})`;

function extractDomain(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  const raw = fs.readFileSync(p, "utf8");
  if (!raw || raw.trim().length === 0) {
    console.warn(`  [warn] ${p} is empty or missing content - using fallback instead of crashing`);
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`  [warn] ${p} contains invalid JSON (${err.message}) - using fallback instead of crashing`);
    return fallback;
  }
}

function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function buildQueries(sources, backlog) {
  const queries = [];

  for (const platform of sources.official_platforms || []) {
    if (platform.type === "news") {
      // Generic news outlet - scope the query to its land coverage via a
      // site: filter, rather than searching the outlet's name (which just
      // returns everything they publish, land-related or not).
      const domain = extractDomain(platform.url);
      if (domain) {
        queries.push({
          q: `site:${domain} ${LAND_QUERY_FILTER}`,
          origin: platform.name,
          originType: "official_platform"
        });
        continue;
      }
      // Fall through to the name-based query below if no usable domain was found.
    }
    // Government/judiciary bodies: their own name is already a specific,
    // targeted query - no site: filter needed.
    queries.push({ q: `${platform.name} Kenya`, origin: platform.name, originType: "official_platform" });
  }

  for (const page of sources.facebook_pages || []) {
    queries.push({ q: `${page.name} Kenya`, origin: page.name, originType: "facebook_page" });
  }

  // Social platforms (X, YouTube, TikTok, LinkedIn) can't be scraped directly
  // without paid API access, and doing so would break each platform's terms
  // of service. Same proxy pattern as facebook_pages above: Google News
  // indexes news coverage that reports on or embeds posts from these
  // platforms, usually within hours of something going viral or official.
  for (const platform of sources.social_platforms || []) {
    queries.push({
      q: `Kenya land ${platform.search_filter}`,
      origin: platform.name,
      originType: "social_platform"
    });
  }

  for (const term of backlog.evergreen_watch_terms || []) {
    const anchored = /kenya/i.test(term) ? term : `${term} Kenya`;
    queries.push({ q: anchored, origin: "evergreen_watch_term", originType: "evergreen" });
  }

  for (const term of backlog.general_land_watch_terms || []) {
    const anchored = /kenya/i.test(term) ? term : `${term} Kenya`;
    queries.push({ q: anchored, origin: "general_land_watch_term", originType: "general_land" });
  }

  return queries;
}

async function fetchGoogleNewsRSS(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-KE&gl=KE&ceid=KE:en`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
  });
  if (!res.ok) {
    console.warn(`  [warn] fetch failed for "${query}": HTTP ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item;
  if (!items) {
    // Diagnostic: something came back with HTTP 200 but no parseable items.
    // Could be a genuinely empty result set, or Google serving a non-RSS
    // response (rate-limit/consent page) that still returns 200.
    console.warn(`  [diag] no items parsed for "${query}". Response length: ${xml.length}. First 200 chars: ${xml.slice(0, 200).replace(/\n/g, " ")}`);
    return [];
  }
  return Array.isArray(items) ? items : [items];
}

// Reddit publishes genuine public search feeds - no auth, no API key, and
// fully within Reddit's terms (this is the documented RSS/Atom endpoint,
// not scraping). Returns Atom <entry> items, not RSS 2.0 <item> like the
// Google News feed, so it needs its own light parsing.
async function fetchRedditRSS(subreddit, query) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=25`;
  const res = await fetch(url, {
    headers: { "User-Agent": "ardhi-ai-topic-sourcing/1.0 (contact: ardhiai.kenya@gmail.com)" }
  });
  if (!res.ok) {
    console.warn(`  [warn] reddit fetch failed for r/${subreddit} "${query}": HTTP ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const parsed = parser.parse(xml);
  const entries = parsed?.feed?.entry;
  if (!entries) return [];
  const list = Array.isArray(entries) ? entries : [entries];
  return list.map((e) => ({
    title: e.title || "",
    link: e.link?.["@_href"] || e.id || "",
    pubDate: e.published || e.updated || "",
    sourceName: `r/${subreddit}`
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withinLookback(pubDateStr, hours) {
  const pubDate = new Date(pubDateStr);
  if (isNaN(pubDate.getTime())) return true; // if unparsable, don't drop it silently
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return pubDate.getTime() >= cutoff;
}

function scoreAgainstBacklog(text, backlog) {
  const lower = text.toLowerCase();
  const matches = [];

  for (const part of backlog.series.parts) {
    const hits = part.keywords.filter((kw) => lower.includes(kw.toLowerCase()));
    if (hits.length > 0) {
      matches.push({ seriesPartId: part.id, seriesPartTitle: part.title, matchedKeywords: hits, weight: hits.length });
    }
  }

  for (const standalone of backlog.standalone_backlog || []) {
    const hits = standalone.keywords.filter((kw) => lower.includes(kw.toLowerCase()));
    if (hits.length > 0) {
      matches.push({ standaloneTitle: standalone.title, matchedKeywords: hits, weight: hits.length });
    }
  }

  return matches;
}

const KENYA_SIGNALS = [
  "kenya", "nairobi", "mombasa", "kisumu", "kiambu", "nakuru", "murang'a", "muranga",
  "machakos", "isolo", "isiolo", "county", "ardhisasa", "nlc", "ardhi house"
];

function isKenyaRelevant(candidate) {
  const haystack = `${candidate.title} ${candidate.sourceName}`.toLowerCase();
  return KENYA_SIGNALS.some((signal) => haystack.includes(signal));
}

const LAND_CONFLICT_SIGNAL_WORDS = [
  "dispute", "disputed", "grab", "grabbed", "grabbing", "demolition", "demolished",
  "evict", "eviction", "fraud", "forged", "fake", "illegal", "cartel", "invasion",
  "encroach", "encroachment", "boundary", "titles", "title deed", "war", "wars",
  "compensation", "displaced", "squatter", "squatters"
];

function hasLandConflictSignal(title) {
  const lower = title.toLowerCase();
  if (!lower.includes("land")) return false;
  return LAND_CONFLICT_SIGNAL_WORDS.some((w) => lower.includes(w));
}

function stableId(link, title) {
  const base = link || title || "";
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = (hash << 5) - hash + base.charCodeAt(i);
    hash |= 0;
  }
  return `t_${Math.abs(hash)}`;
}

async function main() {
  const sources = loadJSON(SOURCES_PATH, { official_platforms: [], facebook_pages: [] });
  const backlog = loadJSON(BACKLOG_PATH, { series: { parts: [] }, standalone_backlog: [], evergreen_watch_terms: [] });
  const seen = loadJSON(SEEN_PATH, { ids: [] });
  const seenSet = new Set(seen.ids);

  const queries = buildQueries(sources, backlog);
  console.log(`Running ${queries.length} source queries (lookback: ${LOOKBACK_HOURS}h)...\n`);

  const candidates = [];

  for (const { q, origin, originType } of queries) {
    console.log(`- ${q}`);
    let items = [];
    try {
      items = await fetchGoogleNewsRSS(q);
    } catch (err) {
      console.warn(`  [warn] error fetching "${q}": ${err.message}`);
      continue;
    } finally {
      await sleep(500); // space out requests so we don't look like a bot flood
    }

    let kept = 0;
    for (const item of items.slice(0, MAX_ITEMS_PER_QUERY)) {
      const title = item.title || "";
      const link = item.link || "";
      const pubDate = item.pubDate || "";
      const sourceName = item?.source?.["#text"] || item?.source || "";

      if (!withinLookback(pubDate, LOOKBACK_HOURS)) continue;

      const id = stableId(link, title);
      if (seenSet.has(id)) continue;

      const candidate = { title, sourceName };
      if ((originType === "evergreen" || originType === "general_land") && !isKenyaRelevant(candidate)) {
        seenSet.add(id); // still mark as seen so it doesn't get re-checked every day
        continue;
      }

      const backlogMatches = scoreAgainstBacklog(title, backlog);
      const isGeneralLandStory = originType === "general_land";
      const hasSignal = hasLandConflictSignal(title);
      // Relevance bonus applies if it came from a broad general-land query OR if the
      // headline itself shows land+conflict signal words, regardless of exact keyword
      // phrasing or which query surfaced it (e.g. "land war" vs backlog's "land wars").
      const relevanceBonus = (isGeneralLandStory || hasSignal) ? 1 : 0;
      const score = backlogMatches.reduce((sum, m) => sum + m.weight, 0) + relevanceBonus;

      candidates.push({
        id,
        title,
        link,
        pubDate,
        discoveredAt: new Date().toISOString(),
        sourceName,
        discoveredVia: { query: q, origin, originType },
        backlogMatches,
        isGeneralLandStory,
        hasLandConflictSignal: hasSignal,
        score
      });

      seenSet.add(id);
      kept++;
    }
    console.log(`  -> ${kept} new item(s)`);
  }

  // Reddit: direct integration via public search RSS (see fetchRedditRSS).
  for (const watch of sources.reddit_watch || []) {
    const label = `r/${watch.subreddit} "${watch.query}"`;
    console.log(`- ${label}`);
    let items = [];
    try {
      items = await fetchRedditRSS(watch.subreddit, watch.query);
    } catch (err) {
      console.warn(`  [warn] error fetching ${label}: ${err.message}`);
      continue;
    } finally {
      await sleep(500);
    }

    let kept = 0;
    for (const item of items.slice(0, MAX_ITEMS_PER_QUERY)) {
      const { title, link, pubDate, sourceName } = item;
      if (!withinLookback(pubDate, LOOKBACK_HOURS)) continue;

      const id = stableId(link, title);
      if (seenSet.has(id)) continue;

      const backlogMatches = scoreAgainstBacklog(title, backlog);
      const hasSignal = hasLandConflictSignal(title);
      const relevanceBonus = hasSignal ? 1 : 0;
      const score = backlogMatches.reduce((sum, m) => sum + m.weight, 0) + relevanceBonus;

      candidates.push({
        id,
        title,
        link,
        pubDate,
        discoveredAt: new Date().toISOString(),
        sourceName,
        discoveredVia: { query: watch.query, origin: `r/${watch.subreddit}`, originType: "reddit" },
        backlogMatches,
        isGeneralLandStory: false,
        hasLandConflictSignal: hasSignal,
        score
      });

      seenSet.add(id);
      kept++;
    }
    console.log(`  -> ${kept} new item(s)`);
  }

  candidates.sort((a, b) => b.score - a.score);

  const pending = loadJSON(PENDING_PATH, { generatedAt: null, candidates: [] });
  const merged = [...candidates, ...pending.candidates];

  saveJSON(PENDING_PATH, { generatedAt: new Date().toISOString(), candidates: merged });
  saveJSON(SEEN_PATH, { ids: Array.from(seenSet) });

  console.log(`\nDone. ${candidates.length} new candidate(s) added to state/pending-topics.json.`);
  const backlogScored = candidates.filter((c) => !c.isGeneralLandStory && c.score > 0);
  const generalLand = candidates.filter((c) => c.isGeneralLandStory);
  const fromSocial = candidates.filter((c) => c.discoveredVia?.originType === "social_platform");
  const fromReddit = candidates.filter((c) => c.discoveredVia?.originType === "reddit");
  console.log(`${backlogScored.length} matched a backlog series part or standalone topic directly.`);
  console.log(`${generalLand.length} are general Kenya land stories outside the current 8-part series.`);
  console.log(`${fromSocial.length} surfaced via social platform coverage (X/YouTube/TikTok/LinkedIn, proxied through Google News).`);
  console.log(`${fromReddit.length} surfaced directly from Reddit.`);
}

main().catch((err) => {
  console.error("Fatal error in source-topics.js:", err);
  process.exit(1);
});
