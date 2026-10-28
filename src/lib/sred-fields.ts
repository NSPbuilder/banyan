/**
 * SR&ED's form field names, in SR&ED's own file (doc 48). They were in the
 * framework's forms.ts. Pure, like that file: client components read it.
 */
/** SR&ED: the project, its year, the time, the evidence, the allocations. */
export const SRED_FIELDS = {
  ledgerId: 'ledgerId',
  projectId: 'projectId',
  claimId: 'claimId',
  code: 'code',
  title: 'title',
  startedOn: 'startedOn',
  fieldOfScience: 'fieldOfScience',
  fiscalYearId: 'fiscalYearId',
  method: 'method',
  uncertainty: 'uncertainty',
  workDone: 'workDone',
  advancement: 'advancement',
  assistanceNote: 'assistanceNote',
  assistanceAnswered: 'assistanceAnswered',
  employeeId: 'employeeId',
  onDate: 'onDate',
  hours: 'hours',
  activity: 'activity',
  kind: 'kind',
  note: 'note',
  sourceKind: 'sourceKind',
  sourceId: 'sourceId',
  category: 'category',
  percent: 'percent',
  basis: 'basis',
  allocationId: 'allocationId',
  /** Marking a year filed, and the reason required to take that back. */
  filedOn: 'filedOn',
  reason: 'reason',
  /** Correcting the record: which row, and the fields a project alone has. */
  timeId: 'timeId',
  evidenceId: 'evidenceId',
  status: 'status',
  endedOn: 'endedOn',
  /** A batch, in the shape `docs/design/34-sred-intake.md` asks the agent for. */
  paste: 'paste',
  /** The rate table, which had no door until 2026-09-12. */
  rateId: 'rateId',
  jurisdiction: 'jurisdiction',
  rateName: 'rateName',
  value: 'value',
  effectiveFrom: 'effectiveFrom',
  effectiveTo: 'effectiveTo',
  authority: 'authority',
  confidence: 'confidence',
  // An account's T661 line — SR&ED's own tag on the chart since 0156.
  categoryAccountId: 'categoryAccountId',
  accountCategory: 'accountCategory',
} as const
