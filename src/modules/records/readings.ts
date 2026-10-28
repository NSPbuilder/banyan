/** Browser-safe schema and prompt contribution. No database or server imports. */
import { TABLE_WORDS, rowsFrom, rowsMenu } from '@/lib/record-rows'
import type { StructuredReadingExtension } from '@/lib/structured-readings'

export const structuredReading: StructuredReadingExtension = { tableWords: TABLE_WORDS, rowsFrom, rowsMenu }
