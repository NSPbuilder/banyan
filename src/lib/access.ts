import 'server-only'
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Runner } from './acting'
import { causesOf } from './db-errors'
import { auditRow } from './audit-row'
import { MODULE_PATHS, seatsForPath } from './nav'
import type { UserRecord } from './users'

/**
 * Which companies and which modules a person may reach.
 *
 * 0053 answered "who are you". This answers "may you be here", and it is
 * enforced in the ONE place every entrypoint already goes through — `gate.ts`.
 * Not by hiding nav seats: a hidden seat whose URL still answers is exactly the
 * defect RISKS §15b was written about. The rail filters itself as a courtesy,
 * and if the two ever disagree the gate is right.
 *
 * An OWNER is exempt from user grants, but still follows company switches.
 * `is_owner` means "can manage people and take backups". Company switches still constrain their business routes; global
 * administration remains available so a superadmin can restore company access.
 */

export type Access = {
  /** Entity ids this person may open. Null means every one — an owner. */
  entities: Set<string> | null
  /** Union of nav seats across their companies. Null means every one. */
  modules: Set<string> | null
  /** Effective seats per company, after company switches. Null is legacy unrestricted input. */
  byEntity: Map<string, Set<string>> | null
}

export async function accessFor(user: Pick<UserRecord, 'id' | 'is_owner'>, on: Runner = db): Promise<Access> {
  const rows = user.is_owner
    ? await on.execute<{ entity_id: string; module: string }>(sql`
        SELECT e.id::text AS entity_id, m.module FROM entity e
        CROSS JOIN (VALUES ${sql.join(MODULE_PATHS.map(m => sql`(${m})`), sql`, `)}) AS m(module)
        LEFT JOIN company_module_access c ON c.entity_id = e.id AND c.module = m.module
        WHERE COALESCE(c.enabled, m.module <> '/projects')`)
    : await on.execute<{ entity_id: string; module: string }>(sql`
        SELECT a.entity_id::text, a.module FROM user_entity_module_access a
        LEFT JOIN company_module_access c ON c.entity_id = a.entity_id AND c.module = a.module
        WHERE a.user_id = ${user.id}::uuid AND COALESCE(c.enabled, a.module <> '/projects')`)
  const byEntity = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!byEntity.has(row.entity_id)) byEntity.set(row.entity_id, new Set())
    byEntity.get(row.entity_id)!.add(row.module)
  }
  return {
    entities: user.is_owner ? null : new Set(rows.map((r) => r.entity_id)),
    modules: user.is_owner ? null : new Set(rows.map((r) => r.module)),
    byEntity,
  }
}

/**
 * The seats that open a path — usually one, occasionally several, and an EMPTY
 * array for a ledger path nobody has decided about.
 *
 * `seatsForPath` builds on `activeNavPath`, the same function the rail
 * highlights with — so "which module is this page" has one answer, and /aging
 * lighting Reports in the rail and /aging being covered by the Reports grant
 * are the same fact. What it adds is the paths that light nothing: `/export`,
 * `/attachments`, `/invoices`. Those used to fall through to "allowed".
 */
export function moduleOf(pathname: string, ledgerId: string): string[] | null {
  return seatsForPath(ledgerId, pathname)
}

/**
 * The ledger id in a path, if it is a ledger path at all.
 *
 * The path may carry a query string — the proxy sends the whole thing, because
 * `/export?what=journal` and `/export?what=gst-hst` are two different seats'
 * worth of data through one route.
 */
export function ledgerIdIn(pathname: string): string | null {
  const m = /^\/ledger\/([0-9a-fA-F-]{36})(\/|\?|$)/.exec(pathname)
  return m ? m[1] : null
}

/** Which company a ledger belongs to. */
export async function entityOfLedger(ledgerId: string, on: Runner = db): Promise<string | null> {
  const [row] = await on.execute<{ entity_id: string }>(sql`
    SELECT entity_id::text FROM ledger WHERE id = ${ledgerId}::uuid`)
  return row?.entity_id ?? null
}

export type Refusal = { code: 'NO_COMPANY' | 'NO_MODULE'; message: string }

