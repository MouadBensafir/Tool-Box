# Tool-Box

Report email construction and sending for the ETAT GPS Fusion workflows:
**3 AXIS**, **EXCES DE VITESSE**, and **FREINAGE**.

Fusion AI keeps every node's output resident in memory for the whole
execution, which becomes a problem once a report has many records — each
with its own screenshot, and now a multi-page PDF holding all of them at
once. This service takes the already-analyzed records for a single email (one
recipient per call — TEMM or one transporteur) and does the memory-heavy
formatting/sending step in a normal Node process instead, where each
record's data is released once it's no longer needed.

## What Fusion still does

Everything analysis-related stays in Fusion: scheduling (cron), auth,
extraction, dedup against the recap, OBC threshold analysis, tachograph
fetch, screenshot capture (Playwright/Browserless), recap building, xlsx
generation (`generate-base64-file`), and the Google Drive update. This
service *only* replaces the final stretch: building the email body, building
the PDF when there's more than one record, and sending via Gmail.

## Contract

**Request** — `POST /send-report`, header `X-API-Key: <SERVICE_API_KEY>` if
configured:

```json
{
  "reportType": "3AXIS | VITESSE | FREINAGE",
  "recipientType": "TEMM | TRANSPORTEUR",
  "groupe": "<transporteur name, only for TRANSPORTEUR>",
  "to": ["recipient@example.com"],
  "hour": "14",
  "isMorningCatchup": false,
  "monthFr": "AOUT",
  "records": [
    {
      "item": { "Description du bien": "...", "Immatriculation": "...", "...": "..." },
      "screenshot": "<base64 JPEG/PNG, or null>",
      "tachoTable": [ { "datetime": "...", "value": 92, "highlighted": true } ]
    }
  ],
  "xlsxAttachment": { "fileName": "recap.xlsx", "base64": "..." }
}
```

`tachoTable` only applies to VITESSE (the tachygraphe-beside-screenshot
layout) — Fusion still does the raw tachograph parsing/windowing/highlight
logic (that's OBC analysis), this service just renders the already-reduced
rows. `xlsxAttachment` can be `null` (FREINAGE never sends one).

**Rules applied to every report type:**
1. Exactly one record → the full block (table + screenshot, + tacho table
   for VITESSE) goes directly in the email body, no PDF.
2. More than one record → the body shows only a summary table; a PDF
   attachment is generated with one page per record (table + screenshot,
   + tacho table for VITESSE).
3. The xlsx attachment (when provided) is always included regardless of
   record count.

**Response**: `{ "success": true, "messageId": "...", "subject": "..." }` or
`{ "success": false, "error": "..." }`.

## Local development

```bash
npm install
cp .env.example .env   # fill in SERVICE_API_KEY + GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN
npm start
```

Run the test suite (pure logic + mocked network calls, no real Gmail send):

```bash
node test.js
```

## Deploying to Railway

This repo (`Tool-Box`, linked to the Railway `tool-box-production` project)
deploys this service directly. Build is Docker-based (see `Dockerfile`);
Railway picks it up automatically on push.

```bash
railway variables set SERVICE_API_KEY=<pick something>
railway variables set GMAIL_CLIENT_ID=<from Fusion's Google Credentials variable>
railway variables set GMAIL_CLIENT_SECRET=<from Fusion's Google Credentials variable>
railway variables set GMAIL_REFRESH_TOKEN=<from Fusion's Google Credentials variable>
railway up
```

Then set `SERVICE_API_KEY` in the `Tool Box.apiKey` variable on each Fusion
workflow (3 AXIS, EXCES DE VITESSE, FREINAGE) so the `X-API-Key` header on
their new `Envoyer Rapport...` http-request nodes matches.

## Known limits

- Records within a single report are processed sequentially when building
  the PDF (not parallelized) — fine at current volumes; can be revisited if
  batch PDF generation becomes slow.
- The PDF layout is hand-drawn with `pdfkit` (no built-in table primitive) —
  it's a reasonable approximation of the email HTML layout, not a pixel-exact
  match. See `pdf-builder.js` if the visual needs tuning.
- Filenames with accented characters in email attachments use a simple
  quoted `Content-Disposition` header rather than full RFC 2231 encoding —
  works with Gmail/most clients in practice, flagged here in case a client
  ever mangles one.
- Screenshot de-duplication (`browserless-capture.js`) is in-memory, scoped
  to a single running instance, with a 30-minute TTL — the same event
  captured for TEMM and for a transporteur (they overlap: a transporteur's
  records are a subset of TEMM's) is only bought from Browserless once,
  including when both calls are genuinely concurrent. This only holds as
  long as Tool-Box runs as a single instance without restarting mid-run,
  which matches how it's deployed today; if it's ever horizontally scaled,
  the cache would need to move to something shared (Redis) to keep working
  across instances.
