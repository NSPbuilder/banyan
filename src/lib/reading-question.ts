/**
 * The first sentence of every reading's question: the first from 63983617
 * (2026-09-06), the second since 2026-09-15, when a sentence alone became
 * enough (0077). `readBill` begins its instruction with the last of these, and
 * the assistant page leaves out exchanges whose question begins with any of
 * them: a discarded reading deletes its `ai_bill_reading` row, and the
 * exchange it wrote stays, pointed at by nothing. When the sentence changes,
 * the old one stays in this list and the new one goes on the end.
 */
export const READING_QUESTION_STARTS = [
  'Read the attached bill, invoice or receipt and answer with ONE JSON object and nothing else.',
  'Turn what the person gave you — a sentence, a document, or both — into ONE JSON object and nothing else.',
] as const
