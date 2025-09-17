
import csv
import io
import os
import sqlite3
from datetime import datetime, timezone
from fastapi import FastAPI, File, UploadFile, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional

APP_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(APP_DIR, "invoisa.db")

app = FastAPI(title="Invoisa API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT NOT NULL,
            customer_email TEXT,
            number TEXT NOT NULL UNIQUE,
            amount_cents INTEGER NOT NULL,
            currency TEXT NOT NULL,
            issued_at TEXT NOT NULL,
            due_at TEXT NOT NULL,
            status TEXT NOT NULL
        );
        """
    )
    conn.commit()
    cur.execute("SELECT COUNT(*) AS c FROM invoices")
    if cur.fetchone()["c"] == 0:
        seed = [
            ("Acme Co", "ap@acme.test", "INV-2001", 145000, "USD", "2025-07-01T00:00:00Z", "2025-08-01T00:00:00Z", "overdue"),
            ("Globex", "ar@globex.test", "INV-2002", 56000, "USD", "2025-06-15T00:00:00Z", "2025-07-15T00:00:00Z", "overdue"),
            ("Umbrella", "ap@umbrella.test", "INV-2003", 99000, "USD", "2025-08-20T00:00:00Z", "2025-09-05T00:00:00Z", "open"),
            ("Globex", "ap@globex.test", "INV-1002", 54000, "USD", "2025-03-01T00:00:00Z", "2025-04-01T00:00:00Z", "overdue"),
            ("Acme Co", "ar@acme.test", "INV-1001", 125000, "USD", "2025-02-01T00:00:00Z", "2025-03-15T00:00:00Z", "overdue"),
        ]
        cur.executemany(
            """
            INSERT INTO invoices (customer_name, customer_email, number, amount_cents, currency, issued_at, due_at, status)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            seed,
        )
        conn.commit()
    conn.close()

def parse_iso(s: str):
    if s.endswith("Z"):
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid ISO datetime: {s}")

def days_overdue(due_at_iso: str) -> int:
    due = parse_iso(due_at_iso)
    now = datetime.now(timezone.utc)
    delta = (now - due)
    return max(0, int(delta.days))

def risk_score(days_overdue_val: int, amount_cents: int) -> float:
    d_norm = min(1.0, days_overdue_val / 120.0)
    a_norm = min(1.0, amount_cents / 200000.0)
    score = 0.45 * d_norm + 0.55 * a_norm
    return max(0.05, min(0.95, round(score, 2)))

class InvoiceIn(BaseModel):
    customer_name: str
    customer_email: Optional[str] = None
    number: str
    amount_cents: int = Field(ge=0)
    currency: str = "USD"
    issued_at: str
    due_at: str
    status: str = "open"

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

@app.get("/invoices")
def list_invoices(
    response: Response,
    status: Optional[str] = Query(None, description="open|overdue"),
    aging_min: Optional[int] = Query(None, description="30, 60, 90"),
    min_amount: Optional[int] = Query(None, description="amount in cents"),
    max_amount: Optional[int] = Query(None, description="amount in cents"),
    sort: str = Query("impact_desc"),
    limit: int = Query(10, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM invoices")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    enriched = []
    for r in rows:
        d = days_overdue(r["due_at"])
        score = risk_score(d, r["amount_cents"])
        impact = int(round(r["amount_cents"] * score))
        enriched.append({
            "id": r["id"],
            "customer": r["customer_name"],
            "number": r["number"],
            "amount_cents": r["amount_cents"],
            "days_overdue": d,
            "score": score,
            "impact": impact,
            "status_raw": r["status"],
        })

    def filt(x):
        if status == "overdue" and x["days_overdue"] <= 0:
            return False
        if status == "open" and x["days_overdue"] > 0:
            return False
        if aging_min is not None and x["days_overdue"] < aging_min:
            return False
        if min_amount is not None and x["amount_cents"] < min_amount:
            return False
        if max_amount is not None and x["amount_cents"] > max_amount:
            return False
        return True

    filtered = [x for x in enriched if filt(x)]
    if sort == "amount_desc":
        filtered.sort(key=lambda x: x["amount_cents"], reverse=True)
    elif sort == "days_desc":
        filtered.sort(key=lambda x: x["days_overdue"], reverse=True)
    else:
        filtered.sort(key=lambda x: x["impact"], reverse=True)

    total = len(filtered)
    paged = filtered[offset: offset + limit]
    response.headers["X-Total-Count"] = str(total)
    return paged

@app.post("/invoices")
def create_invoice(body: InvoiceIn):
    conn = get_conn()
    cur = conn.cursor()
    try:
        cur.execute(
            """
            INSERT INTO invoices (customer_name, customer_email, number, amount_cents, currency, issued_at, due_at, status)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (
                body.customer_name, body.customer_email, body.number, body.amount_cents,
                body.currency, body.issued_at, body.due_at, body.status
            ),
        )
        conn.commit()
        new_id = cur.lastrowid
    except sqlite3.IntegrityError as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Integrity error: {str(e)}")
    finally:
        conn.close()
    return {"id": new_id}

@app.put("/invoices/{invoice_id}")
def update_invoice(invoice_id: int, body: InvoiceIn):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT id FROM invoices WHERE id = ?", (invoice_id,))
    if cur.fetchone() is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Not found")
    cur.execute(
        """
        UPDATE invoices
        SET customer_name=?, customer_email=?, number=?, amount_cents=?, currency=?, issued_at=?, due_at=?, status=?
        WHERE id=?
        """,
        (
            body.customer_name, body.customer_email, body.number, body.amount_cents,
            body.currency, body.issued_at, body.due_at, body.status, invoice_id
        ),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/invoices/{invoice_id}")
def delete_invoice(invoice_id: int):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))
    conn.commit()
    deleted = cur.rowcount
    conn.close()
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}

@app.post("/import/invoices")
async def import_invoices(csv_file: UploadFile = File(...)):
    if not csv_file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a CSV file.")
    content = await csv_file.read()
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        text = content.decode("latin-1")
    reader = csv.DictReader(io.StringIO(text))
    required = {"customer_name", "customer_email", "number", "amount_cents", "currency", "issued_at", "due_at", "status"}
    if not required.issubset(set([c.strip() for c in reader.fieldnames or []])):
        raise HTTPException(status_code=400, detail=f"CSV must include columns: {', '.join(sorted(required))}")

    conn = get_conn()
    cur = conn.cursor()
    inserted = 0
    for row in reader:
        try:
            cur.execute(
                """
                INSERT INTO invoices (customer_name, customer_email, number, amount_cents, currency, issued_at, due_at, status)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(number) DO UPDATE SET
                    customer_name=excluded.customer_name,
                    customer_email=excluded.customer_email,
                    amount_cents=excluded.amount_cents,
                    currency=excluded.currency,
                    issued_at=excluded.issued_at,
                    due_at=excluded.due_at,
                    status=excluded.status
                """,
                (
                    row["customer_name"].strip(),
                    (row.get("customer_email") or "").strip() or None,
                    row["number"].strip(),
                    int(row["amount_cents"]),
                    (row.get("currency") or "USD").strip(),
                    row["issued_at"].strip(),
                    row["due_at"].strip(),
                    (row.get("status") or "open").strip(),
                ),
            )
            inserted += 1
        except Exception:
            continue
    conn.commit()
    conn.close()
    return {"rows_processed": inserted}

@app.on_event("startup")
def _startup():
    init_db()
