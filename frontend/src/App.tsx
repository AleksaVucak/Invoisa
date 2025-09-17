import React, { useEffect, useMemo, useState, useRef } from 'react'

type Invoice = {
  id: number
  customer: string
  number: string
  amount_cents: number
  days_overdue: number
  score: number
  impact: number
  customer_email?: string | null
}

type EmailTemplate = {
  id: number
  name: string
  category: 'reminder' | 'followup' | 'promise'
  subject: string
  body: string
  is_default: boolean
  created_at: string
  updated_at: string
}

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const fmtUSD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const cents = (d: number) => Math.round(d * 100)
const dollars = (c: number) => c / 100

export default function App() {
  // THEME (unchanged)
  const [dark, setDark] = useState<boolean>(() => {
    const saved = (typeof localStorage !== 'undefined' && localStorage.getItem('theme')) || ''
    if (saved === 'dark') return true
    if (saved === 'light') return false
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  })
  useEffect(() => { document.documentElement.classList.toggle('dark', dark) }, [dark])
  function toggleTheme() {
    setDark(prev => {
      const next = !prev
      try { localStorage.setItem('theme', next ? 'dark' : 'light') } catch {}
      return next
    })
  }
  function resetToSystem() {
    try { localStorage.removeItem('theme') } catch {}
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    setDark(systemDark)
  }

  // DATA
  const [rows, setRows] = useState<Invoice[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  // Filters (unchanged)
  const [status, setStatus] = useState<'all' | 'open' | 'overdue'>('all')
  const [aging, setAging] = useState<'any' | '30+' | '60+' | '90+'>('any')
  const [minAmt, setMinAmt] = useState<number | ''>('')
  const [maxAmt, setMaxAmt] = useState<number | ''>('')
  const [sort, setSort] = useState<'impact_desc' | 'amount_desc' | 'days_desc'>('impact_desc')

  // Pagination (unchanged)
  const [page, setPage] = useState(1)
  const pageSize = 10
  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total])

  // Modal + form (unchanged)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Invoice | null>(null)
  const [fCustomer, setFCustomer] = useState('')
  const [fEmail, setFEmail] = useState('')
  const [fNumber, setFNumber] = useState('')
  const [fAmount, setFAmount] = useState(0)
  const [fIssuedAt, setFIssuedAt] = useState('')
  const [fDueAt, setFDueAt] = useState('')
  const [fStatus, setFStatus] = useState<'open' | 'overdue'>('open')

  function resetForm() {
    setFCustomer(''); setFEmail(''); setFNumber(''); setFAmount(0)
    const today = new Date().toISOString().slice(0, 10)
    setFIssuedAt(today); setFDueAt(today)
    setFStatus('open')
  }

  async function fetchRows(targetPage: number) {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (status !== 'all') params.set('status', status)
      if (aging !== 'any') params.set('aging_min', aging.replace('+', ''))
      if (minAmt !== '') params.set('min_amount', String(cents(Number(minAmt))))
      if (maxAmt !== '') params.set('max_amount', String(cents(Number(maxAmt))))
      params.set('sort', sort)
      params.set('limit', String(pageSize))
      params.set('offset', String((targetPage - 1) * pageSize))

      const res = await fetch(`${API}/invoices?` + params.toString())
      if (!res.ok) throw new Error(res.statusText)
      setRows(await res.json())
      const totalHeader = res.headers.get('X-Total-Count')
      setTotal(totalHeader ? Number(totalHeader) : 0)

      const url = new URL(window.location.href)
      url.search = params.toString()
      window.history.replaceState(null, '', url.toString())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchRows(1); setPage(1) }, [])

  async function submitForm(e: React.FormEvent) {
    e.preventDefault()
    const payload = {
      customer_name: fCustomer,
      customer_email: fEmail || null,
      number: fNumber,
      amount_cents: cents(fAmount),
      currency: 'USD',
      issued_at: new Date(fIssuedAt).toISOString(),
      due_at: new Date(fDueAt).toISOString(),
      status: fStatus,
    }
    try {
      const res = editing
        ? await fetch(`${API}/invoices/${editing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch(`${API}/invoices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) throw new Error(await res.text())
      setModalOpen(false)
      await fetchRows(1); setPage(1)
    } catch (err: any) { alert(err.message) }
  }

  function onUploadCSV(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.currentTarget.files?.[0]
    if (!f) return
    ev.currentTarget.value = ''
    const fd = new FormData()
    fd.append('csv_file', f)
    setUploading(true)
    fetch(`${API}/import/invoices`, { method: 'POST', body: fd })
      .then(async r => {
        if (!r.ok) throw new Error(await r.text())
        await fetchRows(1); setPage(1)
      })
      .catch(e => alert(e.message))
      .finally(() => setUploading(false))
  }

  function openCreate() { setEditing(null); resetForm(); setModalOpen(true) }
  function openEdit(row: Invoice) {
    setEditing(row)
    setFCustomer(row.customer)
    setFEmail(row.customer_email || '')
    setFNumber(row.number)
    setFAmount(dollars(row.amount_cents))
    const today = new Date().toISOString().slice(0, 10)
    setFIssuedAt(today); setFDueAt(today)
    setFStatus(row.days_overdue > 0 ? 'overdue' : 'open')
    setModalOpen(true)
  }

  // --- autosize helper (fits the email body perfectly, but user can't resize) ---
  function useAutosizeTextArea(ref: React.RefObject<HTMLTextAreaElement>, value: string) {
    useEffect(() => {
      const el = ref.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }, [ref, value])
  }

  /* -------- Delete: modal version (same style as Edit) -------- */
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteRow, setDeleteRow] = useState<Invoice | null>(null)
  function openDelete(row: Invoice) { setDeleteRow(row); setDeleteOpen(true) }
  async function confirmDelete() {
    if (!deleteRow) return
    try {
      const res = await fetch(`${API}/invoices/${deleteRow.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
      setDeleteOpen(false); setDeleteRow(null)
      await fetchRows(page)
    } catch (err: any) { alert(err.message) }
  }

  /* ================= Email: templates + compose ================= */
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeRow, setComposeRow] = useState<Invoice | null>(null)

  const [tpls, setTpls] = useState<EmailTemplate[]>([])
  const [tplLoading, setTplLoading] = useState(false)
  const [tplErr, setTplErr] = useState<string | null>(null)

  const [selectedTplId, setSelectedTplId] = useState<number | ''>('')
  const [promisedDate, setPromisedDate] = useState<string>('')

  const [renderSubject, setRenderSubject] = useState('')
  const [renderBody, setRenderBody] = useState('')
  const [renderErr, setRenderErr] = useState<string | null>(null)

  // Toast for copy actions
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  function showToast(msg: string) {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 1400)
  }

  // templates manager modal (opened from compose)
  const [tplMgrOpen, setTplMgrOpen] = useState(false)
  const [editingTpl, setEditingTpl] = useState<EmailTemplate | null>(null)
  const [tName, setTName] = useState('New Template')
  const [tCategory, setTCategory] = useState<'reminder' | 'followup' | 'promise'>('reminder')
  const [tSubject, setTSubject] = useState('Reminder: Invoice {invoice_number} Due {due_date}')
  const [tBody, setTBody] = useState(
`Hi {customer_name},

Just a friendly reminder that invoice {invoice_number} for {amount_usd} is due on {due_date}.
If you’ve already sent payment, thank you! Otherwise, please let me know if you need anything from me.

Best,
{company_name}`
  )
  const [tDefault, setTDefault] = useState(false)

  async function loadTemplates() {
    setTplLoading(true); setTplErr(null)
    try {
      const r = await fetch(`${API}/email/templates`)
      const j = await r.json()
      setTpls(j.items || [])
    } catch (e: any) {
      setTplErr(e?.message || 'Failed to load templates')
    } finally {
      setTplLoading(false)
    }
  }
  useEffect(() => { loadTemplates() }, [])

  function openCompose(row: Invoice) {
    setComposeRow(row)
    setSelectedTplId(tpls.find(t => t.is_default)?.id || '')
    setPromisedDate('')
    setRenderSubject('')
    setRenderBody('')
    setRenderErr(null)
    setComposeOpen(true)
  }

  async function renderTemplate() {
    if (!composeRow || !selectedTplId) return
    setRenderErr(null)
    try {
      const payload: any = {
        template_id: selectedTplId,
        customer_name: composeRow.customer,
        customer_email: composeRow.customer_email || '',
        invoice_number: composeRow.number,
        amount_cents: composeRow.amount_cents,
        currency: 'USD',
        due_date: '',
        days_overdue: composeRow.days_overdue,
        company_name: 'Invoisa',
        promised_date: promisedDate || undefined,
      }
      const r = await fetch(`${API}/email/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await r.json()
      setRenderSubject(j.subject || '')
      setRenderBody(j.body || '')
    } catch (e: any) {
      setRenderErr(e?.message || 'Failed to render')
    }
  }
  useEffect(() => { if (composeOpen && selectedTplId) renderTemplate() }, [composeOpen, selectedTplId, promisedDate]) // eslint-disable-line

  async function saveTemplate(e: React.FormEvent) {
    e.preventDefault()
    const payload = { name: tName.trim(), category: tCategory, subject: tSubject, body: tBody, is_default: tDefault }
    const url = editingTpl ? `${API}/email/templates/${editingTpl.id}` : `${API}/email/templates`
    const method = editingTpl ? 'PUT' : 'POST'
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (!r.ok) { alert(await r.text()); return }
    setTplMgrOpen(false)
    setEditingTpl(null)
    await loadTemplates()
  }
  async function deleteTemplate(id: number) {
    if (!confirm('Delete this template?')) return
    await fetch(`${API}/email/templates/${id}`, { method: 'DELETE' })
    await loadTemplates()
  }

  // autosize setup for compose body
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  useAutosizeTextArea(bodyRef, renderBody)

  return (
    <div className="min-h-screen">
      {/* toast */}
      {toast && (
        <div
          style={{ position: 'fixed', top: '16px', right: '16px', zIndex: 9999 }}
          className="rounded-xl ring-1 ring-zinc-200 dark:ring-zinc-800 bg-white dark:bg-zinc-900 px-4 py-2 text-sm dark:text-zinc-100 shadow-sm"
        >
          {toast}
        </div>
      )}

      <header className="sticky top-0 z-10 border-b border-zinc-200/70 dark:border-zinc-800/70 backdrop-blur bg-white/70 dark:bg-zinc-950/70">
        <div className="mx-auto max-w-6xl px-3 sm:px-4 py-3 flex items-center justify-between">
          <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Invoisa</div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              onAuxClick={resetToSystem}
              onContextMenu={(e) => { e.preventDefault(); resetToSystem() }}
              className="btn btn-outline"
              aria-pressed={dark}
              title={dark ? 'Dark (click = Light, right-click = System)' : 'Light (click = Dark, right-click = System)'}
            >
              {dark ? 'Light Mode' : 'Dark Mode'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-3 sm:p-4">
        {/* Filters (unchanged) */}
        <section className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm ring-1 ring-zinc-200 dark:ring-zinc-800 p-4 mb-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Status</div>
              <select className="select" value={status} onChange={e => setStatus(e.target.value as any)}>
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="overdue">Overdue</option>
              </select>
            </label>

            <label className="grid gap-1">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Aging</div>
              <select className="select" value={aging} onChange={e => setAging(e.target.value as any)}>
                <option value="any">Any</option>
                <option value="30+">30+</option>
                <option value="60+">60+</option>
                <option value="90+">90+</option>
              </select>
            </label>

            <label className="grid gap-1">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Min $</div>
              <input className="input" type="number" placeholder="e.g. 500" value={minAmt} onChange={e => setMinAmt(e.target.value === '' ? '' : Number(e.target.value))}/>
            </label>

            <label className="grid gap-1">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Max $</div>
              <input className="input" type="number" placeholder="e.g. 5000" value={maxAmt} onChange={e => setMaxAmt(e.target.value === '' ? '' : Number(e.target.value))}/>
            </label>

            <label className="grid gap-1">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Sort</div>
              <select className="select" value={sort} onChange={e => setSort(e.target.value as any)}>
                <option value="impact_desc">Impact ↓</option>
                <option value="amount_desc">Amount ↓</option>
                <option value="days_desc">Days Overdue ↓</option>
              </select>
            </label>

            <div className="ml-auto flex gap-2">
              <label className="btn btn-primary cursor-pointer">
                {uploading ? 'Uploading…' : 'Import CSV'}
                <input type="file" accept=".csv" className="hidden" onChange={onUploadCSV} disabled={uploading}/>
              </label>
              <button onClick={() => { setPage(1); fetchRows(1) }} className="btn btn-outline">Apply</button>
              <button onClick={openCreate} className="btn btn-primary">New Invoice</button>
            </div>
          </div>
        </section>

        {/* Table (unchanged) */}
        <section className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm ring-1 ring-zinc-200 dark:ring-zinc-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
            <div className="text-sm text-zinc-600 dark:text-zinc-300">
              {total > 0 ? `Showing ${((page-1)*pageSize)+1}–${Math.min(page*pageSize,total)} of ${total}` : 'No Results'}
            </div>
            {loading && <div className="text-sm text-zinc-500">Loading…</div>}
            {error && <div className="text-sm text-red-600">{error}</div>}
          </div>

          <div className="overflow-x-auto">
            <table className="table w-full border-collapse">
              <thead className="bg-zinc-50 dark:bg-zinc-900">
                <tr>
                  <th className="th px-4">Customer</th>
                  <th className="th px-4">Invoice #</th>
                  <th className="th px-4">Amount</th>
                  <th className="th px-4">Days Overdue</th>
                  <th className="th px-4">Score</th>
                  <th className="th px-4">Impact</th>
                  <th className="th px-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {!loading && rows.map(r => (
                  <tr key={r.id} className="tr-hover">
                    <td className="td px-4">
                      <div className="font-medium">{r.customer}</div>
                      <div className="text-xs text-zinc-500 mt-0.5">{r.days_overdue > 0 ? 'Overdue' : 'Open'}</div>
                    </td>
                    <td className="td px-4">{r.number}</td>
                    <td className="td px-4">{fmtUSD.format(dollars(r.amount_cents))}</td>
                    <td className="td px-4">{r.days_overdue}</td>
                    <td className="td px-4">{r.score.toFixed(2)}</td>
                    <td className="td px-4">{fmtUSD.format(dollars(r.impact))}</td>
                    <td className="td px-4">
                      <div className="flex gap-2">
                        <button onClick={() => openCompose(r)} className="btn btn-primary">Compose Email</button>
                        <button onClick={() => openEdit(r)} className="btn btn-outline">Edit</button>
                        <button onClick={() => openDelete(r)} className="btn btn-danger">Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}

                {loading && (
                  <tr>
                    <td className="td px-4" colSpan={7}>
                      <div className="animate-pulse h-6 w-full rounded bg-zinc-200 dark:bg-zinc-800"></div>
                    </td>
                  </tr>
                )}

                {!loading && !error && rows.length === 0 && (
                  <tr>
                    <td className="td px-4 text-zinc-500" colSpan={7}>No Invoices Match Your Filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
            <div className="text-sm dark:text-white">Page {page} / {totalPages}</div>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => { const p = Math.max(1, page - 1); setPage(p); fetchRows(p) }}
                className="btn btn-outline disabled:opacity-50"
              >Prev</button>
              <button
                disabled={page >= totalPages}
                onClick={() => { const p = Math.min(totalPages, page + 1); setPage(p); fetchRows(p) }}
                className="btn btn-outline disabled:opacity-50"
              >Next</button>
            </div>
          </div>
        </section>
      </main>

      {/* Invoice Modal */}
      {modalOpen && (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-3 dark:text-zinc-100">{editing ? 'Edit Invoice' : 'New Invoice'}</h2>
            <form onSubmit={submitForm} className="grid gap-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Customer</label>
                  <input className="input" value={fCustomer} onChange={e => setFCustomer(e.target.value)} required/>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Customer Email (Optional)</label>
                  <input className="input" type="email" value={fEmail} onChange={e => setFEmail(e.target.value)} />
                </div>
              </div>

              <div className="grid sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Invoice #</label>
                  <input className="input" value={fNumber} onChange={e => setFNumber(e.target.value)} required/>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Amount ($)</label>
                  <input className="input" type="number" step="0.01" value={fAmount} onChange={e => setFAmount(Number(e.target.value || 0))} required/>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Status</label>
                  <select className="select" value={fStatus} onChange={e => setFStatus(e.target.value as any)}>
                    <option value="open">Open</option>
                    <option value="overdue">Overdue</option>
                  </select>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Issued At</label>
                  <input className="input" type="date" value={fIssuedAt} onChange={e => setFIssuedAt(e.target.value)} required/>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Due At</label>
                  <input className="input" type="date" value={fDueAt} onChange={e => setFDueAt(e.target.value)} required/>
                </div>
              </div>

              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setModalOpen(false)} className="btn btn-ghost">Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {deleteOpen && deleteRow && (
        <div className="modal-overlay" onClick={() => setDeleteOpen(false)}>
          <div className="modal-card max-w-md" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-2 dark:text-zinc-100">Delete Invoice</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              Are you sure you want to delete <span className="font-medium">{deleteRow.customer}</span> – <span className="font-mono">{deleteRow.number}</span>?
              This action cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setDeleteOpen(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={confirmDelete}>Delete Invoice</button>
            </div>
          </div>
        </div>
      )}

      {/* Compose Email Modal (wider, fixed-size body auto-fits, copy toasts) */}
      {composeOpen && composeRow && (
        <div className="modal-overlay" onClick={() => setComposeOpen(false)}>
          <div
            className="modal-card"
            style={{ width: 'min(96vw, 1000px)', maxWidth: '1000px' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-2">
              <div>
                <h2 className="text-lg font-semibold dark:text-zinc-100">Compose Email</h2>
                <div className="text-sm text-zinc-600 dark:text-zinc-300 mt-0.5">
                  {composeRow.customer} • <span className="font-mono">{composeRow.number}</span> • {fmtUSD.format(dollars(composeRow.amount_cents))}
                </div>
              </div>
              <button className="btn btn-ghost" onClick={() => setTplMgrOpen(true)}>Manage Templates</button>
            </div>

            {/* Recipient */}
            <div className="rounded-xl ring-1 ring-zinc-200 dark:ring-zinc-800 p-3 mb-3 bg-white dark:bg-zinc-900">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">To</div>
              <div className="text-sm dark:text-zinc-100">{composeRow.customer_email || <span className="text-zinc-400">No Email On File</span>}</div>
            </div>

            {/* Template Row */}
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="grid gap-1 text-sm">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Template</span>
                <select className="select" value={selectedTplId} onChange={e => setSelectedTplId(e.target.value ? Number(e.target.value) : '' as any)}>
                  <option value="">— Select —</option>
                  {tpls.map(t => <option key={t.id} value={t.id}>{t.name} ({t.category})</option>)}
                </select>
              </label>
              {tpls.find(t => t.id === selectedTplId)?.category === 'promise' && (
                <label className="grid gap-1 text-sm">
                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Promised Date</span>
                  <input className="input" type="date" value={promisedDate} onChange={e => setPromisedDate(e.target.value)} />
                </label>
              )}
            </div>

            {/* Subject / Body */}
            {renderErr && <div className="mt-2 text-sm text-red-600">{renderErr}</div>}
            <div className="mt-3 grid gap-2">
              <label className="grid gap-1 text-sm">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Subject</span>
                <input className="input dark:text-zinc-100" value={renderSubject} onChange={e => setRenderSubject(e.target.value)} placeholder="Email Subject"/>
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Body</span>
                <textarea
                  ref={bodyRef}
                  className="textarea dark:text-zinc-100"
                  style={{
                    overflow: 'hidden',     // no internal scrollbar
                    resize: 'none',         // user cannot resize
                    minHeight: '260px',     // base size
                  }}
                  value={renderBody}
                  onChange={(e) => setRenderBody(e.target.value)}
                  placeholder="Email Body"
                />
              </label>
            </div>

            {/* Footer actions */}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                className="btn btn-outline"
                onClick={() => { navigator.clipboard.writeText(renderSubject); showToast('Subject Copied'); }}
              >
                Copy Subject
              </button>
              <button
                className="btn btn-outline"
                onClick={() => { navigator.clipboard.writeText(renderBody); showToast('Body Copied'); }}
              >
                Copy Body
              </button>
              <a
                className="btn btn-primary"
                href={`mailto:${encodeURIComponent((composeRow.customer_email || ''))}?subject=${encodeURIComponent(renderSubject)}&body=${encodeURIComponent(renderBody)}`}
              >
                Open In Email Client
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Templates Manager (modernized, two-panel) */}
      {tplMgrOpen && (
        <div className="modal-overlay" onClick={() => setTplMgrOpen(false)}>
          <div
            className="modal-card"
            style={{ width: 'min(96vw, 1000px)', maxWidth: '1000px' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold dark:text-zinc-100">Email Templates</h2>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setEditingTpl(null)
                  setTName('New Template')
                  setTCategory('reminder')
                  setTSubject('Reminder: Invoice {invoice_number} Due {due_date}')
                  setTBody(`Hi {customer_name},\n\nJust a friendly reminder that invoice {invoice_number} for {amount_usd} is due on {due_date}.\n\nBest,\n{company_name}`)
                  setTDefault(false)
                }}
              >
                New Template
              </button>
            </div>

            {tplErr && <div className="text-sm text-red-600 mb-2">{tplErr}</div>}
            {tplLoading && <div className="text-sm text-zinc-500 mb-2">Loading…</div>}

            <div className="grid sm:grid-cols-2 gap-3">
              {/* Left: list */}
              <div
                className="rounded-xl ring-1 ring-zinc-200 dark:ring-zinc-800 p-3 bg-white dark:bg-zinc-900"
                style={{ maxHeight: '60vh', overflowY: 'auto' }}
              >
                {tpls.length === 0 && <div className="text-sm text-zinc-500">No Templates Yet.</div>}
                {tpls.map(t => (
                  <div key={t.id} className="rounded-xl p-3 mb-3 last:mb-0 ring-1 ring-zinc-200 dark:ring-zinc-800 bg-white dark:bg-zinc-900">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium dark:text-zinc-100">
                          {t.name}
                          <span className="text-xs text-zinc-500 ml-2">({t.category})</span>
                          {t.is_default ? <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800">Default</span> : null}
                        </div>
                        <div className="text-sm text-zinc-600 dark:text-zinc-300 mt-1 truncate">
                          Subject: {t.subject}
                        </div>
                      </div>
                      <div className="flex-shrink-0 flex gap-2">
                        <button
                          className="btn btn-outline"
                          onClick={() => {
                            setEditingTpl(t)
                            setTName(t.name); setTCategory(t.category); setTSubject(t.subject); setTBody(t.body); setTDefault(!!t.is_default)
                          }}
                        >
                          Edit
                        </button>
                        <button className="btn btn-danger" onClick={() => deleteTemplate(t.id)}>Delete</button>
                      </div>
                    </div>
                    <pre className="mt-2 text-sm whitespace-pre-wrap text-zinc-700 dark:text-zinc-300"
                         style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace' }}>
{t.body}
                    </pre>
                  </div>
                ))}
              </div>

              {/* Right: editor */}
              <form onSubmit={saveTemplate} className="grid gap-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="grid gap-1 text-sm">
                    <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Name</span>
                    <input className="input" value={tName} onChange={e => setTName(e.target.value)} required />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Category</span>
                    <select className="select" value={tCategory} onChange={e => setTCategory(e.target.value as any)}>
                      <option value="reminder">Reminder</option>
                      <option value="followup">Follow-Up</option>
                      <option value="promise">Promise-To-Pay</option>
                    </select>
                  </label>
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="grid gap-1 text-sm">
                    <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Subject</span>
                    <input className="input" value={tSubject} onChange={e => setTSubject(e.target.value)} required />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Default</span>
                    <select className="select" value={tDefault ? '1' : '0'} onChange={e => setTDefault(e.target.value === '1')}>
                      <option value="0">No</option>
                      <option value="1">Yes</option>
                    </select>
                  </label>
                </div>

                <label className="grid gap-1 text-sm">
                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Body</span>
                  <textarea className="textarea min-h-[180px]" value={tBody} onChange={e => setTBody(e.target.value)} required />
                </label>

                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" className="btn btn-ghost" onClick={() => setTplMgrOpen(false)}>Close</button>
                  <button type="submit" className="btn btn-primary">{editingTpl ? 'Save' : 'Create'}</button>
                </div>

                <div className="text-xs text-zinc-500 mt-3">
                  Available Variables: {'{customer_name}'}, {'{customer_email}'}, {'{invoice_number}'}, {'{amount_usd}'}, {'{currency}'}, {'{due_date}'}, {'{days_overdue}'}, {'{company_name}'}, {'{today_date}'}, {'{promised_date}'}
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}