const IS_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * May this person be at this path? Null when yes.
 *
 * A path outside any ledger — the desk, the company list, the people screen —
 * is not a module and is not refused here. `/users` has its own owner check,
 * and the company list shows only the companies somebody may open.
 */
export async function refuseFor(
  user: UserRecord, pathname: string,
): Promise<Refusal | null> {
  const ledgerId = ledgerIdIn(pathname)
  if (!ledgerId) {
    if (!pathname.startsWith('/ledger/')) return null
    // Under /ledger/ with no id this can read: REFUSE, not "outside every
    // ledger". The router may still find a ledger in it — an escaped id was
    // admitted this way and handed to the page decoded (security review,
    // 2026-10-20). The proxy now decodes; this is the second lock. Somebody who
    // may see every company still reaches the page's own notFound.
    const access = await accessFor(user)
    if (access.byEntity === null) return null
    return { code: 'NO_COMPANY', message: 'That address does not name a company of yours.' }
  }
  const access = await accessFor(user)
  if (access.byEntity === null) return null

  const entityId = await entityOfLedger(ledgerId)
  if (access.entities) {
    // A ledger that does not exist is not an access question — the page's own
    // notFound answers it, and refusing here would make this an existence
    // oracle for ledger ids, which is the fault the ledger layout had.
    if (entityId && !access.entities.has(entityId)) {
      return {
        code: 'NO_COMPANY',
        message: 'That company is not one of yours. Ask an owner if you need it.',
      }
    }
  }

  if (entityId) {
    const seats = moduleOf(pathname, ledgerId)
    // ANY one of them opens it: an invoice is reached from /expenses or from
    // /income, and holding either is holding the document.
    //
    // An EMPTY list refuses. Before 2026-09-03 a seatless ledger path fell
    // through to "allowed" on the theory that the company check had already
    // decided it — which was true of the company and false of the module, so
    // `/export?what=journal` and every filed receipt were open to anybody with
    // any seat at all (critic). A door nobody has decided about stays shut, and
    // `N18` makes sure somebody decides.
    const held = access.byEntity.get(entityId) ?? new Set<string>()
    if (seats !== null && !seats.some((s) => held.has(s))) {
      return {
        code: 'NO_MODULE',
        message: 'This module is unavailable for this company or your user. '
          + 'Ask the superadmin or an owner if you need it.',
      }
    }
  }

  return null
}

/**
 * The same question about an id in a form body rather than a URL.
 *
 * A server action POSTs to the page's own URL, so `refuseFor` judges the page
 * the form was ON — and every action here reads the ledger it acts on out of
 * the form. Standing on a company you hold, one POST wrote to a company you do
 * not (critic, 2026-09-03): the gate never saw the second id. Six actions had
 * no authentication at all when the gate first shipped, and this is the same
 * shape one layer along — authenticated, unauthorised.
 *
 * `module` is the seat the action belongs to, which is the seat of the page its
 * form lives on. It is written down rather than derived because the server
 * cannot know which component called it — and `N18` re-derives it from the tree
 * and refuses a declaration that has gone stale.
 */
export async function refuseForLedger(
  user: UserRecord, ledgerId: string, module: string | string[],
  on: Runner = db,
): Promise<Refusal | null> {
  // A missing or malformed id refuses rather than reaching the database, where
  // `''::uuid` is a 500 and not an answer. A POST with no ledger in it is not a
  // request this can say yes to.
  if (!IS_UUID.test(ledgerId)) {
    return { code: 'NO_COMPANY', message: 'That request did not name a company.' }
  }
  const access = await accessFor(user, on)
  if (access.byEntity === null) return null

  const entityId = await entityOfLedger(ledgerId, on)
  if (access.entities) {
    if (entityId && !access.entities.has(entityId)) {
      return {
        code: 'NO_COMPANY',
        message: 'That company is not one of yours. Ask an owner if you need it.',
      }
    }
  }
  // ANY of them, for an action reachable from more than one screen: an invoice
  // is opened from /expenses or from /income, and holding either is holding it.
  const seats = typeof module === 'string' ? [module] : module
  const held = entityId ? access.byEntity.get(entityId) ?? new Set<string>() : new Set<string>()
  if (!seats.some((m) => held.has(m))) {
    return {
      code: 'NO_MODULE',
      message: 'This module is unavailable for this company or your user. '
        + 'Ask the superadmin or an owner if you need it.',
    }
  }
  return null
}

