# Ardhi AI Automation

Automated content pipeline: topic sourcing -> script/deck generation -> video rendering -> publishing,
with WhatsApp approval gates at each checkpoint.

## Status

**Built so far:**
- [x] `data/sources.json` - official platforms, Facebook pages Ardhi AI follows, X/YouTube/TikTok/LinkedIn
      coverage, and Reddit watch terms (verified live)
- [x] `data/series-backlog.json` - the 8-part fraud/due-diligence series + standalone topic backlog
- [x] `scripts/source-topics.js` - continuous topic discovery via Google News (for news sites, Facebook,
      and X/YouTube/TikTok/LinkedIn - none of these platforms are scraped directly, since that breaks
      each one's terms of service; Google News reliably indexes coverage of what gets posted/announced,
      usually within hours) plus a direct integration with Reddit's public search RSS feed
- [x] `.github/workflows/source-topics.yml` - runs the sourcing script continuously, every 20 minutes,
      all day - no fixed daily check time
- [x] `docs/index.html` (Field Desk dashboard) - re-fetches the latest `state/pending-topics.json` fresh
      on every page load, so reloading the page always pulls whatever the last automated run found.
      Every item shows both when it was originally published and when the pipeline discovered it.

**Not built yet:**
- [ ] `scripts/generate-deck.js` - draft scripts + fill the v16 shell template
- [ ] `scripts/render-video.js` - headless Playwright recording (Presentation + Reel modes)
- [ ] `scripts/notify-whatsapp.js` - WhatsApp Cloud API checkpoint messages + approval read-back
- [ ] `scripts/publish.js` - YouTube + Facebook + Instagram publishing
- [ ] `templates/shell-v16.html` - needs to be copied in from the existing template

## Setup (one-time)

1. Create a new **private** GitHub repo and push this folder to it.
2. The sourcing workflow needs no secrets to run - it's live once pushed.
3. Later stages (WhatsApp, YouTube, FB/IG) will need repo secrets added under
   Settings -> Secrets and variables -> Actions. Guidance provided when we build those scripts.

## How topic sourcing works

Every 20 minutes, all day, every day (no fixed check time), GitHub Actions runs `scripts/source-topics.js`, which:

1. Builds search queries from every source in `data/sources.json` - official platforms, Facebook pages,
   X/YouTube/TikTok/LinkedIn (via a `site:` filter on Google News), and Reddit - plus the evergreen
   watch terms in `data/series-backlog.json`
2. Pulls each Google News query's RSS feed, and separately pulls Reddit's own public search RSS feed
   directly for each `reddit_watch` entry
3. Keeps items from the last 48 hours, skipping anything already seen (tracked in `state/seen-topics.json`)
4. Scores each new item against the 8-part series backlog and standalone topics
5. Writes everything to `state/pending-topics.json`, sorted by relevance score - each item carries both
   `pubDate` (when it was originally posted/published) and `discoveredAt` (when this pipeline found it)

`state/pending-topics.json` is what the WhatsApp bot will read from once the notify step is built -
that's the next piece. It's also what `docs/index.html` reads from on every page load - open or
refresh the dashboard and it always shows the latest committed run, no separate trigger needed.

**On platform coverage:** X, YouTube, TikTok, and LinkedIn don't offer a free, terms-compliant way to
pull posts directly (same reason Facebook isn't scraped directly). They're covered the same way as
Facebook: through Google News, which indexes press coverage that reports on or embeds posts from these
platforms - not a live firehose of every post, but a reliable within-hours signal for anything that
becomes newsworthy. Reddit is the one platform with a genuine public RSS feed, so that's a direct
integration with no proxy involved.
