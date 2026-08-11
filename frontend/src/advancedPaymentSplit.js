export const advancedSplitModeIds = new Set(['advance', 'calendar', 'recurring', 'weights'])

export const advancedSplitModes = [
  { id: 'advance', title: 'Аванс + остаток', description: 'Два платежа: аванс и окончательный расчёт' },
  { id: 'calendar', title: 'По календарю', description: 'Равные части через дни, недели, месяцы или кварталы' },
  { id: 'recurring', title: 'Сумма + остаток', description: 'Регулярная сумма, последний платёж — точный остаток' },
  { id: 'weights', title: 'По весам', description: 'Гибкие пропорции 1:2:3 без ручного расчёта процентов' },
]

export const weightTemplates = [
  { label: '50 / 50', weights: [1, 1] },
  { label: '30 / 70', weights: [3, 7] },
  { label: '20 / 30 / 50', weights: [2, 3, 5] },
  { label: '50 / 30 / 20', weights: [5, 3, 2] },
]

export function isAdvancedSplitMode(mode) {
  return advancedSplitModeIds.has(mode)
}

export function createAdvancedSplitFields(defaultDate, defaultAccountType = '') {
  return {
    advance_percent: '30',
    advance_date: defaultDate,
    advance_account_type: defaultAccountType,
    balance_date: defaultDate,
    balance_account_type: defaultAccountType,
    calendar_count: '2',
    calendar_start_date: defaultDate,
    calendar_interval: '1',
    calendar_unit: 'month',
    recurring_amount: '',
    recurring_start_date: defaultDate,
    recurring_interval: '1',
    recurring_unit: 'month',
    recurring_account_type: defaultAccountType,
    weight_parts: createWeightParts([1, 1], defaultDate, defaultAccountType),
  }
}

export function createWeightParts(weights, defaultDate, defaultAccountType = '') {
  return weights.map(weight => ({ weight: String(weight), account_type: defaultAccountType, planned_date: defaultDate }))
}

export function buildAdvancedSplitPreview(amount, form) {
  const totalCents = toCents(amount)
  if (totalCents <= 0) return emptyPreview('У платежа должна быть положительная сумма.')
  if (form.mode === 'advance') return buildAdvancePreview(totalCents, form)
  if (form.mode === 'calendar') return buildCalendarPreview(totalCents, form)
  if (form.mode === 'recurring') return buildRecurringPreview(totalCents, form)
  if (form.mode === 'weights') return buildWeightsPreview(totalCents, form)
  return emptyPreview('Выберите способ разбиения.')
}

export function buildAdvancedSplitPayload(form, preview) {
  if (preview.error || !preview.items.length) return null
  if (form.mode === 'calendar') {
    return { mode: 'count', count: preview.items.length, payment_dates: preview.items.map(item => item.date) }
  }
  if (form.mode === 'recurring') {
    return {
      mode: 'amount',
      amount_parts: preview.items.map(item => ({ amount: item.amount, account_type: item.account_type, planned_date: item.date })),
    }
  }
  return {
    mode: 'percentage',
    percentage_parts: preview.items.map(item => ({ percent: item.percent, account_type: item.account_type, planned_date: item.date })),
  }
}

function buildAdvancePreview(totalCents, form) {
  const percent = Number(form.advance_percent)
  const basisPoints = Math.round(percent * 100)
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100 || Math.abs(percent * 100 - basisPoints) > 0.000001) {
    return emptyPreview('Аванс должен быть больше 0% и меньше 100% с точностью до двух знаков.')
  }
  const fields = [
    { points: basisPoints, account_type: form.advance_account_type, date: form.advance_date, label: 'Аванс' },
    { points: 10000 - basisPoints, account_type: form.balance_account_type, date: form.balance_date, label: 'Окончательный расчёт' },
  ]
  const invalid = validateDatedAccountParts(fields)
  if (invalid) return emptyPreview(invalid)
  return allocationPreview(totalCents, fields)
}

function buildCalendarPreview(totalCents, form) {
  const count = Number(form.calendar_count)
  const interval = Number(form.calendar_interval)
  if (!Number.isInteger(count) || count < 2 || count > 60) return emptyPreview('Количество платежей должно быть от 2 до 60.')
  const scheduleError = validateSchedule(form.calendar_start_date, form.calendar_unit, interval)
  if (scheduleError) return emptyPreview(scheduleError)
  const base = Math.floor(totalCents / count)
  if (base < 1) return emptyPreview('Сумма слишком мала для выбранного количества платежей.')
  const items = Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    date: addSchedulePeriod(form.calendar_start_date, form.calendar_unit, interval * index),
    amount: (index === count - 1 ? totalCents - base * (count - 1) : base) / 100,
  }))
  return successfulPreview(items, items.at(-1).amount !== items[0].amount)
}

