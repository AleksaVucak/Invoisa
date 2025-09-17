import csv
import io
import os
import sqlite3
from datetime import datetime, timezone, date
from fastapi import FastAPI, File, UploadFile, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any

APP_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(APP_DIR, "invoisa.db")

app = FastAPI(title="Invoisa API")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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

    # Invoices (original)
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

    # Email templates (new)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS email_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT NOT NULL,  -- reminder | followup | promise
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )

    # Seed invoices (only if empty)
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

    # Seed templates (only if empty)
    cur.execute("SELECT COUNT(*) AS c FROM email_templates")
    if cur.fetchone()["c"] == 0:
        now = datetime.now(timezone.utc).isoformat()
        templates = [
            ("Gentle Reminder (Before Due)", "reminder",
             "Reminder: Invoice {invoice_number} due {due_date}",
             "Hi {customer_name},\n\nJust a friendly reminder that invoice {invoice_number} for {amount_usd} is due on {due_date}.\n"
             "If you’ve already sent payment, thank you! Otherwise, please let me know if you need anything from me.\n\nBest,\n{company_name}",
             1, now, now),
            ("Overdue Follow-up (1–2 weeks)", "followup",
             "Overdue: Invoice {invoice_number} ({days_overdue} days)",
             "Hi {customer_name},\n\nI’m following up on invoice {invoice_number} for {amount_usd}, which is now {days_overdue} days past due (due {due_date}).\n"
             "Could you share an update on status or an expected payment date?\n\nThanks,\n{company_name}",
             0, now, now),
            ("Promise-to-Pay Confirmation", "promise",
             "Payment plan for invoice {invoice_number}",
             "Hi {customer_name},\n\nThanks for confirming you’ll pay invoice {invoice_number} ({amount_usd}) by {promised_date}.\n"
             "I’ll note that on my side. If anything changes, please let me know.\n\nBest,\n{company_name}",
             0, now, now),
        ]
        cur.executemany(
            "INSERT INTO email_templates (name, category, subject, body, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            templates,
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
    delta = now - due
    return max(0, int(delta.days))

def risk_score(days_overdue_val: int, amount_cents: int) -> float:
    # same shape you had
    d_norm = min(1.0, days_overdue_val / 120.0)
    a_norm = min(1.0, amount_cents / 200000.0)
    return round(max(0.05, min(0.95, 0.45 * d_norm + 0.55 * a_norm)), 2)

# --------- Models ----------
class InvoiceIn(BaseModel):
    customer_name: str
    customer_email: Optional[str] = None
    number: str
    amount_cents: int = Field(ge=0)
    currency: str = "USD"
    issued_at: str
    due_at: str
    status: str = "open"

class TemplateIn(BaseModel):
    name: str
    category: str = Field(pattern="^(reminder|followup|promise)$")
    subject: str
    body: str
    is_default: bool = False

class RenderIn(BaseModel):
    template_id: Optional[int] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None
    invoice_number: Optional[str] = None
    amount_cents: Optional[int] = None
    currency: Optional[str] = None
    due_date: Optional[str] = None
    days_overdue: Optional[int] = None
    company_name: Optional[str] = "Accounts Receivable"
    promised_date: Optional[str] = None

# --------- Routes (original invoices preserved) ----------
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
            "customer_email": r["customer_email"],   # <— added (non-breaking)
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
            (body.customer_name, body.customer_email, body.number, body.amount_cents, body.currency, body.issued_at, body.due_at, body.status),
        )
        conn.commit()
        return {"id": cur.lastrowid}
    except sqlite3.IntegrityError as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Invoice number must be unique: {e}")
    finally:
        conn.close()

@app.put("/invoices/{invoice_id}")
def update_invoice(invoice_id: int, body: InvoiceIn):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT id FROM invoices WHERE id=?", (invoice_id,))
    if not cur.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Not found")
    try:
        cur.execute(
            """
            UPDATE invoices SET customer_name=?, customer_email=?, number=?, amount_cents=?, currency=?, issued_at=?, due_at=?, status=?
            WHERE id=?
            """,
            (body.customer_name, body.customer_email, body.number, body.amount_cents, body.currency, body.issued_at, body.due_at, body.status, invoice_id),
        )
        conn.commit()
        return {"ok": True}
    except sqlite3.IntegrityError as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Update failed: {e}")
    finally:
        conn.close()

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
                    (row.get("customer_email") or "").strip(),
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

