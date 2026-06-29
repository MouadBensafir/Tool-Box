"""
OBC Email Microservice
======================
FastAPI service responsible for:
  1. Generating HTML email bodies (with embedded table) + Excel attachments.
  2. Parsing an Excel file fetched from Gmail and returning it as JSON.

Fusion AI handles data collection, filtering, and actual email sending.
This service only constructs the payloads.

Endpoints
---------
POST /etat-gps               → EmailResponse
POST /demarrage-tardif       → EmailResponse
POST /analyse-evenement-hos  → EmailResponse
POST /survitesse             → EmailResponse
POST /parse-attachment       → AttachmentResponse
"""

import base64

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from schemas import AttachmentRequest, AttachmentResponse, EmailRequest, EmailResponse, ExcelAttachment
from services.gmail_client import fetch_attachment_as_excel_json
from services.table_builder import build_excel_bytes, build_html_table

# ──────────────────────────────────────────────────────────────
# App
# ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="OBC Email Microservice",
    description=(
        "Generates HTML emails with Excel attachments for OBC supervision reports, "
        "and parses Excel attachments retrieved from Gmail."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ──────────────────────────────────────────────────────────────
# Shared helper
# ──────────────────────────────────────────────────────────────

def _build_response(req: EmailRequest, case_slug: str) -> EmailResponse:
    """
    Core logic shared by all email-generation endpoints.

    :param req: Incoming request with table_data and email metadata.
    :param case_slug: Used as the Excel sheet name and filename prefix.
    :returns: Fully constructed EmailResponse.
    """
    html_table = build_html_table(req.table_data)

    # Inject the table into the caller-supplied HTML body
    PLACEHOLDER = "__TABLE__"
    if PLACEHOLDER not in req.body:
        raise HTTPException(
            status_code=422,
            detail="Field 'body' must contain the placeholder __TABLE__.",
        )
    html_body = req.body.replace(PLACEHOLDER, html_table)

    excel_bytes = build_excel_bytes(req.table_data, sheet_name=case_slug)
    excel_b64 = base64.b64encode(excel_bytes).decode("utf-8")
    filename = f"{case_slug.replace('-', '_')}.xlsx"

    return EmailResponse(
        to_email=req.to_email,
        cc_email=req.cc_email,
        subject=req.subject,
        html_body=html_body,
        excel_attachment=ExcelAttachment(
            filename=filename,
            content_base64=excel_b64,
        ),
    )


# ──────────────────────────────────────────────────────────────
# Email generation endpoints
# ──────────────────────────────────────────────────────────────

@app.post(
    "/etat-gps",
    response_model=EmailResponse,
    summary="Generate ETAT GPS email + Excel attachment",
    tags=["Email Generation"],
)
async def etat_gps(req: EmailRequest) -> EmailResponse:
    return _build_response(req, "etat-gps")


@app.post(
    "/demarrage-tardif",
    response_model=EmailResponse,
    summary="Generate DEMARRAGE TARDIF email + Excel attachment",
    tags=["Email Generation"],
)
async def demarrage_tardif(req: EmailRequest) -> EmailResponse:
    return _build_response(req, "demarrage-tardif")


@app.post(
    "/analyse-evenement-hos",
    response_model=EmailResponse,
    summary="Generate ANALYSE EVENEMENT HOS email + Excel attachment",
    tags=["Email Generation"],
)
async def analyse_evenement_hos(req: EmailRequest) -> EmailResponse:
    return _build_response(req, "analyse-evenement-hos")


@app.post(
    "/survitesse",
    response_model=EmailResponse,
    summary="Generate SURVITESSE email + Excel attachment",
    tags=["Email Generation"],
)
async def survitesse(req: EmailRequest) -> EmailResponse:
    return _build_response(req, "survitesse")


# ──────────────────────────────────────────────────────────────
# Excel retrieval / parsing endpoint
# ──────────────────────────────────────────────────────────────

@app.post(
    "/parse-attachment",
    response_model=AttachmentResponse,
    summary="Fetch a Gmail Excel attachment and return its content as JSON",
    tags=["Attachment Parsing"],
)
async def parse_attachment(req: AttachmentRequest) -> AttachmentResponse:
    """
    Credentials are read from GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET /
    GMAIL_REFRESH_TOKEN environment variables — no token needed in the request.
    """
    try:
        data = await fetch_attachment_as_excel_json(
            message_id=req.message_id,
            attachment_id=req.attachment_id,
        )
    except RuntimeError as exc:
        # Missing env vars → 500 (server misconfiguration)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        # Gmail API errors or parse failures → 502
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return AttachmentResponse(data=data)


# ──────────────────────────────────────────────────────────────
# Health check
# ──────────────────────────────────────────────────────────────

@app.get("/health", tags=["Meta"])
async def health() -> dict:
    return {"status": "ok"}