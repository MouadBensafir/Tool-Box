from pydantic import BaseModel
from typing import Any, Dict, List, Optional


class EmailRequest(BaseModel):
    to_email: str
    cc_email: Optional[str] = None
    subject: str
    # HTML body — must contain {{TABLE}} where the generated table will be injected
    body: str
    # Array of flat objects; all objects must share the same keys
    table_data: List[Dict[str, Any]]


class ExcelAttachment(BaseModel):
    filename: str
    content_base64: str
    mime_type: str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class EmailResponse(BaseModel):
    to_email: str
    cc_email: Optional[str]
    subject: str
    html_body: str
    excel_attachment: ExcelAttachment


class AttachmentRequest(BaseModel):
    message_id: str
    attachment_id: str


class AttachmentResponse(BaseModel):
    data: List[Dict[str, Any]]
