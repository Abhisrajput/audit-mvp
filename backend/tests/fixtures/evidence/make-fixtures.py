"""Regenerates sample.pdf, scanned.pdf, sample.docx and sample.csv. Run: python3 make-fixtures.py
(sample.xlsx was written once with exceljs; see README.md.)"""
import zipfile

def build_pdf(page_texts):
    objs = {}
    n = len(page_texts)
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n))
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>"
    objs[2] = f"<< /Type /Pages /Kids [{kids}] /Count {n} >>"
    font = 3 + 2 * n
    for i, t in enumerate(page_texts):
        p, c = 3 + 2 * i, 4 + 2 * i
        objs[p] = f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {c} 0 R /Resources << /Font << /F1 {font} 0 R >> >> >>"
        stream = f"BT /F1 18 Tf 72 700 Td ({t}) Tj ET" if t else ""
        objs[c] = f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream"
    objs[font] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    out = b"%PDF-1.4\n"
    offs = {}
    for k in sorted(objs):
        offs[k] = len(out)
        out += f"{k} 0 obj\n{objs[k]}\nendobj\n".encode()
    x = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for k in sorted(objs):
        out += f"{offs[k]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n".encode()
    return out

open("sample.pdf", "wb").write(build_pdf(["Batch record BMR-2026-0142 page one", "Deviation DEV-0031 raised on page two"]))
open("scanned.pdf", "wb").write(build_pdf([""]))

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
with zipfile.ZipFile("sample.docx", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr("word/document.xml", f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>Training matrix</w:t></w:r></w:p><w:p><w:r><w:t>Operator A signed off on 2026-03-02</w:t></w:r></w:p></w:body></w:document>')

open("sample.csv", "w").write("batch,result\n0142,pass\n")

# Boundary fixtures for the no_text threshold: 19 and 20 non-whitespace characters.
open("chars19.pdf", "wb").write(build_pdf(["abcdefghij klmnopqrs"]))
open("chars20.pdf", "wb").write(build_pdf(["abcdefghij klmnopqrst"]))
