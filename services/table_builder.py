"""
Builds HTML tables and Excel files from a list of flat dicts.

Style: black header row (white bold text), white data rows (black text),
thin black borders on all cells.
"""

import io
from typing import Any, Dict, List

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side


# ─────────────────────────────────────────────
# HTML
# ─────────────────────────────────────────────

_TH_STYLE = (
    "background-color:#000000;"
    "color:#ffffff;"
    "font-weight:bold;"
    "padding:8px 12px;"
    "border:1px solid #000000;"
    "text-align:left;"
    "white-space:nowrap;"
)

_TD_STYLE = (
    "color:#000000;"
    "padding:8px 12px;"
    "border:1px solid #cccccc;"
    "background-color:#ffffff;"
    "white-space:nowrap;"
)

_TABLE_STYLE = (
    "border-collapse:collapse;"
    "width:100%;"
    "font-family:Arial,sans-serif;"
    "font-size:13px;"
)


def build_html_table(data: List[Dict[str, Any]]) -> str:
    """Return a self-contained HTML <table> string."""
    if not data:
        return "<p><em>Aucune donnée disponible.</em></p>"

    headers = list(data[0].keys())

    header_cells = "".join(f'<th style="{_TH_STYLE}">{h}</th>' for h in headers)

    body_rows = ""
    for row in data:
        cells = "".join(
            f'<td style="{_TD_STYLE}">{_safe(row.get(h))}</td>' for h in headers
        )
        body_rows += f"<tr>{cells}</tr>"

    return (
        f'<table style="{_TABLE_STYLE}">'
        f"<thead><tr>{header_cells}</tr></thead>"
        f"<tbody>{body_rows}</tbody>"
        f"</table>"
    )


def _safe(value: Any) -> str:
    if value is None:
        return ""
    # Basic HTML escaping
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


# ─────────────────────────────────────────────
# Excel
# ─────────────────────────────────────────────

_BLACK_FILL = PatternFill(start_color="000000", end_color="000000", fill_type="solid")
_WHITE_BOLD_FONT = Font(color="FFFFFF", bold=True, name="Arial", size=11)
_BLACK_FONT = Font(color="000000", name="Arial", size=11)

_THIN_SIDE = Side(style="thin", color="000000")
_CELL_BORDER = Border(
    left=_THIN_SIDE, right=_THIN_SIDE, top=_THIN_SIDE, bottom=_THIN_SIDE
)


def build_excel_bytes(data: List[Dict[str, Any]], sheet_name: str = "Rapport") -> bytes:
    """Return raw .xlsx bytes for the given data."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet_name[:31]  # Excel sheet-name limit

    if not data:
        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    headers = list(data[0].keys())

    # ── Header row ──────────────────────────────
    for col_idx, header in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx, value=header)
        cell.fill = _BLACK_FILL
        cell.font = _WHITE_BOLD_FONT
        cell.border = _CELL_BORDER
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=False)

    # ── Data rows ───────────────────────────────
    for row_idx, row in enumerate(data, start=2):
        for col_idx, header in enumerate(headers, start=1):
            cell = ws.cell(row=row_idx, column=col_idx, value=row.get(header))
            cell.font = _BLACK_FONT
            cell.border = _CELL_BORDER
            cell.alignment = Alignment(vertical="center")

    # ── Auto-fit column widths ──────────────────
    for col in ws.columns:
        col_letter = col[0].column_letter
        max_len = max(
            (len(str(cell.value)) for cell in col if cell.value is not None),
            default=8,
        )
        ws.column_dimensions[col_letter].width = min(max_len + 4, 60)

    # Freeze the header row
    ws.freeze_panes = "A2"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