/** And for an action that names a company rather than a ledger. */
export async function refuseForEntity(
  user: UserRecord, entityId: string,
): Promise<Refusal | null> {
  if (!IS_UUID.test(entityId)) {
    return { code: 'NO_COMPANY', message: 'That request did not name a company.' }
  }
  const access = await accessFor(user)
  if (!access.entities) return null
  return access.entities.has(entityId) ? null : {
    code: 'NO_COMPANY',
    message: 'That company is not one of yours. Ask an owner if you need it.',
  }
}

/** The seats to draw in the rail for this person. */
export function seatsFor(access: Access, paths: string[]): string[] {
  return access.modules === null ? paths : paths.filter((p) => access.modules!.has(p))
}

/** The seats to draw in one company's rail, not the union held elsewhere. */
export function seatsForEntity(access: Access, entityId: string, paths: string[]): string[] {
  if (access.byEntity === null) return paths
  const held = access.byEntity.get(entityId) ?? new Set<string>()
  return paths.filter((p) => held.has(p))
}

/** The first page a person can actually open in one company. */
export function homeSeatForEntity(access: Access, entityId: string, paths: string[]): string | null {
  if (access.byEntity === null) return paths[0] ?? null
  const held = access.byEntity.get(entityId) ?? new Set<string>()
  return paths.find((path) => held.has(path)) ?? null
}

// ------------------------------------------------------------------ granting


export class AccessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AccessError'
  }
}

/**
 * "May this person open this company", as one SQL predicate.
 *
 * ONE spelling, because there were two readers and only one of them asked:
 * `/companies` filtered on `user_entity_access` under a comment about not
 * inviting somebody to a locked door, and the DESK — the landing page — handed
 * every company's name and primary ledger id to anybody signed in (critic,
 * 2026-09-03). A predicate rather than a query, because the two screens want
 * different columns and forcing one shape would have been the reason the next
 * reader wrote a third.
 *
 * Takes the entity's id column, so a caller can alias its table how it likes.
 */
export function mayOpenEntity(user: UserRecord, entityId: SQL | SQLWrapper): SQL {
  return user.is_owner ? sql`TRUE` : sql`EXISTS (
    SELECT 1 FROM user_entity_module_access a
     WHERE a.user_id = ${user.id}::uuid AND a.entity_id = ${entityId}
       AND COALESCE((SELECT c.enabled FROM company_module_access c
         WHERE c.entity_id = a.entity_id AND c.module = a.module), a.module <> '/projects'))`
}

/**
 * Every company, for the screen that grants them — ARCHIVED ONES INCLUDED,
 * flagged so the screen can say so.
 *
 * This filtered on `is_active` until 0065 gave that column a meaning: after
 * it, an archived company vanished from the ticks, and `setGrants` replaces
 * the whole set of ticks — so the next time anybody's access was saved, every
 * grant to an archived company was deleted and never came back. Archiving is
 * meant to leave people and permissions alone (24-archiving-a-company.md);
 * this is what makes that true (critic, 2026-09-07).
 *
 * An archived company's books are still readable, so being granted one is
 * still a meaningful thing to be granted.
 */
export function allCompanies() {
  return db.execute<{ id: string; code: string; name: string; archived: boolean }>(sql`
    SELECT id::text, code, name, (archived_at IS NOT NULL) AS archived
      FROM entity ORDER BY archived_at IS NOT NULL, code`)
}

/** What one person has been given. */
export async function grantsOf(userId: string) {
  const [rows, entities, modules] = await Promise.all([
    db.execute<{ entity_id: string; module: string }>(sql`
      SELECT entity_id::text, module FROM user_entity_module_access
       WHERE user_id = ${userId}::uuid ORDER BY entity_id, module`),
    db.execute<{ entity_id: string }>(sql`
      SELECT entity_id::text FROM user_entity_access WHERE user_id = ${userId}::uuid ORDER BY entity_id`),
    db.execute<{ module: string }>(sql`
      SELECT module FROM user_module_access WHERE user_id = ${userId}::uuid ORDER BY module`),
  ])
  return {
    entities: entities.map((r) => r.entity_id),
    modules: modules.map((r) => r.module),
    grants: rows.map((r) => `${r.entity_id}|${r.module}`),
  }
}

