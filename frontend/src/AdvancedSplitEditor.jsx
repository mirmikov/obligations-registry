import { BadgePercent, CalendarClock, CircleDollarSign, Plus, Scale, Trash2 } from 'lucide-react'
import { DateInput, money } from './App'
import { advancedSplitModes, createWeightParts, weightTemplates } from './advancedPaymentSplit'

const modeIcons = { advance: BadgePercent, calendar: CalendarClock, recurring: CircleDollarSign, weights: Scale }
const scheduleUnits = [
  ['day', 'день'],
  ['business_day', 'рабочий день (без сб/вс)'],
  ['week', 'неделя'],
  ['month', 'месяц'],
  ['quarter', 'квартал'],
]

export function AdvancedSplitModePicker({ value, onChange }) {
  return <section className="split-smart-modes" aria-label="Новые способы разбиения">
    <header><div><strong>Новые сценарии</strong><span>Автоматический расчёт с предварительной проверкой суммы и дат</span></div><b>NEW</b></header>
    <div>{advancedSplitModes.map(mode => {
      const Icon = modeIcons[mode.id]
      return <button type="button" key={mode.id} className={value === mode.id ? 'active' : ''} onClick={() => onChange(mode.id)} aria-pressed={value === mode.id}>
        <i><Icon size={18}/></i><span><strong>{mode.title}</strong><small>{mode.description}</small></span>
      </button>
    })}</div>
  </section>
}

export default function AdvancedSplitEditor({ form, setForm, preview, accountTypes, fixedAmountAccountTypes, defaultDate }) {
  const update = (key, value) => setForm(current => ({ ...current, [key]: value }))
  if (form.mode === 'advance') return <AdvanceEditor form={form} update={update} preview={preview} accountTypes={accountTypes}/>
  if (form.mode === 'calendar') return <CalendarEditor form={form} update={update}/>
  if (form.mode === 'recurring') return <RecurringEditor form={form} update={update} preview={preview} accountTypes={fixedAmountAccountTypes}/>
  if (form.mode === 'weights') return <WeightsEditor form={form} setForm={setForm} preview={preview} accountTypes={accountTypes} defaultDate={defaultDate}/>
  return null
}

function AdvanceEditor({ form, update, preview, accountTypes }) {
  return <section className="split-smart-editor">
    <EditorHead title="Аванс и окончательный расчёт" text="Укажите долю аванса. Остаток и обе суммы рассчитаются автоматически до копейки." badge={preview.items.length ? `${preview.items[0].percent}% / ${preview.items[1].percent}%` : '2 платежа'}/>
    <div className="split-smart-fields advance-fields">
      <label className="field"><span>Аванс, %</span><input type="number" min="0.01" max="99.99" step="0.01" value={form.advance_percent} onChange={event => update('advance_percent', event.target.value)}/></label>
      <AccountTypeField label="Признак аванса" value={form.advance_account_type} options={accountTypes} onChange={value => update('advance_account_type', value)}/>
      <label className="field"><span>Дата аванса</span><DateInput value={form.advance_date} onChange={value => update('advance_date', value)}/></label>
      <AccountTypeField label="Признак остатка" value={form.balance_account_type} options={accountTypes} onChange={value => update('balance_account_type', value)}/>
      <label className="field"><span>Дата остатка</span><DateInput value={form.balance_date} onChange={value => update('balance_date', value)}/></label>
    </div>
  </section>
}

