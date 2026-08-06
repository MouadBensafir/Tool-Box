// =====================================================================
// EXCES DE VITESSE — external violation processor
//
// Replaces the obsolete tool-box-production Railway app. Fusion AI's own
// execution model keeps every node's output resident in memory for the
// whole run, which crashes on large batches (300+ recap rows, 10+
// screenshots held simultaneously). This service does the same per-
// violation work (tachograph + positions fetch, OBC threshold/anomaly
// analysis, screenshot capture) in a normal Node process, where each
// iteration's data is garbage-collected as soon as it's no longer
// referenced -- Fusion calls this once per run with the list of already-
// deduped violations, and gets back one JSON array with each violation's
// verdict and (when retenue) its screenshot. Fusion still owns
// scheduling, dedup, recap building, attachment generation, and sending.
//
// Fusion already authenticates to Mix Telematics itself (Connexion Mix
// Telematics / Authentification) -- the raw AuthToken is passed in on
// every request rather than this service holding its own Mix Telematics
// credentials.
// =====================================================================

const express = require("express");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SERVICE_API_KEY; // shared secret Fusion must send back
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "2UoKl0rUOpJjz9z21c35decfd944b92e9766a965a6a2e00d8";
const ORG_ID = "-6230425177667903426";

// ---------------------------------------------------------------------
// Ported from the live Fusion nodes (VITESSE workflow), unchanged logic.
// ---------------------------------------------------------------------

// Port of "URL"
function buildTachoUrl(item) {
  const assetId = item["ID du véhicule"];
  const siteId = item["ID du site"];

  function toIso(dateStr, timeStr) {
    const [d, m, y] = dateStr.split("/");
    const [h, mi, s = "00"] = timeStr.split(":");
    return `${y}-${m}-${d}T${h}:${mi}:${s}`;
  }

  const from = toIso(item["Date de départ"], item["Heure de départ"]);
  const to = toIso(item["Date de fin"] || item["Date de départ"], item["Heure de fin"]);

  return `https://za.mixtelematics.com/DynaMiX.API/timeline/sites/${siteId}/asset/${assetId}/tacho?excludeEvents=false&from=${from}&to=${to}`;
}

// Port of "URL Positions" (event-scoped ±6min window fix)
function buildPositionsRequest(item) {
  function parseEventTimeMs(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    const [d, m, y] = dateStr.split("/");
    const [hh, mi, ss] = timeStr.split(":");
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mi), Number(ss || 0));
  }

  const thisStartMs = parseEventTimeMs(item["Date de départ"], item["Heure de départ"]);
  const thisEndMs = parseEventTimeMs(item["Date de fin"] || item["Date de départ"], item["Heure de fin"]);

  const WINDOW_MS = 6 * 60 * 1000;
  const startMs = thisStartMs ?? thisEndMs;
  const endMs = thisEndMs ?? thisStartMs;
  const fromMs = startMs - WINDOW_MS;
  const toMs = endMs + WINDOW_MS;

  function fmtIso(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  return {
    url: `https://za.mixtelematics.com/DynaMiX.API/tracking/organisations/${ORG_ID}/asset/positions`,
    body: {
      entityId: String(item["ID du véhicule"]),
      from: { IsoDateTimeString: fmtIso(fromMs), TimeZoneName: "W. Central Africa Standard Time", TimeZoneShortCode: "WAT" },
      to: { IsoDateTimeString: fmtIso(toMs), TimeZoneName: "W. Central Africa Standard Time", TimeZoneShortCode: "WAT" },
    },
  };
}

