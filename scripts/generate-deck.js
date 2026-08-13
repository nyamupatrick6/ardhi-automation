#!/usr/bin/env node
/**
 * Ardhi AI - Deck Generator
 *
 * Takes an approved topic and turns it into a finished, self-contained
 * v19 deck: drafts the slide-by-slide script via the Claude API, then
 * duplicates the shell template's content-slide block to fit however many
 * slides the story actually needs (6-12, decided by the model per topic).
 *
 * The shell (templates/shell-v19.html) has 4 slides: Cover, Content
 * (example - this is the block that gets cloned), CTA, Final Branding.
 * CTA and Branding are copied through untouched - contact details and the
 * branding white-background fix are already correct in the shell, so
 * nothing there should ever need to change per-deck.
 *
 * Usage:
 *   node scripts/generate-deck.js --topic-id=<id>
 *     Looks up the topic by id in state/pending-topics.json.
 *
 *   node scripts/generate-deck.js --title="..." --summary="..." [--link="..."]
 *     Manual/ad-hoc topic, skipping the sourcing pipeline entirely.
 *
 * Requires ANTHROPIC_API_KEY in the environment (repo secret in Actions).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHELL_PATH = path.join(ROOT, "templates", "shell-v19.html");
const PENDING_PATH = path.join(ROOT, "state", "pending-topics.json");
const DRAFTED_PATH = path.join(ROOT, "state", "drafted-topics.json");
const DECKS_DIR = path.join(ROOT, "decks");

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const MIN_SLIDES = 6;
const MAX_SLIDES = 12;

// ---------- small helpers ----------

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

function slugify(title) {
  return String(title || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

// ---------- topic resolution ----------

function resolveTopic(args) {
  if (args["topic-id"]) {
    const pending = loadJSON(PENDING_PATH, { candidates: [] });
    const found = pending.candidates.find((c) => c.id === args["topic-id"]);
    if (!found) {
      throw new Error(`No topic with id "${args["topic-id"]}" in state/pending-topics.json`);
    }
    return {
      id: found.id,
      title: found.title,
      summary: found.title, // RSS items only carry a headline, not a body - the model works from this + link
      link: found.link,
      sourceName: found.sourceName,
      backlogMatches: found.backlogMatches || []
    };
  }

  if (args.title) {
    return {
      id: `manual_${Date.now()}`,
      title: args.title,
      summary: args.summary || args.title,
      link: args.link || "",
      sourceName: "manual",
      backlogMatches: []
    };
  }

  throw new Error("Provide --topic-id=<id> or --title=\"...\" (see file header for usage).");
}

// ---------- Claude API: draft the slide script ----------

async function draftScript(topic) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in the environment.");

  const backlogContext = topic.backlogMatches.length
    ? topic.backlogMatches
        .map((m) => m.seriesPartTitle || m.standaloneTitle)
        .filter(Boolean)
        .join(", ")
    : "none matched - treat as a standalone topic";

  const systemPrompt = `You are drafting the script for one Ardhi AI presentation deck.

Ardhi AI is a Kenya-based AI-powered land verification, surveying, and geospatial platform. Its mission is educating Kenyan landowners about land fraud, registry corruption, boundary disputes, and illegal land-taking, while positioning Ardhi AI as the trusted solution.

Deck structure you are drafting for:
- A cover slide (title + one-line subtitle/hook)
- Between ${MIN_SLIDES} and ${MAX_SLIDES} content slides, however many the story genuinely needs - don't pad or compress artificially
- A CTA slide and final branding slide already exist in the shell and are NOT part of your output

Voice and rules:
- Educational content first. Do not write pitch/CTA copy - that slide is static and already built.
- The last content slide should land the point in a way that naturally sets up "here's what to do about it," without itself pitching Ardhi AI.
- Bold, clear titles. Paragraph body copy, no slide numbering anywhere.
- Any statistic or figure must be defensible. If you're not certain of an exact figure, use qualifying language ("many," "a significant share") instead of inventing a specific number or percentage.
- Narration: write both a long version (2-3 natural sentences, for the full presentation mode) and a short version (one punchy line, for the reel/short-form mode) for every slide including the cover.

Respond with ONLY valid JSON, no markdown fences, no preamble, matching exactly this shape:
{
  "deck_title": "string - short cover title",
  "cover_subtitle": "string - one-line hook",
  "cover_narration_long": "string",
  "cover_narration_short": "string",
  "slides": [
    {
      "eyebrow": "string - short section label",
      "title": "string - slide headline",
      "body": "string - 1-3 sentence paragraph",
      "narration_long": "string",
      "narration_short": "string"
    }
  ]
}`;

  const userPrompt = `Topic: ${topic.title}
Summary/context: ${topic.summary}
Source: ${topic.sourceName || "unknown"}${topic.link ? ` (${topic.link})` : ""}
Related Ardhi AI series angle(s): ${backlogContext}

Draft the full deck script now.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude API returned no text content block.");

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Claude's JSON output: ${err.message}\n---\n${cleaned}`);
  }

  if (!Array.isArray(parsed.slides) || parsed.slides.length < 1) {
    throw new Error("Claude's output had no usable slides array.");
  }
  if (parsed.slides.length > MAX_SLIDES) {
    parsed.slides = parsed.slides.slice(0, MAX_SLIDES);
  }

  return parsed;
}

// ---------- shell surgery ----------

function extractBetween(text, startMarker, endMarker) {
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Could not locate expected markers in shell template:\n  start: ${startMarker}\n  end: ${endMarker}`);
  }
  return { startIdx, endIdx, block: text.slice(startIdx, endIdx) };
}

function buildCoverSlide(shellText, script) {
  const { block } = extractBetween(
    shellText,
    '<!-- ================= SLIDE 1: COVER ================= -->',
    '<!-- ================= SLIDE 2: CONTENT (example) ================= -->'
  );

  return block
    .replace(
      'data-narration-long="Welcome to Ardhi AI, Kenya\'s trusted AI-powered surveying and geospatial platform. This presentation walks through everything you need to know about this topic, backed by real legal precedent and practical verification steps."',
      `data-narration-long="${escapeAttr(script.cover_narration_long)}"`
    )
    .replace(
      'data-narration-short="Welcome to Ardhi AI — Kenya\'s trusted AI-powered surveying and geospatial platform."',
      `data-narration-short="${escapeAttr(script.cover_narration_short)}"`
    )
    .replace("[ TOPIC TITLE GOES HERE ]", escapeHtml(script.deck_title))
    .replace("[ One-line subtitle / hook for this slide's topic ]", escapeHtml(script.cover_subtitle));
}

function buildContentSlideTemplate(shellText) {
  const { block } = extractBetween(
    shellText,
    '<!-- ================= SLIDE 2: CONTENT (example) ================= -->',
    '<!-- ================= SLIDE 3: CTA ================= -->'
  );
  return block;
}

function fillContentSlide(templateBlock, slideData, index) {
  return templateBlock
    .replace(
      'data-narration-long="This is where the long-form narration for this content slide goes — written to sound natural when read aloud, covering the full point of the slide in two to three sentences."',
      `data-narration-long="${escapeAttr(slideData.narration_long)}"`
    )
    .replace(
      'data-narration-short="This is the short, punchy reel version of the same point."',
      `data-narration-short="${escapeAttr(slideData.narration_short)}"`
    )
    .replace('data-slide="2"', `data-slide="${index}"`)
    .replace(">Section Label<", `>${escapeHtml(slideData.eyebrow)}<`)
    .replace("[ Content Slide Headline ]", escapeHtml(slideData.title))
    .replace(
      "[ Supporting body copy for this slide — statute references, statistics, or explanation go here. ]",
      escapeHtml(slideData.body)
    );
}

function patchStaleComments(text) {
  return text
    .replace("Ardhi AI — Presentation Template (v18)", "Ardhi AI — Presentation Template (v19)")
    .replace(
      "Currently empty —\n          drop the base64 data URIs in once the master file is provided.",
      "Populated below with Ardhi AI's default background video/music."
    );
}

function assembleDeck(shellText, script) {
  const n = script.slides.length;

  const cover = buildCoverSlide(shellText, script);
  const contentTemplate = buildContentSlideTemplate(shellText);
  const contentSlides = script.slides
    .map((s, i) => fillContentSlide(contentTemplate, s, i + 2))
    .join("\n\n");

  const ctaBlock = extractBetween(
    shellText,
    '<!-- ================= SLIDE 3: CTA ================= -->',
    '<!-- ================= SLIDE 4: FINAL BRANDING ================= -->'
  ).block.replace('data-slide="3"', `data-slide="${n + 2}"`);

  const brandingEndMarker = '<!-- Tap / fullscreen zones -->';
  const brandingBlock = extractBetween(
    shellText,
    '<!-- ================= SLIDE 4: FINAL BRANDING ================= -->',
    brandingEndMarker
  ).block.replace('data-slide="4"', `data-slide="${n + 3}"`);

  const head = shellText.slice(0, shellText.indexOf('<!-- ================= SLIDE 1: COVER ================= -->'));
  const tail = shellText.slice(shellText.indexOf(brandingEndMarker));

  const assembled = head + cover + "\n\n" + contentSlides + "\n\n" + ctaBlock + brandingBlock + tail;
  return patchStaleComments(assembled);
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv);
  const topic = resolveTopic(args);

  console.log(`Drafting script for: ${topic.title}`);
  const script = await draftScript(topic);
  console.log(`  -> "${script.deck_title}" with ${script.slides.length} content slides`);

  if (!fs.existsSync(SHELL_PATH)) {
    throw new Error(`Shell template not found at ${SHELL_PATH}. Expected templates/shell-v19.html.`);
  }
  const shellText = fs.readFileSync(SHELL_PATH, "utf8");

  console.log("Assembling deck from shell template...");
  const deckHtml = assembleDeck(shellText, script);

  fs.mkdirSync(DECKS_DIR, { recursive: true });
  const filename = `${slugify(script.deck_title)}.html`;
  const outPath = path.join(DECKS_DIR, filename);
  fs.writeFileSync(outPath, deckHtml);

  const drafted = loadJSON(DRAFTED_PATH, { decks: [] });
  drafted.decks.push({
    topicId: topic.id,
    deckTitle: script.deck_title,
    slideCount: script.slides.length + 4, // + cover, cta, branding... content slides already counted
    file: `decks/${filename}`,
    draftedAt: new Date().toISOString()
  });
  saveJSON(DRAFTED_PATH, drafted);

  console.log(`\nDone. Deck written to decks/${filename}`);
  console.log(`Total slides: ${script.slides.length + 3} (cover + ${script.slides.length} content + CTA + branding)`);
}

main().catch((err) => {
  console.error("Fatal error in generate-deck.js:", err.message);
  process.exit(1);
});
