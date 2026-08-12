// Configuration par type de rapport (3AXIS / VITESSE / FREINAGE) : colonnes de
// tableau, présence ou non d'un tachygraphe, textes de sujet/corps. Fusion
// reste responsable de TOUTE l'analyse (OBC, dédup, capture d'écran) et ne
// passe ici que les enregistrements déjà prêts -- ce module ne fait que
// choisir les bons mots et les bonnes colonnes selon le type de rapport.

const escapeHtml = (v) => (v === null || v === undefined) ? "" : String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 3e élément de chaque tuple = "weight" (poids relatif, ~longueur de
// caractères) utilisé uniquement par le PDF pour répartir la largeur des
// colonnes -- ignoré par les tableaux HTML (email), qui remplissent la
// largeur disponible naturellement (min-width:100%, pas de layout figé).
const COLS_3AXIS = [
  ["Description du véhicule", (it) => it["Description du bien"], 22],
  ["Immatriculation", (it) => it["Immatriculation"], 14],
  ["Site Conducteur", (it) => it["Site Conducteur"], 14],
  ["Chauffeur", (it) => it["Conducteur"], 16],
  ["Description de l'événement", (it) => it["Description de l'événement"], 26],
  ["Date de départ", (it) => it["Date de départ"], 10],
  ["Heure de début", (it) => it["Heure de départ"], 10],
  ["Heure de fin", (it) => it["Heure de fin"], 10],
  ["Nbre d'occurrences", (it) => it["Nbre d'occurrences"], 8],
];

// Mêmes colonnes pour VITESSE et FREINAGE (les deux rapports OBC-seuil) --
// "Site Conducteur" affiche le champ "Groupe" de l'item, pas "Site
// Conducteur" (nom de champ différent entre 3AXIS et VITESSE/FREINAGE côté
// Mix Telematics).
const COLS_OBC = [
  ["Description du véhicule", (it) => it["Description du bien"], 22],
  ["Immatriculation", (it) => it["Immatriculation"], 14],
  ["Site Conducteur", (it) => it["Groupe"], 14],
  ["Chauffeur", (it) => it["Conducteur"], 16],
  ["ID du conducteur", (it) => it["ID du conducteur"], 12],
  ["Description de l'événement", (it) => it["Description de l'événement"], 26],
  ["Date de départ", (it) => it["Date de départ"], 10],
  ["Heure de début", (it) => it["Heure de départ"], 10],
  ["Heure de fin", (it) => it["Heure de fin"], 10],
  ["Nbre d'occurrences", (it) => it["Nbre d'occurrences"], 8],
];

const COLS_DECONNEXION = [
  ["Nom du site de l'actif", (it) => it["Nom du site de l'actif"], 16],
  ["Description du véhicule", (it) => it["Description du vehicule"], 22],
  ["Immatriculation", (it) => it["Immatriculation"], 14],
  ["Chauffeur", (it) => it["Chauffeur"], 16],
  ["Description de l'événement", (it) => it["Description de l'évenement"], 26],
  ["Start date", (it) => it["Start date"], 10],
  ["Heure de début", (it) => it["Heure de début"], 10],
  ["Heure de fin", (it) => it["Heure de fin"], 10],
  ["Nbre d'occurrences", (it) => it["Nbre d'occurrences"], 8],
];

const SIGNATURE_HTML = `
<table style="font-family:Arial,sans-serif;font-size:12px;margin-top:10px;">
  <tr>
    <td style="padding-right:16px;border-right:2px solid #cc0000;vertical-align:top;">
      <strong style="color:#cc0000;">ABA TECHNOLOGY</strong><br/>
      Supervision OBC<br/>
      <a href="http://www.abatechnology.ma" style="color:#cc0000;">www.abatechnology.ma</a>
    </td>
    <td style="padding-left:16px;vertical-align:top;">
      E: <a href="mailto:supervisionobc@abatechnology.ma">SUPERVISIONOBC@ABATECHNOLOGY.MA</a><br/>
      T: 0520603030<br/>
      A: Technopark 7th floor. Casablanca
    </td>
  </tr>
</table>`;

const REPORT_CONFIGS = {
  "DECONNEXION": {
    label: "DECONNEXION J-1",
    eventCols: COLS_DECONNEXION,
    hasTacho: false,
    hasTitle: false,
    imageMime: "image/jpeg",
    supportsTransporteur: true,

    subjectTemm: () => "RAPPORT DE DECONNEXION J-1",
    subjectTransporteur: ({ groupe }) => `RAPPORT DE DECONNEXION J-1 / ${groupe}`,
    pdfFileName: ({ monthFr, groupe }) => `RAPPORT DE DECONNEXION J-1 ${monthFr}${groupe ? ` ${groupe}` : ""}.pdf`,

    bodyTemm: ({ middleHtml, hasRecords }) => hasRecords
      ? `Bonjour,<br><br>Veuillez trouver ci-dessous le rapport suivi des événements de déconnexion J-1:<br><br>${middleHtml}<br><br>Cordialement.`
      : `Bonjour,<br><br>Je souhaite vous informer que nous n'avons aucune déconnexion signalée pour la période J-1.<br><br>Cordialement.`,
    bodyTransporteur: ({ middleHtml, groupe }) =>
      `Bonjour,<br><br>Veuillez trouver ci-dessous le rapport suivi des événements de déconnexion J-1 pour ${escapeHtml(groupe)} :<br><br>${middleHtml}<br><br>Cordialement.`,
  },

  "3AXIS": {
    label: "3 AXIS POSSIBLE ACCIDENT",
    eventCols: COLS_3AXIS,
    hasTacho: false,
    hasTitle: false,
    imageMime: "image/jpeg",
    supportsTransporteur: true,

    subjectTemm: ({ hour, isMorningCatchup }) =>
      isMorningCatchup ? "RAPPORT DES 3 AXIS POSSIBLE ACCIDENT J-1 05H30" : `RAPPORT DES 3 AXIS POSSIBLE ACCIDENT ${hour}H`,
    subjectTransporteur: ({ hour, isMorningCatchup, groupe }) =>
      (isMorningCatchup ? "RAPPORT DES 3 AXIS POSSIBLE ACCIDENT J-1 05H30" : `RAPPORT DES 3 AXIS POSSIBLE ACCIDENT ${hour}H`) + ` / ${groupe}`,
    pdfFileName: ({ monthFr, groupe }) => `RAPPORT DES 3 AXIS POSSIBLE ACCIDENT ${monthFr}${groupe ? ` ${groupe}` : ""}.pdf`,

    bodyTemm: ({ middleHtml, hasRecords }) => hasRecords
      ? `Bonjour,<br><br>Veuillez trouver ci-dessous le rapport suivi des événements 3 axis possible accident :<br><br>${middleHtml}<br>Cordialement,`
      : `Bonjour,<br><br>Je souhaite vous informer que nous n'avons aucune infraction signalée concernant le rapport des événements 3 axis possible accident.<br><br>Cordialement,`,
    bodyTransporteur: ({ middleHtml, groupe }) =>
      `Bonjour,<br><br>Veuillez trouver ci-dessous le rapport suivi des événements 3 axis possible accident pour ${escapeHtml(groupe)} :<br><br>${middleHtml}<br>Cordialement,`,
  },

  "VITESSE": {
    label: "EXCES DE VITESSE",
    eventCols: COLS_OBC,
    hasTacho: true,
    hasTitle: true,
    imageMime: "image/jpeg",
    supportsTransporteur: true,

    subjectTemm: ({ hour }) => `RAPPORT SUIVI DES INFRACTIONS EXCES DE VITESSE ${hour}H`,
    subjectTransporteur: ({ hour, groupe }) => `RAPPORT DES INFRACTIONS EXCES DE VITESSE ${hour}H / ${groupe}`,
    pdfFileName: ({ monthFr, groupe }) => `RAPPORT DES INFRACTIONS EXCES DE VITESSE${groupe ? ` ${groupe}` : ""}.pdf`,

    bodyTemm: ({ middleHtml, hasRecords }) =>
      `Bonjour,<br><br>Veuillez trouver ci-dessous le rapport suivi des infractions excès de vitesse :<br><br>${hasRecords ? middleHtml : "<p><em>Aucune infraction confirmée pour cette période.</em></p>"}`,
    bodyTransporteur: ({ middleHtml, driverLabel, driverNames }) =>
      `Bonjour,<br><br>En continuité des sensibilisation faites au niveau des dépôts de chargements et les causeries transférées, nous enregistrons des cas aberrants de survitesses pour ${driverLabel} : <strong>${escapeHtml(driverNames)}</strong><br><br>${middleHtml}<br><br>De ce fait, nous vous sollicitons d'intervenir en urgence de façon à y remédier à cette anomalie et que cette transgression de règle ne soit plus remontée ni reproduite.<br><br>Nous tenons à vous rappeler que chaque cas redondant courant la journée entraînera derrière des mesures disciplinaires très sévères. Merci d'en prendre note !<br><br>Nous vous informons également que ces infractions seront enregistrées comme événements HSE et seront comptabilisées dans votre performance HSE.<br><br>Merci de votre prise en considération.<br>${SIGNATURE_HTML}`,
  },

  "FREINAGE": {
    label: "FREINAGE ET ACCELERATION EXCESSIFS",
    eventCols: COLS_OBC,
    hasTacho: true,
    hasTitle: true,
    imageMime: "image/jpeg",
    supportsTransporteur: false,

    subjectTemm: ({ hour }) => `RAPPORT SUIVI DES INFRACTIONS FREINAGE ET ACCELERATION EXCESSIFS ${hour}H`,
    pdfFileName: ({ monthFr }) => `RAPPORT FREINAGE ET ACCELERATION EXCESSIFS.pdf`,

    bodyTemm: ({ middleHtml, hasRecords, records }) => {
      if (!hasRecords) {
        return `Bonjour,<br><br>Je souhaite vous informer que nous n'avons aucune infraction signalée concernant le rapport des Freinages excessifs et Accélération excessive .<br><br>Cordialement.`;
      }
      // Un seul enregistrement : message personnalisé nommant l'événement et
      // le conducteur, comme demandé -- pas de sens à faire pareil pour
      // plusieurs enregistrements (plusieurs événements/conducteurs
      // différents), donc ce cas retombe sur l'intro générique ci-dessous.
      if (records.length === 1) {
        const evenement = escapeHtml(records[0].item?.["Description de l'événement"] || "");
        const conducteur = escapeHtml(records[0].item?.["Conducteur"] || "");
        return `Bonjour,<br><br>Nous souhaitons attirer votre attention sur une situation inquiétante  de ${evenement}  de la part du conducteur nommé :${conducteur}<br><br>Nous vous prions de nous fournir des explications concernant cet événement :<br><br>${middleHtml}<br><br>Cordialement.`;
      }
      return `Bonjour,<br><br>Veuillez trouver ci-dessous le rapport suivi des infractions freinage excessif et accélération excessive :<br><br>${middleHtml}<br><br>Cordialement,`;
    },
  },
};

function getReportConfig(reportType) {
  const config = REPORT_CONFIGS[reportType];
  if (!config) throw new Error(`Unknown reportType: ${reportType}`);
  return config;
}

module.exports = { REPORT_CONFIGS, getReportConfig, escapeHtml };
