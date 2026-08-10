const { escapeHtml } = require("./report-config");

// Style partagé, établi cette session (Fusion) : pas de layout figé, chaque
// ligne reste sur une seule ligne (nowrap), "min-width:100%" plutôt que
// "width:100%" pour remplir toute la largeur disponible sans jamais forcer
// le contenu à rétrécir en dessous de sa taille naturelle.
const CELL_BASE = "box-sizing:border-box;padding:5px 8px;border:1px solid #000000;text-align:center;font-family:Arial,sans-serif;font-size:11px;white-space:nowrap;";
const TH_STYLE = `background-color:#000000;color:#ffffff;font-weight:bold;${CELL_BASE}`;
const TD_STYLE = `background-color:#ffffff;color:#000000;${CELL_BASE}`;

function buildEventTableHtml(item, eventCols) {
  return (
    `<table style="border-collapse:collapse;min-width:100%;">` +
    `<thead><tr>${eventCols.map(([h]) => `<th style="${TH_STYLE}">${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
    `<tbody><tr>${eventCols.map(([, get]) => `<td style="${TD_STYLE}">${escapeHtml(get(item))}</td>`).join("")}</tr></tbody>` +
    `</table>`
  );
}

function buildSummaryTableHtml(items, eventCols) {
  return (
    `<table style="border-collapse:collapse;min-width:100%;">` +
    `<thead><tr>${eventCols.map(([h]) => `<th style="${TH_STYLE}">${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${items.map(it => `<tr>${eventCols.map(([, get]) => `<td style="${TD_STYLE}">${escapeHtml(get(it))}</td>`).join("")}</tr>`).join("")}</tbody>` +
    `</table>`
  );
}

// Tableau tachygraphe (VITESSE uniquement) : Fusion a déjà réduit les
// relevés bruts à la fenêtre pertinente et calculé quelles lignes surligner
// -- ce module se contente de les rendre en HTML, flottant à droite pour
// venir se coller contre la capture d'écran.
function buildTachoTableHtml(tachoTable, imgHeight) {
  if (!tachoTable || !tachoTable.length) return "";
  const cellBase = "box-sizing:border-box;padding:5px 8px;border:1px solid #000000;text-align:center;font-family:Arial,sans-serif;font-size:12px;white-space:nowrap;";
  const th = `background-color:#000000;color:#ffffff;font-weight:bold;${cellBase}`;
  const tdWhite = `background-color:#ffffff;color:#000000;${cellBase}`;
  const tdYellow = `background-color:#ffff00;color:#000000;font-weight:bold;${cellBase}`;
  return (
    `<table height="${imgHeight}" style="float:right;box-sizing:border-box;border-collapse:collapse;height:${imgHeight}px;">` +
    `<thead><tr><th style="${th}">Horodatage</th><th style="${th}">Vitesse (km/h)</th></tr></thead>` +
    `<tbody>${tachoTable.map(r => `<tr><td style="${r.highlighted ? tdYellow : tdWhite}">${escapeHtml(r.datetime)}</td><td style="${r.highlighted ? tdYellow : tdWhite}">${escapeHtml(r.value)}</td></tr>`).join("")}</tbody>` +
    `</table>`
  );
}

const BLOCK_MAX_WIDTH = 1300;
const IMG_H = 700;

function buildImageHtml(record, config) {
  if (!record.screenshot) {
    return `<p style="font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">Capture d'écran indisponible.</p>`;
  }
  return `<img src="data:${config.imageMime};base64,${record.screenshot}" height="${IMG_H}" style="box-sizing:border-box;width:100%;height:${IMG_H}px;display:block;border:1px solid #000000;">`;
}

// Bloc complet pour UN enregistrement : titre (si applicable) + tableau de
// l'événement + tachygraphe (si applicable, flottant à gauche de l'image) +
// capture d'écran. Utilisé (a) directement dans le corps du mail quand il
// n'y a qu'un seul enregistrement, (b) comme référence de mise en page pour
// chaque page du PDF quand il y en a plusieurs.
function buildRecordBlockHtml(record, config) {
  const { item } = record;
  const titleHtml = config.hasTitle
    ? `<div style="font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding-bottom:8px;">${escapeHtml(item["Description du bien"])} — ${escapeHtml(item["Description de l'événement"])}</div>`
    : "";
  const eventTableHtml = buildEventTableHtml(item, config.eventCols);

  const imageInner = buildImageHtml(record, config);
  let mediaHtml;
  if (config.hasTacho) {
    const tachoHtml = buildTachoTableHtml(record.tachoTable, IMG_H);
    const imageWrapped = `<div style="overflow:hidden;">${imageInner}</div>`;
    mediaHtml = tachoHtml + imageWrapped + `<div style="clear:both;"></div>`;
  } else {
    mediaHtml = `<div style="overflow:hidden;padding-bottom:12px;">${imageInner}</div>`;
  }

  return (
    `<div style="box-sizing:border-box;max-width:${BLOCK_MAX_WIDTH}px;margin-bottom:24px;">` +
    titleHtml +
    eventTableHtml +
    mediaHtml +
    `</div>`
  );
}

// Décide, selon les règles établies : 1 enregistrement -> le bloc complet
// directement ; plus d'un -> uniquement le tableau récapitulatif (le détail
// part en pièce jointe PDF).
function buildMiddleHtml(records, config) {
  if (records.length === 1) {
    return { middleHtml: buildRecordBlockHtml(records[0], config), needsPdf: false };
  }
  const middleHtml = buildSummaryTableHtml(records.map(r => r.item), config.eventCols);
  return { middleHtml, needsPdf: records.length > 1 };
}

module.exports = {
  buildEventTableHtml,
  buildSummaryTableHtml,
  buildTachoTableHtml,
  buildImageHtml,
  buildRecordBlockHtml,
  buildMiddleHtml,
  BLOCK_MAX_WIDTH,
  IMG_H,
};
