import 'server-only'
import { parseCsvRows } from './csv'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs, type Runner } from './acting'
import { account, accountRole, entity } from '@/db/schema'
import { mustBeOurs } from './ours'

export class AccountError extends Error {
  constructor(readonly code: string, message: string, readonly line?: number) {
    super(message)
    this.name = 'AccountError'
  }
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
export type NormalBalance = 'debit' | 'credit'

/** Which side an account of this type normally sits on, absent a contra. */
export const DEFAULT_BALANCE: Record<AccountType, NormalBalance> = {
  asset: 'debit', expense: 'debit',
  liability: 'credit', equity: 'credit', revenue: 'credit',
}

/**
 * What a type is called in a sentence, article included.
 *
 * Refusals about the tree name two types in one breath — "5250 is an expense
 * and 1000 is an asset" — and a bare enum value reads as a variable leaking
 * through. Written once so the import and the form word it the same way.
 */
export const TYPE_WORD: Record<AccountType, string> = {
  asset: 'an asset', liability: 'a liability', equity: 'an equity account',
  revenue: 'an income account', expense: 'an expense',
}

export type NewAccount = {
  entityId: string
  code: string
  name: string
  accountType: AccountType
  /** Omit unless this is a contra account — accumulated depreciation, say. */
  normalBalance?: NormalBalance
  parentCode?: string
  isPostable?: boolean
  roles?: string[]
}

export async function createAccount(input: NewAccount, actor = 'system') {
  const rows = await importAccounts(input.entityId, [input], actor)
  return rows[0]
}

/**
 * Rename an account, or change what it is, while that is still allowed.
 *
 * 0008 freezes account_type and normal_balance once the account has a posted
 * line — so this reports that in words rather than letting the database refuse
 * it with a message naming a UUID.
 *
 * It also MOVES an account on the chart. Until 0078 there was no way to: the
 * parent could only be set by a pasted chart, and never changed afterwards, so
 * a chart typed once was a chart filed wrong forever (owner, 2026-09-15).
 */
export async function updateAccount(
  accountId: string,
  patch: {
    code?: string; name?: string; accountType?: AccountType
    normalBalance?: NormalBalance; isPostable?: boolean
    /**
     * The code of the account this one sits under, by code because that is
     * what the import speaks and what a person reads. Undefined leaves it
     * alone; null or '' lifts the account back to the top level.
     */
    parentCode?: string | null
  },
  actor = 'system',
  ledgerId?: string,
  on: Runner = db,
) {
  await mustBeOurs('account', accountId, ledgerId, (m) => new AccountError('NOT_OURS', m))
  const existing = await on.query.account.findFirst({ where: eq(account.id, accountId) })
  if (!existing) throw new AccountError('NO_ACCOUNT', 'That account does not exist.')

  const code = patch.code?.trim() ?? existing.code
  const name = patch.name?.trim() ?? existing.name
  if (!code) throw new AccountError('BAD_CODE', 'An account needs a code.')
  if (!name) throw new AccountError('BAD_NAME', 'An account needs a name.')

  if (code !== existing.code) {
    const clash = await on.query.account.findFirst({
      where: and(eq(account.entityId, existing.entityId), eq(account.code, code)),
    })
    if (clash) throw new AccountError('DUPLICATE', `Account ${code} already exists in this company.`)
  }

  // -------------------------------------------------------------- the tree --
  // Sub-accounts group the chart and move no money (0078). Everything refused
  // below is refused again by the trigger; it is said twice so that it can be
  // said in words once, rather than arriving as a message naming a UUID.
  const newType = patch.accountType ?? existing.accountType

  // A parent's type is checked against the row being written, and the children
  // are not being written — so re-typing a parent is the one way past that rule.
  if (newType !== existing.accountType) {
    const kid = await on.query.account.findFirst({
      where: eq(account.parentId, accountId),
      orderBy: (a, { asc }) => [asc(a.code)],
    })
    if (kid) {
      throw new AccountError('HAS_CHILDREN',
        `${existing.code} ${existing.name} has sub-accounts — ${kid.code} ${kid.name} is one — and a ` +
        `sub-account is the same kind of thing as the account it sits under. ` +
        `Move them out from under it first.`)
    }
  }

  let parentId: string | null | undefined
  const wantedParent = patch.parentCode?.trim() ?? ''
  if (patch.parentCode === undefined) {
    parentId = undefined
  } else if (!wantedParent) {
    parentId = null
  } else if (wantedParent === code) {
    throw new AccountError('SELF_PARENT', `${code} cannot sit under itself.`)
  } else {
    const parent = await on.query.account.findFirst({
      where: and(eq(account.entityId, existing.entityId), eq(account.code, wantedParent)),
    })
    if (!parent) {
      throw new AccountError('NO_PARENT', `There is no account ${wantedParent} in this company.`)
    }
    if (parent.id === accountId) throw new AccountError('SELF_PARENT', `${code} cannot sit under itself.`)
    if (parent.accountType !== newType) {
      throw new AccountError('PARENT_TYPE',
        `${code} is ${TYPE_WORD[newType]} and ${parent.code} ${parent.name} is ` +
        `${TYPE_WORD[parent.accountType]}. A sub-account is the same kind of thing as the ` +
        `account it sits under, or the chart would show a grouping no statement could produce.`)
    }
    // Walking UP from the proposed parent: reaching this account means the
    // parent is one of its own descendants. The chain is at most five long
    // (0078), so the recursion is bounded by the same rule that keeps it acyclic.
    const [reached] = await on.execute<{ mine: boolean }>(sql`
      WITH RECURSIVE up AS (
        SELECT id, parent_id FROM account WHERE id = ${parent.id}::uuid
        UNION ALL
        SELECT a.id, a.parent_id FROM account a JOIN up ON a.id = up.parent_id
      )
      SELECT EXISTS (SELECT 1 FROM up WHERE id = ${accountId}::uuid) AS mine`)
    if (reached?.mine) {
      throw new AccountError('PARENT_CYCLE',
        `${parent.code} ${parent.name} already sits under ${code}, so ${code} cannot sit under it.`)
    }
    parentId = parent.id
  }

  const changingMeaning =
    (patch.accountType && patch.accountType !== existing.accountType) ||
    (patch.normalBalance && patch.normalBalance !== existing.normalBalance)

  if (changingMeaning) {
    const [{ n }] = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
       WHERE jl.account_id = ${accountId}::uuid AND je.status IN ('posted','reversed')`)
    if (Number(n) > 0) {
      throw new AccountError('POSTED_TO',
        `${existing.code} ${existing.name} has been posted to ${n} time${n === '1' ? '' : 's'}. ` +
        `Its type decides which statement it appears on, so changing it would rewrite reports ` +
        `that are already filed. Create a new account instead.`)
    }
  }

  const [row] = await actingAs(actor, (tx) => tx.update(account).set({
    code, name,
    accountType: patch.accountType ?? existing.accountType,
    normalBalance: patch.normalBalance ?? existing.normalBalance,
    isPostable: patch.isPostable ?? existing.isPostable,
    parentId: parentId === undefined ? existing.parentId : parentId,
    updatedAt: new Date(),
  }).where(eq(account.id, accountId)).returning(), on)

  return row
}

/**
 * Create many accounts at once, all or nothing.
 *
 * Everything is validated before anything is written. A half-applied chart is
 * worse than a rejected one: the owner would have to reconcile by hand to find
 * out which rows made it.
 */
export async function importAccounts(entityId: string, rows: NewAccount[], actor = 'system') {
  return actingAs(actor, (tx) => importAccountsCore(tx, entityId, rows, actor))
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * The same import, joining a transaction that is already open.
 *
 * Callers that create accounts as part of a larger act — registering for a
 * sales tax, say — need the accounts and that act to stand or fall together.
 * Calling `importAccounts` from inside another transaction would open a second
 * one and quietly break that.
 */
export async function importAccountsCore(
  tx: Tx, entityId: string, rows: NewAccount[], actor = 'system',
) {
  const company = await tx.query.entity.findFirst({ where: eq(entity.id, entityId) })
  if (!company) throw new AccountError('NO_ENTITY', 'That company does not exist.')
  if (rows.length === 0) throw new AccountError('EMPTY', 'Nothing to import.')

  const existing = await tx.query.account.findMany({ where: eq(account.entityId, entityId) })
  const byCode = new Map(existing.map((a) => [a.code, a]))
  // What TYPE each code is, this company's rows and this import's rows alike —
  // a parent may be either, and a sub-account is the same kind of thing as the
  // account it sits under (0078).
  const typeOf = new Map<string, AccountType>(existing.map((a) => [a.code, a.accountType]))
  const roleDefs = new Map((await tx.query.roleDefinition.findMany()).map((r) => [r.code, r]))

  const seen = new Set<string>()
  for (const [i, r] of rows.entries()) {
    const line = i + 1
    const code = r.code.trim()
    if (!code) throw new AccountError('BAD_CODE', 'An account needs a code.', line)
    if (!r.name.trim()) throw new AccountError('BAD_NAME', `Account ${code} needs a name.`, line)
    if (byCode.has(code)) {
      throw new AccountError('DUPLICATE', `Account ${code} already exists in this company.`, line)
    }
    if (seen.has(code)) {
      throw new AccountError('DUPLICATE', `Account ${code} appears twice in this import.`, line)
    }

    if (!DEFAULT_BALANCE[r.accountType]) {
      throw new AccountError('BAD_TYPE',
        `"${r.accountType}" is not an account type. Use asset, liability, equity, revenue or expense.`, line)
    }
    if (r.parentCode === code) {
      throw new AccountError('SELF_PARENT', `Account ${code} lists itself as its parent.`, line)
    }
    if (r.parentCode && !byCode.has(r.parentCode) && !seen.has(r.parentCode)) {
      throw new AccountError('NO_PARENT',
        `Account ${code} lists parent ${r.parentCode}, which is not in this company or earlier in this import.`, line)
    }
    if (r.parentCode) {
      const parentType = typeOf.get(r.parentCode)
      if (parentType && parentType !== r.accountType) {
        throw new AccountError('PARENT_TYPE',
          `Account ${code} is ${TYPE_WORD[r.accountType]} and its parent ${r.parentCode} is ` +
          `${TYPE_WORD[parentType]}. A sub-account is the same kind of thing as the account it ` +
          `sits under.`, line)
      }
    }
    seen.add(code)
    typeOf.set(code, r.accountType)

    for (const role of r.roles ?? []) {
      const def = roleDefs.get(role)
      if (!def) throw new AccountError('NO_ROLE', `There is no role called "${role}".`, line)
      if (def.category && def.category !== r.accountType) {
        throw new AccountError('ROLE_MISMATCH',
          `Role "${def.label}" is for ${def.category} accounts; ${code} is ${r.accountType}.`, line)
      }
    }
    const families = (r.roles ?? []).map((x) => roleDefs.get(x)!.family)
    const dupFamily = families.find((f, j) => families.indexOf(f) !== j)
    if (dupFamily) {
      throw new AccountError('ROLE_FAMILY',
        `Account ${code} lists two ${dupFamily} roles; an account takes at most one per family.`, line)
    }
  }

  const created: Array<typeof account.$inferSelect> = []
  const idByCode = new Map(existing.map((a) => [a.code, a.id]))

  for (const r of rows) {
    const [row] = await tx.insert(account).values({
      entityId,
      code: r.code.trim(),
      name: r.name.trim(),
      accountType: r.accountType,
      normalBalance: r.normalBalance ?? DEFAULT_BALANCE[r.accountType],
      parentId: r.parentCode ? idByCode.get(r.parentCode) ?? null : null,
      isPostable: r.isPostable ?? true,
    }).returning()

    idByCode.set(row.code, row.id)
    created.push(row)

    if (r.roles?.length) {
      await tx.insert(accountRole).values(r.roles.map((role) => ({ accountId: row.id, role })))
    }
  }

  await tx.execute(sql`
    INSERT INTO audit_log (actor, action, table_name, record_id, after)
    VALUES (${actor}, 'import_accounts', 'account', ${entityId},
            ${JSON.stringify({ count: created.length, codes: created.map((c) => c.code) })}::jsonb)`)

  return created
}

/** Replace an account's roles wholesale. The triggers enforce consistency. */
export async function setAccountRoles(accountId: string, roles: string[], actor = 'system', ledgerId?: string, on: Runner = db) {
  await mustBeOurs('account', accountId, ledgerId, (m) => new AccountError('NOT_OURS', m))
  const target = await on.query.account.findFirst({ where: eq(account.id, accountId) })
  if (!target) throw new AccountError('NO_ACCOUNT', 'That account does not exist.')

  return on.transaction(async (tx) => {
    await tx.execute(sql`UPDATE account SET version=version WHERE id=${accountId}::uuid`)
    const before = await tx.query.accountRole.findMany({ where: eq(accountRole.accountId, accountId) })
    await tx.delete(accountRole).where(eq(accountRole.accountId, accountId))
    if (roles.length) {
      await tx.insert(accountRole).values(roles.map((role) => ({ accountId, role })))
    }
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after)
      VALUES (${actor}, 'set_account_roles', 'account', ${accountId},
              ${JSON.stringify(before.map((b) => b.role))}::jsonb,
              ${JSON.stringify(roles)}::jsonb)`)
    return roles
  })
}

