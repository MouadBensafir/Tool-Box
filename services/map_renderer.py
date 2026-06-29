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

_MAP_WIDTH = 760
_MAP_HEIGHT = 500
_ZOOM = 17

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
    .pb { font-family: Arial, sans-serif; font-size: 12px; min-width: 220px; }
    .pb-title {
      font-weight: bold; font-size: 13px;
      margin-bottom: 5px; padding-bottom: 4px;
      border-bottom: 1px solid #ccc;
    }
    .pb table { border-collapse: collapse; width: 100%; }
    .pb .pk {
      color: #555; font-weight: bold;
      padding: 1px 10px 1px 0;
      white-space: nowrap; vertical-align: top;
    }
    .pb .pv { color: #111; padding: 1px 0; vertical-align: top; }
  </style>
</head>
<body>
<div id="map"></div>
<script>
  var TILE_URL   = INJECT_TILE_URL;
  var CENTER     = INJECT_CENTER;
  var ZOOM       = INJECT_ZOOM;
  var TRAJECTORY = INJECT_TRAJECTORY;
  var POPUP_HTML = INJECT_POPUP_HTML;

  var map = L.map('map', { zoomControl: true, attributionControl: false })
             .setView(CENTER, ZOOM);

  L.tileLayer(TILE_URL, { maxZoom: 20 }).addTo(map);

  if (TRAJECTORY.length > 1) {
    L.polyline(TRAJECTORY, { color: '#e91e8c', weight: 5, opacity: 0.9 })
     .addTo(map);
  }

  L.popup({ maxWidth: 320, closeButton: false, autoClose: false })
   .setLatLng(CENTER)
   .setContent(POPUP_HTML)
   .addTo(map);
</script>
</body>
</html>
"""


def _build_popup_html(event: Dict[str, Any]) -> str:
    """Build the inner HTML for the event popup card."""
    fields = [
        ("Event name",    event.get("event_name", "")),
        ("Driver",        event.get("driver", "")),
        ("Driver ID",     event.get("driver_id", "")),
        ("Asset",         event.get("asset", "")),
        ("Asset ID",      event.get("asset_id", "")),
        ("Start time",    event.get("start_time", "")),
        ("End time",      event.get("end_time", "")),
        ("Duration",      event.get("duration", "")),
        ("Location name", event.get("location_name", "")),
    ]
    rows = "".join(
        f'<tr><td class="pk">{k}</td><td class="pv">{v}</td></tr>'
        for k, v in fields
        if v
    )
    return f'<div class="pb"><div class="pb-title">Event start</div><table>{rows}</table></div>'


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
        .replace("INJECT_ZOOM",       str(_ZOOM))
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
