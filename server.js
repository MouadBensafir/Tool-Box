// =====================================================================
// Tool-Box -- email construction + sending for the ETAT GPS report
// workflows (3 AXIS, EXCES DE VITESSE, FREINAGE).
//
// Fusion AI stays responsible for analysis (auth, extraction, dedup, OBC
// threshold analysis, tachograph fetch), screenshot capture (Playwright +
// Browserless, per item, in its own loop), recap building, and the xlsx
// generation + Google Drive update. This service takes the already-
// analyzed, already-captured records (one recipient's worth per call --
// TEMM or a transporteur) and "handles the rest": building the email body
// (single block vs. summary table + PDF, per the established rules),
// building the multi-page PDF when needed, and sending the Gmail message.
// captureAllScreenshots is kept only as a defensive fallback for any
// record that arrives without a screenshot -- it is a no-op skip for
// every record Fusion already captured.
// =====================================================================

const express = require("express");
const { getReportConfig } = require("./report-config");
const { buildMiddleHtml } = require("./html-builder");
const { buildPdfBuffer } = require("./pdf-builder");
const { sendGmail } = require("./gmail-client");
const { captureAllScreenshots } = require("./browserless-capture");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SERVICE_API_KEY; // shared secret Fusion must send back
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

// Assemble le corps + les pièces jointes pour une exécution donnée (un seul
// destinataire par appel -- TEMM ou un transporteur -- Fusion continue de
// gérer le groupement par transporteur et la boucle, ce n'est pas un
// traitement coûteux en mémoire).
async function buildReport(payload, fetchImpl) {
  const { reportType, recipientType, groupe, hour, isMorningCatchup, monthFr, authToken, xlsxAttachment } = payload;
  const config = getReportConfig(reportType);

  if (recipientType === "TRANSPORTEUR" && !config.supportsTransporteur) {
    throw new Error(`${reportType} does not support a TRANSPORTEUR recipient`);
  }

  const records = await captureAllScreenshots(payload.records, { authToken, reportType }, fetchImpl);

  const { middleHtml, needsPdf } = buildMiddleHtml(records, config);

  let subject, body;
  if (recipientType === "TRANSPORTEUR") {
    subject = config.subjectTransporteur({ hour, isMorningCatchup, groupe });
    const distinctDrivers = [...new Set(records.map(r => r.item["Conducteur"]).filter(Boolean))];
    body = config.bodyTransporteur({
      middleHtml,
      groupe,
      records,
      driverLabel: distinctDrivers.length <= 1 ? "le conducteur" : "les conducteurs",
      driverNames: distinctDrivers.length ? distinctDrivers.join(", ") : "N/A",
    });
  } else {
    subject = config.subjectTemm({ hour, isMorningCatchup });
    body = config.bodyTemm({ middleHtml, hasRecords: records.length > 0 });
  }

  const attachments = [];
  if (xlsxAttachment && xlsxAttachment.base64) {
    attachments.push({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileName: xlsxAttachment.fileName,
      contentBase64: xlsxAttachment.base64,
    });
  }
  if (needsPdf) {
    const pdfBuffer = await buildPdfBuffer(records, config);
    attachments.push({
      mimeType: "application/pdf",
      fileName: config.pdfFileName({ monthFr, groupe }),
      contentBase64: pdfBuffer.toString("base64"),
    });
  }

  return { subject, body, attachments };
}

app.post("/send-report", async (req, res) => {
  if (API_KEY && req.get("X-API-Key") !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { reportType, recipientType, to, records } = req.body || {};
  if (!reportType || typeof reportType !== "string") {
    return res.status(400).json({ error: "Missing reportType" });
  }
  if (!recipientType || !["TEMM", "TRANSPORTEUR"].includes(recipientType)) {
    return res.status(400).json({ error: "Missing or invalid recipientType" });
  }
  if (!to || (Array.isArray(to) && to.length === 0)) {
    return res.status(400).json({ error: "Missing to" });
  }
  if (!Array.isArray(records)) {
    return res.status(400).json({ error: "Missing records array" });
  }
  if (records.length > 0 && records.some(r => !r.screenshot) && !req.body.authToken) {
    return res.status(400).json({ error: "Missing authToken (required to capture screenshots for records that don't already have one)" });
  }
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    return res.status(500).json({ error: "Gmail credentials not configured on the service" });
  }

  try {
    const { subject, body, attachments } = await buildReport(req.body);
    const result = await sendGmail({
      clientId: GMAIL_CLIENT_ID,
      clientSecret: GMAIL_CLIENT_SECRET,
      refreshToken: GMAIL_REFRESH_TOKEN,
      to,
      subject,
      html: body,
      attachments,
    });
    res.json({ success: true, messageId: result.id, subject });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}

module.exports = { app, buildReport };
