// Captures the map screenshot for one record via Browserless.io, using the
// report-type-specific Playwright script. This used to run inside Fusion's
// per-item Loop (Playwright Script -> Browserless nodes); it moved here so
// screenshots never enter Fusion's per-run memory accumulator at all --
// Tool-Box captures, builds, and sends the report in one call, and Fusion
// only ever sees the final send result.
const { buildPlaywrightScript3axis, buildPlaywrightScriptVitesse, buildPlaywrightScriptFreinage } = require("./playwright-scripts");

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "2UoKl0rUOpJjz9z21c35decfd944b92e9766a965a6a2e00d8";

const SCRIPT_BUILDERS = {
  "3AXIS": buildPlaywrightScript3axis,
  "VITESSE": buildPlaywrightScriptVitesse,
  "FREINAGE": buildPlaywrightScriptFreinage,
};

// `fetchImpl` is injectable for tests -- defaults to the global fetch.
async function captureScreenshot({ item, authToken, reportType }, fetchImpl = fetch) {
  const builder = SCRIPT_BUILDERS[reportType];
  if (!builder) throw new Error(`No Playwright script builder for reportType: ${reportType}`);
  const script = builder(item, authToken);

  const res = await fetchImpl(`https://chrome.browserless.io/function?token=${BROWSERLESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: script }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Browserless capture failed (${res.status}): ${text}`);
  }
  const data = await res.json();

  // The Browserless *HTTP call* can succeed (200) while the script itself
  // reports failure in its JSON body -- e.g. the 3AXIS script's early exit
  // when the target event isn't found on the page returns
  // {success:false, message:"..."} with a 200 status. Treating that as "no
  // image, but otherwise fine" silently marked the violation as handled
  // (recap dedup would then never retry it). Must throw here so this
  // propagates as a real capture failure.
  if (data && data.success === false) {
    throw new Error(`Browserless script reported failure: ${data.message || "unknown reason"}`);
  }
  return data && data.image ? data.image : null;
}

// ── De-duplication ──────────────────────────────────────────────────────
// TEMM's report and each transporteur's report can both include the SAME
// event (a transporteur's records are a filtered subset of TEMM's), and
// Fusion fires the TEMM call and the transporteur loop as parallel branches
// -- so without this, the same screenshot gets bought from Browserless
// twice (or once per transporteur that also happens to share it), which
// costs real money on a metered plan.
//
// Two layers, both keyed on the same identity (report type + plate + event
// + date + start hour -- the same 4 fields already used for dedup in the
// 3AXIS "Accidents" node):
//   1. `inFlight` -- if a capture for this key is already running (a
//      genuinely concurrent request for the same event), the second caller
//      awaits the SAME promise instead of starting a second Browserless
//      call. Safe under Node's single-threaded event loop: the check and
//      the promise registration happen synchronously, with no `await`
//      between them, so two requests can't both "miss" and both proceed.
//   2. `completed` -- a short-lived cache of already-finished captures, so
//      a call that arrives after an earlier one already finished reuses
//      the result instead of re-fetching. Entries expire after
//      CACHE_TTL_MS; a whole Fusion run comfortably finishes well inside
//      that window. Failed captures are never cached, so a transient
//      failure for one recipient doesn't propagate into every recipient's
//      email -- the next caller gets a fresh attempt.
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const inFlight = new Map(); // key -> Promise<screenshot>
const completed = new Map(); // key -> { screenshot, expiresAt }

function cacheKey(reportType, item) {
  return [reportType, item["Immatriculation"], item["Description de l'événement"], item["Date de départ"], item["Heure de départ"]].join("|");
}

function getCompleted(key) {
  const entry = completed.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    completed.delete(key);
    return undefined;
  }
  return entry.screenshot;
}

// Periodic sweep so entries that are captured once and never looked up
// again don't linger in memory forever on a long-running process. unref()
// so this timer never keeps the process alive by itself (relevant for
// tests and graceful shutdown).
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of completed) {
    if (now > entry.expiresAt) completed.delete(key);
  }
}, 5 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

async function captureScreenshotDeduped({ item, authToken, reportType }, fetchImpl) {
  const key = cacheKey(reportType, item);

  const cached = getCompleted(key);
  if (cached !== undefined) return cached;

  if (inFlight.has(key)) return inFlight.get(key);

  const promise = captureScreenshot({ item, authToken, reportType }, fetchImpl)
    .then((screenshot) => {
      completed.set(key, { screenshot, expiresAt: Date.now() + CACHE_TTL_MS });
      inFlight.delete(key);
      return screenshot;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });

  inFlight.set(key, promise);
  return promise;
}

// Captures every record's screenshot sequentially within THIS call (matches
// Fusion's own prior sequential-loop behavior) -- de-duplication against
// OTHER concurrent/recent calls happens via captureScreenshotDeduped above.
// A single record's capture failure never aborts the batch -- that record
// just gets a null screenshot, same graceful-degradation convention used
// throughout this service.
async function captureAllScreenshots(records, { authToken, reportType }, fetchImpl = fetch) {
  const results = [];
  for (const record of records) {
    if (record.screenshot) {
      // Already has one (e.g. a test fixture, or a future caller that
      // captured it another way) -- don't recapture.
      results.push(record);
      continue;
    }
    try {
      const screenshot = await captureScreenshotDeduped({ item: record.item, authToken, reportType }, fetchImpl);
      results.push({ ...record, screenshot });
    } catch (err) {
      results.push({ ...record, screenshot: null, captureError: err.message });
    }
  }
  return results;
}

// Test-only escape hatch to reset cache state between test cases.
function _resetCacheForTests() {
  inFlight.clear();
  completed.clear();
}

module.exports = { captureScreenshot, captureAllScreenshots, SCRIPT_BUILDERS, cacheKey, _resetCacheForTests };
