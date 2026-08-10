const assert = require("assert");
const http = require("http");

let passed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => { console.log("PASS:", name); passed++; })
        .catch((e) => { console.log("FAIL:", name, "--", e.stack); process.exitCode = 1; });
    }
    console.log("PASS:", name); passed++;
  } catch (e) { console.log("FAIL:", name, "--", e.stack); process.exitCode = 1; }
}

async function run() {
  const { getReportConfig, REPORT_CONFIGS } = require("./report-config");
  const { buildEventTableHtml, buildSummaryTableHtml, buildTachoTableHtml, buildRecordBlockHtml, buildMiddleHtml } = require("./html-builder");
  const { buildPdfBuffer } = require("./pdf-builder");
  const { buildMimeMessage, encodeSubject, sendGmail, getAccessToken } = require("./gmail-client");
  const { OAuth2Client } = require("google-auth-library");
  const { PDFParse } = require("pdf-parse");

  async function parsePdf(buf) {
    const parser = new PDFParse({ data: buf });
    try {
      const result = await parser.getText();
      return { numpages: result.total, text: result.text };
    } finally {
      await parser.destroy();
    }
  }

  const item3axis = {
    "Description du bien": "MA26554 HCL", "Immatriculation": "46610-A-14", "Site Conducteur": "SOTRAGAZ",
    "Conducteur": "AIT BOUYOUB MOHAMED", "Description de l'événement": "TEG102 - 3 Axis possible accident /IMPACT severity",
    "Date de départ": "07/08/2026", "Heure de départ": "07:46:26", "Heure de fin": "07:46:27", "Nbre d'occurrences": "1",
  };
  const itemVitesse = {
    "Description du bien": "MA31145 HCL", "Immatriculation": "78361-E-1", "Groupe": "MEHARIS TE",
    "Conducteur": "NASRI TARIK", "ID du conducteur": "198", "Description de l'événement": "Excès de vitesse",
    "Date de départ": "10/08/2026", "Heure de départ": "13:55:34", "Heure de fin": "13:55:43", "Nbre d'occurrences": "1",
  };
  const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const TINY_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

  // ---- report-config.js ----
  check("getReportConfig throws on unknown type", () => {
    assert.throws(() => getReportConfig("NOPE"));
  });
  check("3AXIS config: subjectTemm, no title, no tacho", () => {
    const c = getReportConfig("3AXIS");
    assert.strictEqual(c.hasTitle, false);
    assert.strictEqual(c.hasTacho, false);
    assert.ok(c.subjectTemm({ hour: "14", isMorningCatchup: false }).includes("14H"));
    assert.ok(c.subjectTemm({ isMorningCatchup: true }).includes("J-1 05H30"));
  });
  check("VITESSE config: has title, has tacho", () => {
    const c = getReportConfig("VITESSE");
    assert.strictEqual(c.hasTitle, true);
    assert.strictEqual(c.hasTacho, true);
    assert.ok(c.subjectTransporteur({ hour: "14", groupe: "MEHARIS TE" }).includes("MEHARIS TE"));
  });
  check("FREINAGE config: no transporteur support", () => {
    const c = getReportConfig("FREINAGE");
    assert.strictEqual(c.supportsTransporteur, false);
    assert.strictEqual(c.hasTacho, false);
  });

  // ---- html-builder.js ----
  check("buildEventTableHtml: single row, nowrap, min-width:100%", () => {
    const html = buildEventTableHtml(item3axis, getReportConfig("3AXIS").eventCols);
    assert.ok(html.includes("min-width:100%"));
    assert.ok(html.includes("white-space:nowrap"));
    assert.ok(!html.includes("table-layout:fixed"));
    assert.strictEqual((html.match(/<tr>/g) || []).length, 2); // header + 1 data row
  });
  check("buildSummaryTableHtml: one header row + one row per item", () => {
    const html = buildSummaryTableHtml([item3axis, { ...item3axis, "Immatriculation": "X" }], getReportConfig("3AXIS").eventCols);
    assert.strictEqual((html.match(/<tr>/g) || []).length, 3);
  });
  check("buildTachoTableHtml: highlighted rows get yellow fill", () => {
    const html = buildTachoTableHtml([
      { datetime: "2026-08-10 13:55:34", value: 92, highlighted: true },
      { datetime: "2026-08-10 13:55:35", value: 91, highlighted: false },
    ], 700);
    assert.ok(html.includes("#ffff00"));
    assert.ok(html.includes("float:right"));
  });
  check("buildTachoTableHtml: empty/null -> empty string", () => {
    assert.strictEqual(buildTachoTableHtml(null, 700), "");
    assert.strictEqual(buildTachoTableHtml([], 700), "");
  });
  check("buildRecordBlockHtml: 3AXIS has no title, no tacho float", () => {
    const html = buildRecordBlockHtml({ item: item3axis, screenshot: TINY_JPEG_BASE64 }, getReportConfig("3AXIS"));
    assert.ok(!html.includes("font-weight:bold;padding-bottom:8px"));
    assert.ok(!html.includes("float:right"));
    assert.ok(html.includes("data:image/jpeg;base64,"));
  });
  check("buildRecordBlockHtml: VITESSE has title and tacho float beside image", () => {
    const html = buildRecordBlockHtml({
      item: itemVitesse, screenshot: TINY_JPEG_BASE64,
      tachoTable: [{ datetime: "13:55:34", value: 92, highlighted: true }],
    }, getReportConfig("VITESSE"));
    assert.ok(html.includes("font-weight:bold;padding-bottom:8px"));
    assert.ok(html.includes("float:right"));
    assert.ok(html.indexOf("float:right") < html.indexOf("data:image/jpeg"), "tacho table must come before the image in the HTML source so it floats correctly");
  });
  check("buildMiddleHtml: 1 record -> full block, needsPdf false", () => {
    const { middleHtml, needsPdf } = buildMiddleHtml([{ item: item3axis, screenshot: TINY_JPEG_BASE64 }], getReportConfig("3AXIS"));
    assert.strictEqual(needsPdf, false);
    assert.ok(middleHtml.includes("<img"));
  });
  check("buildMiddleHtml: 2 records -> summary table only, needsPdf true", () => {
    const { middleHtml, needsPdf } = buildMiddleHtml(
      [{ item: item3axis, screenshot: TINY_JPEG_BASE64 }, { item: { ...item3axis, Immatriculation: "X" }, screenshot: TINY_JPEG_BASE64 }],
      getReportConfig("3AXIS")
    );
    assert.strictEqual(needsPdf, true);
    assert.ok(!middleHtml.includes("<img"));
    assert.strictEqual((middleHtml.match(/<tr>/g) || []).length, 3);
  });

  // ---- pdf-builder.js ----
  await check("buildPdfBuffer: 3AXIS, 2 records -> valid PDF, 2 pages, correct text, no tacho", async () => {
    const records = [
      { item: item3axis, screenshot: TINY_JPEG_BASE64 },
      { item: { ...item3axis, Immatriculation: "99999-Z-99" }, screenshot: TINY_JPEG_BASE64 },
    ];
    const buf = await buildPdfBuffer(records, getReportConfig("3AXIS"));
    assert.ok(buf.length > 0);
    assert.strictEqual(buf.slice(0, 5).toString("latin1"), "%PDF-");
    const parsed = await parsePdf(buf);
    assert.strictEqual(parsed.numpages, 2);
    assert.ok(parsed.text.includes("46610-A-14"));
    assert.ok(parsed.text.includes("99999-Z-99"));
  });
  await check("buildPdfBuffer: VITESSE with tacho -> tacho values appear in extracted text", async () => {
    const records = [
      { item: itemVitesse, screenshot: TINY_JPEG_BASE64, tachoTable: [
        { datetime: "2026-08-10 13:55:34", value: 92, highlighted: true },
        { datetime: "2026-08-10 13:55:35", value: 91, highlighted: false },
      ] },
      { item: { ...itemVitesse, Immatriculation: "X" }, screenshot: TINY_JPEG_BASE64, tachoTable: [] },
    ];
    const buf = await buildPdfBuffer(records, getReportConfig("VITESSE"));
    const parsed = await parsePdf(buf);
    assert.strictEqual(parsed.numpages, 2);
    assert.ok(parsed.text.includes("Horodatage"));
    assert.ok(parsed.text.includes("92"));
  });
  await check("buildPdfBuffer: 0 records -> still produces a single placeholder page", async () => {
    const buf = await buildPdfBuffer([], getReportConfig("3AXIS"));
    const parsed = await parsePdf(buf);
    assert.strictEqual(parsed.numpages, 1);
    assert.ok(parsed.text.includes("Aucun événement"));
  });
  await check("buildPdfBuffer: missing screenshot -> page still renders (no crash)", async () => {
    const buf = await buildPdfBuffer([{ item: item3axis, screenshot: null }], getReportConfig("3AXIS"));
    const parsed = await parsePdf(buf);
    assert.strictEqual(parsed.numpages, 1);
  });
  await check("buildPdfBuffer: PNG screenshot (FREINAGE) also renders without error", async () => {
    const buf = await buildPdfBuffer([{ item: itemVitesse, screenshot: TINY_PNG_BASE64 }], getReportConfig("FREINAGE"));
    assert.ok(buf.length > 0);
  });

  // ---- gmail-client.js ----
  check("encodeSubject: ASCII passes through, accented text gets RFC2047-encoded", () => {
    assert.strictEqual(encodeSubject("PLAIN SUBJECT"), "PLAIN SUBJECT");
    const encoded = encodeSubject("RAPPORT DES 3 AXIS POSSIBLE ACCIDENT — MEHARIS TE");
    assert.ok(encoded.startsWith("=?UTF-8?B?"));
  });
  check("buildMimeMessage: has boundary, html part, and one attachment part per attachment", () => {
    const raw = buildMimeMessage({
      to: ["a@b.com"], subject: "Test", html: "<p>hi</p>",
      attachments: [
        { mimeType: "application/pdf", fileName: "r.pdf", contentBase64: "QUJD" },
        { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: "r.xlsx", contentBase64: "WFla" },
      ],
    });
    assert.ok(raw.includes("To: a@b.com"));
    assert.ok(raw.includes("multipart/mixed"));
    assert.ok(raw.includes('filename="r.pdf"'));
    assert.ok(raw.includes('filename="r.xlsx"'));
    assert.strictEqual((raw.match(/Content-Disposition: attachment/g) || []).length, 2);
  });
  check("buildMimeMessage: no attachments -> no attachment parts", () => {
    const raw = buildMimeMessage({ to: ["a@b.com"], subject: "Test", html: "<p>hi</p>", attachments: [] });
    assert.ok(!raw.includes("Content-Disposition: attachment"));
  });

  await check("sendGmail: calls Gmail API with bearer token and base64url raw message, no real network", async () => {
    const originalGetAccessToken = OAuth2Client.prototype.getAccessToken;
    OAuth2Client.prototype.getAccessToken = async function () { return { token: "FAKE_ACCESS_TOKEN" }; };
    try {
      let capturedUrl, capturedHeaders, capturedBody;
      const fakeFetch = async (url, opts) => {
        capturedUrl = url; capturedHeaders = opts.headers; capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ id: "msg123" }) };
      };
      const result = await sendGmail({
        clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken",
        to: ["x@y.com"], subject: "Sujet", html: "<p>Corps</p>", attachments: [],
      }, fakeFetch);
      assert.strictEqual(result.id, "msg123");
      assert.strictEqual(capturedUrl, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
      assert.strictEqual(capturedHeaders.Authorization, "Bearer FAKE_ACCESS_TOKEN");
      assert.ok(typeof capturedBody.raw === "string" && capturedBody.raw.length > 0);
      assert.ok(!capturedBody.raw.includes("+") && !capturedBody.raw.includes("/"), "raw message must be base64url, not base64");
    } finally {
      OAuth2Client.prototype.getAccessToken = originalGetAccessToken;
    }
  });
  await check("sendGmail: non-ok response throws with status+body", async () => {
    const originalGetAccessToken = OAuth2Client.prototype.getAccessToken;
    OAuth2Client.prototype.getAccessToken = async function () { return { token: "FAKE" }; };
    try {
      const fakeFetch = async () => ({ ok: false, status: 403, text: async () => "insufficient scope" });
      await assert.rejects(
        sendGmail({ clientId: "a", clientSecret: "b", refreshToken: "c", to: ["x@y.com"], subject: "s", html: "h", attachments: [] }, fakeFetch),
        /Gmail send failed \(403\): insufficient scope/
      );
    } finally {
      OAuth2Client.prototype.getAccessToken = originalGetAccessToken;
    }
  });

  // ---- server.js: buildReport (pure, no network) + HTTP endpoint validation ----
  const { app, buildReport } = require("./server");

  await check("buildReport: 3AXIS TEMM, 1 record -> no PDF, xlsx attached", async () => {
    const { subject, body, attachments } = await buildReport({
      reportType: "3AXIS", recipientType: "TEMM", hour: "14", isMorningCatchup: false,
      records: [{ item: item3axis, screenshot: TINY_JPEG_BASE64 }],
      xlsxAttachment: { fileName: "recap.xlsx", base64: "WFla" },
    });
    assert.ok(subject.includes("14H"));
    assert.ok(body.includes("<img"));
    assert.strictEqual(attachments.length, 1);
    assert.strictEqual(attachments[0].fileName, "recap.xlsx");
  });

  await check("buildReport: 3AXIS TEMM, 2 records -> PDF attached alongside xlsx", async () => {
    const { attachments, body } = await buildReport({
      reportType: "3AXIS", recipientType: "TEMM", hour: "14", isMorningCatchup: false, monthFr: "AOUT",
      records: [
        { item: item3axis, screenshot: TINY_JPEG_BASE64 },
        { item: { ...item3axis, Immatriculation: "X" }, screenshot: TINY_JPEG_BASE64 },
      ],
      xlsxAttachment: { fileName: "recap.xlsx", base64: "WFla" },
    });
    assert.strictEqual(attachments.length, 2);
    assert.ok(attachments.some(a => a.mimeType === "application/pdf"));
    assert.ok(!body.includes("<img"), "body should only show the summary table, not an embedded image, when >1 record");
  });

  await check("buildReport: VITESSE TRANSPORTEUR, 1 record -> disciplinary body text + signature present", async () => {
    const { body } = await buildReport({
      reportType: "VITESSE", recipientType: "TRANSPORTEUR", groupe: "MEHARIS TE", hour: "14",
      records: [{ item: itemVitesse, screenshot: TINY_JPEG_BASE64, tachoTable: [{ datetime: "13:55:34", value: 92, highlighted: true }] }],
      xlsxAttachment: null,
    });
    assert.ok(body.includes("ABA TECHNOLOGY"));
    assert.ok(body.includes("NASRI TARIK"));
    assert.ok(body.includes("mesures disciplinaires"));
  });

  await check("buildReport: FREINAGE rejects TRANSPORTEUR recipientType", async () => {
    await assert.rejects(
      buildReport({ reportType: "FREINAGE", recipientType: "TRANSPORTEUR", groupe: "X", records: [] }),
      /does not support a TRANSPORTEUR recipient/
    );
  });

  await check("buildReport: 0 records, TEMM -> no-infraction body, no PDF, still xlsx attached", async () => {
    const { body, attachments } = await buildReport({
      reportType: "FREINAGE", recipientType: "TEMM", hour: "14", records: [],
      xlsxAttachment: { fileName: "recap.xlsx", base64: "WFla" },
    });
    assert.ok(body.includes("Aucune infraction confirmée"));
    assert.strictEqual(attachments.length, 1);
  });

  // ---- HTTP endpoint validation (real request, no Gmail creds set -> 500 with clear error, not a crash) ----
  await check("POST /send-report: missing reportType -> 400", async () => {
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const res = await fetch(`http://localhost:${port}/send-report`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientType: "TEMM", to: ["a@b.com"], records: [] }),
      });
      assert.strictEqual(res.status, 400);
      const json = await res.json();
      assert.ok(json.error.includes("reportType"));
    } finally {
      server.close();
    }
  });
  await check("GET /health -> 200 ok", async () => {
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const res = await fetch(`http://localhost:${port}/health`);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), { status: "ok" });
    } finally {
      server.close();
    }
  });

  console.log(`\n${passed} check(s) passed.`);
  if (process.exitCode) process.exit(process.exitCode);
}

run();
