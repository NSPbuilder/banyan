/** The same number identifies a Project receipt in the register, preview and PDF. */
export function projectReceiptNumber(paymentId: string, accountingEntryNo?: string | null): string {
  return accountingEntryNo ? `R-${accountingEntryNo}` : `R-${paymentId.replaceAll('-', '').toUpperCase()}`
}
