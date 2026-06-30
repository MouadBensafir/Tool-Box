"""
Map renderer — generates a PNG of a satellite map with a trajectory
polyline and an event popup, using Playwright + Leaflet.js.

No external API key is required by default (ESRI World Imagery tiles).
Set MAP_TILE_URL env var to override, e.g. for HERE hybrid:
  https://{s}.aerial.maps.ls.hereapi.com/maptile/2.1/maptile/newest/hybrid.day/{z}/{x}/{y}/256/png8?apiKey=KEY
"""

import json
import os
from typing import Any, Dict, List

from playwright.async_api import async_playwright

# ESRI World Imagery — satellite, no API key required
_DEFAULT_TILE_URL = (
    "https://server.arcgisonline.com/ArcGIS/rest/services"
    "/World_Imagery/MapServer/tile/{z}/{y}/{x}"
)

_MAP_WIDTH = 1100
_MAP_HEIGHT = 700

# ── HTML template ──────────────────────────────────────────────────────────────
# Dynamic values are injected as JS variables to avoid f-string / brace conflicts.

_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <link rel="stylesheet"
        href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    #map { width: MAP_WIDTHpx; height: MAP_HEIGHTpx; }

    /* Popup — compact, MiX Telematics style */
    .pb {
      font-family: Arial, sans-serif;
      font-size: 11px;
      min-width: 190px;
      max-width: 260px;
    }
    .pb-title {
      font-weight: bold;
      font-size: 12px;
      margin-bottom: 4px;
      padding-bottom: 3px;
      border-bottom: 1px solid #ddd;
    }
    .pb table { border-collapse: collapse; width: 100%; }
    .pb .pk {
      font-weight: bold;
      color: #222;
      padding: 1px 8px 1px 0;
      white-space: nowrap;
      vertical-align: top;
    }
    .pb .pv { color: #222; padding: 1px 0; vertical-align: top; }
  </style>
</head>
<body>
<div id="map"></div>
<script>
  var PINK       = '#d43089';
  var TILE_URL   = INJECT_TILE_URL;
  var CENTER     = INJECT_CENTER;
  var TRAJECTORY = INJECT_TRAJECTORY;
  var POPUP_HTML = INJECT_POPUP_HTML;

  /* Map centered on the event */
  var map = L.map('map', { zoomControl: true, attributionControl: false })
             .setView(CENTER, 17);

  L.tileLayer(TILE_URL, { maxZoom: 20 }).addTo(map);

  /* Trajectory polyline */
  if (TRAJECTORY.length > 0) {
    L.polyline(TRAJECTORY, { color: PINK, weight: 6, opacity: 1 }).addTo(map);
  }

  /* White circle markers at every recorded position */
  TRAJECTORY.forEach(function(pt) {
    L.circleMarker(pt, {
      radius:      5,
      fillColor:   '#ffffff',
      fillOpacity: 1,
      color:       PINK,
      weight:      2.5
    }).addTo(map);
  });

  /* Directional arrows along each segment (bearing-aware) */
  function bearing(a, b) {
    var lat1 = a[0] * Math.PI / 180, lat2 = b[0] * Math.PI / 180;
    var dLng = (b[1] - a[1]) * Math.PI / 180;
    return Math.atan2(
      Math.sin(dLng) * Math.cos(lat2),
      Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
    ) * 180 / Math.PI;
  }

  for (var i = 0; i < TRAJECTORY.length - 1; i++) {
    var p1 = TRAJECTORY[i], p2 = TRAJECTORY[i + 1];
    var mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    var angle = bearing(p1, p2);
    /* Arrow tip points up in SVG; rotate by bearing to align with road direction */
    L.marker(mid, {
      icon: L.divIcon({
        className: '',
        html: '<svg width="14" height="14" viewBox="0 0 14 14"'
            + '  xmlns="http://www.w3.org/2000/svg"'
            + '  style="display:block;transform:rotate(' + angle + 'deg)">'
            + '<path d="M7,1 L13,13 L7,9 L1,13 Z" fill="' + PINK + '"/>'
            + '</svg>',
        iconSize:   [14, 14],
        iconAnchor: [7, 7]
      }),
      interactive: false
    }).addTo(map);
  }

  /* Alarm triangle icon — pink, MiX style */
  var alarmIcon = L.divIcon({
    className: '',
    html: '<svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">'
        + '<polygon points="13,2 24,23 2,23" fill="' + PINK + '" stroke="#fff" stroke-width="1.5"/>'
        + '<text x="13" y="21" text-anchor="middle" font-size="13" font-weight="bold"'
        + '  fill="white" font-family="Arial,sans-serif">!</text>'
        + '</svg>',
    iconSize:    [26, 26],
    iconAnchor:  [13, 23],
    popupAnchor: [0, -26]
  });

  L.marker(CENTER, { icon: alarmIcon })
   .addTo(map)
   .bindPopup(POPUP_HTML, { maxWidth: 280, closeButton: false, autoClose: false })
   .openPopup();

  /* Blue flag marker at the start of the trip (first position) */
  if (TRAJECTORY.length > 0) {
    var startPt = TRAJECTORY[0];
    var flagIcon = L.divIcon({
      className: '',
      html: '<svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">'
          /* flagpole */
          + '<line x1="4" y1="2" x2="4" y2="31" stroke="#555" stroke-width="2" stroke-linecap="round"/>'
          /* flag body */
          + '<polygon points="4,2 22,8 4,16" fill="#2979ff" stroke="#1a56cc" stroke-width="0.8"/>'
          + '</svg>',
      iconSize:   [24, 32],
      iconAnchor: [4, 31]   /* tip of the pole sits on the coordinate */
    });
    L.marker(startPt, { icon: flagIcon, interactive: false }).addTo(map);
  }

  /* Truck marker at the end of the trip (last position) */
  if (TRAJECTORY.length > 0) {
    var endPt = TRAJECTORY[TRAJECTORY.length - 1];
    var truckIcon = L.divIcon({
      className: '',
      html: '<svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg">'
          + '<circle cx="15" cy="15" r="13" fill="white" stroke="#22bb22" stroke-width="2.5"/>'
          /* cargo body */
          + '<rect x="5" y="14" width="12" height="8" rx="1" fill="' + PINK + '"/>'
          /* cab */
          + '<rect x="16" y="11" width="8" height="11" rx="1.5" fill="' + PINK + '"/>'
          /* windshield */
          + '<rect x="17" y="12" width="6" height="5" rx="0.5" fill="white" opacity="0.55"/>'
          /* rear wheel */
          + '<circle cx="9" cy="23" r="2.5" fill="#444"/>'
          + '<circle cx="9" cy="23" r="1.2" fill="#ccc"/>'
          /* front wheel */
          + '<circle cx="20" cy="23" r="2.5" fill="#444"/>'
          + '<circle cx="20" cy="23" r="1.2" fill="#ccc"/>'
          + '</svg>',
      iconSize:   [30, 30],
      iconAnchor: [15, 15]
    });
    L.marker(endPt, { icon: truckIcon, interactive: false }).addTo(map);
  }
</script>
</body>
</html>
"""


def _build_popup_html(event: Dict[str, Any]) -> str:
    """Build the inner HTML for the event popup card (MiX Telematics style, French labels)."""
    date = event.get("date_depart", "")
    def _fmt_time(t: str) -> str:
        if not t:
            return ""
        return f"{date} {t} (WAT)".strip() if date else f"{t} (WAT)"

    fields = [
        ("Nom de l'événement :",      event.get("event_name", "")),
        ("Chauffeur :",               event.get("driver", "")),
        ("ID du conducteur :",        event.get("driver_id", "")),
        ("Actif :",                   event.get("asset", "")),
        ("Heure de début :",          _fmt_time(event.get("start_time", ""))),
        ("Heure de fin :",            _fmt_time(event.get("end_time", ""))),
        ("Durée :",                   event.get("duration", "")),
        ("Nom de la localisation :",  event.get("location_name", "")),
        ("Limitation de vitesse :",   event.get("speed_limit", "")),
    ]
    rows = "".join(
        f'<tr><td class="pk">{k}</td><td class="pv">{v}</td></tr>'
        for k, v in fields
        if v
    )
    return f'<div class="pb"><div class="pb-title">Début de l\'événement</div><table>{rows}</table></div>'


async def render_event_map(
    trajectory: List[List[float]],
    event: Dict[str, Any],
) -> bytes:
    """
    Render a satellite map with a trajectory polyline and event popup.

    :param trajectory: ordered list of [lat, lng] pairs (the vehicle route).
    :param event: dict with keys —
        lat, lng            (required — event pin location)
        event_name, driver, driver_id, asset, asset_id,
        start_time, end_time, duration, location_name  (optional — popup fields)
    :returns: PNG image as raw bytes.
    """
    tile_url = os.environ.get("MAP_TILE_URL", _DEFAULT_TILE_URL)
    center = [event["lat"], event["lng"]]
    popup_html = _build_popup_html(event)

    html = (
        _HTML_TEMPLATE
        .replace("MAP_WIDTH",         str(_MAP_WIDTH))
        .replace("MAP_HEIGHT",        str(_MAP_HEIGHT))
        .replace("INJECT_TILE_URL",   json.dumps(tile_url))
        .replace("INJECT_CENTER",     json.dumps(center))
        .replace("INJECT_TRAJECTORY", json.dumps(trajectory))
        .replace("INJECT_POPUP_HTML", json.dumps(popup_html))
    )

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=[
            "--no-sandbox",           # required when running as root in containers
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",  # /dev/shm is small in Railway containers
        ])
        page = await browser.new_page(
            viewport={"width": _MAP_WIDTH, "height": _MAP_HEIGHT}
        )
        await page.set_content(html, wait_until="domcontentloaded")
        # Wait for map tiles to finish loading over the network
        await page.wait_for_load_state("networkidle")
        png_bytes = await page.locator("#map").screenshot()
        await browser.close()

    return png_bytes
