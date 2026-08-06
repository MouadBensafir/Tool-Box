# VITESSE violation processor

External replacement for the per-violation loop in the EXCES DE VITESSE Fusion
workflow (tachograph + positions fetch, OBC threshold/anomaly analysis,
screenshot capture). Exists because Fusion AI keeps every node's output
resident in memory for the whole execution, which crashes the workflow on
large batches (300+ recap rows, 10+ screenshots held at once). This service
runs the same logic in a normal Node process, where each violation's data is
garbage-collected once it's processed instead of accumulating for the whole
run.

Replaces the old `tool-box-production` Railway app (obsolete).

## What Fusion still does

Scheduling (cron), authentication, extraction, dedup against the recap,
recap building, xlsx attachment generation, and sending the email all stay in
Fusion. This service *only* replaces the loop that currently runs through
`Tachigraphe` → `Analyse OBC` → `If-Else` → `Playwright Script` →
`Browserless` → `Préparation Bloc Email` per violation.

## Contract

**Request** — `POST /process-violations`, header `X-API-Key: <SERVICE_API_KEY>`
if configured:

```json
{
  "authToken": "<raw Mix Telematics AuthToken, from Fusion's own Authentification node>",
  "violations": [ { "Description du bien": "...", "Immatriculation": "...", "ID du véhicule": "...", "ID du site": "...", "Groupe": "...", "Conducteur": "...", "Description de l'événement": "...", "Date de départ": "...", "Heure de départ": "...", "Date de fin": "...", "Heure de fin": "...", "...": "..." } ]
}
```

Send `Nouvelles Violations`' output directly as `violations` — same shape
Fusion already produces, no reformatting needed on the Fusion side.

**Response**:

```json
{ "results": [ { "...all the original fields...": "...", "Analyse OBC": "...", "Infraction avérée": "retenue | non retenue", "dureeSeuil": 10, "screenshot": "<base64 JPEG or null>" } ] }
```

This is exactly the shape `Loop.done` produces today — Fusion's existing
recap-building and email-block-building logic should need minimal changes to
consume it.

Errors on an individual violation (tacho/positions fetch failure, screenshot
capture failure) never fail the whole batch — that violation comes back with
an explanatory `"Analyse OBC"` message and `"Infraction avérée": "non retenue"`
instead.

## Local development

```bash
npm install
cp .env.example .env   # fill in SERVICE_API_KEY if you want auth locally
npm start
```

Run the test suite (pure logic + mocked network calls, no real API calls):

```bash
node test.js
```

Run the live smoke test (real Mix Telematics calls, Browserless intercepted
so it never actually fires):

```bash
MIX_USERNAME=... MIX_PASSWORD=... node live_smoke_test.js
```

## Deploying to Railway

This repo (`Tool-Box`, linked to the Railway `tool-box-production` project)
now deploys this service directly — the old Python/browser-node app it
replaced is preserved on the `legacy-python-backup` branch, not on `main`.

Build is Docker-based (see `Dockerfile`); Railway will pick it up
automatically on push. Set the following variables on the Railway service
(there is no `.env` committed, per `.gitignore`):

```bash
railway variables set SERVICE_API_KEY=<pick something>
railway variables set BROWSERLESS_TOKEN=<optional, defaults to the existing hardcoded token>
railway up
```

Then set `SERVICE_API_KEY` to the same value in whatever Fusion variable
feeds the `X-API-Key` header on the new http-request node. The old
`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` variables
are no longer used by this service (Gmail sending stays in Fusion) and can be
removed from the Railway project once confirmed unused elsewhere.

## Known limits

- Violations are processed sequentially, not in parallel. This matches
  today's Fusion behavior exactly and is the safest starting point; if batch
  runtime becomes a problem, bounded concurrency (a handful of violations at
  once) can be added later without changing the request/response contract.
- Screenshot capture still goes through Browserless.io (unchanged from
  today) rather than a self-hosted browser, so no new infra to manage there.