/**
 * Replace what somebody has been given, in one transaction.
 *
 * Replace rather than add-and-remove: the screen sends the whole set of ticks,
 * and "what is ticked is what they have" is one question with one answer. Two
 * operations would leave a window where somebody had neither or both.
 */
export async function setGrants(input: {
  userId: string; entityIds: string[]; modules: string[]; actor: string; reason?: string
}): Promise<void> {
  if (input.modules.length > 0 && input.entityIds.length === 0) {
    throw new AccessError('NO_COMPANY_YET',
      'Give this person at least one company as well. A module they cannot reach any books through does nothing.')
  }
  return setGrantMatrix({
    userId: input.userId,
    grants: input.entityIds.flatMap((entityId) => input.modules.map((module) => ({ entityId, module }))),
    actor: input.actor,
    reason: input.reason,
    summaryEntityIds: input.entityIds,
    summaryModules: input.modules,
  })
}

/** Replace the exact company × module cells somebody has been given. */
export async function setGrantMatrix(input: {
  userId: string
  grants: Array<{ entityId: string; module: string }>
  actor: string
  reason?: string
  /** Omitted by legacy callers; the People matrix always sends a choice. */
  webdavEnabled?: boolean
  /** Compatibility summaries for the former Cartesian-product form. */
  summaryEntityIds?: string[]
  summaryModules?: string[]
}): Promise<void> {
  // Every module must be a seat that exists. A row naming a module nobody can
  // navigate to would grant nothing and never say so.
  const grants = [...new Map(input.grants.map((g) => [`${g.entityId}|${g.module}`, g])).values()]
  const unknown = grants.map((g) => g.module).filter((m) => !MODULE_PATHS.includes(m))
  if (unknown.length > 0) {
    throw new AccessError('NO_SUCH_MODULE',
      `There is no module at ${unknown.join(', ')}.`)
  }

  try {
    await db.transaction(async (tx) => {
      // One grant-writer at a time for this person. Without it, two concurrent
      // saves can each see the other's entity rows still present, both commit,
      // and leave modules with no company to use them in — the state
      // `trg_module_needs_a_company` exists to prevent, reached by a route the
      // trigger cannot see under READ COMMITTED (critic, 2026-09-03).
      const [person] = await tx.execute<{ webdav_enabled: boolean }>(sql`
        SELECT webdav_enabled FROM app_user WHERE id = ${input.userId}::uuid FOR UPDATE`)
      if (!person) throw new AccessError('NO_SUCH_USER', 'There is no such person.')
      // What they had, read under the same lock, so the trail can say what
      // changed: a grant widened and narrowed again used to leave no trace
      // (RISKS §15b). Sorted, so two readings of one set compare equal.
      const had = await tx.execute<{ entity_id: string; module: string }>(sql`
        SELECT entity_id::text, module FROM user_entity_module_access
         WHERE user_id = ${input.userId}::uuid ORDER BY entity_id, module`)
      const hadEntityRows = await tx.execute<{ entity_id: string }>(sql`
        SELECT entity_id::text FROM user_entity_access WHERE user_id = ${input.userId}::uuid`)
      const hadModuleRows = await tx.execute<{ module: string }>(sql`
        SELECT module FROM user_module_access WHERE user_id = ${input.userId}::uuid`)
      const hadEntities = hadEntityRows.map((r) => r.entity_id)
      const hadModules = hadModuleRows.map((r) => r.module)
      await tx.execute(sql`
        DELETE FROM user_entity_module_access WHERE user_id = ${input.userId}::uuid`)
      await tx.execute(sql`
        DELETE FROM user_module_access WHERE user_id = ${input.userId}::uuid`)
      await tx.execute(sql`
        DELETE FROM user_entity_access WHERE user_id = ${input.userId}::uuid`)
      const entityIds = [...new Set(input.summaryEntityIds ?? grants.map((g) => g.entityId))]
      const modules = [...new Set(input.summaryModules ?? grants.map((g) => g.module))]
      for (const entityId of entityIds) {
        await tx.execute(sql`
          INSERT INTO user_entity_access (user_id, entity_id, granted_by)
          VALUES (${input.userId}::uuid, ${entityId}::uuid, ${input.actor})`)
      }
      for (const seat of modules) {
        await tx.execute(sql`
          INSERT INTO user_module_access (user_id, module, granted_by)
          VALUES (${input.userId}::uuid, ${seat}, ${input.actor})`)
      }
      for (const grant of grants) {
        await tx.execute(sql`
          INSERT INTO user_entity_module_access (user_id, entity_id, module, granted_by)
          VALUES (${input.userId}::uuid, ${grant.entityId}::uuid, ${grant.module}, ${input.actor})`)
      }
      if (input.webdavEnabled !== undefined) {
        await tx.execute(sql`
          UPDATE app_user SET webdav_enabled = ${input.webdavEnabled}, updated_at = now()
           WHERE id = ${input.userId}::uuid`)
        // Credentials from before this opt-in existed must not revive when
        // the first grant turns it on; a later re-grant likewise starts fresh.
        if (!person.webdav_enabled || !input.webdavEnabled) await tx.execute(sql`
          UPDATE webdav_credential SET revoked_at = now()
           WHERE user_id = ${input.userId}::uuid AND revoked_at IS NULL`)
      }
      // Losing the last attachment seat in a company ends that company's
      // password. Regranting a seat must not resurrect an old Finder login.
      await tx.execute(sql`
        UPDATE webdav_credential c SET revoked_at = now()
         WHERE c.user_id = ${input.userId}::uuid AND c.revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_entity_module_access g
              WHERE g.user_id = c.user_id AND g.entity_id = c.entity_id
                AND g.module IN ('/entries', '/invoices', '/records')
           )`)
      await auditRow(tx, {
        actor: input.actor, action: 'set_grants', table: 'app_user', recordId: input.userId,
        before: {
          entities: [...hadEntities].sort(),
          modules: [...hadModules].sort(),
          grants: had.map((r) => `${r.entity_id}|${r.module}`),
          webdavEnabled: person.webdav_enabled,
        },
        after: {
          entities: [...entityIds].sort(), modules: [...modules].sort(),
          grants: grants.map((g) => `${g.entityId}|${g.module}`).sort(),
          webdavEnabled: input.webdavEnabled ?? person.webdav_enabled,
        },
        // Access is a shared/system decision. Keep every affected company id
        // in the event without pretending a multi-company change belongs to
        // one arbitrarily chosen company.
        scope: 'shared',
        context: {
          affectedEntityIds: [...new Set([
            ...hadEntities, ...entityIds,
          ])].sort(),
          reason: input.reason?.trim() || undefined,
        },
        reason: input.reason,
      })
    })
  } catch (e) {
    if (causesOf(e).includes('NO_COMPANY_YET')) {
      throw new AccessError('NO_COMPANY_YET',
        'Give this person at least one company as well. A module they cannot '
        + 'reach any books through does nothing.')
    }
    throw e
  }
}

/** Owners have no company matrix; their WebDAV choice is saved on its own. */
export async function setWebDavAccess(input: {
  userId: string; enabled: boolean; actor: string; reason: string
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [person] = await tx.execute<{ webdav_enabled: boolean }>(sql`
      SELECT webdav_enabled FROM app_user WHERE id = ${input.userId}::uuid FOR UPDATE`)
    if (!person) throw new AccessError('NO_SUCH_USER', 'There is no such person.')
    await tx.execute(sql`
      UPDATE app_user SET webdav_enabled = ${input.enabled}, updated_at = now()
       WHERE id = ${input.userId}::uuid`)
    if (!person.webdav_enabled || !input.enabled) await tx.execute(sql`
      UPDATE webdav_credential SET revoked_at = now()
       WHERE user_id = ${input.userId}::uuid AND revoked_at IS NULL`)
    await auditRow(tx, {
      actor: input.actor, action: 'set_webdav_access', table: 'app_user', recordId: input.userId,
      before: { webdavEnabled: person.webdav_enabled },
      after: { webdavEnabled: input.enabled },
      scope: 'shared', reason: input.reason,
      context: { reason: input.reason },
    })
  })
}
