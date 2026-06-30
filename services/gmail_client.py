"""
Gmail client — send emails and fetch/parse attachments.

Auth flow
---------
The microservice owns the Gmail credentials (client_id, client_secret,
refresh_token). Before every Gmail API call it exchanges the refresh token
for a short-lived access token via the Google OAuth2 token endpoint.

Credentials are read from environment variables:
  GMAIL_CLIENT_ID
  GMAIL_CLIENT_SECRET
  GMAIL_REFRESH_TOKEN

Required OAuth2 scopes on the refresh token:
  https://www.googleapis.com/auth/gmail.send
  https://www.googleapis.com/auth/gmail.readonly
"""

import base64
import io
import os
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
from typing import Any, Dict, List, Optional, Tuple

import httpx
import openpyxl

GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
GMAIL_ATTACHMENT_URL = (
    "https://gmail.googleapis.com/gmail/v1/users/me"
    "/messages/{message_id}/attachments/{attachment_id}"
)


def _get_credentials() -> tuple[str, str, str]:
    """Read Gmail OAuth2 credentials from environment variables."""
    client_id = os.environ.get("GMAIL_CLIENT_ID", "")
    client_secret = os.environ.get("GMAIL_CLIENT_SECRET", "")
    refresh_token = os.environ.get("GMAIL_REFRESH_TOKEN", "")
    missing = [k for k, v in {
        "GMAIL_CLIENT_ID": client_id,
        "GMAIL_CLIENT_SECRET": client_secret,
        "GMAIL_REFRESH_TOKEN": refresh_token,
    }.items() if not v]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")
    return client_id, client_secret, refresh_token


async def _get_access_token() -> str:
    """Exchange the refresh token for a fresh access token."""
    client_id, client_secret, refresh_token = _get_credentials()
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(GMAIL_TOKEN_URL, data={
            "grant_type": "refresh_token",
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
        })
        resp.raise_for_status()
    return resp.json()["access_token"]


async def fetch_attachment_as_excel_json(
    message_id: str,
    attachment_id: str,
) -> List[Dict[str, Any]]:
    """
    Fetch a Gmail attachment and parse it as an Excel file.

    Credentials are read from GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET /
    GMAIL_REFRESH_TOKEN environment variables.

    :param message_id: Gmail message ID.
    :param attachment_id: Gmail attachment ID.
    :returns: List of row dicts (first row used as header).
    :raises httpx.HTTPStatusError: on non-2xx from Gmail.
    :raises ValueError: if the attachment cannot be parsed as Excel.
    """
    access_token = await _get_access_token()

    url = GMAIL_ATTACHMENT_URL.format(
        message_id=message_id, attachment_id=attachment_id
    )

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers={"Authorization": f"Bearer {access_token}"})
        resp.raise_for_status()

    body = resp.json()

    # Gmail encodes attachment data as base64url (RFC 4648 §5)
    raw_b64 = body.get("data", "")
    # Pad to a multiple of 4 and convert base64url → standard base64
    padded = raw_b64.replace("-", "+").replace("_", "/")
    padded += "=" * (-len(padded) % 4)

    try:
        excel_bytes = base64.b64decode(padded)
    except Exception as exc:
        raise ValueError(f"Could not decode attachment data: {exc}") from exc

    return _parse_excel(excel_bytes)


def _parse_excel(excel_bytes: bytes) -> List[Dict[str, Any]]:
    """Load workbook from bytes and return the first sheet as a list of dicts."""
    try:
        wb = openpyxl.load_workbook(io.BytesIO(excel_bytes), data_only=True)
    except Exception as exc:
        raise ValueError(f"Could not open workbook: {exc}") from exc

    ws = wb.active
    ws.reset_dimensions()  # ignore cached <dimension ref> — recalculate from actual cells
    rows = list(ws.iter_rows(values_only=True))

    if not rows:
        return []

    # First row → column headers; fall back to "col_N" for blank headers
    headers = [
        str(h).strip() if h is not None else f"col_{i}"
        for i, h in enumerate(rows[0])
    ]

    result: List[Dict[str, Any]] = []
    for row in rows[1:]:
        # Skip entirely empty rows
        if any(cell is not None for cell in row):
            result.append(
                {headers[i]: row[i] for i in range(min(len(headers), len(row)))}
            )

    return result


# ─────────────────────────────────────────────
# Email sending
# ─────────────────────────────────────────────

def _build_mime_message(
    to_email: str,
    cc_email: Optional[str],
    subject: str,
    html_body: str,
    attachments: List[Tuple[bytes, str]],
) -> MIMEMultipart:
    """Construct a MIME multipart message with an HTML body and one or more Excel attachments."""
    msg = MIMEMultipart("mixed")
    msg["To"] = to_email
    if cc_email:
        msg["Cc"] = cc_email
    msg["Subject"] = subject

    msg.attach(MIMEText(html_body, "html", "utf-8"))

    for excel_bytes, filename in attachments:
        part = MIMEBase(
            "application",
            "vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        part.set_payload(excel_bytes)
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
        msg.attach(part)

    return msg


async def send_email_with_map(
    to_email: str,
    cc_email: Optional[str],
    subject: str,
    html_body: str,
    png_bytes: bytes,
) -> str:
    """
    Send an HTML email with a satellite map PNG embedded inline (CID attachment).
    The html_body must already contain <img src="cid:event_map"> where the image
    should appear — call this after replacing the __MAP__ placeholder.

    :returns: The Gmail message ID of the sent message.
    """
    access_token = await _get_access_token()

    # multipart/mixed
    #   └── multipart/related  (ties the HTML to its inline image)
    #         ├── text/html
    #         └── image/png    (Content-ID: <event_map>)
    outer = MIMEMultipart("mixed")
    outer["To"] = to_email
    if cc_email:
        outer["Cc"] = cc_email
    outer["Subject"] = subject

    related = MIMEMultipart("related")

    html_part = MIMEText(html_body, "html", "utf-8")
    related.attach(html_part)

    img_part = MIMEImage(png_bytes, "png")
    img_part.add_header("Content-ID", "<event_map>")
    img_part.add_header("Content-Disposition", "inline", filename="event_map.png")
    related.attach(img_part)

    outer.attach(related)

    raw = base64.urlsafe_b64encode(outer.as_bytes()).decode("utf-8")

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            GMAIL_SEND_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            json={"raw": raw},
        )
        resp.raise_for_status()

    return resp.json().get("id", "")


async def send_email(
    to_email: str,
    cc_email: Optional[str],
    subject: str,
    html_body: str,
    attachments: List[Tuple[bytes, str]],
) -> str:
    """
    Send an email with one or more Excel attachments via the Gmail API.

    :param attachments: list of (excel_bytes, filename) tuples.
    :returns: The Gmail message ID of the sent message.
    :raises httpx.HTTPStatusError: on non-2xx from Gmail.
    """
    access_token = await _get_access_token()

    msg = _build_mime_message(to_email, cc_email, subject, html_body, attachments)

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            GMAIL_SEND_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            json={"raw": raw},
        )
        resp.raise_for_status()

    return resp.json().get("id", "")