// Port of "Analyse OBC"
const SEUILS = {
  "Autoroute Alerte": { seuil: 86, duree: 20 },
  "Autoroute Alarme": { seuil: 92, duree: 10 },
  "Survitesse Agglomération Agouim Alert SSE": { seuil: 36, duree: 20 },
  "Survitesse Agglomération Agouim Alarm SSE": { seuil: 42, duree: 10 },
  "Survitesse AgglomerationSSE | Alert": { seuil: 36, duree: 20 },
  "Survitesse AgglomerationSSE | Alarm": { seuil: 42, duree: 10 },
  "Survitesse personnalisée 30 Km/h SSE Alert": { seuil: 36, duree: 20 },
  "Survitesse personnalisée 30 Km/h SSE Alarm": { seuil: 42, duree: 10 },
  "Survitesse personnalisée 40Km/h SSE Alert": { seuil: 46, duree: 20 },
  "Survitesse personnalisée 40Km/h SSE Alarm": { seuil: 52, duree: 10 },
  "Survitesse personnalisée 50km/h SSE Alert": { seuil: 56, duree: 20 },
  "Survitesse personnalisée 50km/h SSE Alarm": { seuil: 62, duree: 10 },
  "Survitesse personnalisée 60Km/h SSE Alert": { seuil: 66, duree: 20 },
  "Survitesse personnalisée 60Km/h SSE Alarm": { seuil: 72, duree: 10 },
  "Survitesse Route Agouim Nord Alert SSE": { seuil: 46, duree: 20 },
  "Survitesse Route Agouim Nord Alarm SSE": { seuil: 52, duree: 10 },
  "Survitesse Route Agouim Sud Alert SSE": { seuil: 46, duree: 20 },
  "Survitesse Route Agouim Sud Alarm SSE": { seuil: 52, duree: 10 },
  "Survitesse Route prioritaire SSE | Alert": { seuil: 76, duree: 20 },
  "Survitesse Route prioritaire SSE | Alarm": { seuil: 82, duree: 10 },
  "Survitesse Route secondaire SSE | Alert": { seuil: 66, duree: 20 },
  "Survitesse Route secondaire SSE | Alarm": { seuil: 72, duree: 10 },
};

