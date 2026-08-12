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

Every day at 05:00 EAT, GitHub Actions runs `scripts/source-topics.js`, which:

1. Builds search queries from every source in `data/sources.json` plus the evergreen watch terms
   in `data/series-backlog.json`
2. Pulls each query's Google News RSS feed
3. Keeps items from the last 48 hours, skipping anything already seen (tracked in `state/seen-topics.json`)
4. Scores each new item against the 8-part series backlog and standalone topics
5. Writes everything to `state/pending-topics.json`, sorted by relevance score

`state/pending-topics.json` is what the WhatsApp bot will read from once the notify step is built -
that's the next piece.