/**
 * Accounts are deactivated, never deleted, once they have been posted to — the
 * trigger in 0008 refuses the delete, and the history has to stay readable.
 *
 * The door 0008's refusal sends people to had no button until 2026-09-16
 * (owner: 「所有的紀錄儘量都可以編輯刪除」); `setAccountActive` is it, both ways.
 */
export async function deactivateAccount(accountId: string, actor = 'system') {
  return setAccountActive(accountId, false, actor)
}

export async function setAccountActive(accountId: string, active: boolean, actor = 'system', ledgerId?: string, on: Runner = db) {
  await mustBeOurs('account', accountId, ledgerId, (m) => new AccountError('NOT_OURS', m))
  const [row] = await actingAs(actor, (tx) => tx.update(account)
    .set({ isActive: active, updatedAt: new Date() })
    .where(eq(account.id, accountId))
    .returning(), on)
  if (!row) throw new AccountError('NO_ACCOUNT', 'That account does not exist.')
  await on.execute(sql`
    INSERT INTO audit_log (actor, action, table_name, record_id, after)
    VALUES (${actor}, ${active ? 'reactivate_account' : 'deactivate_account'}, 'account', ${accountId},
            ${JSON.stringify({ code: row.code })}::jsonb)`)
  return row
}

/**
 * Delete an account nothing has used — made by mistake, or by an import with a
 * typo (0084). Anything that points at it keeps it: a journal line of any
 * status, a sub-account, an invoice, a bank row or statement, a pay run. The
 * refusal says which, and that deactivating is the way to retire it; 0008 and
 * the foreign keys refuse the same things again underneath.
 */