function isReadingArray(arr) {
  return Array.isArray(arr) && arr.length > 0 && arr.every((r) => r && typeof r === "object" && "TimeOffset" in r && "Value" in r);
}
function findChannel(node, inputId, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (node.InputId === inputId) {
    for (const key of Object.keys(node)) {
      if (isReadingArray(node[key])) return node[key];
    }
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const el of val) {
        const found = findChannel(el, inputId, seen);
        if (found) return found;
      }
    } else if (val && typeof val === "object") {
      const found = findChannel(val, inputId, seen);
      if (found) return found;
    }
  }
  return null;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function analyseObc(item, tacho, positions) {
  function finalize(obcText, infractionAveree, extra = {}) {
    return { ...item, "Analyse OBC": obcText, "Infraction avérée": infractionAveree, ...extra };
  }

  if (!tacho) {
    return finalize("Tachygraphe indisponible pour cet événement.", "non retenue");
  }

  const speedSeries = findChannel(tacho, "Speed") || [];
  const rpmSeries = findChannel(tacho, "RPM") || [];

  if (!speedSeries.length) {
    return finalize("Données de vitesse indisponibles dans le tachygraphe.", "non retenue");
  }

  const speedValues = speedSeries.map((r) => r.Value);
  const rpmValues = rpmSeries.map((r) => r.Value);
  const isConstant = (values) => values.length > 0 && values.every((v) => v === values[0]);

  if (isConstant(speedValues) && rpmValues.length > 0 && isConstant(rpmValues)) {
    return finalize("D'après notre analyse, il s'agit d'une déconnexion suspecte.", "non retenue");
  }

  if (rpmValues.length > 0 && isConstant(rpmValues) && !isConstant(speedValues)) {
    return finalize("D'après notre analyse, il s'agit d'un problème lié au tour de moteur.", "non retenue");
  }

  if (positions && positions.length >= 2) {
    const sorted = [...positions].sort((a, b) => new Date(a.TimeStamp.DateTime) - new Date(b.TimeStamp.DateTime));

    const FREEZE_RADIUS_M = 30;
    const MIN_SPEED_FOR_ANOMALY = 15;
    const MIN_FREEZE_SECONDS = 60;
    const MAX_PLAUSIBLE_KMH = 180;

    let clusterStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
      const stillInCluster =
        i < sorted.length &&
        haversineM(
          sorted[clusterStart].LatLng.Latitude, sorted[clusterStart].LatLng.Longitude,
          sorted[i].LatLng.Latitude, sorted[i].LatLng.Longitude
        ) <= FREEZE_RADIUS_M;

      if (!stillInCluster) {
        const clusterEnd = i - 1;
        if (clusterEnd > clusterStart) {
          const durationSec = (new Date(sorted[clusterEnd].TimeStamp.DateTime) - new Date(sorted[clusterStart].TimeStamp.DateTime)) / 1000;
          const clusterPoints = sorted.slice(clusterStart, clusterEnd + 1);
          const maxSpeedInCluster = Math.max(...clusterPoints.map((p) => p.SpeedKph ?? 0));
          if (durationSec >= MIN_FREEZE_SECONDS && maxSpeedInCluster >= MIN_SPEED_FOR_ANOMALY) {
            return finalize("D'après notre analyse, la position GPS est restée figée pendant que le véhicule rapportait une vitesse non nulle : il s'agit d'une déconnexion suspecte.", "non retenue");
          }
        }
        clusterStart = i;
      }
    }

    for (let i = 1; i < sorted.length; i++) {
      const dtSec = (new Date(sorted[i].TimeStamp.DateTime) - new Date(sorted[i - 1].TimeStamp.DateTime)) / 1000;
      if (dtSec <= 0) continue;
      const distKm = haversineM(
        sorted[i - 1].LatLng.Latitude, sorted[i - 1].LatLng.Longitude,
        sorted[i].LatLng.Latitude, sorted[i].LatLng.Longitude
      ) / 1000;
      const impliedKmh = distKm / (dtSec / 3600);
      if (impliedKmh > MAX_PLAUSIBLE_KMH) {
        return finalize("D'après notre analyse, un saut de position GPS physiquement impossible a été détecté : il s'agit d'une déconnexion suspecte.", "non retenue");
      }
    }
  }

  function findRule(eventName) {
    const name = (eventName || "").trim();
    if (SEUILS[name]) return SEUILS[name];
    let bestKey = null;
    for (const key of Object.keys(SEUILS)) {
      if (name.includes(key) && (!bestKey || key.length > bestKey.length)) bestKey = key;
    }
    return bestKey ? SEUILS[bestKey] : null;
  }
  const rule = findRule(item["Description de l'événement"]);
  if (!rule) {
    return finalize(`Type d'événement non reconnu : "${item["Description de l'événement"]}".`, "non retenue");
  }

  let maxRun = 0;
  let currentRun = 0;
  let prevOffset = null;
  for (const reading of speedSeries) {
    if (reading.Value >= rule.seuil) {
      if (prevOffset !== null && reading.TimeOffset - prevOffset > 1.5) currentRun = 0;
      currentRun += 1;
      maxRun = Math.max(maxRun, currentRun);
      prevOffset = reading.TimeOffset;
    } else {
      currentRun = 0;
      prevOffset = null;
    }
  }

  const depasse = maxRun >= rule.duree;
  const obcText = depasse
    ? `D'après notre analyse le conducteur a dépassé la limitation de vitesse de ${rule.seuil}km/h pendant ${rule.duree}s`
    : `D'après notre analyse le conducteur n'a pas dépassé la limitation de vitesse de ${rule.seuil}km/h pendant ${rule.duree}s`;

  return finalize(obcText, depasse ? "retenue" : "non retenue", depasse ? { dureeSeuil: rule.duree } : {});
}

