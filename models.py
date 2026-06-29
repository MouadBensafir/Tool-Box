# Re-exported from schemas.py for backwards compatibility.
# main.py imports from schemas directly — this file is kept only to avoid
# breaking any tooling that expects models.py to exist.
from schemas import (  # noqa: F401
    AttachmentRequest,
    AttachmentResponse,
    EmailRequest,
    EmailResponse,
    ExcelAttachment,
)
