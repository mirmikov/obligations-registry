export function groupCreditSchedule(payments = [], { asOf, scheduleMode, creditor }) {
  const filtered = payments.filter(item => {
    if (creditor && item.counterparty !== creditor) return false
    if (scheduleMode === 'upcoming') return item.date >= asOf && item.outstanding_amount > 0
    if (scheduleMode === 'overdue') return item.date < asOf && item.outstanding_amount > 0
    return true
  })
  const months = new Map()
  for (const item of filtered) {
    const month = item.date.slice(0, 7)
    if (!months.has(month)) months.set(month, new Map())
    const days = months.get(month)
    if (!days.has(item.date)) days.set(item.date, [])
    days.get(item.date).push(item)
  }
  return [...months.entries()].map(([month, days]) => {
    const dayItems = [...days.entries()].map(([date, items]) => ({
      date,
      items,
      count: sum(items, 'count'),
      total: sum(items, 'total_amount'),
      outstanding: sum(items, 'outstanding_amount'),
      overdue: items.some(item => item.overdue),
    }))
    return {
      month,
      days: dayItems,
      total: dayItems.reduce((value, day) => value + day.total, 0),
    }
  })
}

export function summarizeCreditDetails(items = []) {
  return items.reduce((summary, item) => {
    const amount = Number(item.amount || 0)
    const paid = item.status === 'Оплачено' || Boolean(item.actual_payment_date)
    summary.count += 1
    summary.total += amount
    if (paid) summary.paid += amount
    else if (item.status !== 'Отменено') summary.outstanding += amount
    return summary
  }, { count: 0, total: 0, paid: 0, outstanding: 0 })
}

function sum(items, field) {
  return items.reduce((value, item) => value + Number(item[field] || 0), 0)
}
