import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Building2, CalendarClock, CalendarRange, Check, ChevronDown, ChevronRight, Layers3, Printer, RefreshCw, Scissors, Search, Settings2, X } from 'lucide-react'
import { request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'
import { BLANK_ACCOUNT_TYPE_FILTER, filterSelectOptions } from './filterValues'
import { defaultExecutiveFilters, EXECUTIVE_FILTER_STATUSES, executiveUpdatePayload } from './executiveView'
import { localTodayISO } from './paymentsView'
import { can, canApproveObligations } from './permissions'
import { withDerivedObligationValues } from './obligationValues'
import { canSplitPayment, SplitPaymentModal } from './Registry'

const periodIcons = {
  overdue: AlertTriangle,
  week: CalendarClock,
  month: CalendarRange,
}

const executiveStatusOptions = EXECUTIVE_FILTER_STATUSES.map(value => ({ value, label: value }))

export default function ExecutiveDashboard({ user, notify }) {
  const [refs, setRefs] = useState({})
  const [filters, setFilters] = useState(() => defaultExecutiveFilters(localTodayISO()))
  const [data, setData] = useState({ periods: [] })
  const [loading, setLoading] = useState(true)
  const [details, setDetails] = useState(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsSaving, setDetailsSaving] = useState(() => new Set())
  const [splitItem, setSplitItem] = useState(null)
  const [settings, setSettings] = useState({ kibirev_rent_enabled: true })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString(), [filters])

  useEffect(() => {
    Promise.all([request('/api/references'), request('/api/reports/executive/settings')])
      .then(([referenceData, settingsData]) => {
        setRefs(referenceData)
        setSettings(settingsData)
      })
      .catch(error => notify(error.message, 'error'))
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    request(`/api/reports/executive?${query}`)
      .then(result => { if (active) setData(result) })
      .catch(error => { if (active) notify(error.message, 'error') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [query])

  const openDetails = (period, group) => {
    const params = new URLSearchParams({
      ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
      period: period.key,
      cost_category: group.cost_category,
    })
    setDetails({
      kind: 'general',
      period,
      cost_category: group.cost_category,
      count: group.count,
      amount: group.amount,
      items: [],
      report_date: filters.as_of,
      legal_entity: filters.legal_entity,
      account_type: filters.account_type,
      status: filters.status,
    })
    setDetailsLoading(true)
    request(`/api/reports/executive/details?${params}`)
      .then(result => setDetails(current => current ? { ...current, ...result } : current))
      .catch(error => { setDetails(null); notify(error.message, 'error') })
      .finally(() => setDetailsLoading(false))
  }

  const openSpecialDetails = special => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value))
    setDetails({
      kind: 'special',
      period: { key: 'special', title: 'До конца месяца, включая просроченные', to: special.to },
      cost_category: special.title,
      count: special.count,
      amount: special.amount,
      paid_amount: 0,
      outstanding_amount: special.amount,
      items: [],
      report_date: filters.as_of,
      legal_entity: filters.legal_entity,
      account_type: filters.account_type,
      status: filters.status,
    })
    setDetailsLoading(true)
    request(`/api/reports/executive/special-details?${params}`)
      .then(result => setDetails(current => current ? { ...current, ...result, kind: 'special' } : current))
      .catch(error => { setDetails(null); notify(error.message, 'error') })
      .finally(() => setDetailsLoading(false))
  }

  const saveDetailField = async (item, field, value) => {
    const key = `${item.id}:${field}`
    const optimisticItem = withDerivedObligationValues({ ...item, [field]: value }, field)
    setDetailsSaving(current => new Set(current).add(key))
    setDetails(current => current ? {
      ...current,
      items: current.items.map(row => row.id === item.id ? optimisticItem : row),
    } : current)
    const payload = executiveUpdatePayload(item.id, field, value)
    const currentDetails = details
    const params = new URLSearchParams(Object.entries(filters).filter(([, filterValue]) => filterValue))
    if (currentDetails.kind !== 'special') {
      params.set('period', currentDetails.period.key)
      params.set('cost_category', currentDetails.cost_category)
    }
    const detailsEndpoint = currentDetails.kind === 'special'
      ? '/api/reports/executive/special-details'
      : '/api/reports/executive/details'
    try {
      await request('/api/reports/executive/obligations/bulk', { method: 'POST', body: JSON.stringify(payload) })
      const [dashboardResult, detailsResult] = await Promise.all([
        request(`/api/reports/executive?${query}`),
        request(`${detailsEndpoint}?${params}`),
      ])
      setData(dashboardResult)
      setDetails(current => current ? { ...current, ...detailsResult } : current)
      notify(field === 'status' ? 'Статус обновлён' : value ? 'Дата утверждения обновлена' : 'Дата утверждения очищена')
      return true
    } catch (error) {
      setDetails(current => current ? {
        ...current,
        items: current.items.map(row => {
          if (row.id !== item.id || row[field] !== value) return row
          const reverted = { ...row, [field]: item[field] }
          if (row.status === optimisticItem.status) reverted.status = item.status
          return reverted
        }),
      } : current)
      notify(error.message, 'error')
      return false
    } finally {
      setDetailsSaving(current => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const splitPayment = async (item, values) => {
    const currentDetails = details
    if (!currentDetails) return
    try {
      const result = await request(`/api/obligations/${item.id}/split`, {
        method: 'POST',
        body: JSON.stringify(values),
      })
      const params = new URLSearchParams(Object.entries(filters).filter(([, filterValue]) => filterValue))
      if (currentDetails.kind !== 'special') {
        params.set('period', currentDetails.period.key)
        params.set('cost_category', currentDetails.cost_category)
      }
      const detailsEndpoint = currentDetails.kind === 'special'
        ? '/api/reports/executive/special-details'
        : '/api/reports/executive/details'
      const [dashboardResult, detailsResult] = await Promise.all([
        request(`/api/reports/executive?${query}`),
        request(`${detailsEndpoint}?${params}`),
      ])
      setData(dashboardResult)
      setDetails(current => current ? { ...current, ...detailsResult } : current)
      setSplitItem(null)
      notify(`Платёж разбит на ${result.installments.length} частей без изменения общей суммы`)
    } catch (error) {
      notify(error.message, 'error')
      throw error
    }
  }

  const saveSpecialSetting = async enabled => {
    setSettingsSaving(true)
    try {
      const result = await request('/api/reports/executive/settings', {
        method: 'PUT',
        body: JSON.stringify({ kibirev_rent_enabled: enabled }),
      })
      setSettings(result)
      setDetails(null)
      const dashboardResult = await request(`/api/reports/executive?${query}`)
      setData(dashboardResult)
      notify(enabled ? 'Раздел аренды включён' : 'Раздел аренды отключён')
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setSettingsSaving(false)
    }
  }

  const refresh = () => {
    setLoading(true)
    request(`/api/reports/executive?${query}`)
      .then(setData)
      .catch(error => notify(error.message, 'error'))
      .finally(() => setLoading(false))
  }

  return <div className="page executive-page">
    <PageHeader
      eyebrow="Управленческая аналитика"
      title="Панель руководителя"
      subtitle="Контроль обязательств на выбранную дату"
      actions={<>
        {can(user, 'executive.settings') && <button className="secondary" onClick={() => setSettingsOpen(true)}><Settings2 size={17}/>Настройки</button>}
        <button className="secondary" onClick={refresh} disabled={loading}><RefreshCw size={17}/>Обновить</button>
      </>}
    />

    <section className="executive-filters panel">
      <label>
        <span>Дата отчёта</span>
        <DateInput value={filters.as_of} onChange={value => value && setFilters(current => ({ ...current, as_of: value }))} aria-label="Дата отчёта"/>
      </label>
      <ExecutiveFilterSelect
        label="Юридическое лицо"
        value={filters.legal_entity}
        allLabel="Все юридические лица"
        options={(refs.legal_entities || []).map(item => ({ value: item.value, label: item.value }))}
        onChange={value => setFilters(current => ({ ...current, legal_entity: value }))}
      />
      <ExecutiveFilterSelect
        label="Признак учёта"
        value={filters.account_type}
        allLabel="Все признаки учёта"
        options={[
          { value: BLANK_ACCOUNT_TYPE_FILTER, label: 'Не выбран (—)' },
          ...(refs.account_types || []).map(item => ({ value: item.value, label: item.value })),
        ]}
        onChange={value => setFilters(current => ({ ...current, account_type: value }))}
      />
      <ExecutiveFilterSelect
        label="Статус"
        value={filters.status}
        allLabel="Все"
        options={executiveStatusOptions}
        onChange={value => setFilters(current => ({ ...current, status: value }))}
      />
    </section>

    {data.special_section && <ExecutiveSpecialCard special={data.special_section} onSelect={() => openSpecialDetails(data.special_section)}/>}

    <section className={`executive-grid ${loading ? 'is-loading' : ''}`} aria-busy={loading}>
      {loading && data.periods.length === 0
        ? ['overdue', 'week', 'month'].map(key => <ExecutiveSkeleton key={key}/>)
        : data.periods.map(period => <ExecutivePeriodCard key={period.key} period={period} onSelect={group => openDetails(period, group)}/>)}
    </section>

    {details && <ExecutiveDetails
      details={details}
      loading={detailsLoading}
      statuses={(refs.statuses || []).map(item => item.value)}
      savingCells={detailsSaving}
      editable={canApproveObligations(user)}
      splitAllowed={can(user, 'registry.split')}
      onCommit={saveDetailField}
      onSplit={setSplitItem}
      onClose={() => setDetails(null)}
    />}
    {splitItem && <SplitPaymentModal item={splitItem} refs={refs} onClose={() => setSplitItem(null)} onSave={values => splitPayment(splitItem, values)}/>}
    {settingsOpen && <ExecutiveSettingsModal
      settings={settings}
      saving={settingsSaving}
      onChange={saveSpecialSetting}
      onClose={() => setSettingsOpen(false)}
    />}
  </div>
}

function ExecutiveFilterSelect({ label, value, allLabel, options, onChange, allowAll = true }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const selected = options.find(option => option.value === value)
  const visible = useMemo(() => filterSelectOptions(options, search), [options, search])

  useEffect(() => {
    if (!open) return undefined
    const closeOutside = event => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    const closeEscape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [open])

  const choose = next => {
    onChange(next)
    setSearch('')
    setOpen(false)
  }

  return <label>
    <span>{label}</span>
    <div ref={rootRef} className={`executive-select ${open ? 'is-open' : ''} ${value ? 'has-value' : ''}`}>
      <button type="button" className="executive-select-trigger" onClick={() => { setSearch(''); setOpen(current => !current) }} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${selected?.label || allLabel}`}>
        <span title={selected?.label || allLabel}>{selected?.label || allLabel}</span>
        <ChevronDown size={16}/>
      </button>
      {open && <div className="executive-select-menu">
        <div className="header-filter-search">
          <Search size={15}/>
          <input ref={inputRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск по наименованию" aria-label={`Поиск: ${label}`}/>
          {search && <button type="button" onClick={() => setSearch('')} aria-label="Очистить поиск"><X size={13}/></button>}
        </div>
        <div className="header-filter-options" role="listbox" aria-label={`Значения: ${label}`}>
          {allowAll && <button type="button" className={!value ? 'selected' : ''} onClick={() => choose('')} role="option" aria-selected={!value}><span>{allLabel}</span>{!value && <Check size={14}/>}</button>}
          {visible.map(option => <button type="button" key={option.value} className={option.value === value ? 'selected' : ''} onClick={() => choose(option.value)} title={option.label} role="option" aria-selected={option.value === value}><span>{option.label}</span>{option.value === value && <Check size={14}/>}</button>)}
          {!visible.length && <p>Ничего не найдено</p>}
        </div>
      </div>}
    </div>
  </label>
}

function ExecutivePeriodCard({ period, onSelect }) {
  const Icon = periodIcons[period.key] || Layers3
  const range = period.from ? `${shortDate(period.from)} — ${shortDate(period.to)}` : `до ${shortDate(period.to)}`
  return <article className={`executive-period executive-period-${period.key} panel`}>
    <header>
      <div className="executive-period-icon"><Icon size={21}/></div>
      <div><span>{range}</span><h2>{period.title}</h2></div>
    </header>
    <div className="executive-period-total">
      <div><span>Обязательств</span><strong>{period.count.toLocaleString('ru-RU')}</strong></div>
      <div><span>Общая сумма</span><strong>{money(period.amount)}</strong></div>
    </div>
    <div className="executive-groups">
      <div className="executive-groups-head"><span>Статья затрат</span><span>Кол-во</span><span>Сумма</span><i/></div>
      {period.groups.length === 0
        ? <div className="executive-empty"><Layers3 size={25}/><strong>Обязательств нет</strong><span>По выбранным условиям список пуст</span></div>
        : period.groups.map(group => <button type="button" className="executive-group-row" key={group.cost_category} onClick={() => onSelect(group)}>
          <strong title={group.cost_category}>{group.cost_category}</strong>
          <span>{group.count.toLocaleString('ru-RU')}</span>
          <b>{money(group.amount)}</b>
          <ChevronRight size={17}/>
        </button>)}
    </div>
  </article>
}

function ExecutiveSkeleton() {
  return <article className="executive-period executive-skeleton panel"><div/><div/><div/><div/><div/></article>
}

function ExecutiveSpecialCard({ special, onSelect }) {
  return <section className="executive-special panel">
    <header>
      <div className="executive-special-icon"><Building2 size={23}/></div>
      <div>
        <span>Отдельный контур согласования · до {shortDate(special.to)}</span>
        <h2>{special.title}</h2>
        <p>Счета выделены из общей сводки, двойной учёт исключён</p>
      </div>
    </header>
    <button type="button" className="executive-special-summary" onClick={onSelect}>
      <div><span>Всего счетов</span><strong>{special.count.toLocaleString('ru-RU')}</strong></div>
      <div><span>Общая сумма</span><strong>{money(special.amount)}</strong></div>
      <div><span>Зарегистрировано</span><strong>{special.registered_count.toLocaleString('ru-RU')}</strong><small>{money(special.registered_amount)}</small></div>
      <div><span>К оплате</span><strong>{special.payable_count.toLocaleString('ru-RU')}</strong><small>{money(special.payable_amount)}</small></div>
      <ChevronRight size={20}/>
    </button>
  </section>
}

function ExecutiveSettingsModal({ settings, saving, onChange, onClose }) {
  return <div className="modal-backdrop executive-settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal executive-settings-modal" role="dialog" aria-modal="true" aria-label="Настройки панели руководителя">
      <header className="modal-head">
        <div><p className="eyebrow">Только для администратора</p><h2>Настройки панели руководителя</h2></div>
        <button type="button" onClick={onClose} title="Закрыть" aria-label="Закрыть"><X/></button>
      </header>
      <div className="executive-settings-body">
        <div>
          <Building2 size={22}/>
          <span><strong>Аренда — ИП Кибирев О. А.</strong><small>Показывать отдельным разделом и исключать эти счета из общей сводки.</small></span>
          <button
            type="button"
            className={`executive-setting-switch ${settings.kibirev_rent_enabled ? 'is-on' : ''}`}
            role="switch"
            aria-checked={settings.kibirev_rent_enabled}
            disabled={saving}
            onClick={() => onChange(!settings.kibirev_rent_enabled)}
          ><i/><b>{settings.kibirev_rent_enabled ? 'Включено' : 'Отключено'}</b></button>
        </div>
      </div>
    </section>
  </div>
}

function ExecutiveDetails({ details, loading, statuses, savingCells, editable, splitAllowed, onCommit, onSplit, onClose }) {
  const statusOptions = details.kind === 'special'
    ? ['К оплате']
    : (statuses.length ? statuses : executiveStatusOptions.map(option => option.value))
  return <div className="modal-backdrop executive-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal executive-detail-modal" role="dialog" aria-modal="true" aria-label={`Детализация: ${details.cost_category}`}>
      <header className="modal-head executive-detail-head">
        <div>
          <p className="eyebrow">{details.period.title}</p>
          <h2>{details.cost_category}</h2>
          <span>{details.count.toLocaleString('ru-RU')} обязательств · {money(details.amount)}</span>
        </div>
        <div className="executive-detail-actions">
          <button type="button" className="secondary executive-print-button" onClick={() => window.print()} disabled={loading || details.items.length === 0}><Printer size={17}/>Печать</button>
          <button type="button" onClick={onClose} title="Закрыть" aria-label="Закрыть"><X/></button>
        </div>
      </header>
      <div className="executive-detail-scroll">
        {loading ? <div className="executive-detail-loading"><div className="loading-line"/><span>Загружаем обязательства…</span></div>
          : details.items.length === 0 ? <div className="executive-empty"><Layers3 size={28}/><strong>Записи не найдены</strong></div>
            : details.kind === 'special' ? <ExecutiveSpecialDetailsTable details={details} statusOptions={statusOptions} savingCells={savingCells} editable={editable} splitAllowed={splitAllowed} onCommit={onCommit} onSplit={onSplit}/>
            : <table className="executive-detail-table executive-general-detail-table">
              <thead><tr>
                <th>Юридическое лицо</th><th>Признак учёта</th><th>Плановая дата</th><th>Контрагент</th><th>Назначение платежа</th>
                <th>Комментарий</th><th>Сумма</th><th>Ответственный</th><th>Статус</th><th>Дата утверждения</th>{splitAllowed && <th>Действия</th>}
              </tr></thead>
              <tbody>{details.items.map(item => <tr key={item.id}>
                <td>{item.legal_entity || '—'}</td>
                <td>{item.account_type || '—'}</td>
                <td>{shortDate(item.planned_payment_date)}</td>
                <td><strong>{item.counterparty || '—'}</strong></td>
                <td>{item.payment_purpose || '—'}</td>
                <td>{item.comment || '—'}</td>
                <td className="executive-detail-amount">{money(item.amount)}</td>
                <td>{item.responsible || '—'}</td>
                <ExecutiveStatusCell item={item} options={statusOptions} saving={savingCells.has(`${item.id}:status`)} editable={editable} onCommit={onCommit}/>
                <ExecutiveApprovalDateCell item={item} saving={savingCells.has(`${item.id}:approval_date`)} editable={editable} onCommit={onCommit}/>
                {splitAllowed && <ExecutiveSplitCell item={item} onSplit={onSplit}/>}
              </tr>)}</tbody>
              <tfoot><tr><td colSpan="6">Итого</td><td>{money(details.amount)}</td><td colSpan={splitAllowed ? 4 : 3}>{details.count.toLocaleString('ru-RU')} обязательств</td></tr></tfoot>
            </table>}
      </div>
      {!loading && details.items.length > 0 && (details.kind === 'special'
        ? <ExecutiveSpecialPrintReport details={details}/>
        : <ExecutivePrintReport details={details}/>)}
    </section>
  </div>
}

function ExecutiveSpecialDetailsTable({ details, statusOptions, savingCells, editable, splitAllowed, onCommit, onSplit }) {
  return <table className="executive-detail-table executive-special-detail-table">
    <thead><tr>
      <th>Юридическое лицо</th><th>Признак учёта</th><th>Плановая дата</th><th>Счёт</th><th>Назначение платежа</th><th>Комментарий</th>
      <th>Сумма</th><th>Оплачено</th><th>Остаток</th><th>Статус</th><th>Дата утверждения</th>{splitAllowed && <th>Действия</th>}
    </tr></thead>
    <tbody>{details.items.map(item => <tr key={item.id}>
      <td>{item.legal_entity || '—'}</td>
      <td>{item.account_type || '—'}</td>
      <td>{shortDate(item.planned_payment_date)}</td>
      <td><strong>{item.document_number || '—'}</strong><small>{shortDate(item.document_date)}</small></td>
      <td>{item.payment_purpose || '—'}</td>
      <td>{item.comment || '—'}</td>
      <td className="executive-detail-amount">{money(item.amount)}</td>
      <td className="executive-detail-paid">{money(item.paid_amount)}</td>
      <td className="executive-detail-outstanding">{money(item.outstanding_amount)}</td>
      <ExecutiveStatusCell item={item} options={statusOptions} saving={savingCells.has(`${item.id}:status`)} editable={editable} onCommit={onCommit}/>
      <ExecutiveApprovalDateCell item={item} saving={savingCells.has(`${item.id}:approval_date`)} editable={editable} onCommit={onCommit}/>
      {splitAllowed && <ExecutiveSplitCell item={item} onSplit={onSplit}/>}
    </tr>)}</tbody>
    <tfoot><tr>
      <td colSpan="6">Итого · {details.count.toLocaleString('ru-RU')} счетов</td>
      <td>{money(details.amount)}</td><td>{money(details.paid_amount)}</td><td>{money(details.outstanding_amount)}</td><td colSpan={splitAllowed ? 3 : 2}/>
    </tr></tfoot>
  </table>
}

function ExecutiveSplitCell({ item, onSplit }) {
  if (!canSplitPayment(item)) return <td className="executive-detail-action"><span title="Этот платёж уже разбит, оплачен или отменён">—</span></td>
  return <td className="executive-detail-action"><button type="button" className="secondary executive-split-button" onClick={() => onSplit(item)} title="Разбить платёж"><Scissors size={14}/>Разбить</button></td>
}

function ExecutiveStatusCell({ item, options, saving, editable, onCommit }) {
  const [editing, setEditing] = useState(false)
  const rootRef = useRef(null)
  useEffect(() => {
    if (!editing) return undefined
    const closeOutside = event => { if (!rootRef.current?.contains(event.target)) setEditing(false) }
    const closeEscape = event => { if (event.key === 'Escape') setEditing(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [editing])
  const choose = async value => {
    if (value === item.status) {
      setEditing(false)
      return
    }
    if (await onCommit(item, 'status', value)) setEditing(false)
  }
  if (!editable) return <td><span className={`executive-status ${item.status === 'К оплате' ? 'is-payable' : ''}`}>{item.status || 'Не указан'}</span></td>
  return <td ref={rootRef} className={`executive-editable-cell ${editing ? 'is-editing' : ''} ${saving ? 'is-saving' : ''}`}>
    <button type="button" className="executive-cell-trigger" onClick={() => !saving && setEditing(current => !current)} disabled={saving} aria-label={`Статус: ${item.status}. Изменить`}>
      <span className={`executive-status ${item.status === 'К оплате' ? 'is-payable' : ''}`}>{item.status || 'Не указан'}</span><ChevronDown size={14}/>
    </button>
    {editing && <div className="executive-inline-select" role="listbox" aria-label="Выбор статуса">
      {options.map(option => <button type="button" key={option} className={option === item.status ? 'selected' : ''} onClick={() => choose(option)} role="option" aria-selected={option === item.status}><span>{option}</span>{option === item.status && <Check size={14}/>}</button>)}
    </div>}
    {saving && <i className="cell-saving-dot"/>}
  </td>
}

function ExecutiveApprovalDateCell({ item, saving, editable, onCommit }) {
  const [editing, setEditing] = useState(false)
  if (!editable) return <td>{shortDate(item.approval_date)}</td>
  return <td className={`executive-editable-cell executive-date-cell ${editing ? 'is-editing' : ''} ${saving ? 'is-saving' : ''}`}>
    {editing
      ? <DateInput
          className="executive-date-input"
          value={item.approval_date || ''}
          onChange={value => { setEditing(false); onCommit(item, 'approval_date', value) }}
          onClose={() => setEditing(false)}
          closeOnScroll={false}
          aria-label="Дата утверждения"
          autoFocus
        />
      : <button type="button" className="executive-cell-trigger executive-date-trigger" onClick={() => !saving && setEditing(true)} disabled={saving} aria-label={`Дата утверждения: ${shortDate(item.approval_date)}. Изменить`}>{shortDate(item.approval_date)}</button>}
    {saving && <i className="cell-saving-dot"/>}
  </td>
}

function ExecutiveSpecialPrintReport({ details }) {
  const accountType = details.account_type === BLANK_ACCOUNT_TYPE_FILTER ? 'Не выбран (—)' : details.account_type || 'Все признаки учёта'
  return <article className="executive-print-report executive-special-print-report">
    <header className="executive-print-title">
      <div>
        <p>Панель руководителя · отдельный контур согласования</p>
        <h1>{details.cost_category}</h1>
        <span>До конца месяца, включая просроченные · отчёт на {shortDate(details.report_date)}</span>
      </div>
      <div className="executive-print-mark"><strong>ФИНРЕЕСТР</strong><span>Управленческий отчёт</span></div>
    </header>
    <section className="executive-print-filters">
      <div><span>Юридическое лицо</span><strong>{details.legal_entity || 'Все юридические лица'}</strong></div>
      <div><span>Признак учёта</span><strong>{accountType}</strong></div>
      <div><span>Статус</span><strong>{details.status || 'Все'}</strong></div>
      <div><span>Счетов</span><strong>{details.count.toLocaleString('ru-RU')}</strong></div>
      <div><span>Общая сумма</span><strong>{money(details.amount)}</strong></div>
      <div><span>Остаток</span><strong>{money(details.outstanding_amount)}</strong></div>
    </section>
    <table>
      <thead><tr>
        <th>№</th><th>Юридическое лицо</th><th>Плановая дата</th><th>Счёт / дата</th><th>Назначение платежа</th>
        <th>Комментарий</th><th>Сумма</th><th>Оплачено</th><th>Остаток</th><th>Статус / утверждение</th>
      </tr></thead>
      <tbody>{details.items.map((item, index) => <tr key={item.id}>
        <td>{index + 1}</td><td>{item.legal_entity || '—'}</td><td>{shortDate(item.planned_payment_date)}</td>
        <td>{item.document_number || '—'}<br/>{shortDate(item.document_date)}</td><td>{item.payment_purpose || '—'}</td>
        <td>{item.comment || '—'}</td><td>{money(item.amount)}</td><td>{money(item.paid_amount)}</td>
        <td>{money(item.outstanding_amount)}</td><td>{item.status || '—'}<br/>{shortDate(item.approval_date)}</td>
      </tr>)}</tbody>
      <tfoot><tr><td colSpan="6">Итого · {details.count.toLocaleString('ru-RU')} счетов</td><td>{money(details.amount)}</td><td>{money(details.paid_amount)}</td><td>{money(details.outstanding_amount)}</td><td/></tr></tfoot>
    </table>
    <footer><span>Сформировано: {new Date().toLocaleString('ru-RU')}</span><span>Подпись: ____________________</span></footer>
  </article>
}

function ExecutivePrintReport({ details }) {
  const accountType = details.account_type === BLANK_ACCOUNT_TYPE_FILTER ? 'Не выбран (—)' : details.account_type || 'Все признаки учёта'
  return <article className="executive-print-report">
    <header className="executive-print-title">
      <div>
        <p>Панель руководителя · детализация</p>
        <h1>{details.cost_category}</h1>
        <span>{details.period.title} · отчёт на {shortDate(details.report_date)}</span>
      </div>
      <div className="executive-print-mark"><strong>ФИНРЕЕСТР</strong><span>Управленческий отчёт</span></div>
    </header>
    <section className="executive-print-filters">
      <div><span>Период</span><strong>{details.period.from ? `${shortDate(details.period.from)} — ${shortDate(details.period.to)}` : `до ${shortDate(details.period.to)}`}</strong></div>
      <div><span>Юридическое лицо</span><strong>{details.legal_entity || 'Все юридические лица'}</strong></div>
      <div><span>Признак учёта</span><strong>{accountType}</strong></div>
      <div><span>Статус</span><strong>{details.status || 'Все'}</strong></div>
      <div><span>Обязательств</span><strong>{details.count.toLocaleString('ru-RU')}</strong></div>
      <div><span>Общая сумма</span><strong>{money(details.amount)}</strong></div>
    </section>
    <table>
      <thead><tr>
        <th>№</th><th>Юридическое лицо</th><th>Плановая дата</th><th>Контрагент</th><th>Назначение платежа</th>
        <th>Комментарий</th><th>Сумма</th><th>Ответственный</th><th>Статус</th><th>Дата утверждения</th>
      </tr></thead>
      <tbody>{details.items.map((item, index) => <tr key={item.id}>
        <td>{index + 1}</td>
        <td>{item.legal_entity || '—'}</td>
        <td>{shortDate(item.planned_payment_date)}</td>
        <td>{item.counterparty || '—'}</td>
        <td>{item.payment_purpose || '—'}</td>
        <td>{item.comment || '—'}</td>
        <td>{money(item.amount)}</td>
        <td>{item.responsible || '—'}</td>
        <td>{item.status || '—'}</td>
        <td>{shortDate(item.approval_date)}</td>
      </tr>)}</tbody>
      <tfoot><tr><td colSpan="6">Итого</td><td>{money(details.amount)}</td><td colSpan="3">{details.count.toLocaleString('ru-RU')} обязательств</td></tr></tfoot>
    </table>
    <footer><span>Сформировано: {new Date().toLocaleString('ru-RU')}</span><span>Подпись: ____________________</span></footer>
  </article>
}
