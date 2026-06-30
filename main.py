"""
OBC Email Microservice
======================
FastAPI service responsible for:
  1. Building and sending emails (HTML body + Excel attachment) via Gmail API.
  2. Parsing an Excel file fetched from Gmail and returning it as JSON.
  3. Rendering a satellite map PNG with a vehicle trajectory and event popup.

Endpoints
---------
POST /etat-gps               → SendEmailResponse
POST /demarrage-tardif       → SendEmailResponse  (two tables, two Excel attachments)
POST /analyse-evenement-hos  → SendEmailResponse
POST /survitesse             → SendEmailResponse
POST /parse-attachment       → AttachmentResponse
POST /evenement-map          → SendEmailResponse
POST /render-event-map       → MapRenderResponse
"""

import asyncio
import base64

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from schemas import (
    AttachmentRequest,
    AttachmentResponse,
    EmailRequest,
    EventMapEmailRequest,
    MapRenderRequest,
    MapRenderResponse,
    SendEmailResponse,
)
from services.gmail_client import fetch_attachment_as_excel_json, send_email, send_email_with_map
from services.map_renderer import render_event_map
from services.table_builder import (
    build_excel_bytes,
    build_excel_bytes_etat_gps,
    build_html_table,
    build_html_table_etat_gps,
)

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
# Shared helper — single table
# ──────────────────────────────────────────────────────────────

async def _send(req: EmailRequest, case_slug: str) -> SendEmailResponse:
    """Build and send the email for single-table endpoints."""
    PLACEHOLDER = "__TABLE__"
    if PLACEHOLDER not in req.body:
        raise HTTPException(
            status_code=422,
            detail="Field 'body' must contain the placeholder __TABLE__.",
        )

    html_body = req.body.replace(PLACEHOLDER, build_html_table(req.table_data))
    excel_bytes = build_excel_bytes(req.table_data, sheet_name=case_slug)
    filename = req.filename or f"{case_slug.replace('-', '_')}.xlsx"

    try:
        gmail_id = await send_email(
            to_email=req.to_email,
            cc_email=req.cc_email,
            subject=req.subject,
            html_body=html_body,
            attachments=[(excel_bytes, filename)],
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
    PLACEHOLDER = "__TABLE__"
    if PLACEHOLDER not in req.body:
        raise HTTPException(status_code=422, detail="Field 'body' must contain the placeholder __TABLE__.")

    date_field = req.date_field or "Date"
    html_body = req.body.replace(PLACEHOLDER, build_html_table_etat_gps(req.table_data, date_field))
    excel_bytes = build_excel_bytes_etat_gps(req.table_data, sheet_name="etat-gps", date_field=date_field)

    try:
        gmail_id = await send_email(
            to_email=req.to_email,
            cc_email=req.cc_email,
            subject=req.subject,
            html_body=html_body,
            attachments=[(excel_bytes, req.filename or "etat_gps.xlsx")],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return SendEmailResponse(gmail_message_id=gmail_id)


@app.post("/demarrage-tardif", response_model=SendEmailResponse, tags=["Email"])
async def demarrage_tardif(req: EmailRequest) -> SendEmailResponse:
    """
    Supports two tables and two Excel attachments.
    Body must contain __TABLE_1__ (démarrage tardif) and __TABLE_2__ (pas encore démarré).
    Falls back to single-table mode (__TABLE__) if table_data_2 is not provided.
    """
    if req.table_data_2 is not None:
        # ── Two-table mode ──────────────────────────────────────
        if "__TABLE_1__" not in req.body or "__TABLE_2__" not in req.body:
            raise HTTPException(
                status_code=422,
                detail="When table_data_2 is provided, body must contain __TABLE_1__ and __TABLE_2__.",
            )
        # Build both Excel files concurrently to reduce response time
        loop = asyncio.get_event_loop()
        excel1, excel2 = await asyncio.gather(
            loop.run_in_executor(None, build_excel_bytes, req.table_data,   "demarrage-tardif"),
            loop.run_in_executor(None, build_excel_bytes, req.table_data_2, "pas-encore-demarre"),
        )
        html_body = (
            req.body
            .replace("__TABLE_1__", build_html_table(req.table_data))
            .replace("__TABLE_2__", build_html_table(req.table_data_2))
        )
        attachments = [
            (excel1, req.filename   or "demarrage_tardif.xlsx"),
            (excel2, req.filename_2 or "pas_encore_demarre.xlsx"),
        ]
        try:
            gmail_id = await send_email(
                to_email=req.to_email,
                cc_email=req.cc_email,
                subject=req.subject,
                html_body=html_body,
                attachments=attachments,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return SendEmailResponse(gmail_message_id=gmail_id)
    else:
        # ── Single-table fallback ───────────────────────────────
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
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return AttachmentResponse(data=data)


# ──────────────────────────────────────────────────────────────
# Map rendering + email endpoint
# ──────────────────────────────────────────────────────────────

@app.post("/evenement-map", response_model=SendEmailResponse, tags=["Email"])
async def evenement_map(req: EventMapEmailRequest) -> SendEmailResponse:
    """
    Render a satellite map for the given event and send it embedded in an email.
    Body must contain __MAP__ where the image should appear.
    """
    PLACEHOLDER = "__MAP__"
    if PLACEHOLDER not in req.body:
        raise HTTPException(
            status_code=422,
            detail="Field 'body' must contain the placeholder __MAP__.",
        )

    try:
        png_bytes = await render_event_map(
            trajectory=req.trajectory,
            event=req.event.model_dump(),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Map render failed: {exc}") from exc

    img_tag = '<img src="cid:event_map" style="max-width:100%;border:1px solid #ddd;" />'
    html_body = req.body.replace(PLACEHOLDER, img_tag)

    try:
        gmail_id = await send_email_with_map(
            to_email=req.to_email,
            cc_email=req.cc_email,
            subject=req.subject,
            html_body=html_body,
            png_bytes=png_bytes,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return SendEmailResponse(gmail_message_id=gmail_id)


# ──────────────────────────────────────────────────────────────
# Map rendering (raw PNG) endpoint
# ──────────────────────────────────────────────────────────────

@app.post(
    "/render-event-map",
    response_model=MapRenderResponse,
    summary="Render a satellite map PNG with a vehicle trajectory and event popup",
    tags=["Map"],
)
async def render_map(req: MapRenderRequest) -> MapRenderResponse:
    try:
        png_bytes = await render_event_map(
            trajectory=req.trajectory,
            event=req.event.model_dump(),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return MapRenderResponse(image_b64=base64.b64encode(png_bytes).decode())


# ──────────────────────────────────────────────────────────────
# Health check
# ──────────────────────────────────────────────────────────────

@app.get("/health", tags=["Meta"])
async def health() -> dict:
    return {"status": "ok"}
