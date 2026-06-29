from pydantic import BaseModel
from typing import Any, Dict, List, Optional


# ── Map rendering ──────────────────────────────────────────────────────────────

class EventInfo(BaseModel):
    lat: float
    lng: float
    event_name: str = ""
    driver: str = ""
    driver_id: str = ""
    asset: str = ""
    asset_id: str = ""
    start_time: str = ""
    end_time: str = ""
    duration: str = ""
    location_name: str = ""


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


class SendEmailResponse(BaseModel):
    status: str = "sent"
    gmail_message_id: str


class AttachmentRequest(BaseModel):
    message_id: str
    attachment_id: str


class AttachmentResponse(BaseModel):
    data: List[Dict[str, Any]]
