#!/usr/bin/env python3
"""
Import a Texas appraisal-district mineral roll ("4. MINERAL DATA" export)
into mineral_roll_imports / mineral_roll_interests (migration 038).

    python3 scripts/import_mineral_roll.py --county MARTIN <file.xlsx|file.csv>

Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from
frontend/.env.local (or the environment). Idempotent per (county, tax year,
file SHA-256): a completed import of the same file is left alone; an
incomplete one is removed and reloaded.

The export's header row is a single packed cell of quoted, comma-separated
column names, while each data row spans the full 188 columns; both layouts
are handled. INTEREST TYPE codes are labeled from the file's own decimals
(see INTEREST_TYPES) and the basis is stored with the import.
"""
import argparse, csv, hashlib, io, json, os, re, sys, urllib.request, urllib.error
from pathlib import Path

# Inferred from the 2025 Martin roll, not from a published code table: per
# RRC lease the decimals of all types sum to 1.0000 at the median, and each
# code's per-lease share matches its role — 1: 0.20 (royalty), 2: 0.04
# (overriding royalty), 4: 0.76 (working interest, one or few holders).
INTEREST_TYPES = {"1": "royalty", "2": "overriding_royalty", "4": "working_interest"}
INTEREST_TYPE_BASIS = ("Labels inferred from the roll's own decimals: per RRC lease, code 1 sums to a median 0.20 "
                       "(royalty), code 2 to 0.04 (overriding royalty), code 4 to 0.76 (working interest); all codes "
                       "together sum to 1.0000. Not taken from a published code table.")
BATCH = 1000


def env():
    vals = dict(os.environ)
    p = Path(__file__).resolve().parents[1] / "frontend" / ".env.local"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                vals.setdefault(k.strip(), v.strip().strip('"'))
    url, key = vals.get("NEXT_PUBLIC_SUPABASE_URL"), vals.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    return url.rstrip("/"), key


def api(url, key, method, path, body=None, prefer="return=representation"):
    req = urllib.request.Request(f"{url}/rest/v1/{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": prefer})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path.split('?')[0]} failed: {e.code} {e.read()[:300]!r}")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def rows_of(path):
    """Yield (header_names, row_tuple) for xlsx or csv."""
    if path.suffix.lower() == ".xlsx":
        import openpyxl
        ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
        it = ws.iter_rows(values_only=True)
        first = next(it)
        names = next(csv.reader(io.StringIO(first[0]))) if (first[0] and sum(v is not None for v in first) == 1) else [str(v or "") for v in first]
        for r in it:
            yield names, r
    else:
        with open(path, newline="", encoding="latin-1") as f:
            rd = csv.reader(f)
            names = next(rd)
            for r in rd:
                yield names, r


def clean(v):
    s = "" if v is None else str(v).strip()
    return s or None


def num(v):
    s = clean(v)
    if s is None:
        return None
    try:
        float(s)
        return s
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--county", required=True)
    ap.add_argument("file")
    a = ap.parse_args()
    path, county = Path(a.file), a.county.strip().upper()
    url, key = env()
    digest = sha256(path)
    print(f"file {path.name} sha256 {digest[:16]}...")

    ix, tax_year, job, batch, n = None, None, None, [], 0
    import_id = None
    for names, r in rows_of(path):
        if ix is None:
            ix = {nm.strip(): i for i, nm in enumerate(names)}
        get = lambda name: r[ix[name]] if ix.get(name) is not None and ix[name] < len(r) else None
        if all(v is None or str(v).strip() == "" for v in r[:30]):
            continue
        if import_id is None:
            tax_year, job = int(str(get("YEAR")).strip()), clean(get("JOB NUMBER"))
            existing = api(url, key, "GET", f"mineral_roll_imports?county=eq.{county}&tax_year=eq.{tax_year}&source_sha256=eq.{digest}&select=id,status")
            if existing and existing[0]["status"] == "complete":
                print(f"already imported ({existing[0]['id']}); nothing to do")
                return
            if existing:
                api(url, key, "DELETE", f"mineral_roll_imports?id=eq.{existing[0]['id']}", prefer="return=minimal")
            import_id = api(url, key, "POST", "mineral_roll_imports", {
                "county": county, "tax_year": tax_year, "appraisal_job_number": job, "source_file_name": path.name,
                "source_sha256": digest, "status": "loading", "interest_type_basis": INTEREST_TYPE_BASIS})[0]["id"]
        n += 1
        rrc = re.search(r"(\d+)", str(get("RRC#") or ""))
        code = clean(get("INTEREST TYPE"))
        owner = clean(get("OWNER NAME"))
        if not owner:
            continue
        batch.append({
            "import_id": import_id, "county": county, "tax_year": tax_year,
            "rrc_lease_number": rrc.group(1).lstrip("0") or "0" if rrc else None,
            "cad_lease_number": clean(get("LEASE NUMBER")), "lease_name": clean(get("LEASE NAME")), "operator_name": clean(get("OPER NAME")),
            "legal_description": " ".join(x for x in [clean(get("DESCRIPTION 1")), clean(get("DESCRIPTION 2"))] if x) or None,
            "owner_number": clean(get("OWNER NUMBER")), "owner_name": owner, "in_care_of": clean(get("IN CARE OF")),
            "mailing_address": clean(get("STREET ADDRESS")), "mailing_city_state_zip": clean(get("CITY, STATE, AND ZIP")),
            "interest_type_code": code, "interest_type": INTEREST_TYPES.get(code or "", "unknown"),
            "decimal_interest": num(get("DECIMAL INTEREST")), "acres": num(get("ACRES")), "market_value": num(get("JUR  1 MARKET VALUE")),
            "mineral_account_number": clean(get("MINERAL ACCOUNT NUMBER")), "privacy_code": clean(get("PRIVACY CODE")), "source_row": n + 1,
        })
        if len(batch) >= BATCH:
            api(url, key, "POST", "mineral_roll_interests", batch, prefer="return=minimal")
            batch = []
            if n % 20000 < BATCH:
                print(f"  {n:,} rows loaded")
    if batch:
        api(url, key, "POST", "mineral_roll_interests", batch, prefer="return=minimal")
    if import_id is None:
        sys.exit("no data rows found")
    api(url, key, "PATCH", f"mineral_roll_imports?id=eq.{import_id}", {"status": "complete", "row_count": n}, prefer="return=minimal")
    print(f"import {import_id}: {county} tax year {tax_year}, {n:,} rows, complete")


if __name__ == "__main__":
    main()
