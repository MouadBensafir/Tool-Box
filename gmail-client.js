// Construit et envoie l'email via l'API Gmail, avec les identifiants OAuth
// stockés côté service (variables d'env, comme BROWSERLESS_TOKEN) -- pas
// besoin de les faire transiter dans chaque requête Fusion, contrairement au
// AuthToken Mix Telematics qui est lui à durée de vie courte.
const { OAuth2Client } = require("google-auth-library");

function toBase64Url(buf) {
  const b64 = Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(buf, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// RFC 2047 : un sujet contenant des caractères non-ASCII (accents français)
// doit être encodé, sinon certains clients mail l'affichent corrompu.
function encodeSubject(subject) {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function buildMimeMessage({ to, subject, html, attachments = [] }) {
  const boundary = `mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const toHeader = Array.isArray(to) ? to.join(", ") : to;

  const lines = [
    `To: ${toHeader}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64"),
    "",
  ];

  for (const att of attachments) {
    if (!att || !att.contentBase64) continue;
    lines.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType || "application/octet-stream"}; name="${att.fileName}"`,
      `Content-Disposition: attachment; filename="${att.fileName}"`,
      "Content-Transfer-Encoding: base64",
      "",
      att.contentBase64,
      "",
    );
  }

  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const client = new OAuth2Client(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Failed to obtain Gmail access token from refresh token");
  return token;
}

// `fetchImpl` is injectable for tests -- defaults to the global fetch.
async function sendGmail({ clientId, clientSecret, refreshToken, to, subject, html, attachments }, fetchImpl = fetch) {
  const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
  const raw = buildMimeMessage({ to, subject, html, attachments });
  const rawBase64Url = toBase64Url(raw);

  const res = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: rawBase64Url }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail send failed (${res.status}): ${text}`);
  }
  return res.json();
}

module.exports = { buildMimeMessage, encodeSubject, toBase64Url, getAccessToken, sendGmail };
