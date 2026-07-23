export function getRegistryStickyOffsets(widths) {
  return {
    counterparty: widths[0],
    entryDate: widths[0] + widths[1],
    accountType: widths[0] + widths[1] + widths[2],
    legalEntity: widths[0] + widths[1] + widths[2] + widths[3],
  }
}
