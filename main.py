"""
OBC Email Microservice
======================
FastAPI service responsible for:
  1. Building and sending emails (HTML body + Excel attachment) via Gmail API.
  2. Parsing an Excel file fetched from Gmail and returning it as JSON.

Endpoints
---------
POST /etat-gps               → SendEmailResponse
POST /demarrage-tardif       → SendEmailResponse
POST /analyse-evenement-hos  → SendEmailResponse
POST /survitesse             → SendEmailResponse
POST /parse-attachment       → AttachmentResponse
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from schemas import AttachmentRequest, AttachmentResponse, EmailRequest, SendEmailResponse
from services.gmail_client import fetch_attachment_as_excel_json, send_email
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

async def _send(req: EmailRequest, case_slug: str) -> SendEmailResponse:
    """Build and send the email. Shared by all four case endpoints."""
    PLACEHOLDER = "__TABLE__"
    if PLACEHOLDER not in req.body:
        raise HTTPException(
            status_code=422,
            detail="Field 'body' must contain the placeholder __TABLE__.",
        )

    html_body = req.body.replace(PLACEHOLDER, build_html_table(req.table_data))
    excel_bytes = build_excel_bytes(req.table_data, sheet_name=case_slug)
    filename = f"{case_slug.replace('-', '_')}.xlsx"

    try:
        gmail_id = await send_email(
            to_email=req.to_email,
            cc_email=req.cc_email,
            subject=req.subject,
            html_body=html_body,
            excel_bytes=excel_bytes,
            filename=filename,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return SendEmailResponse(gmail_message_id=gmail_id)


# ──────────────────────────────────────────────────────────────
# Email generation endpoints
# ──────────────────────────────────────────────────────────────

@app.post("/etat-gps", response_model=SendEmailResponse, tags=["Email"])
async def etat_gps(req: EmailRequest) -> SendEmailResponse:
    return await _send(req, "etat-gps")


@app.post("/demarrage-tardif", response_model=SendEmailResponse, tags=["Email"])
async def demarrage_tardif(req: EmailRequest) -> SendEmailResponse:
    return await _send(req, "demarrage-tardif")


@app.post("/analyse-evenement-hos", response_model=SendEmailResponse, tags=["Email"])
async def analyse_evenement_hos(req: EmailRequest) -> SendEmailResponse:
    return await _send(req, "analyse-evenement-hos")


@app.post("/survitesse", response_model=SendEmailResponse, tags=["Email"])
async def survitesse(req: EmailRequest) -> SendEmailResponse:
    return await _send(req, "survitesse")


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
