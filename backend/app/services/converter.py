"""
DOCX → PDF conversion service.

Conversion strategies, tried in order of fidelity:

  1. LibreOffice headless  — preserves all layout, fonts, images, tables, headers/footers.
                             Install: https://www.libreoffice.org/download/libreoffice/
  2. docx2pdf (Word COM)   — uses the locally-installed Microsoft Word on Windows;
                             pixel-perfect because it IS Word.
                             Install: pip install docx2pdf  (pywin32 already present)
  3. reportlab fallback    — text-only rebuild; loses images and complex formatting.
                             Always available, used only when both engines above fail.

Install LibreOffice for best results on a server (no Word license required).
"""

import io
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape as _esc


# ─────────────────────────────────────────────────────────────────────────────
# Strategy 1 – LibreOffice
# ─────────────────────────────────────────────────────────────────────────────

def _find_soffice() -> str | None:
    """Return the soffice/libreoffice executable path, or None if not found."""
    # Check PATH
    for cmd in ("soffice", "libreoffice"):
        found = shutil.which(cmd)
        if found:
            return found

    # Windows – common install locations
    for candidate in (
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ):
        if Path(candidate).is_file():
            return candidate

    # macOS
    mac = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    if Path(mac).is_file():
        return mac

    # Linux snap / flatpak
    for candidate in ("/snap/bin/libreoffice", "/usr/bin/libreoffice", "/usr/bin/soffice"):
        if Path(candidate).is_file():
            return candidate

    return None


def _win_path_to_file_uri(path: str) -> str:
    """Convert a Windows absolute path to a file:/// URI for LibreOffice."""
    return "file:///" + path.replace("\\", "/")


def _convert_via_libreoffice(docx_bytes: bytes) -> bytes:
    soffice = _find_soffice()
    if not soffice:
        raise RuntimeError("LibreOffice executable not found")

    with tempfile.TemporaryDirectory() as tmpdir:
        docx_path = os.path.join(tmpdir, "document.docx")
        pdf_path  = os.path.join(tmpdir, "document.pdf")
        profile   = os.path.join(tmpdir, "lo_profile")

        with open(docx_path, "wb") as fh:
            fh.write(docx_bytes)

        # --env:UserInstallation avoids profile-lock conflicts under concurrent calls
        profile_uri = _win_path_to_file_uri(profile)
        cmd = [
            soffice,
            "--headless",
            "--norestore",
            "--nofirststartwizard",
            f"--env:UserInstallation={profile_uri}",
            "--convert-to", "pdf",
            "--outdir", tmpdir,
            docx_path,
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=120,
            text=True,
        )

        if result.returncode != 0 or not Path(pdf_path).is_file():
            err = (result.stderr or result.stdout or "no output").strip()
            raise RuntimeError(f"LibreOffice exited {result.returncode}: {err}")

        return Path(pdf_path).read_bytes()


# ─────────────────────────────────────────────────────────────────────────────
# Strategy 2 – docx2pdf  (Word COM on Windows, LibreOffice on Linux/Mac)
# ─────────────────────────────────────────────────────────────────────────────

def _convert_via_docx2pdf(docx_bytes: bytes) -> bytes:
    try:
        from docx2pdf import convert as _d2p_convert
    except ImportError:
        raise RuntimeError("docx2pdf not installed — run: pip install docx2pdf")

    with tempfile.TemporaryDirectory() as tmpdir:
        docx_path = os.path.join(tmpdir, "document.docx")
        pdf_path  = os.path.join(tmpdir, "document.pdf")

        with open(docx_path, "wb") as fh:
            fh.write(docx_bytes)

        _d2p_convert(docx_path, pdf_path)

        if not Path(pdf_path).is_file():
            raise RuntimeError("docx2pdf produced no output file")

        return Path(pdf_path).read_bytes()


# ─────────────────────────────────────────────────────────────────────────────
# Strategy 3 – reportlab (text-only fallback)
# ─────────────────────────────────────────────────────────────────────────────

def _clean(text: str) -> str:
    """Strip control characters that break reportlab's XML parser."""
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)


def _iter_blocks(doc):
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph as DocxParagraph

    def _walk(element):
        for child in element.iterchildren():
            tag = child.tag
            if tag == qn("w:p"):
                yield DocxParagraph(child, doc)
            elif tag == qn("w:tbl"):
                yield Table(child, doc)
            elif tag == qn("w:sdt"):
                content = child.find(qn("w:sdtContent"))
                if content is not None:
                    yield from _walk(content)

    yield from _walk(doc.element.body)


def _runs_to_markup(para) -> str:
    parts = []
    for run in para.runs:
        text = _esc(_clean(run.text))
        if not text:
            continue
        if run.bold and run.italic:
            text = f"<b><i>{text}</i></b>"
        elif run.bold:
            text = f"<b>{text}</b>"
        elif run.italic:
            text = f"<i>{text}</i>"
        parts.append(text)
    return "".join(parts) or _esc(_clean(para.text))


