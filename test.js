const assert = require("assert");
const { buildTachoUrl, buildPositionsRequest, analyseObc, buildPlaywrightScript, processViolation, app } = require("./server.js");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS:", name);
    passed++;
  } catch (e) {
    console.log("FAIL:", name, "--", e.message);
    process.exitCode = 1;
  }
}

const baseItem = {
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
  "Heure de fin": "10:46:45",
  "Nbre d'occurrences": "1",
  "Valeur de l'événement": "44",
};

// ---- buildTachoUrl ----
check("buildTachoUrl produces the expected endpoint", () => {
  const url = buildTachoUrl(baseItem);
  assert.strictEqual(
    url,
    "https://za.mixtelematics.com/DynaMiX.API/timeline/sites/9009592914788954934/asset/1636216911637594112/tacho?excludeEvents=false&from=2026-07-28T10:46:32&to=2026-07-28T10:46:45"
  );
});

// ---- buildPositionsRequest ----
check("buildPositionsRequest builds a tight +/-6min window, timezone-safe", () => {
  const { url, body } = buildPositionsRequest(baseItem);
  assert.ok(url.includes("/asset/positions"));
  assert.strictEqual(body.entityId, "1636216911637594112");
  assert.strictEqual(body.from.IsoDateTimeString, "2026-07-28T10:40:32");
  assert.strictEqual(body.to.IsoDateTimeString, "2026-07-28T10:52:45");
});

// ---- analyseObc ----
function mkTacho(speedReadings, rpmReadings) {
  const channels = [{ InputId: "Speed", Readings: speedReadings }];
  if (rpmReadings) channels.push({ InputId: "RPM", Readings: rpmReadings });
  return { Channels: channels };
}

check("analyseObc: normal threshold exceeded -> retenue", () => {
  const speed = [];
  for (let i = 0; i < 10; i++) speed.push({ TimeOffset: i, Value: 45 });
  const res = analyseObc(baseItem, mkTacho(speed), null);
  assert.strictEqual(res["Infraction avérée"], "retenue");
  assert.strictEqual(res.dureeSeuil, 10);
});

check("analyseObc: threshold not sustained long enough -> non retenue", () => {
  const speed = [{ TimeOffset: 0, Value: 45 }];
  const res = analyseObc(baseItem, mkTacho(speed), null);
  assert.strictEqual(res["Infraction avérée"], "non retenue");
});

check("analyseObc: frozen speed+RPM -> déconnexion suspecte (Cas A)", () => {
  const speed = [{ TimeOffset: 0, Value: 50 }, { TimeOffset: 1, Value: 50 }];
  const rpm = [{ TimeOffset: 0, Value: 1200 }, { TimeOffset: 1, Value: 1200 }];
  const res = analyseObc(baseItem, mkTacho(speed, rpm), null);
  assert.strictEqual(res["Infraction avérée"], "non retenue");
  assert.ok(res["Analyse OBC"].includes("déconnexion suspecte"));
});

check("analyseObc: real captured frozen-position case -> déconnexion suspecte (Cas A2)", () => {
  const positions = [];
  for (let i = 0; i < 10; i++) {
    positions.push({
      LatLng: { Latitude: 35.83727, Longitude: -5.35551 },
      SpeedKph: 44,
      TimeStamp: { DateTime: new Date(Date.parse("2026-07-28T10:42:50") + i * 8000).toISOString() },
    });
  }
  const speed = [{ TimeOffset: 0, Value: 44 }];
  const res = analyseObc(baseItem, mkTacho(speed), positions);
  assert.strictEqual(res["Infraction avérée"], "non retenue");
  assert.ok(res["Analyse OBC"].includes("figée"));
});

check("analyseObc: teleport jump -> déconnexion suspecte (Cas A2 signal 2)", () => {
  const positions = [
    { LatLng: { Latitude: 35.8, Longitude: -5.35 }, SpeedKph: 60, TimeStamp: { DateTime: "2026-07-28T10:46:32.000Z" } },
    { LatLng: { Latitude: 36.2, Longitude: -5.9 }, SpeedKph: 60, TimeStamp: { DateTime: "2026-07-28T10:46:42.000Z" } },
  ];
  const speed = [{ TimeOffset: 0, Value: 60 }];
  const res = analyseObc(baseItem, mkTacho(speed), positions);
  assert.strictEqual(res["Infraction avérée"], "non retenue");
  assert.ok(res["Analyse OBC"].includes("téléportation") === false); // exact wording check below
  assert.ok(res["Analyse OBC"].includes("physiquement impossible"));
});

