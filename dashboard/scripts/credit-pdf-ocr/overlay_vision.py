"""Add a searchable Apple Vision text layer to selected scanned PDF pages."""

import argparse
import io
import json
import subprocess
import tempfile
from pathlib import Path

import pikepdf
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "original", type=Path, help="Unmodified source PDF for OCR images"
    )
    parser.add_argument(
        "base",
        type=Path,
        help="PDF to add searchable text to; may be a compressed copy",
    )
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--pages", required=True, help="Comma-separated, one-based scanned page numbers"
    )
    parser.add_argument(
        "--font", type=Path, required=True, help="Chinese-capable TrueType font"
    )
    parser.add_argument("--vision-binary", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=200)
    args = parser.parse_args()

    pdfmetrics.registerFont(TTFont("VisionChinese", str(args.font)))
    page_numbers = [int(value) for value in args.pages.split(",")]
    pdf = pikepdf.Pdf.open(args.base)
    original = pikepdf.Pdf.open(args.original)
    if len(pdf.pages) != len(original.pages):
        raise ValueError("The source and base PDFs have different page counts")

    records = []
    with tempfile.TemporaryDirectory(prefix="credit-vision-") as temporary:
        for page_number in page_numbers:
            if not 1 <= page_number <= len(pdf.pages):
                raise ValueError(f"Page {page_number} is outside the PDF")
            prefix = str(Path(temporary) / f"page-{page_number}")
            subprocess.run(
                [
                    "pdftoppm",
                    "-f",
                    str(page_number),
                    "-l",
                    str(page_number),
                    "-r",
                    str(args.dpi),
                    "-singlefile",
                    "-png",
                    str(args.original),
                    prefix,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            boxes = json.loads(
                subprocess.check_output([str(args.vision_binary), prefix + ".png"])
            )
            media = pdf.pages[page_number - 1].mediabox
            width, height = float(media[2] - media[0]), float(media[3] - media[1])
            buffer = io.BytesIO()
            output = canvas.Canvas(buffer, pagesize=(width, height), pageCompression=1)
            for box in boxes:
                content = box["text"].strip()
                if not content:
                    continue
                x, y = box["x"] * width, box["y"] * height
                box_width, box_height = box["width"] * width, box["height"] * height
                font_size = max(3, box_height * 0.85)
                content_width = pdfmetrics.stringWidth(
                    content, "VisionChinese", font_size
                )
                text = output.beginText(x, y + box_height * 0.1)
                text.setFont("VisionChinese", font_size)
                text.setTextRenderMode(3)
                if content_width > 0:
                    text.setHorizScale(100 * box_width / content_width)
                text.textOut(content)
                output.drawText(text)
            output.showPage()
            output.save()
            buffer.seek(0)
            overlay = pikepdf.Pdf.open(buffer)
            pdf.pages[page_number - 1].add_overlay(overlay.pages[0])
            records.append(
                {
                    "page": page_number,
                    "boxes": len(boxes),
                    "low_confidence": sum(box["confidence"] < 0.5 for box in boxes),
                }
            )
            print(f"page {page_number}: {len(boxes)} boxes", flush=True)
    pdf.save(
        args.output,
        compress_streams=True,
        object_stream_mode=pikepdf.ObjectStreamMode.generate,
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "bytes": args.output.stat().st_size,
                "pages": records,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
