// Live integration smoke test: real Mix Telematics auth + real tacho/positions
// calls, exercised directly through the exported functions (not spawning the
// HTTP server, so we can intercept only the Browserless leg -- a real
// screenshot call costs real money and shouldn't fire in an unattended test).

const { processViolation } = require("./server.js");

async function main() {
  const username = process.env.MIX_USERNAME;
  const password = process.env.MIX_PASSWORD;
  if (!username || !password) {
    throw new Error("Set MIX_USERNAME and MIX_PASSWORD environment variables before running this test.");
  }

  const authRes = await fetch("https://za.mixtelematics.com/DynaMiX.API/authentication/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const authJson = await authRes.json();
  const authToken = (authJson.body || authJson).AuthToken;
  console.log("Got real AuthToken:", authToken ? authToken.slice(0, 12) + "..." : "MISSING");
  if (!authToken) throw new Error("Auth failed, aborting smoke test");

  // Intercept only calls to Browserless; let everything else (real Mix
  // Telematics tacho/positions calls) go through untouched.
  const realFetch = global.fetch;
  let browserlessCallAttempted = false;
  global.fetch = (url, opts) => {
    if (String(url).includes("chrome.browserless.io")) {
      browserlessCallAttempted = true;
      console.log("(Intercepted a Browserless call -- NOT actually sent, returning a fake image)");
      return Promise.resolve({ ok: true, json: async () => ({ image: "RkFLRV9TQ1JFRU5TSE9U" }) });
    }
    return realFetch(url, opts);
  };

  const violation = {
    "Description du bien": "MA27508 GPL Distribution",
    "Immatriculation": "19679 B 50",
    "ID du véhicule": "1636216911637594112",
    "ID du site": "9009592914788954934",
    "Groupe": "STG",
    "Conducteur": "NAALA Ayoub",
    "ID du conducteur": "123",
    "Description de l'événement": "TEG - Survitesse AgglomerationSSE | Alarm",
    "Date de départ": "28/07/2026",
    "Heure de départ": "10:46:32",
    "Date de fin": "28/07/2026",
    "Heure de fin": "10:52:45",
    "Nbre d'occurrences": "1",
    "Valeur de l'événement": "44",
  };

  const result = await processViolation(violation, authToken, `token=${authToken}`);
  global.fetch = realFetch;

  console.log("\n--- Result from REAL tacho/positions calls ---");
  console.log("Analyse OBC:", result["Analyse OBC"]);
  console.log("Infraction avérée:", result["Infraction avérée"]);
  console.log("Browserless was called:", browserlessCallAttempted, "(expected: true only if 'retenue')");
  console.log("Screenshot field populated:", result.screenshot !== null);

  if (result["Infraction avérée"] === "retenue" && !browserlessCallAttempted) {
    throw new Error("BUG: retenue but Browserless was never called");
  }
  if (result["Infraction avérée"] !== "retenue" && browserlessCallAttempted) {
    throw new Error("BUG: non retenue but Browserless was called anyway");
  }
  console.log("\nSMOKE TEST PASSED -- real network path works end to end, no real Browserless charge incurred.");
}

main().catch((e) => {
  console.error("SMOKE TEST ERROR:", e);
  process.exit(1);
});
