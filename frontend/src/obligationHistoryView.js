export function mergeCurrentObligationRecord(item = {}, historyRecord = {}) {
  return {
    ...historyRecord,
    ...item,
    created_by: historyRecord.created_by || item.created_by || '',
    updated_by: historyRecord.updated_by || item.updated_by || '',
  }
}