export async function deleteAccount(accountId: string, actor = 'system', ledgerId?: string, on: Runner = db) {
  await mustBeOurs('account', accountId, ledgerId, (m) => new AccountError('NOT_OURS', m))
  const [held] = await on.execute<{
    code: string; name: string; account_type: string
    lines: number; kids: number; invoices: number; bank: number; payroll: number
  }>(sql`
    SELECT a.code, a.name, a.account_type,
           (SELECT count(*)::int FROM journal_line WHERE account_id = a.id) AS lines,
           (SELECT count(*)::int FROM account WHERE parent_id = a.id) AS kids,
           (SELECT count(*)::int FROM invoice_line WHERE account_id = a.id)
             + (SELECT count(*)::int FROM invoice WHERE control_account_id = a.id) AS invoices,
           (SELECT count(*)::int FROM bank_transaction WHERE account_id = a.id)
             + (SELECT count(*)::int FROM bank_statement WHERE account_id = a.id) AS bank,
           (SELECT count(*)::int FROM pay_run WHERE bank_account_id = a.id) AS payroll
      FROM account a WHERE a.id = ${accountId}::uuid`)
  if (!held) throw new AccountError('NO_ACCOUNT', 'That account does not exist.')
  const uses = ([
    [held.lines, 'journal line'], [held.kids, 'sub-account'], [held.invoices, 'invoice line or invoice'],
    [held.bank, 'bank row or statement'], [held.payroll, 'pay run'],
  ] as Array<[number, string]>).filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}${n === 1 ? '' : 's'}`)
  if (uses.length > 0) {
    throw new AccountError('IN_USE',
      `${held.code} ${held.name} is used — ${uses.join(', ')} — so it stays. `
      + 'Deactivate it instead: it keeps its history and takes nothing new.')
  }
  try {
    await actingAs(actor, async (tx) => {
      // Balances are a cache of lines, and there are none; its roles go with it.
      await tx.execute(sql`DELETE FROM period_balance WHERE account_id = ${accountId}::uuid`)
      await tx.execute(sql`DELETE FROM account WHERE id = ${accountId}::uuid`)
      await tx.execute(sql`
        INSERT INTO audit_log (actor, action, table_name, record_id, before)
        VALUES (${actor}, 'delete_account', 'account', ${accountId},
                ${JSON.stringify({ code: held.code, name: held.name, type: held.account_type })}::jsonb)`)
    }, on)
  } catch (e) {
    const text = `${String(e)} ${String((e as { cause?: unknown }).cause ?? '')}`
    if (text.includes('foreign key')) {
      throw new AccountError('IN_USE', `${held.code} ${held.name} is still pointed at by something, so it stays. Deactivate it instead.`)
    }
    throw e
  }
  return { code: held.code, name: held.name }
}

// -------------------------------------------------------------------- parse --

const TYPE_ALIASES: Record<string, AccountType> = {
  asset: 'asset', assets: 'asset', a: 'asset',
  liability: 'liability', liabilities: 'liability', l: 'liability',
  equity: 'equity', e: 'equity',
  revenue: 'revenue', income: 'revenue', r: 'revenue',
  expense: 'expense', expenses: 'expense', x: 'expense',
}

/**
 * Parse a pasted chart of accounts.
 *
 *   code, name, type, [parent], [roles], [balance]
 *
 * `balance` is debit, credit, or contra — the last meaning the opposite of what
 * the type would normally be. Without it there was no way to create an
 * accumulated depreciation or an allowance account through the UI, and 0008
 * freezes normal_balance once the account is posted to, so the mistake was
 * permanent.
 *
 * A header row is skipped if the first non-blank, non-comment row starts with
 * "code" — keyed to that row rather than to physical line 0, because a leading
 * blank line is a routine artefact of pasting from a spreadsheet.
 */
export function parseAccountsCsv(text: string): NewAccount[] {
  const out: NewAccount[] = []
  let rowNo = 0

  parseCsvRows(text, [',', '\t'], {
    commentPrefix: '#', includeEmptyFinalRecord: true, trimRecordWhitespace: true,
  }).forEach(({ cells, line, blank }) => {
    if (blank) return
    rowNo++
    if (rowNo === 1 && cells[0]?.trim().toLowerCase() === 'code') return

    if (cells.length < 3) {
      throw new AccountError('BAD_ROW',
        `Line ${line} has ${cells.length} column${cells.length === 1 ? '' : 's'}; ` +
        `at least three are needed: code, name, type.`, line)
    }

    const [code, name, rawType, parent, roles, balance] = cells.map((c) => (c ?? '').trim())
    const accountType = TYPE_ALIASES[rawType.toLowerCase()]
    if (!accountType) {
      throw new AccountError('BAD_TYPE',
        `Line ${line}: "${rawType}" is not an account type. ` +
        `Use asset, liability, equity, revenue or expense.`, line)
    }

    let normalBalance: NormalBalance | undefined
    if (balance) {
      const b = balance.toLowerCase()
      if (b === 'debit' || b === 'credit') normalBalance = b
      else if (b === 'contra') {
        normalBalance = DEFAULT_BALANCE[accountType] === 'debit' ? 'credit' : 'debit'
      } else {
        throw new AccountError('BAD_BALANCE',
          `Line ${line}: "${balance}" is not a balance. Use debit, credit or contra, or leave it blank.`, line)
      }
    }

    out.push({
      entityId: '',
      code, name, accountType, normalBalance,
      parentCode: parent || undefined,
      roles: roles ? roles.split(/[\s|,]+/).filter(Boolean) : undefined,
    })
  })

  if (out.length === 0) throw new AccountError('EMPTY', 'No account rows found in that text.')
  return out
}

// ------------------------------------------------------------------ queries --

export async function chartOfAccounts(entityId: string, ledgerId?: string) {
  return db.execute<{
    id: string; version:string; code: string; name: string; account_type: string; normal_balance: string
    is_postable: boolean; is_active: boolean; parent_code: string | null
    roles: string[] | null; role_labels: string[] | null; balance: string
  }>(sql`
    SELECT a.id::text, a.version::text, a.code, a.name, a.account_type::text, a.normal_balance::text,
           a.is_postable, a.is_active, p.code AS parent_code,
           array_remove(array_agg(ar.role ORDER BY rd.sort_order), NULL) AS roles,
           array_remove(array_agg(rd.label ORDER BY rd.sort_order), NULL) AS role_labels,
           -- The signed position, straight from the journal (posted only) —
           -- shown for balance-sheet accounts, whose balance is a fact about
           -- now; a P&L account's is a question about a period, and the
           -- reports answer that one.
           (SELECT COALESCE(SUM(jl.amount), 0) FROM journal_line jl
             JOIN journal_entry je ON je.id = jl.entry_id
            WHERE jl.account_id = a.id AND je.status IN ('posted','reversed')
              ${ledgerId ? sql`AND je.ledger_id=${ledgerId}::uuid` : sql``})::text AS balance
      FROM account a
      LEFT JOIN account p ON p.id = a.parent_id
      LEFT JOIN account_role ar ON ar.account_id = a.id
      LEFT JOIN role_definition rd ON rd.code = ar.role
     WHERE a.entity_id = ${entityId}::uuid
     GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance,
              a.is_postable, a.is_active, p.code
     ORDER BY a.code`)
}

/**
 * Accounts that reach no statement line — whether because they carry no role at
 * all, or because every role they carry is one no statement uses.
 */
export async function untaggedAccounts(entityId: string) {
  return db.execute<{
    code: string; name: string; account_type: string; has_activity: boolean; reason: string
  }>(sql`SELECT * FROM check_untagged_accounts(${entityId}::uuid)`)
}

export async function availableRoles() {
  return db.query.roleDefinition.findMany({
    orderBy: (r, { asc }) => [asc(r.sortOrder)],
  })
}

/**
 * The account a module should post a role to, in this company.
 *
 * Several accounts may carry one role, and something has to choose. LOWEST
 * CODE WINS: the same account every time, and the choice is visible in the
 * chart rather than buried in whichever module asked. Empty when nothing
 * active carries the role — the caller says what that means for it, because
 * "no GST account" and "no payroll liability account" want different words.
 */
export function accountWithRole(ledgerId: string, role: string, on: Runner = db) {
  return on.execute<{ id: string; code: string; name: string }>(sql`
    SELECT a.id::text, a.code, a.name
      FROM account a
      JOIN account_role ar ON ar.account_id = a.id
     WHERE ar.role = ${role}
       AND a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND a.is_postable AND a.is_active
     ORDER BY a.code
     LIMIT 1`)
}
