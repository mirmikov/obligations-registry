import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Combine, Plus, Save, Search, Trash2, X } from 'lucide-react'
import { request } from './api'
import { PageHeader } from './App'
import { can } from './permissions'
import { filterCounterparties, normalizeTaxIdInput } from './counterpartyTaxId'

const kinds = [
  ['statuses', 'Статусы', 'Этапы обработки обязательства'],
  ['cost_categories', 'Статьи затрат', 'Категории управленческого учёта'],
  ['priorities', 'Приоритеты', 'Уровни очередности'],
  ['urgencies', 'Срочность', 'Маркировка срочных платежей'],
  ['legal_entities', 'Юридические лица', 'Организации группы'],
  ['responsibles', 'Ответственные', 'Сотрудники, ведущие обязательства'],
  ['account_types', 'Признаки учёта', 'ОМС и коммерция'],
  ['counterparties', 'Контрагенты', 'Единый справочник поставщиков'],
]

export default function References({ user, notify }) {
  const editable = can(user, 'references.edit')
  const [data, setData] = useState({})
  const [active, setActive] = useState('statuses')
  const [value, setValue] = useState('')
  const [search, setSearch] = useState('')
  const [counterpartyModal, setCounterpartyModal] = useState(null)
  const [mergeModal, setMergeModal] = useState(null)
  const [selectedCounterparties, setSelectedCounterparties] = useState([])
  const [savingAssignment, setSavingAssignment] = useState(null)
  const [assignableUsers, setAssignableUsers] = useState([])
  const load = () => request('/api/references').then(setData).catch(error => notify(error.message, 'error'))

  useEffect(() => {
    load()
    if (editable) request('/api/references/assignable-users').then(setAssignableUsers).catch(error => notify(error.message, 'error'))
  }, [editable])

  const assignments = useMemo(() => Object.fromEntries(
    (data.cost_category_responsibles || []).map(item => [Number(item.cost_category_id), item.responsible]),
  ), [data.cost_category_responsibles])
  const userAssignments = useMemo(() => Object.fromEntries(
    (data.responsible_users || []).map(item => [Number(item.responsible_id), Number(item.user_id)]),
  ), [data.responsible_users])

  const add = async (nextValue, taxID = '') => {
    if (!nextValue.trim()) return
    try {
      await request(`/api/references/${active}`, { method: 'POST', body: JSON.stringify({ value: nextValue, tax_id: normalizeTaxIdInput(taxID) }) })
      setValue('')
      setCounterpartyModal(null)
      notify(active === 'counterparties' ? 'Контрагент добавлен' : 'Значение добавлено')
      await load()
    } catch (error) {
      notify(error.message, 'error')
      throw error
    }
  }

  const addInline = event => {
    event.preventDefault()
    add(value).catch(() => {})
  }

  const saveCounterpartyTaxID = async (id, taxID) => {
    const result = await request(`/api/references/counterparties/${id}/tax-id`, {
      method: 'PUT',
      body: JSON.stringify({ tax_id: normalizeTaxIdInput(taxID) }),
    })
    setData(current => ({
      ...current,
      counterparties: (current.counterparties || []).map(item => Number(item.id) === Number(id) ? { ...item, tax_id: result.tax_id || '' } : item),
    }))
    notify(result.tax_id ? 'ИНН сохранён' : 'ИНН удалён')
  }

  const toggleCounterparty = id => setSelectedCounterparties(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])

  const mergeCounterparties = async value => {
    const result = await request('/api/references/counterparties/merge', {
      method: 'POST',
      body: JSON.stringify({ ids: selectedCounterparties, value }),
    })
    setMergeModal(null)
    setSelectedCounterparties([])
    await load()
    notify(`Контрагенты объединены. Обновлено записей реестра: ${result.updated_obligations}`)
  }

  const remove = async id => {
    if (!confirm('Убрать значение из справочника? Существующие записи реестра сохранятся.')) return
    try {
      await request(`/api/references/${active}/${id}`, { method: 'DELETE' })
      notify('Значение убрано')
      load()
    } catch (error) {
      notify(error.message, 'error')
    }
  }

  const assignResponsible = async (categoryID, responsible) => {
    setSavingAssignment(`category:${categoryID}`)
    try {
      await request(`/api/references/cost-categories/${categoryID}/responsible`, {
        method: 'PUT',
        body: JSON.stringify({ responsible }),
      })
      setData(current => ({
        ...current,
        cost_category_responsibles: [
          ...(current.cost_category_responsibles || []).filter(item => Number(item.cost_category_id) !== Number(categoryID)),
          ...(responsible ? [{ cost_category_id: Number(categoryID), responsible }] : []),
        ],
      }))
      notify(responsible ? 'Ответственный привязан к статье затрат' : 'Привязка ответственного удалена')
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setSavingAssignment(null)
    }
  }

  const assignUser = async (responsibleID, userID) => {
    setSavingAssignment(`responsible:${responsibleID}`)
    try {
      await request(`/api/references/responsibles/${responsibleID}/user`, {
        method: 'PUT',
        body: JSON.stringify({ user_id: userID || null }),
      })
      setData(current => ({
        ...current,
        responsible_users: [
          ...(current.responsible_users || []).filter(item => Number(item.responsible_id) !== Number(responsibleID)),
          ...(userID ? [{ responsible_id: Number(responsibleID), user_id: Number(userID) }] : []),
        ],
      }))
      notify(userID ? 'Пользователь привязан к ответственному' : 'Привязка пользователя удалена')
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setSavingAssignment(null)
    }
  }

  const current = kinds.find(kind => kind[0] === active)
  const currentItems = active === 'counterparties' ? filterCounterparties(data[active] || [], search) : (data[active] || [])
  const selectedCounterpartyItems = (data.counterparties || []).filter(item => selectedCounterparties.includes(Number(item.id)))
  return <div className="page">
    <PageHeader eyebrow="Настройки" title="Справочники" subtitle="Единые значения для выпадающих списков реестра" />
    <div className="settings-layout">
      <aside className="settings-nav">
        {kinds.map(([key, label, description]) => <button key={key} className={active === key ? 'active' : ''} onClick={() => { setActive(key); setSearch(''); setValue(''); setSelectedCounterparties([]) }}>
          <strong>{label}</strong><span>{description}</span><i>{(data[key] || []).length}</i>
        </button>)}
      </aside>
      <section className="panel reference-panel">
        <div className="reference-head">
          <div><h2>{current[1]}</h2><span>{current[2]}</span></div>
          {editable && (active === 'counterparties' ? <div className="reference-head-actions"><button type="button" className="secondary reference-merge-button" disabled={selectedCounterparties.length < 2} onClick={() => setMergeModal({ value: selectedCounterpartyItems[0]?.value || '' })}><Combine size={17} />Объединить{selectedCounterparties.length > 0 ? ` (${selectedCounterparties.length})` : ''}</button><button type="button" className="primary reference-add-counterparty" onClick={() => setCounterpartyModal({ value: '', taxID: '' })}><Plus size={17} />Добавить контрагента</button></div> : <form onSubmit={addInline}>
            <input placeholder="Новое значение" value={value} onChange={event => setValue(event.target.value)} />
            <button className="primary"><Plus size={17} />Добавить</button>
          </form>)}
        </div>
        {active === 'counterparties' && <div className="reference-search">
          <Search size={17}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск по названию или ИНН" aria-label="Поиск контрагентов по названию или ИНН"/>
          {search && <button type="button" onClick={() => setSearch('')} aria-label="Очистить поиск"><X size={15}/></button>}
          <span>Найдено: {currentItems.length}</span>
        </div>}
        {active === 'cost_categories' && <div className="reference-assignment-hint">
          Для каждой статьи можно назначить ответственного по умолчанию. В реестре его по-прежнему можно изменить вручную.
        </div>}
        {active === 'responsibles' && editable && <div className="reference-assignment-hint">
          Привяжите значение ответственного к учётной записи сотрудника. После этого все строки реестра с этим ответственным появятся у сотрудника во вкладке «Мои счета».
        </div>}
        <div className="reference-list">
          {currentItems.map((item, index) => <div key={item.id} className={`${active === 'cost_categories' ? 'has-assignment' : ''} ${active === 'responsibles' && editable ? 'has-user-assignment' : ''} ${active === 'counterparties' ? 'counterparty-reference-row' : ''}`}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            {active === 'counterparties' && editable && <button type="button" className={`reference-merge-checkbox ${selectedCounterparties.includes(Number(item.id)) ? 'selected' : ''}`} onClick={() => toggleCounterparty(Number(item.id))} aria-label={`Выбрать контрагента ${item.value} для объединения`} aria-pressed={selectedCounterparties.includes(Number(item.id))}>{selectedCounterparties.includes(Number(item.id)) && <Check size={15}/>}</button>}
            <strong>{item.value}</strong>
            {active === 'counterparties' && <CounterpartyTaxIDEditor item={item} editable={editable} onSave={saveCounterpartyTaxID} notify={notify}/>}
            {active === 'cost_categories' && <ResponsiblePicker
              value={assignments[Number(item.id)] || ''}
              options={data.responsibles || []}
              disabled={!editable || savingAssignment === `category:${item.id}`}
              saving={savingAssignment === `category:${item.id}`}
              onChange={responsible => assignResponsible(item.id, responsible)}
            />}
            {active === 'responsibles' && editable && <UserPicker
              value={userAssignments[Number(item.id)] || 0}
              options={assignableUsers}
              disabled={savingAssignment === `responsible:${item.id}`}
              saving={savingAssignment === `responsible:${item.id}`}
              onChange={userID => assignUser(item.id, userID)}
            />}
            {editable && <button className="reference-delete" onClick={() => remove(item.id)} title="Удалить значение"><Trash2 size={16} /></button>}
          </div>)}
          {active === 'counterparties' && currentItems.length === 0 && <div className="reference-empty">Контрагенты не найдены</div>}
        </div>
      </section>
    </div>
    {counterpartyModal && <CounterpartyModal value={counterpartyModal.value} taxID={counterpartyModal.taxID} onClose={() => setCounterpartyModal(null)} onSave={(nextValue, taxID) => add(nextValue, taxID)}/>}
    {mergeModal && <CounterpartyMergeModal items={selectedCounterpartyItems} value={mergeModal.value} onClose={() => setMergeModal(null)} onSave={mergeCounterparties}/>}
  </div>
}

