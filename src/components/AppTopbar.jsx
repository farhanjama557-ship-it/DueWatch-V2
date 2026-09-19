import { useEffect, useRef, useState } from 'react'
import { Bell, ChevronDown, Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useData } from '../context/DataContext'

export default function AppTopbar() {
  const navigate = useNavigate()
  const { awaitingSignature = [], name = 'Account' } = useData()
  const [query, setQuery] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function submit(event) {
    event.preventDefault()
    const value = query.trim()
    navigate(value ? `/invoices?search=${encodeURIComponent(value)}` : '/invoices')
  }

  return (
    <header className="v1-topbar">
      <form className="v1-global-search" onSubmit={submit}>
        <Search size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search invoices, clients, payments..."
          aria-label="Search DueWatch"
        />
        <span className="v1-keycap">⌘ K</span>
      </form>

      <div className="v1-topbar-actions">
        <button
          type="button"
          className="v1-icon-button"
          aria-label={`${awaitingSignature.length} decisions need review`}
          onClick={() => navigate('/', { state: { scrollToSignature: true } })}
        >
          <Bell size={18} />
          {awaitingSignature.length > 0 && <span className="v1-notification-badge">{awaitingSignature.length}</span>}
        </button>
        <button type="button" className="v1-account-button" aria-label="Workspace menu">
          <span>Acme Holdings</span>
          <ChevronDown size={15} />
        </button>
      </div>
    </header>
  )
}