check("analyseObc: no tacho at all -> graceful non retenue", () => {
  const res = analyseObc(baseItem, null, null);
  assert.strictEqual(res["Infraction avérée"], "non retenue");
  assert.ok(res["Analyse OBC"].includes("indisponible"));
});

// ---- buildPlaywrightScript ----
check("buildPlaywrightScript embeds token, plate, and dates safely", () => {
  const script = buildPlaywrightScript(baseItem, "FAKE_TOKEN_123");
  assert.ok(script.includes("FAKE_TOKEN_123"));
  assert.ok(script.includes("28/07/2026 00:00"));
  assert.ok(script.includes(JSON.stringify("19679 B 50")));
  assert.ok(script.includes(JSON.stringify("TEG - Survitesse AgglomerationSSE | Alarm")));
});

// ---- processViolation, with fetch mocked (no real network calls) ----
async function withMockedFetch(responses, fn) {
  const original = global.fetch;
  let callIndex = 0;
  global.fetch = async (url, opts) => {
    const r = responses[callIndex++];
    if (!r) throw new Error("Unexpected extra fetch call to " + url);
    return { ok: r.ok !== false, json: async () => r.json };
  };
  try {
    await fn();
  } finally {
    global.fetch = original;
  }
}

(async () => {
  await withMockedFetch(
    [
      { json: mkTacho([{ TimeOffset: 0, Value: 10 }]) }, // tacho fetch, below threshold
      { json: { Positions: null } }, // positions fetch
    ],
    async () => {
      const result = await processViolation(baseItem, "TOKEN", "token=TOKEN");
      check("processViolation: non retenue case never calls screenshot capture", () => {
        assert.strictEqual(result["Infraction avérée"], "non retenue");
        assert.strictEqual(result.screenshot, null);
      });
    }
  );

  await withMockedFetch(
    [
      { json: mkTacho((() => { const s = []; for (let i = 0; i < 10; i++) s.push({ TimeOffset: i, Value: 45 }); return s; })()) },
      { json: { Positions: null } },
      { json: { image: "ZmFrZXNjcmVlbnNob3Q=" } }, // screenshot capture
    ],
    async () => {
      const result = await processViolation(baseItem, "TOKEN", "token=TOKEN");
      check("processViolation: retenue case captures a screenshot", () => {
        assert.strictEqual(result["Infraction avérée"], "retenue");
        assert.strictEqual(result.screenshot, "ZmFrZXNjcmVlbnNob3Q=");
      });
    }
  );

  await withMockedFetch(
    [
      { ok: false, json: {} }, // tacho fetch fails
      { ok: false, json: {} }, // positions fetch fails
    ],
    async () => {
      const result = await processViolation(baseItem, "TOKEN", "token=TOKEN");
      check("processViolation: upstream API failures degrade gracefully, don't throw", () => {
        assert.strictEqual(result["Infraction avérée"], "non retenue");
        assert.strictEqual(result.screenshot, null);
      });
    }
  );

  // ---- HTTP endpoint validation (no mocked fetch needed, these return before any network call) ----
  const request = await import("http");
  function startServer() {
    return new Promise((resolve) => {
      const server = app.listen(0, () => resolve(server));
    });
  }
  function post(server, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request.request(
        { host: "localhost", port: server.address().port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  const server = await startServer();
  try {
    const r1 = await post(server, "/process-violations", {});
    check("endpoint: missing authToken -> 400", () => {
      assert.strictEqual(r1.status, 400);
    });

    const r2 = await post(server, "/process-violations", { authToken: "x" });
    check("endpoint: missing violations array -> 400", () => {
      assert.strictEqual(r2.status, 400);
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} check(s) passed.`);
  if (process.exitCode) console.log("SOME CHECKS FAILED");
  else console.log("ALL CHECKS PASSED");
})();