function buildRecurringPreview(totalCents, form) {
  const recurringCents = toCents(form.recurring_amount)
  if (recurringCents < 1) return emptyPreview('Укажите положительную регулярную сумму с точностью до копеек.')
  if (recurringCents >= totalCents) return emptyPreview('Регулярная сумма должна быть меньше общей суммы платежа.')
  if (!['ОМС', 'Коммерция'].includes(form.recurring_account_type)) return emptyPreview('Выберите ОМС или Коммерция для графика.')
  const interval = Number(form.recurring_interval)
  const scheduleError = validateSchedule(form.recurring_start_date, form.recurring_unit, interval)
  if (scheduleError) return emptyPreview(scheduleError)
  const count = Math.ceil(totalCents / recurringCents)
  if (count < 2 || count > 60) return emptyPreview('При такой сумме получится больше 60 платежей. Увеличьте регулярную сумму.')
  const items = Array.from({ length: count }, (_, index) => {
    const cents = index === count - 1 ? totalCents - recurringCents * (count - 1) : recurringCents
    return {
      number: index + 1,
      date: addSchedulePeriod(form.recurring_start_date, form.recurring_unit, interval * index),
      amount: cents / 100,
      account_type: form.recurring_account_type,
    }
  })
  return successfulPreview(items, items.at(-1).amount !== items[0].amount)
}

function buildWeightsPreview(totalCents, form) {
  const parts = form.weight_parts || []
  if (parts.length < 2 || parts.length > 60) return emptyPreview('Количество долей должно быть от 2 до 60.', { weightTotal: 0 })
  const weights = []
  let weightTotal = 0
  for (let index = 0; index < parts.length; index++) {
    const weight = Number(parts[index].weight)
    if (!Number.isFinite(weight) || weight <= 0) return emptyPreview(`Укажите положительный вес для доли ${index + 1}.`, { weightTotal })
    if (!parts[index].account_type) return emptyPreview(`Выберите признак учёта для доли ${index + 1}.`, { weightTotal: weightTotal + weight })
    if (!isIsoDate(parts[index].planned_date)) return emptyPreview(`Выберите плановую дату для доли ${index + 1}.`, { weightTotal: weightTotal + weight })
    weights.push(weight)
    weightTotal += weight
  }
  const points = distributeIntegerTotal(10000, weights)
  if (points.some(value => value < 1)) return emptyPreview('Разница между весами слишком велика: одна из долей меньше 0,01%.', { weightTotal })
  const fields = parts.map((part, index) => ({
    points: points[index],
    account_type: part.account_type,
    date: part.planned_date,
    weight: weights[index],
  }))
  return { ...allocationPreview(totalCents, fields), weightTotal }
}

function allocationPreview(totalCents, fields) {
  const cents = distributeIntegerTotal(totalCents, fields.map(field => field.points))
  if (cents.some(value => value < 1)) return emptyPreview('Одна из долей получается меньше одной копейки.')
  const items = fields.map((field, index) => ({
    number: index + 1,
    date: field.date,
    amount: cents[index] / 100,
    percent: field.points / 100,
    account_type: field.account_type,
    label: field.label,
    weight: field.weight,
  }))
  return successfulPreview(items, true)
}

function distributeIntegerTotal(total, weights) {
  const sum = weights.reduce((value, weight) => value + weight, 0)
  const raw = weights.map((weight, index) => {
    const exact = total * weight / sum
    const value = Math.floor(exact)
    return { index, value, remainder: exact - value }
  })
  let remaining = total - raw.reduce((value, item) => value + item.value, 0)
  const order = [...raw].sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  for (let index = 0; remaining > 0; index++, remaining--) order[index % order.length].value++
  return raw.sort((left, right) => left.index - right.index).map(item => item.value)
}

export function addSchedulePeriod(value, unit, amount) {
  if (!isIsoDate(value)) return ''
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (unit === 'business_day') {
    let remaining = amount
    while (remaining > 0) {
      date.setUTCDate(date.getUTCDate() + 1)
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) remaining--
    }
    return formatIsoDate(date)
  }
  if (unit === 'day' || unit === 'week') {
    date.setUTCDate(date.getUTCDate() + amount * (unit === 'week' ? 7 : 1))
    return formatIsoDate(date)
  }
  const monthStep = unit === 'quarter' ? amount * 3 : amount
  const target = new Date(Date.UTC(year, month - 1 + monthStep, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return formatIsoDate(target)
}

function validateSchedule(startDate, unit, interval) {
  if (!isIsoDate(startDate)) return 'Выберите дату первого платежа.'
  if (!['day', 'business_day', 'week', 'month', 'quarter'].includes(unit)) return 'Выберите периодичность платежей.'
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) return 'Интервал должен быть целым числом от 1 до 365.'
  return ''
}

function validateDatedAccountParts(parts) {
  for (let index = 0; index < parts.length; index++) {
    if (!parts[index].account_type) return `Выберите признак учёта для платежа ${index + 1}.`
    if (!isIsoDate(parts[index].date)) return `Выберите плановую дату для платежа ${index + 1}.`
  }
  return ''
}

function toCents(value) {
  const number = Number(String(value ?? '').replace(',', '.'))
  const cents = Math.round(number * 100)
  return Number.isFinite(number) && number > 0 && Math.abs(number * 100 - cents) <= 0.000001 ? cents : 0
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && formatIsoDate(date) === value
}

function formatIsoDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function successfulPreview(items, hasRemainder = false) {
  const total = Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100
  return { items, total, hasRemainder, error: '' }
}

function emptyPreview(error, extra = {}) {
  return { error, items: [], total: 0, ...extra }
}