function CounterpartyMergeModal({ items, value: initialValue, onClose, onSave }) {
  const [value, setValue] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const submit = async event => {
    event.preventDefault()
    if (!value.trim() || items.length < 2 || saving) return
    setSaving(true)
    try { await onSave(value.trim()) } catch { setSaving(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <form className="modal counterparty-merge-modal" onSubmit={submit}>
      <div className="modal-head"><div><h2>Объединение контрагентов</h2><p>Все связанные счета останутся в реестре. Изменится только название контрагента, а дубли справочника будут перенесены в архив.</p></div><button type="button" onClick={onClose} disabled={saving} aria-label="Закрыть"><X size={17}/></button></div>
      <div className="modal-body counterparty-merge-body">
        <section><span>Выбрано для объединения</span><div>{items.map(item => <button type="button" key={item.id} className={item.value === value ? 'selected' : ''} onClick={() => setValue(item.value)}><strong>{item.value}</strong><small>{item.tax_id ? `ИНН ${item.tax_id}` : 'ИНН не указан'}</small>{item.value === value && <Check size={15}/>}</button>)}</div></section>
        <label className="field"><span>Итоговое название контрагента *</span><input autoFocus value={value} onChange={event => setValue(event.target.value)} placeholder="Введите единое название" required/><small>Можно выбрать одно из существующих названий выше или ввести корректное название вручную.</small></label>
        <div className="counterparty-merge-warning"><Combine size={19}/><div><strong>Что произойдёт</strong><span>Во всех строках реестра с выбранными контрагентами будет установлено название «{value.trim() || '…'}». Суммы, даты, статусы, документы и остальные поля не изменятся.</span></div></div>
      </div>
      <div className="modal-footer"><button type="button" className="secondary" onClick={onClose} disabled={saving}>Отмена</button><button type="submit" className="primary" disabled={!value.trim() || items.length < 2 || saving}>{saving ? 'Объединение…' : `Объединить ${items.length} контрагентов`}</button></div>
    </form>
  </div>
}

function CounterpartyTaxIDEditor({ item, editable, onSave, notify }) {
  const [value, setValue] = useState(item.tax_id || '')
  const [saving, setSaving] = useState(false)
  useEffect(() => setValue(item.tax_id || ''), [item.tax_id])
  const changed = normalizeTaxIdInput(value) !== (item.tax_id || '')
  const save = async () => {
    setSaving(true)
    try { await onSave(item.id, value) } catch (error) { notify(error.message, 'error') } finally { setSaving(false) }
  }
  return <div className="reference-tax-id-editor">
    <label><span>ИНН</span><input value={value} onChange={event => setValue(event.target.value)} inputMode="numeric" maxLength={15} placeholder="Не указан" disabled={!editable || saving} aria-label={`ИНН контрагента ${item.value}`} onKeyDown={event => { if (event.key === 'Enter' && changed) { event.preventDefault(); save() } }}/></label>
    {editable && <button type="button" className="reference-tax-id-save" disabled={!changed || saving} onClick={save} title="Сохранить ИНН" aria-label={`Сохранить ИНН контрагента ${item.value}`}><Save size={15}/></button>}
  </div>
}

function CounterpartyModal({ value: initialValue, taxID: initialTaxID, onClose, onSave }) {
  const [value, setValue] = useState(initialValue)
  const [taxID, setTaxID] = useState(initialTaxID)
  const [saving, setSaving] = useState(false)
  const submit = async event => {
    event.preventDefault()
    if (!value.trim() || saving) return
    setSaving(true)
    try { await onSave(value.trim(), taxID) } catch { setSaving(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <form className="modal small-modal counterparty-modal" onSubmit={submit}>
      <div className="modal-head"><div><h2>Новый контрагент</h2><p>ИНН можно указать сейчас или добавить позднее в справочнике.</p></div><button type="button" onClick={onClose} disabled={saving} aria-label="Закрыть"><X size={17}/></button></div>
      <div className="modal-body stacked-fields">
        <label className="field"><span>Наименование контрагента *</span><input autoFocus value={value} onChange={event => setValue(event.target.value)} placeholder="Например, ООО «Поставщик»" required/></label>
        <label className="field"><span>ИНН (необязательно)</span><input value={taxID} onChange={event => setTaxID(event.target.value)} inputMode="numeric" maxLength={15} placeholder="10 или 12 цифр"/><small>ИНН используется для поиска и защиты от дублирования контрагентов.</small></label>
      </div>
      <div className="modal-footer"><button type="button" className="secondary" onClick={onClose} disabled={saving}>Отмена</button><button type="submit" className="primary" disabled={!value.trim() || saving}>{saving ? 'Сохранение…' : taxID.trim() ? 'Добавить с ИНН' : 'Добавить без ИНН'}</button></div>
    </form>
  </div>
}

function ResponsiblePicker({ value, options, disabled, saving, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const close = event => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const choose = next => {
    setOpen(false)
    if (next !== value) onChange(next)
  }

  return <div className={`reference-responsible-picker ${open ? 'is-open' : ''}`} ref={rootRef}>
    <button type="button" disabled={disabled} onClick={() => setOpen(current => !current)} aria-haspopup="listbox" aria-expanded={open}>
      <span>{saving ? 'Сохранение…' : value || 'Назначить ответственного'}</span><ChevronDown size={15} />
    </button>
    {open && <div className="reference-responsible-menu" role="listbox">
      <button type="button" className={!value ? 'selected' : ''} onClick={() => choose('')} role="option" aria-selected={!value}>
        <span>Без ответственного</span>{!value && <Check size={14} />}
      </button>
      {options.map(option => <button type="button" key={option.id} className={option.value === value ? 'selected' : ''} onClick={() => choose(option.value)} role="option" aria-selected={option.value === value}>
        <span>{option.value}</span>{option.value === value && <Check size={14} />}
      </button>)}
    </div>}
  </div>
}

function UserPicker({ value, options, disabled, saving, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const selected = options.find(option => Number(option.id) === Number(value))

  useEffect(() => {
    if (!open) return undefined
    const close = event => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    const escape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open])

  const choose = next => {
    setOpen(false)
    if (Number(next) !== Number(value)) onChange(Number(next) || 0)
  }

  return <div className={`reference-user-picker ${open ? 'is-open' : ''}`} ref={rootRef}>
    <button type="button" disabled={disabled} onClick={() => setOpen(current => !current)} aria-haspopup="listbox" aria-expanded={open} aria-label={`Пользователь: ${selected?.name || 'не привязан'}`}>
      <span><strong>{saving ? 'Сохранение…' : selected?.name || 'Привязать пользователя'}</strong>{selected?.email && <small>{selected.email}</small>}</span><ChevronDown size={15}/>
    </button>
    {open && <div className="reference-user-menu" role="listbox" aria-label="Выбор пользователя для ответственного">
      <button type="button" className={!value ? 'selected' : ''} onClick={() => choose(0)} role="option" aria-selected={!value}><span><strong>Не привязан</strong><small>Сотрудник не увидит эти счета</small></span>{!value && <Check size={14}/>}</button>
      {options.map(option => <button type="button" key={option.id} className={Number(option.id) === Number(value) ? 'selected' : ''} onClick={() => choose(option.id)} role="option" aria-selected={Number(option.id) === Number(value)}><span><strong>{option.name}</strong><small>{option.email}</small></span>{Number(option.id) === Number(value) && <Check size={14}/>}</button>)}
    </div>}
  </div>
}
