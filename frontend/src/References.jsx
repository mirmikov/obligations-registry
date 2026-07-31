import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react'
import { request } from './api'
import { PageHeader } from './App'
import { can } from './permissions'

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
  const [savingAssignment, setSavingAssignment] = useState(null)
  const load = () => request('/api/references').then(setData).catch(error => notify(error.message, 'error'))

  useEffect(() => { load() }, [])

  const assignments = useMemo(() => Object.fromEntries(
    (data.cost_category_responsibles || []).map(item => [Number(item.cost_category_id), item.responsible]),
  ), [data.cost_category_responsibles])

  const add = async event => {
    event.preventDefault()
    if (!value.trim()) return
    try {
      await request(`/api/references/${active}`, { method: 'POST', body: JSON.stringify({ value }) })
      setValue('')
      notify('Значение добавлено')
      load()
    } catch (error) {
      notify(error.message, 'error')
    }
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
    setSavingAssignment(categoryID)
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

  const current = kinds.find(kind => kind[0] === active)
  return <div className="page">
    <PageHeader eyebrow="Настройки" title="Справочники" subtitle="Единые значения для выпадающих списков реестра" />
    <div className="settings-layout">
      <aside className="settings-nav">
        {kinds.map(([key, label, description]) => <button key={key} className={active === key ? 'active' : ''} onClick={() => setActive(key)}>
          <strong>{label}</strong><span>{description}</span><i>{(data[key] || []).length}</i>
        </button>)}
      </aside>
      <section className="panel reference-panel">
        <div className="reference-head">
          <div><h2>{current[1]}</h2><span>{current[2]}</span></div>
          {editable && <form onSubmit={add}>
            <input placeholder="Новое значение" value={value} onChange={event => setValue(event.target.value)} />
            <button className="primary"><Plus size={17} />Добавить</button>
          </form>}
        </div>
        {active === 'cost_categories' && <div className="reference-assignment-hint">
          Для каждой статьи можно назначить ответственного по умолчанию. В реестре его по-прежнему можно изменить вручную.
        </div>}
        <div className="reference-list">
          {(data[active] || []).map((item, index) => <div key={item.id} className={active === 'cost_categories' ? 'has-assignment' : ''}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{item.value}</strong>
            {active === 'cost_categories' && <ResponsiblePicker
              value={assignments[Number(item.id)] || ''}
              options={data.responsibles || []}
              disabled={!editable || savingAssignment === item.id}
              saving={savingAssignment === item.id}
              onChange={responsible => assignResponsible(item.id, responsible)}
            />}
            {editable && <button className="reference-delete" onClick={() => remove(item.id)} title="Удалить значение"><Trash2 size={16} /></button>}
          </div>)}
        </div>
      </section>
    </div>
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