def _convert_via_reportlab(docx_bytes: bytes) -> bytes:
    from docx import Document as DocxDocument
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_JUSTIFY
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    doc = DocxDocument(io.BytesIO(docx_bytes))
    buf = io.BytesIO()

    page_width, _ = A4
    left_margin = right_margin = 2.5 * cm
    usable_width = page_width - left_margin - right_margin

    pdf = SimpleDocTemplate(
        buf, pagesize=A4,
        rightMargin=right_margin, leftMargin=left_margin,
        topMargin=2.5 * cm, bottomMargin=2.5 * cm,
    )

    body = ParagraphStyle("body", fontSize=11, leading=16, spaceAfter=5, alignment=TA_JUSTIFY)
    h1   = ParagraphStyle("h1", fontSize=20, leading=24, spaceBefore=14, spaceAfter=8,  fontName="Helvetica-Bold")
    h2   = ParagraphStyle("h2", fontSize=15, leading=19, spaceBefore=10, spaceAfter=6,  fontName="Helvetica-Bold")
    h3   = ParagraphStyle("h3", fontSize=12, leading=15, spaceBefore=8,  spaceAfter=4,  fontName="Helvetica-Bold")
    blt  = ParagraphStyle("bullet", parent=body, leftIndent=18, spaceAfter=3)
    STYLE_MAP = {
        "Heading 1": h1, "Title": h1,
        "Heading 2": h2, "Subtitle": h2,
        "Heading 3": h3,
    }

    story = []
    for block in _iter_blocks(doc):
        try:
            if hasattr(block, "rows"):
                rows = [[Paragraph(_esc(_clean(c.text.strip())), body) for c in row.cells]
                        for row in block.rows]
                if not rows:
                    continue
                col_count = max(len(r) for r in rows)
                if not col_count:
                    continue
                t = Table(rows, colWidths=[usable_width / col_count] * col_count)
                t.setStyle(TableStyle([
                    ("GRID",           (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
                    ("FONTNAME",       (0, 0), (-1,  0), "Helvetica-Bold"),
                    ("BACKGROUND",     (0, 0), (-1,  0), colors.HexColor("#f2f2f2")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#fafafa")]),
                    ("LEFTPADDING",    (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING",   (0, 0), (-1, -1), 6),
                    ("TOPPADDING",     (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING",  (0, 0), (-1, -1), 4),
                ]))
                story.append(t)
                story.append(Spacer(1, 8))
                continue

            text = block.text.strip()
            if not text:
                story.append(Spacer(1, 4))
                continue

            sname  = block.style.name if block.style else "Normal"
            markup = _runs_to_markup(block)

            if sname in STYLE_MAP:
                story.append(Paragraph(markup, STYLE_MAP[sname]))
            elif "List" in sname:
                story.append(Paragraph(f"• {markup}", blt))
            else:
                story.append(Paragraph(markup, body))

        except Exception as exc:
            print(f"⚠️  Skipping block during PDF conversion: {exc}")

    if not story:
        raise ValueError("Document appears to be empty or contains no extractable text.")

    total_chars = sum(len(getattr(i, "text", "") or "") for i in story if hasattr(i, "text"))
    if total_chars < 500:
        raise ValueError(
            "This document contains very little selectable text — it appears to be "
            "image-based (e.g. a scanned PDF saved as .docx). "
            "Please upload the original PDF directly, or run OCR on the document first."
        )

    pdf.build(story)
    return buf.getvalue()


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def convert_docx_to_pdf(docx_bytes: bytes) -> bytes:
    """
    Convert DOCX bytes → PDF bytes using the highest-fidelity engine available.

    Priority:
      1. LibreOffice   – pixel-accurate; install from libreoffice.org
      2. docx2pdf      – uses installed Microsoft Word via COM (Windows)
      3. reportlab     – text-only fallback; always available
    """
    # ── Strategy 1: LibreOffice ───────────────────────────────────────────────
    try:
        pdf = _convert_via_libreoffice(docx_bytes)
        print("✅ Converted via LibreOffice (high fidelity)")
        return pdf
    except Exception as exc:
        print(f"⚠️  LibreOffice unavailable: {exc}")

    # ── Strategy 2: docx2pdf (Word COM) ──────────────────────────────────────
    try:
        pdf = _convert_via_docx2pdf(docx_bytes)
        print("✅ Converted via docx2pdf / Word COM (high fidelity)")
        return pdf
    except Exception as exc:
        print(f"⚠️  docx2pdf unavailable: {exc}")

    # ── Strategy 3: reportlab fallback ───────────────────────────────────────
    print("⚠️  Using reportlab fallback — install LibreOffice for full layout fidelity")
    return _convert_via_reportlab(docx_bytes)
