import {
  attachMinuteBookAction, ceaseDirectorAction, ceaseSiAction, correctRowAction, deleteRecordRowAction,
  deleteShareClassAction, detachMinuteBookAction, renameShareClassAction, setShareholderAddressAction,
} from '@/app/records-actions'
import { RecordsScreen, type RecordsShow } from './RecordsScreen'
import type { recordsScreenData } from './screen-data'

type RecordsData = NonNullable<Awaited<ReturnType<typeof recordsScreenData>>>

/**
 * The records screen with its doors attached — Basic Info and each register
 * page render the same thing with a different `show`. Adding is not among the
 * doors: every Add is a link to a floating form (`records/add/[table]`). Every
 * row's Edit and Delete are (0083).
 */
export function RecordsPanel({ ledgerId, show, data }: {
  ledgerId: string; show: RecordsShow; data: RecordsData
}) {
  return (
    <RecordsScreen
      ledgerId={ledgerId}
      today={data.today}
      show={show}
      profile={data.profile}
      isCcpc={data.isCcpc}
      companyTypes={data.companyTypes}
      offices={data.offices}
      directorships={data.directorships}
      holdings={data.holdings}
      totals={data.totals}
      sis={data.sis}
      minuteBook={data.minuteBook}
      minutePaper={data.minutePaper}
      movements={data.movements}
      classes={data.classes}
      choices={data.choices}
      actions={{
        cease: ceaseDirectorAction, ceaseSi: ceaseSiAction,
        attachMinute: attachMinuteBookAction, detachMinute: detachMinuteBookAction,
        correct: correctRowAction, remove: deleteRecordRowAction,
        renameClass: renameShareClassAction, deleteClass: deleteShareClassAction,
        setShareholderAddress: setShareholderAddressAction,
      }}
    />
  )
}
