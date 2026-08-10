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
  return data && data.image ? data.image : null;
}

// Captures every record's screenshot sequentially (matches Fusion's own
// prior sequential-loop behavior). A single record's capture failure never
// aborts the batch -- that record just gets a null screenshot, same
// graceful-degradation convention used throughout this service.
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
      const screenshot = await captureScreenshot({ item: record.item, authToken, reportType }, fetchImpl);
      results.push({ ...record, screenshot });
    } catch (err) {
      results.push({ ...record, screenshot: null, captureError: err.message });
    }
  }
  return results;
}

module.exports = { captureScreenshot, captureAllScreenshots, SCRIPT_BUILDERS };
