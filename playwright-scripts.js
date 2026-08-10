// Playwright/Browserless script builders, one per report type -- ported
// verbatim from each Fusion workflow's own "Playwright Script" node. These
// are NOT unified into one shared function: a diff confirmed real
// behavioral differences between them (3AXIS targets a specific event by
// index + start-hour among several on the same row, expands ALL matching
// trip/subtrip rows rather than the first match, etc.) -- these are
// separately-tuned implementations, not copy-paste duplication, so keeping
// them distinct avoids silently changing behavior that was deliberately
// different.
//
// Each function takes the raw item + the Mix Telematics AuthToken (passed
// in per-request by Fusion, which already authenticates itself -- this
// service never stores its own Mix Telematics credentials) and returns the
// Browserless "function" script text to POST to chrome.browserless.io.

function buildPlaywrightScript3axis(item, authToken) {
  // 1. Dates dynamiques : journée complète de l'événement (le sélecteur de
  // dates de la plateforme attend le format JJ/MM/AAAA, identique à nos
  // propres champs "Date de départ"/"Date de fin").
  const dateFrom = `${item["Date de départ"]} 00:00`;
  const dateTo = `${item["Date de fin"] || item["Date de départ"]} 23:59`;

  // 2. Jeton d'authentification, plaque et événement ciblé — dynamiques eux
  // aussi (auparavant : valeurs de test codées en dur).
  const myToken = authToken;
  const myPlate = item["Immatriculation"];
  const targetEvent = item["Description de l'événement"];
  const targetstarthour = item["Heure de départ"];

  // 3. Zoom Configuration
  const zoomTicks = 5;

  // 4. Build the complete Browserless script
  const myScript = `
  export default async ({ page }) => {
    
    // ─── AUTHENTICATION & NAVIGATION ──────────────────────────────────────────
    await page.setCookie({
      name: 'token',
      value: '${myToken}',
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

    // ─── DATE INJECTION ───────────────────────────────────────────────────────
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
    
    // ─── SEARCH LOGIC ─────────────────────────────────────────────────────────
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

    // ─── STAGE 1: EXPAND THE MAIN VEHICLE ROW ─────────────────────────────────
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
      await new Promise(r => setTimeout(r, 1000)); 
    }
    
    // ─── STAGE 2: EXPAND ALL TRIP ROWS WITH EVENTS ────────────────────────────
    const clickedTrip = await page.evaluate(() => {
      const tripRows = document.querySelectorAll('tbody[ng-repeat="trip in asset.trips"] tr');
      let expandedAny = false; 
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
            expandedAny = true; 
          }
        }
      }
      return expandedAny;
    });

    if (clickedTrip) {
      await page.waitForSelector('tbody[ng-repeat="subTrip in trip.subTrips"]', { visible: true, timeout: 15000 });
      await new Promise(r => setTimeout(r, 1000)); 
    }

    // ─── STAGE 3: EXPAND ALL SUB-TRIP ROWS WITH EVENTS ────────────────────────
    const clickedSubTrip = await page.evaluate(() => {
      const subTripRows = document.querySelectorAll('tbody[ng-repeat="subTrip in trip.subTrips"] tr');
      let expandedAny = false; 
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
            expandedAny = true; 
          }
        }
      }
      return expandedAny;
    });

    if (clickedSubTrip) {
      await page.waitForSelector('tr[ng-repeat="event in subTrip.events"]', { visible: true, timeout: 15000 });
    }

    // ─── STAGE 4: DYNAMICALLY DETECT EVENT (AND INDEX) & OPEN MAP VIEW ─────────
    const stage4Result = await page.evaluate((targetEventName, targetStartTime) => {
      const eventRows = document.querySelectorAll('tr[ng-repeat="event in subTrip.events"]');
      
      // Normalize string
      const normalize = (str) => str.replace(/\\s+/g, ' ').trim().toUpperCase();
      const searchTarget = normalize(targetEventName);
      let currentIndex = 0;
      
      for (const eventRow of eventRows) {
        const rawText = eventRow.innerText || '';
        const cleanText = normalize(rawText);
        
        if (cleanText.includes(searchTarget) && rawText.includes(targetStartTime)) {
          const expandedContainer = eventRow.closest('tr[ui-if*="expanded"]');
          if (expandedContainer && expandedContainer.previousElementSibling) {
            const parentSubTripRow = expandedContainer.previousElementSibling;
            const threeDotsBtn = parentSubTripRow.querySelector('.btn-group .dropdown-toggle, a.btn-actions');
            if (threeDotsBtn) {
              threeDotsBtn.click();
              return { menuOpened: true, targetIndex: currentIndex };
            }
          }
        }
        currentIndex++;
      }
      return { menuOpened: false, targetIndex: 0 };
    }, ${JSON.stringify(targetEvent)}, ${JSON.stringify(targetstarthour)});

    const menuOpened = stage4Result.menuOpened;
    const targetEventIndex = stage4Result.targetIndex;

    // ─── EARLY EXIT: IF EVENT IS NOT FOUND ────────────────────────────────────
    if (!menuOpened) {
      return {
        success: false,
        message: "Target event not found in the current trip data."
      };
    }

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

    // ─── STAGE 5 & 6: PHYSICAL PAN & ZOOM ─────────────────────────────────────
    const getPanOffset = async (idx) => {
      return await page.evaluate((targetIdx) => {
        const mapEl = document.querySelector('#map-container, .right-pane, .leaflet-container') || document.body;
        const mapRect = mapEl.getBoundingClientRect();
        const mapCenter = { x: mapRect.left + (mapRect.width / 2), y: mapRect.top + (mapRect.height / 2) };

        const markers = Array.from(document.querySelectorAll('.leaflet-marker-icon, div[class*="event-icon"]'));
        const visibleMarkers = markers.filter(el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const className = (el.className || "").toLowerCase();
          const html = el.innerHTML.toLowerCase();
          const src = (el.src || "").toLowerCase();
          
          if (rect.width < 14 || rect.height < 14 || style.display === 'none' || style.visibility === 'hidden') return false;
          
          if (src.includes('start') || src.includes('end') || className.includes('start') || className.includes('end') || html.includes('start') || html.includes('end')) return false;

          return true;
        });

        if (visibleMarkers.length === 0) return null;
        
        const icon = visibleMarkers[targetIdx] || visibleMarkers[0];
        const iconRect = icon.getBoundingClientRect();
        const iconCenter = { x: iconRect.left + (iconRect.width / 2), y: iconRect.top + (iconRect.height / 2) };

        return {
          dx: mapCenter.x - iconCenter.x,
          dy: mapCenter.y - iconCenter.y,
          mapCenter: mapCenter,
          iconCenter: iconCenter,
          found: true
        };
      }, idx);
    };

    let offset = await getPanOffset(targetEventIndex);
    if (offset && offset.found) {
      const startX = offset.mapCenter.x - 100;
      const startY = offset.mapCenter.y - 100;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + offset.dx, startY + offset.dy, { steps: 15 });
      await page.mouse.up();
      await new Promise(r => setTimeout(r, 2000));
    }

    offset = await getPanOffset(targetEventIndex);
    if (offset && offset.found) {
      await page.mouse.move(offset.iconCenter.x, offset.iconCenter.y);
      await new Promise(r => setTimeout(r, 300));
      for (let i = 0; i < ${zoomTicks}; i++) {
        await page.mouse.wheel({ deltaY: -300 });
        await new Promise(r => setTimeout(r, 800)); 
      }
      await new Promise(r => setTimeout(r, 2000));

      offset = await getPanOffset(targetEventIndex);
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

    // ─── STAGE 7: PHYSICAL WARNING/CAMERA ICON CLICK & POPUP ANIMATION WAIT ───
    const iconCoords = await page.evaluate((targetIdx) => {
      const markers = Array.from(document.querySelectorAll('.leaflet-marker-icon, div[class*="event-icon"]'));
      
      const visibleMarkers = markers.filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const className = (el.className || "").toLowerCase();
        const html = el.innerHTML.toLowerCase();
        const src = (el.src || "").toLowerCase();
        
        if (rect.width < 14 || rect.height < 14 || style.display === 'none' || style.visibility === 'hidden') return false;
        
        if (src.includes('start') || src.includes('end') || className.includes('start') || className.includes('end') || html.includes('start') || html.includes('end')) return false;

        return true;
      });

      if (visibleMarkers.length === 0) return null;

      const targetMarker = visibleMarkers[targetIdx] || visibleMarkers[0];
      const targetRect = targetMarker.getBoundingClientRect();

      const html = targetMarker.innerHTML.toLowerCase();
      const className = (targetMarker.className || "").toLowerCase();
      const src = (targetMarker.src || "").toLowerCase();
      const isCamera = className.includes('camera') || html.includes('facetime') || html.includes('camera') || html.includes('video') || src.includes('camera');
      
      if (isCamera) {
        targetMarker.style.setProperty('pointer-events', 'none', 'important');
      }

      return {
        x: targetRect.left + (targetRect.width / 2),
        y: targetRect.top + (targetRect.height / 2),
        found: true
      };
    }, targetEventIndex);

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

    // ─── STAGE 8: MODAL CLEANUP ──────────────────────────────────────────────
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
    
    // ─── STAGE 9: CAPTURE AGGRESSIVELY CROPPED MAP ────────────────────────────
    const mapClip = await page.evaluate(() => {
      const mapEl = document.querySelector('#map-container, .right-pane, div[class*="map-container"], .leaflet-container') || document.body;
      const rect = mapEl.getBoundingClientRect();

      // Aggressive cuts to match the red box in the reference image
      // Cutting roughly 20% off the top, 30% off the bottom, and 5% off the sides
      const topCut = rect.height * 0.20;
      const bottomCut = rect.height * 0.30;
      const sideCut = rect.width * 0.05;

      return {
        x: Math.round(rect.left + sideCut),
        y: Math.round(rect.top + topCut),
        width: Math.round(rect.width - (sideCut * 2)),
        height: Math.round(rect.height - topCut - bottomCut)
      };
    });

    const screenshotBase64 = await page.screenshot({
      encoding: 'base64',
      clip: mapClip,
      type: 'jpeg',
      quality: 70
    });

    return {
      success: true,
      image: screenshotBase64
    };
  };
  `;

  return myScript;
}