# --------- Email Templates (new) ----------
class _Row(BaseModel):
    id: int

def _format_amount(amount_cents: Optional[int], currency: Optional[str]) -> str:
    if amount_cents is None:
        return ""
    code = currency or "USD"
    return f"{(amount_cents/100):,.2f} {code}"

def _safe_format(template: str, context: Dict[str, Any]) -> str:
    out = template
    for k, v in context.items():
        out = out.replace("{" + k + "}", "" if v is None else str(v))
    import re
    return re.sub(r"\{[a-zA-Z0-9_]+\}", "", out)

@app.get("/email/templates")
def list_templates(q: Optional[str] = None, category: Optional[str] = Query(None, pattern="^(reminder|followup|promise)?$")):
    conn = get_conn(); cur = conn.cursor()
    if q:
        cur.execute("SELECT * FROM email_templates WHERE name LIKE ? OR subject LIKE ? OR body LIKE ? ORDER BY updated_at DESC",
                    (f"%{q}%", f"%{q}%", f"%{q}%"))
    elif category:
        cur.execute("SELECT * FROM email_templates WHERE category = ? ORDER BY updated_at DESC", (category,))
    else:
        cur.execute("SELECT * FROM email_templates ORDER BY updated_at DESC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    for r in rows: r["is_default"] = bool(r["is_default"])
    return {"items": rows}

@app.post("/email/templates")
def create_template(body: TemplateIn) -> _Row:
    now = datetime.now(timezone.utc).isoformat()
    conn = get_conn(); cur = conn.cursor()
    cur.execute(
        "INSERT INTO email_templates (name, category, subject, body, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        (body.name, body.category, body.subject, body.body, 1 if body.is_default else 0, now, now),
    )
    conn.commit()
    i = cur.lastrowid
    conn.close()
    return _Row(id=i)

@app.put("/email/templates/{template_id}")
def update_template(template_id: int, body: TemplateIn):
    now = datetime.now(timezone.utc).isoformat()
    conn = get_conn(); cur = conn.cursor()
    cur.execute("SELECT id FROM email_templates WHERE id=?", (template_id,))
    if not cur.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Not found")
    cur.execute(
        "UPDATE email_templates SET name=?, category=?, subject=?, body=?, is_default=?, updated_at=? WHERE id=?",
        (body.name, body.category, body.subject, body.body, 1 if body.is_default else 0, now, template_id),
    )
    conn.commit(); conn.close()
    return {"ok": True}

@app.delete("/email/templates/{template_id}")
def delete_template(template_id: int):
    conn = get_conn(); cur = conn.cursor()
    cur.execute("DELETE FROM email_templates WHERE id = ?", (template_id,))
    conn.commit(); deleted = cur.rowcount; conn.close()
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}

@app.post("/email/render")
def render_template(body: RenderIn):
    subject = body.subject or ""
    text = body.body or ""
    if body.template_id:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("SELECT subject, body FROM email_templates WHERE id=?", (body.template_id,))
        row = cur.fetchone(); conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="Template not found")
        subject = row["subject"]; text = row["body"]

    ctxt = {
        "customer_name": body.customer_name or "",
        "customer_email": body.customer_email or "",
        "invoice_number": body.invoice_number or "",
        "amount_cents": body.amount_cents if body.amount_cents is not None else "",
        "amount_usd": _format_amount(body.amount_cents, body.currency),
        "currency": body.currency or "USD",
        "due_date": body.due_date or "",
        "days_overdue": body.days_overdue if body.days_overdue is not None else "",
        "company_name": body.company_name or "Accounts Receivable",
        "today_date": date.today().isoformat(),
        "promised_date": body.promised_date or "",
    }

    return {"subject": _safe_format(subject, ctxt), "body": _safe_format(text, ctxt), "context": ctxt}

@app.on_event("startup")
def _startup():
    init_db()