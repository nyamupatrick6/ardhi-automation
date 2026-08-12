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

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function buildQueries(sources, backlog) {
  const queries = [];

  for (const platform of sources.official_platforms || []) {
    queries.push({ q: `${platform.name} Kenya`, origin: platform.name, originType: "official_platform" });
  }

  for (const page of sources.facebook_pages || []) {
    queries.push({ q: `${page.name} Kenya`, origin: page.name, originType: "facebook_page" });
  }

  for (const term of backlog.evergreen_watch_terms || []) {
    queries.push({ q: term, origin: "evergreen_watch_term", originType: "evergreen" });
  }

  return queries;
}

async function fetchGoogleNewsRSS(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-KE&gl=KE&ceid=KE:en`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ArdhiAI-Sourcing/1.0)" }
  });
  if (!res.ok) {
    console.warn(`  [warn] fetch failed for "${query}": ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
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

      const backlogMatches = scoreAgainstBacklog(title, backlog);

      candidates.push({
        id,
        title,
        link,
        pubDate,
        sourceName,
        discoveredVia: { query: q, origin, originType },
        backlogMatches,
        score: backlogMatches.reduce((sum, m) => sum + m.weight, 0)
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
  const scored = candidates.filter((c) => c.score > 0);
  console.log(`${scored.length} matched a backlog series part or standalone topic directly.`);
}

main().catch((err) => {
  console.error("Fatal error in source-topics.js:", err);
  process.exit(1);
});
