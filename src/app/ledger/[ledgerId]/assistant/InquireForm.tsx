'use client'

import { ActionForm, type FormAction } from '@/components/ActionForm'
import { ASSISTANT_FIELDS as F } from '@/lib/forms'
import { BUTTON, BUTTON_WIDE, FIELD, QUIET } from '@/lib/ui'

/**
 * The box: a question about this company's books, answered by looking things
 * up. The service it goes to is the person's saved one (ServicePanel); nothing
 * secret is in this form. The actions arrive as props so a check can render
 * these without a server runtime (the ActionForm rule).
 */
export function InquireForm({ ledgerId, action, max, start }: {
  ledgerId: string; action: FormAction; max: number
  /** Text to begin from — what a question that looked up too much still needed. */
  start?: string
}) {
  return (
    <ActionForm action={action} submit="Ask" working="Looking it up…" className="mt-6 max-w-2xl"
                buttonClassName={`mt-3 ${BUTTON_WIDE}`}>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <textarea name={F.question} aria-label="Question" required maxLength={max} rows={4} defaultValue={start}
                className={`w-full ${FIELD}`} />
    </ActionForm>
  )
}

/** Another round of look-ups on one question, for the person who asked it. */
export function KeepLookingForm({ ledgerId, inquiryId, action }: {
  ledgerId: string; inquiryId: string; action: FormAction
}) {
  return (
    <ActionForm action={action} submit="Keep looking" working="Looking further…" className="mt-3"
                buttonClassName={QUIET}>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <input type="hidden" name={F.inquiryId} value={inquiryId} />
    </ActionForm>
  )
}

/** One explicit confirmation for one immutable CRM proposal. */
export function ConfirmSkillCommandForm({ ledgerId, inquiryId, stepN, action }: {
  ledgerId: string; inquiryId: string; stepN: number; action: FormAction
}) {
  return (
    <ActionForm action={action} submit="Confirm and save" working="Saving…" className="mt-3"
                buttonClassName={BUTTON}>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <input type="hidden" name={F.inquiryId} value={inquiryId} />
      <input type="hidden" name={F.stepN} value={stepN} />
    </ActionForm>
  )
}