// Port of "Playwright Script" -- builds the Browserless function-script text.
function buildPlaywrightScript(item, authToken) {
  const dateFrom = `${item["Date de départ"]} 00:00`;
  const dateTo = `${item["Date de fin"] || item["Date de départ"]} 23:59`;
  const myPlate = item["Immatriculation"];
  const targetEvent = item["Description de l'événement"];
  const zoomTicks = 5;

  return `
export default async ({ page }) => {

  await page.setCookie({
    name: 'token',
    value: '${authToken}',
    domain: '.mixtelematics.com',
    path: '/',
    secure: true,
    sameSite: 'Lax'
  });

  await page.setViewport({ width: 1920, height: 1080 });

  await page.goto('https://za.mixtelematics.com/#/tracking/historical-tracking', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  try {
    await page.waitForSelector('body', { timeout: 15000 });
  } catch (error) {
    return { success: false, error: "Dashboard took too long to load" };
  }

  const loadingOverlay = 'div.loading-overlay';

  await page.waitForSelector('#fleet-date-range-link', { visible: true });
  await page.click('#fleet-date-range-link');

  const fromInput = 'div[ng-model="range[0]"] input[type="text"]';
  const toInput = 'div[ng-model="range[1]"] input[type="text"]';

  await page.waitForSelector(fromInput, { visible: true });

  await page.click(fromInput);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(fromInput, '${dateFrom}', { delay: 50 });
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 500));

  await page.click(toInput);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(toInput, '${dateTo}', { delay: 50 });
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 500));

  const saveButton = 'a[ng-click="save()"]';
  await page.waitForSelector(saveButton, { visible: true });
  await page.click(saveButton);

  await new Promise(r => setTimeout(r, 1000));
  await page.waitForSelector(loadingOverlay, { hidden: true, timeout: 30000 });

  const searchInput = '.search-box input[type="text"]';
  await page.waitForSelector(searchInput, { visible: true, timeout: 15000 });

  await page.click(searchInput);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(searchInput, ${JSON.stringify(myPlate)}, { delay: 50 });

  await page.keyboard.press('Enter');

  try {
    await new Promise(r => setTimeout(r, 500));
    await page.waitForSelector(loadingOverlay, { hidden: true, timeout: 15000 });
  } catch(e) {}

  await page.waitForFunction(() => {
    return document.querySelectorAll('a[ng-click="expandOrCollapseAsset(asset)"]').length > 0;
  }, { timeout: 15000 }).catch(() => {});

  const clickedAsset = await page.evaluate(() => {
    const expandBtns = document.querySelectorAll('a[ng-click="expandOrCollapseAsset(asset)"]');

    for (const btn of expandBtns) {
      if (btn.getBoundingClientRect().width === 0 || window.getComputedStyle(btn).display === 'none') continue;

      const row = btn.closest('tr') || btn.closest('tbody');
      if (!row) continue;

      const icons = row.querySelectorAll('i[class*="icon-camera"], i[class*="icon-warning-sign"], i[class*="icon-facetime-video"]');
      const badges = row.querySelectorAll('.badge');
      let hasVisibleEvent = false;

      icons.forEach(icon => {
        if (icon.getBoundingClientRect().width > 0 && window.getComputedStyle(icon).display !== 'none') hasVisibleEvent = true;
      });

      badges.forEach(badge => {
        const text = badge.innerText.trim();
        if (badge.getBoundingClientRect().width > 0 && window.getComputedStyle(badge).display !== 'none' && text !== '' && parseInt(text, 10) > 0) hasVisibleEvent = true;
      });

      if (hasVisibleEvent) {
        btn.click();
        return true;
      }
    }

    for (const btn of expandBtns) {
      if (btn.getBoundingClientRect().width > 0 && window.getComputedStyle(btn).display !== 'none') {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (clickedAsset) {
    await page.waitForSelector('tbody[ng-repeat="trip in asset.trips"]', { visible: true, timeout: 15000 });
  }

  const clickedTrip = await page.evaluate(() => {
    const tripRows = document.querySelectorAll('tbody[ng-repeat="trip in asset.trips"] tr');
    for (const row of tripRows) {
      const icons = row.querySelectorAll('i[class*="icon-camera"], i[class*="icon-warning-sign"], i[class*="icon-facetime-video"]');
      const badges = row.querySelectorAll('.badge');
      let hasVisibleEvent = false;

      icons.forEach(icon => {
        if (icon.getBoundingClientRect().width > 0 && window.getComputedStyle(icon).display !== 'none') hasVisibleEvent = true;
      });

      badges.forEach(badge => {
        const text = badge.innerText.trim();
        if (badge.getBoundingClientRect().width > 0 && window.getComputedStyle(badge).display !== 'none' && text !== '' && parseInt(text, 10) > 0) hasVisibleEvent = true;
      });

      if (hasVisibleEvent) {
        const expandLink = row.querySelector('a[ng-click*="trip.expanded"]');
        if (expandLink) {
          expandLink.click();
          return true;
        }
      }
    }
    return false;
  });

  if (clickedTrip) {
    await page.waitForSelector('tbody[ng-repeat="subTrip in trip.subTrips"]', { visible: true, timeout: 15000 });
  }

  const clickedSubTrip = await page.evaluate(() => {
    const subTripRows = document.querySelectorAll('tbody[ng-repeat="subTrip in trip.subTrips"] tr');
    for (const row of subTripRows) {
      const icons = row.querySelectorAll('i[class*="icon-camera"], i[class*="icon-warning-sign"], i[class*="icon-facetime-video"]');
      const badges = row.querySelectorAll('.badge');
      let hasVisibleEvent = false;

      icons.forEach(icon => {
        if (icon.getBoundingClientRect().width > 0 && window.getComputedStyle(icon).display !== 'none') hasVisibleEvent = true;
      });

      badges.forEach(badge => {
        const text = badge.innerText.trim();
        if (badge.getBoundingClientRect().width > 0 && window.getComputedStyle(badge).display !== 'none' && text !== '' && parseInt(text, 10) > 0) hasVisibleEvent = true;
      });

      if (hasVisibleEvent) {
        const expandLink = row.querySelector('a[ng-click*="subTrip.expanded"]');
        if (expandLink) {
          expandLink.click();
          return true;
        }
      }
    }
    return false;
  });

  if (clickedSubTrip) {
    await page.waitForSelector('tr[ng-repeat="event in subTrip.events"]', { visible: true, timeout: 15000 });
  }

  const menuOpened = await page.evaluate((targetEventName) => {
    const eventRows = document.querySelectorAll('tr[ng-repeat="event in subTrip.events"]');
    const searchTarget = targetEventName.toUpperCase();

    for (const eventRow of eventRows) {
      const text = eventRow.innerText || '';
      if (text.toUpperCase().includes(searchTarget)) {
        const expandedContainer = eventRow.closest('tr[ui-if*="expanded"]');
        if (expandedContainer && expandedContainer.previousElementSibling) {
          const parentSubTripRow = expandedContainer.previousElementSibling;
          const threeDotsBtn = parentSubTripRow.querySelector('.btn-group .dropdown-toggle, a.btn-actions');
          if (threeDotsBtn) {
            threeDotsBtn.click();
            return true;
          }
        }
      }
    }
    return false;
  }, ${JSON.stringify(targetEvent)});

  let mapClicked = false;
  if (menuOpened) {
    await new Promise(r => setTimeout(r, 500));

    mapClicked = await page.evaluate(() => {
      const openDropdown = document.querySelector('.btn-group.open, .dropdown.open, div[class*="open"]');
      if (openDropdown) {
        const mapLink = openDropdown.querySelector('a[ng-click*="showSubTripOnMap"]');
        if (mapLink) {
          mapLink.click();
          return true;
        }
      }
      const allMapLinks = document.querySelectorAll('a[ng-click*="showSubTripOnMap"]');
      for (const link of allMapLinks) {
        if (link.getBoundingClientRect().height > 0 && window.getComputedStyle(link).display !== 'none') {
          link.click();
          return true;
        }
      }
      return false;
    });

    try {
      await new Promise(r => setTimeout(r, 1000));
      await page.waitForSelector(loadingOverlay, { hidden: true, timeout: 20000 });
    } catch(e) {}

    await new Promise(r => setTimeout(r, 5000));
  }

  const getPanOffset = async () => {
    return await page.evaluate(() => {
      const mapEl = document.querySelector('#map-container, .right-pane, .leaflet-container') || document.body;
      const mapRect = mapEl.getBoundingClientRect();
      const mapCenter = { x: mapRect.left + (mapRect.width / 2), y: mapRect.top + (mapRect.height / 2) };

      const icon = document.querySelector('div.map-event-icon, div.event-icon-deeppink, div[class*="event-icon"]');
      if (!icon) return null;

      const iconRect = icon.getBoundingClientRect();
      const iconCenter = { x: iconRect.left + (iconRect.width / 2), y: iconRect.top + (iconRect.height / 2) };

      return {
        dx: mapCenter.x - iconCenter.x,
        dy: mapCenter.y - iconCenter.y,
        mapCenter: mapCenter,
        iconCenter: iconCenter,
        found: true
      };
    });
  };

  let offset = await getPanOffset();
  if (offset && offset.found) {
    const startX = offset.mapCenter.x - 100;
    const startY = offset.mapCenter.y - 100;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + offset.dx, startY + offset.dy, { steps: 15 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 2000));
  }

  offset = await getPanOffset();
  if (offset && offset.found) {
    await page.mouse.move(offset.iconCenter.x, offset.iconCenter.y);
    await new Promise(r => setTimeout(r, 300));
    for (let i = 0; i < ${zoomTicks}; i++) {
      await page.mouse.wheel({ deltaY: -300 });
      await new Promise(r => setTimeout(r, 800));
    }
    await new Promise(r => setTimeout(r, 2000));

    offset = await getPanOffset();
    if (offset && offset.found && (Math.abs(offset.dx) > 5 || Math.abs(offset.dy) > 5)) {
      const startX = offset.mapCenter.x - 50;
      const startY = offset.mapCenter.y - 50;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + offset.dx, startY + offset.dy, { steps: 10 });
      await page.mouse.up();
    }
    await page.mouse.move(10, 10);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await new Promise(r => setTimeout(r, 3500));
  }

  const iconCoords = await page.evaluate(() => {
    const markers = Array.from(document.querySelectorAll('.leaflet-marker-icon, div[class*="event-icon"]'));

    const visibleMarkers = markers.filter(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const className = (el.className || "").toLowerCase();
      const html = el.innerHTML.toLowerCase();
      const src = (el.src || "").toLowerCase();

      if (rect.width < 14 || rect.height < 14 || style.display === 'none' || style.visibility === 'hidden') return false;
      if (className.includes('camera') || html.includes('facetime') || html.includes('camera') || html.includes('video') || src.includes('camera')) return false;
      if (src.includes('start') || src.includes('end') || className.includes('start') || className.includes('end') || html.includes('start') || html.includes('end')) return false;

      return true;
    });

    if (visibleMarkers.length === 0) return null;

    const mapEl = document.querySelector('#map-container, .right-pane, .leaflet-container') || document.body;
    const mapRect = mapEl.getBoundingClientRect();
    const mapCenter = { x: mapRect.left + (mapRect.width / 2), y: mapRect.top + (mapRect.height / 2) };

    visibleMarkers.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      const distA = Math.hypot((rectA.left + rectA.width / 2) - mapCenter.x, (rectA.top + rectA.height / 2) - mapCenter.y);
      const distB = Math.hypot((rectB.left + rectB.width / 2) - mapCenter.x, (rectB.top + rectB.height / 2) - mapCenter.y);
      return distA - distB;
    });

    const targetRect = visibleMarkers[0].getBoundingClientRect();
    return {
      x: targetRect.left + (targetRect.width / 2),
      y: targetRect.top + (targetRect.height / 2),
      found: true
    };
  });

  if (iconCoords && iconCoords.found) {
    await page.mouse.move(iconCoords.x, iconCoords.y);
    await new Promise(r => setTimeout(r, 300));
    await page.mouse.down();
    await new Promise(r => setTimeout(r, 100));
    await page.mouse.up();

    try {
      await page.waitForFunction(() => {
        const popupContent = document.querySelector('.leaflet-popup-content');
        return popupContent && popupContent.innerText.trim().length > 0;
      }, { timeout: 5000 });
    } catch (e) {}

    await new Promise(r => setTimeout(r, 1500));
  }

  let modalClosed = false;
  try {
    const closeBtnSelector = 'button.close, button[ng-click*="$modal.close"]';
    const closeBtn = await page.$(closeBtnSelector);
    if (closeBtn) {
      const isVisible = await page.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
      }, closeBtn);
      if (isVisible) {
        await page.click(closeBtnSelector);
        modalClosed = true;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch (e) {}

  const mapClip = await page.evaluate(() => {
    const mapEl = document.querySelector('#map-container, .right-pane, div[class*="map-container"]') || document.body;
    const rect = mapEl.getBoundingClientRect();
    const bottomCut = 100;
    const topBuffer = 5;
    const sideBuffer = 2;
    return {
      x: Math.round(rect.left + sideBuffer),
      y: Math.round(rect.top + topBuffer),
      width: Math.round(rect.width - (sideBuffer * 2)),
      height: Math.round(rect.height - bottomCut - topBuffer)
    };
  });

  const screenshotBase64 = await page.screenshot({
    encoding: 'base64',
    clip: mapClip,
    type: 'jpeg',
    quality: 70
  });

  return {
    image: screenshotBase64
  };
};
`;
}

