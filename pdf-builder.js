// Construit le PDF multi-pages (une page par enregistrement) : tableau de
// l'événement en haut, puis la capture d'écran (et pour VITESSE, le
// tachygraphe à sa gauche) occupant le reste de la page. pdfkit n'a pas de
// primitive "tableau" -- on dessine chaque cellule (rectangle + texte) à la
// main.
const PDFDocument = require("pdfkit");

const PAGE_MARGIN = 24;
const HEADER_FONT_SIZE = 8;
const ROW_HEIGHT = 22;
const TACHO_COL_WIDTH = 170;
const TACHO_ROW_HEIGHT = 16;
const GAP = 8;

function drawCell(doc, { x, y, width, height, text, fill, textColor, bold }) {
  doc.save();
  doc.rect(x, y, width, height).fillAndStroke(fill, "#B7B7B7");
  doc.restore();
  doc.fillColor(textColor).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(HEADER_FONT_SIZE);
  const textHeight = doc.heightOfString(String(text ?? ""), { width: width - 4 });
  doc.text(String(text ?? ""), x + 2, y + Math.max(2, (height - textHeight) / 2), {
    width: width - 4,
    align: "center",
  });
}

// Tableau à 2 lignes (en-têtes + valeurs) réparti sur toute la largeur
// disponible, largeur de chaque colonne proportionnelle à son "weight".
function drawEventTable(doc, item, eventCols, x, y, totalWidth) {
  const totalWeight = eventCols.reduce((sum, [, , weight]) => sum + (weight || 10), 0);
  let cx = x;
  const colX = eventCols.map(([, , weight]) => {
    const w = ((weight || 10) / totalWeight) * totalWidth;
    const thisX = cx;
    cx += w;
    return { x: thisX, width: w };
  });

  eventCols.forEach(([label], i) => {
    drawCell(doc, { x: colX[i].x, y, width: colX[i].width, height: ROW_HEIGHT, text: label, fill: "#000000", textColor: "#FFFFFF", bold: true });
  });
  eventCols.forEach(([, get], i) => {
    const value = get(item);
    drawCell(doc, { x: colX[i].x, y: y + ROW_HEIGHT, width: colX[i].width, height: ROW_HEIGHT, text: value, fill: "#FFFFFF", textColor: "#000000", bold: true });
  });

  return ROW_HEIGHT * 2;
}

// Tableau tachygraphe (VITESSE uniquement), colonne étroite à gauche de
// l'image -- les lignes surlignées (début/fin du créneau retenu) sont déjà
// marquées par Fusion (`highlighted: true`), ce module se contente de les
// peindre en jaune.
function drawTachoTable(doc, tachoTable, x, y, width, maxHeight) {
  const headerH = TACHO_ROW_HEIGHT;
  drawCell(doc, { x, y, width: width * 0.6, height: headerH, text: "Horodatage", fill: "#000000", textColor: "#FFFFFF", bold: true });
  drawCell(doc, { x: x + width * 0.6, y, width: width * 0.4, height: headerH, text: "Vitesse", fill: "#000000", textColor: "#FFFFFF", bold: true });

  let ry = y + headerH;
  const maxRows = Math.max(0, Math.floor((maxHeight - headerH) / TACHO_ROW_HEIGHT));
  const rows = tachoTable.slice(0, maxRows);
  for (const r of rows) {
    const fill = r.highlighted ? "#FFFF00" : "#FFFFFF";
    drawCell(doc, { x, y: ry, width: width * 0.6, height: TACHO_ROW_HEIGHT, text: r.datetime, fill, textColor: "#000000", bold: !!r.highlighted });
    drawCell(doc, { x: x + width * 0.6, y: ry, width: width * 0.4, height: TACHO_ROW_HEIGHT, text: r.value, fill, textColor: "#000000", bold: !!r.highlighted });
    ry += TACHO_ROW_HEIGHT;
  }
  return ry - y;
}

function drawImage(doc, base64, x, y, width, height) {
  if (!base64 || width <= 0 || height <= 0) return;
  try {
    const buf = Buffer.from(base64, "base64");
    doc.image(buf, x, y, { fit: [width, height], align: "center", valign: "center" });
  } catch (e) {
    doc.fontSize(10).fillColor("#999999").text("Capture d'écran indisponible.", x, y, { width, align: "center" });
  }
}

function renderRecordPage(doc, record, config) {
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const pageHeight = doc.page.height - PAGE_MARGIN * 2;
  const x = PAGE_MARGIN;
  let y = PAGE_MARGIN;

  const tableHeight = drawEventTable(doc, record.item, config.eventCols, x, y, pageWidth);
  y += tableHeight + GAP;

  const remainingHeight = pageHeight - (y - PAGE_MARGIN);

  if (config.hasTacho && record.tachoTable && record.tachoTable.length) {
    drawTachoTable(doc, record.tachoTable, x, y, TACHO_COL_WIDTH, remainingHeight);
    drawImage(doc, record.screenshot, x + TACHO_COL_WIDTH + GAP, y, pageWidth - TACHO_COL_WIDTH - GAP, remainingHeight);
  } else {
    drawImage(doc, record.screenshot, x, y, pageWidth, remainingHeight);
  }
}

// `records`: array of { item, screenshot, tachoTable? }. Un enregistrement
// sans screenshot obtient quand même sa page (juste le tableau, sans image).
function buildPdfBuffer(records, config) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: PAGE_MARGIN, autoFirstPage: false });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pages = records.length > 0 ? records : [null];
    for (const record of pages) {
      doc.addPage();
      if (record) {
        renderRecordPage(doc, record, config);
      } else {
        doc.fontSize(12).text("Aucun événement.", PAGE_MARGIN, PAGE_MARGIN);
      }
    }

    doc.end();
  });
}

module.exports = { buildPdfBuffer, drawEventTable, drawTachoTable };
