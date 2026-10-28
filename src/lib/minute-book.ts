/** Client-safe minute-book vocabulary and upload contracts. */
import { formatNumber } from './numbers'

export function minuteFileSize(value: number | string): string {
  const bytes = Number(value)
  if (bytes < 1024) return `${formatNumber(bytes)} B`
  if (bytes < 1024 * 1024) return `${formatNumber((bytes / 1024).toFixed(1))} KB`
  return `${formatNumber((bytes / 1024 / 1024).toFixed(1))} MB`
}

export const MINUTE_KIND_LABELS: Record<string, string> = {
  incorporation: 'Incorporation', articles: 'Articles', certificate: 'Certificate',
  directors_resolution: 'Directors’ resolution', shareholders_resolution: 'Shareholders’ resolution',
  directors_minutes: 'Directors’ minutes', shareholders_minutes: 'Shareholders’ minutes',
  directors_consent: 'Director’s consent', resignation: 'Resignation', written_dissent: 'Written dissent',
  financial_statements: 'Financial statements', court_or_regulator_order: 'Court or regulator order',
  memo: 'Memo', other: 'Other',
}
export const minuteKindLabel = (kind: string) => MINUTE_KIND_LABELS[kind] ?? kind.replaceAll('_', ' ')

export const MINUTE_CATEGORIES = [
  { value: 'incorporation', label: 'Incorporation', kinds: ['incorporation', 'articles', 'certificate'] },
  { value: 'resolutions', label: 'Resolutions', kinds: ['directors_resolution', 'shareholders_resolution'] },
  { value: 'meetings', label: 'Meetings', kinds: ['directors_minutes', 'shareholders_minutes'] },
  { value: 'memo', label: 'Memos', kinds: ['memo'] },
  { value: 'financial', label: 'Financial statements', kinds: ['financial_statements'] },
  { value: 'other', label: 'Other records', kinds: ['directors_consent', 'resignation', 'written_dissent', 'court_or_regulator_order', 'other'] },
] as const

const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain',
}
export const MINUTE_FILE_ACCEPT = Object.keys(FILE_TYPES).map(ext => `.${ext}`).join(',')
export const minuteFileMime = (filename: string): string | null =>
  FILE_TYPES[filename.split('.').at(-1)?.toLowerCase() ?? ''] ?? null

export type MinuteDocumentMetadata = {
  recordKind: string; onDate: string; title: string; keptAt: string; note: string
}
export type MinutePaperView = {
  id: string; filename: string; uploaded: string; byte_size: string; mime: string
}
export type MinuteRecordView = {
  id: string; record_kind: string; on_date: string; title: string; kept_at: string; note: string | null
  papers: MinutePaperView[]
}
export type MinuteUploadResult = {
  ok?: string; error?: string; minuteId?: string; paperId?: string; alreadyFiled?: boolean
}
