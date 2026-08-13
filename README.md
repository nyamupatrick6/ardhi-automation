# Ardhi AI Automation

Automated content pipeline: topic sourcing -> script/deck generation -> video rendering -> publishing,
with WhatsApp approval gates at each checkpoint.

## Status

**Built so far:**
- [x] `data/sources.json` - official platforms + Facebook pages Ardhi AI already follows (verified live)
- [x] `data/series-backlog.json` - the 8-part fraud/due-diligence series + standalone topic backlog
- [x] `scripts/source-topics.js` - daily topic discovery via Google News (Facebook itself isn't scraped
      directly - that breaks Meta's terms - Google News reliably indexes coverage of what these
      official bodies announce, usually within hours)
- [x] `.github/workflows/source-topics.yml` - runs the sourcing script daily at 05:00 EAT
- [x] `templates/shell-v19.html` - the real master template, with real embedded background video/music
      and narration recording (confirmed valid, not placeholder data)
- [x] `scripts/generate-deck.js` - drafts the slide script via the Claude API (6-12 content slides,
      decided per-topic) and clones the shell's content-slide block to fit. CTA + branding slides are
      copied through untouched. See "How deck generation works" below.

**Not built yet:**
- [ ] `scripts/render-video.js` - headless Playwright recording (Presentation + Reel modes)
- [ ] `scripts/notify-whatsapp.js` - WhatsApp Cloud API checkpoint messages + approval read-back
- [ ] `scripts/publish.js` - YouTube + Facebook + Instagram publishing

## Setup (one-time)

1. Create a new **private** GitHub repo and push this folder to it.
2. The sourcing workflow needs no secrets to run - it's live once pushed.
3. To run `generate-deck.js`, add `ANTHROPIC_API_KEY` as a repo secret
   (Settings -> Secrets and variables -> Actions -> New repository secret).
   Locally, set it as an environment variable instead.
4. Later stages (WhatsApp, YouTube, FB/IG) will need their own repo secrets.
   Guidance provided when we build those scripts.

## How deck generation works

`node scripts/generate-deck.js --topic-id=<id>` (an id from `state/pending-topics.json`),
or `node scripts/generate-deck.js --title="..." --summary="..."` for a manual/ad-hoc topic
outside the sourcing pipeline.

1. Sends the topic to the Claude API with Ardhi AI's voice and structure rules, asking for
   JSON: a cover title/subtitle and 6-12 content slides (however many the story needs),
   each with a title, body copy, and both long-form and short/reel narration.
2. Clones the shell's content-slide block once per drafted slide, fills in the placeholders,
   and inserts them between the cover and the CTA slide. The CTA and final branding slides
   are copied through completely untouched - contact details and the branding
   white-background fix are already correct in `templates/shell-v19.html`.
3. Writes the finished, self-contained deck to `decks/<slug>.html` (not committed to git -
   see `.gitignore` - these are ~13MB+ each; `render-video.js` will turn them into much
   smaller MP4s, which are the things actually worth keeping in git long-term).
4. Logs the result to `state/drafted-topics.json`.

## How topic sourcing works

Every day at 05:00 EAT, GitHub Actions runs `scripts/source-topics.js`, which:

1. Builds search queries from every source in `data/sources.json` plus the evergreen watch terms
   in `data/series-backlog.json`
2. Pulls each query's Google News RSS feed
3. Keeps items from the last 48 hours, skipping anything already seen (tracked in `state/seen-topics.json`)
4. Scores each new item against the 8-part series backlog and standalone topics
5. Writes everything to `state/pending-topics.json`, sorted by relevance score

`state/pending-topics.json` is what the WhatsApp bot will read from once the notify step is built -
that's the next piece.
