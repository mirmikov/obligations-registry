import { useEffect, useMemo, useRef, useState } from 'react'
import { Building2, Check, ChevronDown, CircleAlert, Combine, ExternalLink, Info, LoaderCircle, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import { request } from './api'
import { PageHeader } from './App'
import { can } from './permissions'
import { filterCounterparties, normalizeTaxIdInput } from './counterpartyTaxId'
import { fnsEntityLabel, formatFNSDate, safeFNSSourceURL, validateFNSTaxID } from './fnsCounterparty'

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
  const [counterpartyDetails, setCounterpartyDetails] = useState(null)
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
  const defermentAssignments = useMemo(() => Object.fromEntries(
    (data.counterparty_deferments || []).map(item => [Number(item.counterparty_id), Number(item.deferment_days)]),
  ), [data.counterparty_deferments])

  const add = async (nextValue, taxID = '') => {
    if (!nextValue.trim()) return
    try {
      await request(`/api/references/${active}`, { method: 'POST', body: JSON.stringify({ value: nextValue, tax_id: normalizeTaxIdInput(taxID), ...(active === 'counterparties' ? { new_only: true } : {}) }) })
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

  const saveCounterpartyDeferment = async (id, defermentDays) => {
    const result = await request(`/api/references/counterparties/${id}/deferment`, {
      method: 'PUT',
      body: JSON.stringify({ deferment_days: defermentDays }),
    })
    setData(current => ({
      ...current,
      counterparty_deferments: [
        ...(current.counterparty_deferments || []).filter(item => Number(item.counterparty_id) !== Number(id)),
        ...(result.deferment_days == null ? [] : [{ counterparty_id: Number(id), deferment_days: Number(result.deferment_days) }]),
      ],
    }))
    notify(result.deferment_days == null ? 'Отсрочка по умолчанию удалена' : `Отсрочка ${result.deferment_days} дн. сохранена`)
  }

  const openCounterpartyDetails = item => {
    const id = Number(item.id)
    if (!item.tax_id) {
      setCounterpartyDetails({ item, loading: false, data: null, error: 'Для этого контрагента ИНН не указан. Карточка ФНС недоступна.' })
      return
    }
    setCounterpartyDetails({ item, loading: true, data: null, error: '' })
    request(`/api/references/counterparties/${id}/fns`)
      .then(result => setCounterpartyDetails(current => Number(current?.item?.id) === id ? { item, loading: false, data: result, error: '' } : current))
      .catch(error => setCounterpartyDetails(current => Number(current?.item?.id) === id ? { item, loading: false, data: null, error: error.message } : current))
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
        {active === 'counterparties' && <div className="reference-assignment-hint">
          Укажите отсрочку один раз — при выборе контрагента в реестре она заполнится автоматически. В конкретном платеже значение можно изменить вручную.
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
            {active === 'counterparties' ? <button type="button" className="reference-counterparty-name" onClick={() => openCounterpartyDetails(item)} title="Открыть актуальную карточку ФНС"><span><strong>{item.value}</strong><small>Сведения ФНС</small></span><Info size={16}/></button> : <strong>{item.value}</strong>}
            {active === 'counterparties' && <CounterpartyTaxIDEditor item={item} editable={editable} onSave={saveCounterpartyTaxID} notify={notify}/>}
            {active === 'counterparties' && <CounterpartyDefermentEditor item={item} value={defermentAssignments[Number(item.id)]} editable={editable} onSave={saveCounterpartyDeferment} notify={notify}/>}
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
    {counterpartyDetails && <CounterpartyDetailsModal state={counterpartyDetails} onClose={() => setCounterpartyDetails(null)} onRetry={() => openCounterpartyDetails(counterpartyDetails.item)}/>}
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

function CounterpartyDefermentEditor({ item, value: initialValue, editable, onSave, notify }) {
  const [value, setValue] = useState(initialValue ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => setValue(initialValue ?? ''), [initialValue])
  const parsed = value === '' ? null : Number(value)
  const valid = parsed == null || (Number.isInteger(parsed) && parsed >= 0 && parsed <= 36500)
  const changed = valid && parsed !== (initialValue ?? null)
  const save = async () => {
    if (!changed) return
    setSaving(true)
    try { await onSave(item.id, parsed) } catch (error) { notify(error.message, 'error') } finally { setSaving(false) }
  }
  return <div className={`reference-deferment-editor ${!valid ? 'has-error' : ''}`}>
    <label><span>Отсрочка, дней</span><input type="number" min="0" max="36500" step="1" value={value} onChange={event => setValue(event.target.value)} placeholder="Не указана" disabled={!editable || saving} aria-label={`Отсрочка контрагента ${item.value}`} onKeyDown={event => { if (event.key === 'Enter' && changed) { event.preventDefault(); save() } }}/></label>
    {editable && <button type="button" className="reference-deferment-save" disabled={!changed || saving} onClick={save} title="Сохранить отсрочку" aria-label={`Сохранить отсрочку контрагента ${item.value}`}><Save size={15}/></button>}
  </div>
}

export function CounterpartyModal({ value: initialValue = '', taxID: initialTaxID = '', initialMode, lookupPath = '/api/references/counterparties/fns/lookup', onClose, onSave }) {
  const [value, setValue] = useState(initialValue)
  const [taxID, setTaxID] = useState(initialTaxID)
  const [mode, setMode] = useState(initialMode || (initialTaxID ? 'fns' : initialValue ? 'manual' : 'fns'))
  const [fnsData, setFNSData] = useState(null)
  const [lookupError, setLookupError] = useState('')
  const [lookingUp, setLookingUp] = useState(false)
  const [saving, setSaving] = useState(false)
  const lookupSequence = useRef(0)
  const lastLookupTaxID = useRef('')
  const validation = useMemo(() => validateFNSTaxID(taxID), [taxID])

  const lookup = async (normalizedTaxID, force = false) => {
    if (!normalizedTaxID || (!force && lastLookupTaxID.current === normalizedTaxID)) return
    lastLookupTaxID.current = normalizedTaxID
    const sequence = ++lookupSequence.current
    setLookingUp(true)
    setLookupError('')
    setFNSData(null)
    try {
      const result = await request(lookupPath, {
        method: 'POST', body: JSON.stringify({ tax_id: normalizedTaxID }),
      })
      if (sequence !== lookupSequence.current) return
      setFNSData(result)
      setValue(result.suggested_name || result.short_name || result.full_name || '')
    } catch (error) {
      if (sequence !== lookupSequence.current) return
      setLookupError(error.message)
      setValue('')
    } finally {
      if (sequence === lookupSequence.current) setLookingUp(false)
    }
  }

  useEffect(() => {
    if (mode !== 'fns' || !validation.complete || !validation.valid) return undefined
    const timer = setTimeout(() => lookup(validation.taxID), 700)
    return () => clearTimeout(timer)
  }, [mode, validation.complete, validation.valid, validation.taxID])

  const changeTaxID = event => {
    lookupSequence.current += 1
    lastLookupTaxID.current = ''
    setTaxID(event.target.value.replace(/[^\d\s-]/g, ''))
    setFNSData(null)
    setLookupError('')
    if (mode === 'fns') setValue('')
    setLookingUp(false)
  }

  const switchMode = nextMode => {
    lookupSequence.current += 1
    lastLookupTaxID.current = ''
    setMode(nextMode)
    setFNSData(null)
    setLookupError('')
    setLookingUp(false)
    setValue('')
  }

  const submit = async event => {
    event.preventDefault()
    if (!value.trim() || saving) return
    setSaving(true)
    try { await onSave(value.trim(), taxID) } catch { setSaving(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <form className="modal counterparty-modal fns-counterparty-modal" onSubmit={submit}>
      <div className="modal-head"><div><h2>Новый контрагент</h2><p>Для новых контрагентов название и реквизиты загружаются напрямую из ФНС. Уже заведённые записи не изменяются.</p></div><button type="button" onClick={onClose} disabled={saving} aria-label="Закрыть"><X size={17}/></button></div>
      <div className="counterparty-create-tabs" role="tablist" aria-label="Способ добавления контрагента">
        <button type="button" role="tab" aria-selected={mode === 'fns'} className={mode === 'fns' ? 'active' : ''} onClick={() => switchMode('fns')}><ShieldCheck size={16}/>По ИНН из ФНС</button>
        <button type="button" role="tab" aria-selected={mode === 'manual'} className={mode === 'manual' ? 'active' : ''} onClick={() => switchMode('manual')}><Plus size={16}/>Добавить вручную</button>
      </div>
      <div className="modal-body stacked-fields counterparty-create-body">
        {mode === 'fns' ? <>
          <label className={`field fns-tax-id-field ${validation.error ? 'has-error' : ''}`}><span>ИНН организации или ИП *</span><div><input autoFocus value={taxID} onChange={changeTaxID} inputMode="numeric" maxLength={15} placeholder="10 цифр для организации, 12 — для ИП"/><button type="button" className="secondary" disabled={!validation.valid || lookingUp} onClick={() => lookup(validation.taxID, true)}>{lookingUp ? <LoaderCircle className="spin" size={16}/> : <Search size={16}/>}Найти</button></div><small>{validation.error || (!validation.complete ? 'После ввода корректного ИНН поиск начнётся автоматически.' : fnsEntityLabel(validation.entityType))}</small></label>
          {lookingUp && <div className="fns-lookup-state"><LoaderCircle className="spin" size={20}/><div><strong>Запрашиваем сведения в ФНС</strong><span>Данные не загружаются из локальной копии и могут прийти с небольшой задержкой.</span></div></div>}
          {lookupError && <div className="fns-message error"><CircleAlert size={19}/><div><strong>Не удалось получить сведения</strong><span>{lookupError}</span><button type="button" onClick={() => validation.valid && lookup(validation.taxID, true)}>Повторить запрос</button></div></div>}
          {fnsData && <FNSCounterpartyCard data={fnsData} compact/>}
          {fnsData && !fnsData.existing_reference && <label className="field"><span>Название в справочнике *</span><input value={value} onChange={event => setValue(event.target.value)} placeholder="Название получено из ФНС" required/><small>Поле заполнено по официальным данным ФНС; при необходимости бухгалтер может уточнить отображаемое название.</small></label>}
        </> : <>
          <div className="fns-message neutral"><Info size={19}/><div><strong>Ручное добавление</strong><span>Используйте для иностранной организации или контрагента, которого нет в ЕГРЮЛ/ЕГРИП. Проверка дубля по ИНН всё равно сохранится.</span></div></div>
          <label className="field"><span>Наименование контрагента *</span><input autoFocus value={value} onChange={event => setValue(event.target.value)} placeholder="Например, ООО «Поставщик»" required/></label>
          <label className="field"><span>ИНН (необязательно)</span><input value={taxID} onChange={changeTaxID} inputMode="numeric" maxLength={15} placeholder="10 или 12 цифр"/><small>Можно пропустить для контрагента без российского ИНН.</small></label>
        </>}
      </div>
      <div className="modal-footer"><button type="button" className="secondary" onClick={onClose} disabled={saving}>Отмена</button><button type="submit" className="primary" disabled={!value.trim() || saving || (mode === 'fns' && (!fnsData || Boolean(fnsData.existing_reference)))}>{saving ? 'Сохранение…' : mode === 'fns' ? 'Добавить контрагента' : taxID.trim() ? 'Добавить вручную с ИНН' : 'Добавить без ИНН'}</button></div>
    </form>
  </div>
}

function CounterpartyDetailsModal({ state, onClose, onRetry }) {
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal counterparty-details-modal" role="dialog" aria-modal="true" aria-labelledby="counterparty-details-title">
      <div className="modal-head"><div><h2 id="counterparty-details-title">Карточка контрагента</h2><p>{state.item.value}. Только просмотр: сведения ФНС не перезаписывают существующего контрагента.</p></div><button type="button" onClick={onClose} aria-label="Закрыть"><X size={17}/></button></div>
      <div className="modal-body counterparty-details-body">
        {state.loading && <div className="fns-lookup-state"><LoaderCircle className="spin" size={21}/><div><strong>Получаем актуальные сведения ФНС</strong><span>Запрашиваем карточку по ИНН {state.item.tax_id}.</span></div></div>}
        {state.error && <div className="fns-message error"><CircleAlert size={20}/><div><strong>Карточка недоступна</strong><span>{state.error}</span>{state.item.tax_id && <button type="button" onClick={onRetry}><RefreshCw size={14}/>Повторить</button>}</div></div>}
        {state.data && <FNSCounterpartyCard data={state.data}/>}
      </div>
      <div className="modal-footer"><span className="fns-readonly-note"><ShieldCheck size={15}/>Данные в справочнике не изменяются</span><button type="button" className="primary" onClick={onClose}>Закрыть</button></div>
    </section>
  </div>
}

function FNSCounterpartyCard({ data, compact = false }) {
  const sourceURL = safeFNSSourceURL(data.source_url)
  const statusClass = data.active && !data.invalid ? 'active' : 'inactive'
  const rows = [
    ['ИНН', data.tax_id],
    ['КПП', data.kpp],
    [data.entity_type === 'individual_entrepreneur' ? 'ОГРНИП' : 'ОГРН', data.ogrn],
    ['Дата регистрации', formatFNSDate(data.registration_date)],
    ['Регион', data.region],
    ['Адрес', data.address],
    ['Основной ОКВЭД', [data.okved_code, data.okved_name].filter(Boolean).join(' — ')],
    ['Руководитель', data.director ? [data.director.name, data.director.position].filter(Boolean).join(', ') : ''],
    ['Сведения актуальны на', formatFNSDate(data.registry_updated_at)],
  ].filter(([, value]) => value)
  return <article className={`fns-counterparty-card ${compact ? 'compact' : ''}`}>
    <header><div className="fns-source-icon"><Building2 size={21}/></div><div><span>{fnsEntityLabel(data.entity_type)}</span><h3>{data.short_name || data.suggested_name || data.full_name}</h3>{data.full_name && data.full_name !== data.short_name && <p>{data.full_name}</p>}</div><i className={statusClass}>{data.status || (data.active ? 'Действующий' : 'Недействующий')}</i></header>
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {data.existing_reference && <div className="fns-existing-reference"><CircleAlert size={18}/><div><strong>Контрагент уже есть в справочнике</strong><span>{data.existing_reference.value} · ИНН {data.existing_reference.tax_id}. Новая запись не будет создана.</span></div></div>}
    {(data.warnings || []).map(warning => <div className="fns-card-warning" key={warning}><CircleAlert size={16}/><span>{warning}</span></div>)}
    <footer><span><ShieldCheck size={15}/>{data.source || 'ФНС России — Прозрачный бизнес'}</span>{sourceURL && <a href={sourceURL} target="_blank" rel="noreferrer">Открыть в ФНС <ExternalLink size={14}/></a>}</footer>
  </article>
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
