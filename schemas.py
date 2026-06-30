from pydantic import BaseModel
from typing import Any, Dict, List, Optional


# ── Map rendering ──────────────────────────────────────────────────────────────

class EventInfo(BaseModel):
    lat: float
    lng: float
    # Map popup fields
    event_name: str = ""
    driver: str = ""        # Chauffeur (from trip positions)
    driver_id: str = ""     # ID du conducteur
    asset: str = ""         # Description du véhicule
    start_time: str = ""    # full datetime string, e.g. "30/06/2026 11:21:52 (WAT)"
    end_time: str = ""
    duration: str = ""
    location_name: str = ""
    speed_limit: str = ""
    # Extra fields for the event summary table above the map
    immatriculation: str = ""
    site: str = ""
    conducteur: str = ""    # Conducteur column (may differ from driver/chauffeur)
    date_depart: str = ""   # Date only, e.g. "30/06/2026"
    nbre_occurrences: int = 0
    event_value: str = ""   # e.g. "33,00"


class MapRenderRequest(BaseModel):
    # Ordered list of [lat, lng] pairs representing the vehicle trajectory
    trajectory: List[List[float]]
    event: EventInfo


class MapRenderResponse(BaseModel):
    # Base64-encoded PNG — embed in HTML as: <img src="data:image/png;base64,{image_b64}">
    image_b64: str


# ── Map + Email (combined) ─────────────────────────────────────────────────────

class EventMapEmailRequest(BaseModel):
    to_email: str
    cc_email: Optional[str] = None
    subject: str
    # HTML body — must contain __MAP__ where the satellite image will be injected
    body: str
    trajectory: List[List[float]]
    event: EventInfo


# ── Email ──────────────────────────────────────────────────────────────────────

class EmailRequest(BaseModel):
    to_email: str
    cc_email: Optional[str] = None
    subject: str
    # HTML body — must contain __TABLE__ where the generated table will be injected
    body: str
    # Array of flat objects; all objects must share the same keys
    table_data: List[Dict[str, Any]]
    # ETAT GPS only: name of the date column used to highlight rows ≠ today
    date_field: Optional[str] = "Date"
    # Override the default attachment filename (must end in .xlsx)
    filename: Optional[str] = None
    # Second table — used by endpoints that send two datasets (e.g. demarrage-tardif)
    # Body must contain __TABLE_1__ and __TABLE_2__ when this is provided
    table_data_2: Optional[List[Dict[str, Any]]] = None
    filename_2: Optional[str] = None


class SendEmailResponse(BaseModel):
    status: str = "sent"
    gmail_message_id: str


class AttachmentRequest(BaseModel):
    message_id: str
    attachment_id: str


class AttachmentResponse(BaseModel):
    data: List[Dict[str, Any]]