// ---------------------------------------------------------------------
// Per-violation processing (sequential -- simplest, safest first version;
// bounded concurrency can be added later once this is validated).
// ---------------------------------------------------------------------

async function fetchTacho(item, cookie) {
  const url = buildTachoUrl(item);
  const res = await fetch(url, {
    method: "GET",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchPositions(item, cookie) {
  const { url, body } = buildPositionsRequest(item);
  const res = await fetch(url, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.Positions ?? null;
}

async function captureScreenshot(item, authToken) {
  const script = buildPlaywrightScript(item, authToken);
  const res = await fetch(`https://chrome.browserless.io/function?token=${BROWSERLESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: script }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.image ?? null;
}

async function processViolation(item, authToken, cookie) {
  try {
    const tacho = await fetchTacho(item, cookie);
    const positions = await fetchPositions(item, cookie);
    const analysed = analyseObc(item, tacho, positions);

    if (analysed["Infraction avérée"] === "retenue") {
      try {
        const screenshot = await captureScreenshot(analysed, authToken);
        return { ...analysed, screenshot: screenshot || null };
      } catch (e) {
        return { ...analysed, screenshot: null, screenshotError: String(e?.message || e) };
      }
    }

    return { ...analysed, screenshot: null };
  } catch (e) {
    // Un échec sur UNE violation ne doit jamais faire tomber tout le lot.
    return { ...item, "Analyse OBC": `Erreur de traitement : ${String(e?.message || e)}`, "Infraction avérée": "non retenue", screenshot: null };
  }
}

// ---------------------------------------------------------------------
// HTTP endpoint
// ---------------------------------------------------------------------

app.post("/process-violations", async (req, res) => {
  if (API_KEY && req.get("X-API-Key") !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { authToken, violations } = req.body || {};
  if (!authToken || typeof authToken !== "string") {
    return res.status(400).json({ error: "Missing authToken" });
  }
  if (!Array.isArray(violations)) {
    return res.status(400).json({ error: "Missing violations array" });
  }

  const cookie = `token=${authToken}`;
  const results = [];
  for (const item of violations) {
    const result = await processViolation(item, authToken, cookie);
    results.push(result);
  }

  res.json({ results });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}

module.exports = { app, buildTachoUrl, buildPositionsRequest, analyseObc, buildPlaywrightScript, processViolation };