function CalendarEditor({ form, update }) {
  return <section className="split-smart-editor">
    <EditorHead title="Автоматический календарный график" text="Равные части будут расставлены от первой даты с выбранным интервалом. Для месяцев сохраняется исходный день, а конец месяца корректируется безопасно." badge="2–60 платежей"/>
    <div className="split-smart-fields calendar-fields">
      <label className="field"><span>Количество платежей</span><input type="number" min="2" max="60" value={form.calendar_count} onChange={event => update('calendar_count', event.target.value)}/></label>
      <label className="field"><span>Первый платёж</span><DateInput value={form.calendar_start_date} onChange={value => update('calendar_start_date', value)}/></label>
      <label className="field"><span>Интервал</span><input type="number" min="1" max="365" value={form.calendar_interval} onChange={event => update('calendar_interval', event.target.value)}/></label>
      <label className="field"><span>Единица периода</span><select value={form.calendar_unit} onChange={event => update('calendar_unit', event.target.value)}>{scheduleUnits.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    <p className="split-smart-note">Признак учёта наследуется из исходного обязательства. Режим «рабочий день» исключает субботу и воскресенье, но не производственный календарь праздников.</p>
  </section>
}

function RecurringEditor({ form, update, preview, accountTypes }) {
  return <section className="split-smart-editor">
    <EditorHead title="Регулярная сумма и точный остаток" text="Все платежи, кроме последнего, будут одинаковыми. Последняя строка автоматически закроет остаток без расхождения в копейках." badge={preview.items.length ? `${preview.items.length} платежей` : 'Авторасчёт'}/>
    <div className="split-smart-fields recurring-fields">
      <label className="field"><span>Регулярная сумма, ₽</span><input type="number" min="0.01" step="0.01" value={form.recurring_amount} onChange={event => update('recurring_amount', event.target.value)}/></label>
      <AccountTypeField label="Признак учёта" value={form.recurring_account_type} options={accountTypes.map(value => ({ value }))} onChange={value => update('recurring_account_type', value)}/>
      <label className="field"><span>Первый платёж</span><DateInput value={form.recurring_start_date} onChange={value => update('recurring_start_date', value)}/></label>
      <label className="field"><span>Интервал</span><input type="number" min="1" max="365" value={form.recurring_interval} onChange={event => update('recurring_interval', event.target.value)}/></label>
      <label className="field"><span>Единица периода</span><select value={form.recurring_unit} onChange={event => update('recurring_unit', event.target.value)}>{scheduleUnits.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    {preview.items.length > 1 && <div className="split-recurring-summary"><span>Обычный платёж <strong>{money(preview.items[0].amount)}</strong></span><span>Последний платёж <strong>{money(preview.items.at(-1).amount)}</strong></span></div>}
  </section>
}

function WeightsEditor({ form, setForm, preview, accountTypes, defaultDate }) {
  const parts = form.weight_parts || []
  const updatePart = (index, key, value) => setForm(current => ({ ...current, weight_parts: current.weight_parts.map((part, partIndex) => partIndex === index ? { ...part, [key]: value } : part) }))
  const addPart = () => setForm(current => current.weight_parts.length >= 60 ? current : { ...current, weight_parts: [...current.weight_parts, { weight: '1', account_type: current.weight_parts[0]?.account_type || '', planned_date: current.weight_parts.at(-1)?.planned_date || defaultDate }] })
  const removePart = index => setForm(current => current.weight_parts.length <= 2 ? current : { ...current, weight_parts: current.weight_parts.filter((_, partIndex) => partIndex !== index) })
  const applyTemplate = weights => setForm(current => ({ ...current, weight_parts: createWeightParts(weights, current.weight_parts[0]?.planned_date || defaultDate, current.weight_parts[0]?.account_type || '') }))
  return <section className="split-smart-editor split-weight-editor">
    <EditorHead title="Распределение по весам" text="Введите любые пропорции: например 1:2:3. Система сама переведёт их в проценты и распределит копейки без потери общей суммы." badge={preview.weightTotal ? `Σ ${formatWeight(preview.weightTotal)}` : 'Гибкие доли'}/>
    <div className="split-weight-templates"><span>Шаблоны</span>{weightTemplates.map(template => <button type="button" key={template.label} onClick={() => applyTemplate(template.weights)}>{template.label}</button>)}</div>
    <div className="split-weight-list">{parts.map((part, index) => <div className="split-weight-row" key={index}>
      <span className="split-percentage-number">{index + 1}</span>
      <label className="field"><span>Вес</span><input type="number" min="0.01" step="0.01" value={part.weight} onChange={event => updatePart(index, 'weight', event.target.value)} aria-label={`Вес доли ${index + 1}`}/></label>
      <AccountTypeField label="Признак учёта" value={part.account_type} options={accountTypes} onChange={value => updatePart(index, 'account_type', value)}/>
      <label className="field"><span>Плановая дата</span><DateInput value={part.planned_date} onChange={value => updatePart(index, 'planned_date', value)} aria-label={`Плановая дата весовой доли ${index + 1}`}/></label>
      <div className="split-weight-result"><span>Доля / сумма</span><strong>{preview.items[index] ? `${preview.items[index].percent}% · ${money(preview.items[index].amount)}` : '—'}</strong></div>
      <button type="button" className="split-percentage-remove" onClick={() => removePart(index)} disabled={parts.length <= 2} aria-label={`Удалить весовую долю ${index + 1}`}><Trash2 size={16}/></button>
    </div>)}</div>
    <button type="button" className="split-percentage-add" onClick={addPart} disabled={parts.length >= 60}><Plus size={16}/>Добавить долю</button>
  </section>
}

function EditorHead({ title, text, badge }) {
  return <header className="split-smart-editor-head"><div><strong>{title}</strong><span>{text}</span></div><b>{badge}</b></header>
}

function AccountTypeField({ label, value, options, onChange }) {
  return <label className="field"><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}><option value="">Выберите</option>{options.map(option => <option key={option.id ?? option.value} value={option.value}>{option.value}</option>)}</select></label>
}

function formatWeight(value) {
  return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
}
