
import React, { useEffect, useMemo, useState } from 'react'

type Invoice = {
  id: number
  customer: string
  number: string
  amount_cents: number
  days_overdue: number
  score: number
  impact: number
}

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const fmtUSD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const cents = (d: number) => Math.round(d * 100)
const dollars = (c: number) => c / 100

export default function App() {
  const [dark, setDark] = useState<boolean>(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const root = document.documentElement
    if (dark) root.classList.add('dark'); else root.classList.remove('dark')
  }, [dark])

  const [rows, setRows] = useState<Invoice[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const [status, setStatus] = useState<'all' | 'open' | 'overdue'>('all')
  const [aging, setAging] = useState<'any' | '30+' | '60+' | '90+'>('any')
  const [minAmt, setMinAmt] = useState<number | ''>('')
  const [maxAmt, setMaxAmt] = useState<number | ''>('')
  const [sort, setSort] = useState<'impact_desc' | 'amount_desc' | 'days_desc'>('impact_desc')

  const [page, setPage] = useState(1)
  const pageSize = 10
  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total])

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Invoice | null>(null)
  const [fCustomer, setFCustomer] = useState('')
  const [fEmail, setFEmail] = useState('')
  const [fNumber, setFNumber] = useState('')
  const [fAmount, setFAmount] = useState<number | ''>('')
  const [fIssuedAt, setFIssuedAt] = useState<string>('')
  const [fDueAt, setFDueAt] = useState<string>('')
  const [fStatus, setFStatus] = useState<'open' | 'overdue' | 'paid'>('open')

  function resetForm() {
    setFCustomer(''); setFEmail(''); setFNumber(''); setFAmount('')
    setFIssuedAt(''); setFDueAt(''); setFStatus('open')
  }

  async function fetchRows(targetPage = 1) {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (status !== 'all') params.set('status', status)
      if (aging !== 'any') params.set('aging_min', aging.replace('+',''))
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
    } catch (e:any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchRows(1); setPage(1) }, [])

  async function onUploadCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('csv_file', file)
      const res = await fetch(`${API}/import/invoices`, { method: 'POST', body: fd })
      if (!res.ok) throw new Error(await res.text())
      await fetchRows(1); setPage(1)
      alert('CSV imported successfully')
    } catch (err:any) {
      alert('Import failed: ' + err.message)
    } finally {
      setUploading(false)
      e.currentTarget.value = ''
    }
  }

  function openCreate() { setEditing(null); resetForm(); setModalOpen(true) }
  function openEdit(row: Invoice) {
    setEditing(row)
    setFCustomer(row.customer)
    setFEmail('')
    setFNumber(row.number)
    setFAmount(dollars(row.amount_cents))
    const today = new Date().toISOString().slice(0,10)
    setFIssuedAt(today); setFDueAt(today)
    setFStatus('open')
    setModalOpen(true)
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault()
    if (!fCustomer || !fNumber || fAmount === '' || !fIssuedAt || !fDueAt) {
      alert('Please fill customer, invoice #, amount, issued at, due at.'); return
    }
    const payload: any = {
      customer_name: fCustomer,
      customer_email: fEmail || undefined,
      number: fNumber,
      amount_cents: Math.round(Number(fAmount) * 100),
      currency: 'USD',
      issued_at: new Date(fIssuedAt).toISOString(),
      due_at: new Date(fDueAt).toISOString(),
      status: fStatus
    }
    try {
      const url = editing ? `${API}/invoices/${editing.id}` : `${API}/invoices`
      const method = editing ? 'PUT' : 'POST'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) throw new Error(await res.text())
      setModalOpen(false); resetForm(); await fetchRows(page)
    } catch (err:any) {
      alert(err.message)
    }
  }

  async function onDelete(id: number) {
    if (!confirm('Delete this invoice?')) return
    try {
      const res = await fetch(`${API}/invoices/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
      await fetchRows(page)
    } catch (err:any) { alert(err.message) }
  }

  const statusBadge = (s: 'open'|'overdue'|'paid') => {
    if (s === 'paid') return <span className="badge badge-green">paid</span>
    if (s === 'overdue') return <span className="badge badge-amber">overdue</span>
    return <span className="badge badge-sky">open</span>
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-zinc-200/70 dark:border-zinc-800/70 backdrop-blur bg-white/70 dark:bg-zinc-950/70">
        <div className="mx-auto max-w-6xl px-3 sm:px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-xl bg-brand-600 text-white grid place-items-center font-bold">I</div>
            <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Invoisa</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setDark(d => !d)} className="btn btn-outline" title="Toggle theme">
              {dark ? 'Light' : 'Dark'} mode
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-3 sm:px-4 py-6">
        <section className="card p-4 sm:p-5 mb-5">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Status</label>
              <select className="select" value={status} onChange={e => setStatus(e.target.value as any)}>
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="overdue">Overdue</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Aging</label>
              <select className="select" value={aging} onChange={e => setAging(e.target.value as any)}>
                <option value="any">Any</option>
                <option value="30+">30+</option>
                <option value="60+">60+</option>
                <option value="90+">90+</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Min $</label>
              <input className="input w-28" type="number" min="0" placeholder="e.g. 500" value={minAmt}
                     onChange={e => setMinAmt(e.target.value === '' ? '' : Number(e.target.value))}/>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Max $</label>
              <input className="input w-32" type="number" min="0" placeholder="e.g. 5000" value={maxAmt}
                     onChange={e => setMaxAmt(e.target.value === '' ? '' : Number(e.target.value))}/>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Sort</label>
              <select className="select" value={sort} onChange={e => setSort(e.target.value as any)}>
                <option value="impact_desc">Impact ↓</option>
                <option value="amount_desc">Amount ↓</option>
                <option value="days_desc">Days overdue ↓</option>
              </select>
            </div>

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

        <section className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
            <div className="text-sm text-zinc-600 dark:text-zinc-300">
              {total > 0 ? `Showing ${((page-1)*pageSize)+1}–${Math.min(page*pageSize,total)} of ${total}` : 'No results'}
            </div>
            {loading && <div className="text-sm text-zinc-500">Loading…</div>}
            {error && <div className="text-sm text-red-600">{error}</div>}
          </div>

          <div className="overflow-x-auto">
            <table className="table">
              <thead className="bg-zinc-50 dark:bg-zinc-900">
                <tr>
                  <th className="th px-4">Customer</th>
                  <th className="th px-4">Invoice #</th>
                  <th className="th px-4">Amount</th>
                  <th className="th px-4">Days overdue</th>
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
                      <div className="text-xs text-zinc-500 mt-0.5">{r.days_overdue > 0 ? 'overdue' : 'open'}</div>
                    </td>
                    <td className="td px-4">{r.number}</td>
                    <td className="td px-4">{fmtUSD.format(dollars(r.amount_cents))}</td>
                    <td className="td px-4">{r.days_overdue}</td>
                    <td className="td px-4">{r.score.toFixed(2)}</td>
                    <td className="td px-4">{fmtUSD.format(dollars(r.impact))}</td>
                    <td className="td px-4">
                      <div className="flex gap-2">
                        <button onClick={() => openEdit(r)} className="btn btn-outline">Edit</button>
                        <button onClick={() => onDelete(r.id)} className="btn btn-danger">Delete</button>
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
                    <td className="td px-4 text-zinc-500" colSpan={7}>No invoices match your filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
            <div className="text-sm text-zinc-600 dark:text-zinc-300">Page {page} / {totalPages}</div>
            <div className="flex items-center gap-2">
              <button
                disabled={page<=1}
                onClick={() => { const p = Math.max(1, page-1); setPage(p); fetchRows(p) }}
                className="btn btn-outline disabled:opacity-50"
              >Prev</button>
              <button
                disabled={page>=totalPages}
                onClick={() => { const p = Math.min(totalPages, page+1); setPage(p); fetchRows(p) }}
                className="btn btn-outline disabled:opacity-50"
              >Next</button>
            </div>
          </div>
        </section>
      </main>

      {modalOpen && (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-3">{editing ? 'Edit Invoice' : 'New Invoice'}</h2>
            <form onSubmit={submitForm} className="grid gap-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Customer</label>
                  <input className="input" value={fCustomer} onChange={e => setFCustomer(e.target.value)} required/>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Customer Email (optional)</label>
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
                  <input className="input" type="number" min="0" value={fAmount} onChange={e => setFAmount(e.target.value === '' ? '' : Number(e.target.value))} required/>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Status</label>
                  <select className="select" value={fStatus} onChange={e => setFStatus(e.target.value as any)}>
                    <option value="open">open</option>
                    <option value="overdue">overdue</option>
                    <option value="paid">paid</option>
                  </select>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Issued at</label>
                  <input className="input" type="date" value={fIssuedAt} onChange={e => setFIssuedAt(e.target.value)} required/>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Due at</label>
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
    </div>
  )
}
