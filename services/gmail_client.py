"""
Gmail attachment fetcher + Excel → JSON parser.

Auth flow
---------
The microservice owns the Gmail credentials (client_id, client_secret,
refresh_token). Before every Gmail API call it exchanges the refresh token
for a short-lived access token via the Google OAuth2 token endpoint.

Credentials are read from environment variables:
  GMAIL_CLIENT_ID
  GMAIL_CLIENT_SECRET
  GMAIL_REFRESH_TOKEN

Gmail API endpoint used:
  GET https://gmail.googleapis.com/gmail/v1/users/me/messages/{messageId}/attachments/{attachmentId}

The API returns a base64url-encoded payload; we decode it, load it as an
.xlsx workbook, and return the first sheet as a list of flat dicts.
"""

import base64
import io
import os
from typing import Any, Dict, List

import httpx
import openpyxl

GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token"
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
