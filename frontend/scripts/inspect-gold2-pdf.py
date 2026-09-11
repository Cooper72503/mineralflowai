"""Dev-only PDF visual fingerprint; production gold:report has no Python dependency."""
import hashlib
import json
import sys
import fitz
with fitz.open(sys.argv[1]) as document:
    digest = hashlib.sha256()
    errors = []
    chart_count = 0
    for number, page in enumerate(document, 1):
        pixmap = page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)
        digest.update(f"{number}:{pixmap.width}:{pixmap.height}:".encode())
        digest.update(pixmap.samples)
        text = page.get_text()
        chart_count += text.count("Chart:")
        if any(token in text for token in ("NaN", "[object Object]", "undefined")):
            errors.append(f"Invalid displayed value on page {number}")
        for word in page.get_text("words"):
            if word[0] < 0 or word[1] < 0 or word[2] > page.rect.width + 1 or word[3] > page.rect.height + 1:
                errors.append(f"Text outside page bounds on page {number}")
    if chart_count != 11:
        errors.append(f"Expected 11 chart sections; found {chart_count}")
    print(json.dumps({"renderSha256": digest.hexdigest(), "renderer": f"PyMuPDF-{fitz.__version__}-72dpi-RGB", "pageCount": len(document), "errors": sorted(set(errors))}))
