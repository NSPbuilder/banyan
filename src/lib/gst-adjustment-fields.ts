export const GST_EDITABLE_LINES = [
  { key: 'sales', line: '101', label: 'Sales and other revenue' },
  { key: 'collected', line: '105', label: 'GST/HST and adjustments' },
  { key: 'itcs', line: '108', label: 'ITCs and adjustments' },
] as const
export type GstKey = typeof GST_EDITABLE_LINES[number]['key']
export type GstAdjustment = {
  id: string; sales: string | null; collected: string | null; itcs: string | null
  reason: string; version: number; updated_at: string; updated_by: string
}