function buildPlaywrightScriptVitesse(item, authToken) {
  // 1. Dates dynamiques : journée complète de l'événement (le sélecteur de
  // dates de la plateforme attend le format JJ/MM/AAAA, identique à nos
  // propres champs "Date de départ"/"Date de fin").
  const dateFrom = `${item["Date de départ"]} 00:00`;
  const dateTo = `${item["Date de fin"] || item["Date de départ"]} 23:59`;

  // 2. Jeton d'authentification, plaque et événement ciblé — dynamiques eux
  // aussi (auparavant : valeurs de test codées en dur).
  const myToken = authToken;
  const myPlate = item["Immatriculation"];
  const targetEvent = item["Description de l'événement"];

  // 3. Zoom Configuration
  const zoomTicks = 5;

  // 4. Build the complete Browserless script
  const myScript = `
  export default async ({ page }) => {
    
    // ─── AUTHENTICATION & NAVIGATION ──────────────────────────────────────────
    await page.setCookie({
      name: 'token',
      value: '${myToken}',
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

    // ─── DATE INJECTION ───────────────────────────────────────────────────────
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
    
    // ─── SEARCH LOGIC ─────────────────────────────────────────────────────────
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

    // ─── STAGE 1: EXPAND THE MAIN VEHICLE ROW (DYNAMIC TARGETING) ─────────────
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
        
        // Target the row with the event specifically
        if (hasVisibleEvent) {
          btn.click();
          return true;
        }
      }

      // Fallback: If no badges are found, just click the first visible expand button
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
    
    // ─── STAGE 2: EXPAND THE TRIP ROW WITH THE EVENT ─────────────────────────
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

    // ─── STAGE 3: EXPAND THE SUB-TRIP ROW WITH THE EVENT ─────────────────────
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

    // ─── STAGE 4: DYNAMICALLY DETECT EVENT & OPEN MAP VIEW ────────────────────
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

    // ─── STAGE 5 & 6: PHYSICAL PAN & ZOOM ─────────────────────────────────────
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

    // ─── STAGE 7: PHYSICAL WARNING ICON CLICK & POPUP ANIMATION WAIT ──────────
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

      // Sort by proximity to center screen to click the exact warning icon we zoomed into
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
      // Perform physical CDP mouse click to trigger native DOM events
      await page.mouse.move(iconCoords.x, iconCoords.y);
      await new Promise(r => setTimeout(r, 300));
      await page.mouse.down();
      await new Promise(r => setTimeout(r, 100));
      await page.mouse.up();
      
      // 1. Wait for Leaflet's popup text content to populate
      try {
        await page.waitForFunction(() => {
          const popupContent = document.querySelector('.leaflet-popup-content');
          return popupContent && popupContent.innerText.trim().length > 0;
        }, { timeout: 5000 });
      } catch (e) {}

      // 2. CRITICAL: 1500ms delay to allow CSS fade-in animation to finish completely
      await new Promise(r => setTimeout(r, 1500));
    }

    // ─── STAGE 8: MODAL CLEANUP ──────────────────────────────────────────────
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
    
    // ─── STAGE 9: CAPTURE CROPPED MAP ONLY ────────────────────────────────────
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

    // JPEG à qualité modérée au lieu de PNG : réduit le poids de chaque
    // capture d'environ 1-3 Mo à quelques centaines de Ko une fois en base64,
    // pour éviter la saturation mémoire quand plusieurs captures s'accumulent
    // dans la boucle (omitBackground ne s'applique qu'au PNG, retiré ici).
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

  return myScript;
}

function buildPlaywrightScriptFreinage(item, authToken) {
  // 1. Dates dynamiques : journée complète de l'événement (le sélecteur de
  // dates de la plateforme attend le format JJ/MM/AAAA, identique à nos
  // propres champs "Date de départ"/"Date de fin").
  const dateFrom = `${item["Date de départ"]} 00:00`;
  const dateTo = `${item["Date de fin"] || item["Date de départ"]} 23:59`;

  // 2. Jeton d'authentification, plaque et événement ciblé — dynamiques eux
  // aussi (auparavant : valeurs de test codées en dur).
  const myToken = authToken;
  const myPlate = item["Immatriculation"];
  const targetEvent = item["Description de l'événement"];

  // 3. Zoom Configuration
  const zoomTicks = 5;

  // 4. Build the complete Browserless script
  const myScript = `
  export default async ({ page }) => {
    
    // ─── AUTHENTICATION & NAVIGATION ──────────────────────────────────────────
    await page.setCookie({
      name: 'token',
      value: '${myToken}',
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

    // ─── DATE INJECTION ───────────────────────────────────────────────────────
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
    
    // ─── SEARCH LOGIC ─────────────────────────────────────────────────────────
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

    // ─── STAGE 1: EXPAND THE MAIN VEHICLE ROW ────────────────────────────────
    const mainExpandBtn = 'a[ng-click="expandOrCollapseAsset(asset)"]';
    await page.waitForSelector(mainExpandBtn, { visible: true, timeout: 15000 });
    await page.click(mainExpandBtn);

    await page.waitForSelector('tbody[ng-repeat="trip in asset.trips"]', { visible: true, timeout: 15000 });
    
    // ─── STAGE 2: EXPAND THE TRIP ROW WITH THE EVENT ─────────────────────────
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

    // ─── STAGE 3: EXPAND THE SUB-TRIP ROW WITH THE EVENT ─────────────────────
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

    // ─── STAGE 4: DYNAMICALLY DETECT EVENT & OPEN MAP VIEW ────────────────────
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

    // ─── STAGE 5 & 6: PHYSICAL PAN & ZOOM ─────────────────────────────────────
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

    // ─── STAGE 7: PHYSICAL WARNING ICON CLICK & POPUP ANIMATION WAIT ──────────
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

      // Sort by proximity to center screen to click the exact warning icon we zoomed into
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
      // Perform physical CDP mouse click to trigger native DOM events
      await page.mouse.move(iconCoords.x, iconCoords.y);
      await new Promise(r => setTimeout(r, 300));
      await page.mouse.down();
      await new Promise(r => setTimeout(r, 100));
      await page.mouse.up();
      
      // 1. Wait for Leaflet's popup text content to populate
      try {
        await page.waitForFunction(() => {
          const popupContent = document.querySelector('.leaflet-popup-content');
          return popupContent && popupContent.innerText.trim().length > 0;
        }, { timeout: 5000 });
      } catch (e) {}

      // 2. CRITICAL: 1500ms delay to allow CSS fade-in animation to finish completely
      await new Promise(r => setTimeout(r, 1500));
    }

    // ─── STAGE 8: MODAL CLEANUP ──────────────────────────────────────────────
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
    
    // ─── STAGE 9: CAPTURE CROPPED MAP ONLY ────────────────────────────────────
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

    // JPEG à qualité modérée au lieu de PNG : réduit le poids de chaque
    // capture d'environ 1-3 Mo à quelques centaines de Ko une fois en base64,
    // pour éviter la saturation mémoire quand plusieurs captures s'accumulent
    // dans la boucle (omitBackground ne s'applique qu'au PNG, retiré ici).
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

  return myScript;
}


module.exports = { buildPlaywrightScript3axis, buildPlaywrightScriptVitesse, buildPlaywrightScriptFreinage };
