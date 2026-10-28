# Mutation runs

Newly executed against Next16.4.3 release candidate `2c23aa0e3c44b3db26be45ad17cdda1ddf2a85ebce6bca928af324bd0d071d4f`. Disjoint selected ranges1–200,201–400,401–590,591–780,781–945 cover945 scenarios and948 suite calls. Only each selected fresh range is counted; retained historical blocks outside it are excluded. All five execution receipts prove source restoration. 942 scenarios detect the intended defect; three explicitly harmless controls must stay green. Full hashes and exact commands are in the current release ledger.

## The accounts are written in their own transaction

`marker 1`

`registerTax` calls `importAccounts` instead of `importAccountsCore` — the
pre-extraction shape, two transactions, which is what the extraction was for.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R34 a registration that fails AFTER writing accounts writes neither half  blocked, RACE, 9 accounts, 2 tagged
=== 1 CHECK(S) FAILED ===
```

## The same, on a machine under load

`marker 2`

An 800ms delay at the top of `registerTax` as well. This is how the check
before this one passed while testing nothing: the delay let the guard catch the
conflict before any account was written.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R34 a registration that fails AFTER writing accounts writes neither half  blocked, RACE, 9 accounts, 2 tagged
=== 1 CHECK(S) FAILED ===
```

## The delay alone, transaction intact

`marker 3`

The pair to the run above. A check that goes red under load whatever the code
does is noise; this one has to stay silent. The mutation is asserted present
before the run and the expected line asserted after it — green from a real
mutation and green from a mutation that failed to apply look identical.

```
$ db:verify-registrations | npm run db:verify-registrations
=== ALL CHECKS PASSED ===
```

## Registration decided by the two ends of the range

`marker 4`

Only registrations covering `from` or `to` count, as the first version did.
A company registered for the whole of February disappears.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R28 a registration inside the period is not "never registered"  {"coverage":"none","reg":null,"review":["This company is not registered for GST/HST for this period","1 entry carries tax from outside the registered period","3 periods are still open in this range"]}
=== 1 CHECK(S) FAILED ===
```

## The outside-registration check runs only for registered companies

`marker 5`

Where it sat originally: inside the `else` branch. A company that never
registered is told it never registered, and never shown the tax it charged.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R30 an unregistered company with tax in the books is told  ["This company is not registered for GST/HST for this period","3 periods are still open in this range"]
=== 1 CHECK(S) FAILED ===
```

## The return assumes everyone is registered

`marker 6`

Coverage hardcoded. An unregistered company gets a page of zeroes reading as
"no tax this quarter".

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R14 an unregistered company gets "no return", not zeroes  ["No account carries the \"GST/HST recoverable\" role","3 periods are still open in this range"]
FAIL  R17 a period starting before the registration date is named  ["1 entry carries tax from outside the registered period","3 periods are still open in this range"]
FAIL  R28 a registration inside the period is not "never registered"  {"coverage":"all","reg":{"number":"777888999RT0001","registeredOn":"2026-02-01","ceasedOn":"2026-02-28"},"review":["1 entry carries tax from outside the registered period","3 periods are still open in this range"]}
FAIL  R30 an unregistered company with tax in the books is told  ["1 entry carries tax from outside the registered period","No account carries the \"GST/HST recoverable\" role","3 periods are still open in this range"]
=== 4 CHECK(S) FAILED ===
```

## PST treated as recoverable

`marker 7`

BC, SK and MB get a "PST Recoverable" account — an asset that should never
carry a balance, holding a claim against a government that will not pay it.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R2 BC has GST and PST, and PST is not recoverable       [{"tax":"GST_HST","label":"GST","recoverable":true},{"tax":"PST","label":"PST","recoverable":true,"note":"PST paid on purchases is generally a cost here, not something you claim back — so there is no \"recoverable\" account to create."}]
FAIL  R7 BC PST proposes a payable and nothing to reclaim     [{"code":"2681","name":"PST Payable","accountType":"liability","role":"qst_pst_payable","why":"The PST you charge customers, owed to the tax authority until you remit it."},{"code":"1483","name":"PST Recoverable","accountType":"asset","role":"qst_pst_recoverable","why":"The PST you pay on purchases, which you claim back on the return."}]
=== 2 CHECK(S) FAILED ===
```

## Coverage off by one day at the end of the range

`marker 8`

Registration dates are inclusive at both ends, so a registration ending on the
last day of the period covers it. `end >= to` becomes `end > to`.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R36 coverage is exact at the edges                      ends exactly on the last day: wanted all, got part; a single day, covered: wanted all, got part
=== 1 CHECK(S) FAILED ===
```

## Coverage trusts the order it is handed

`marker 9`

The defensive sort dropped. The caller that matters orders by
`registered_on`, so this would have waited for the second caller.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R36 coverage is exact at the edges                      handed to it out of order: wanted all, got part
=== 1 CHECK(S) FAILED ===
```

## Coverage calls a range it covers none of "part"

`marker 10`

The filter for registrations that touch the range at all, removed. A list
holding only other years' registrations answers "registered for some of this
quarter" about a quarter it covered not one day of.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R36 coverage is exact at the edges                      a single day, ended the day before: wanted none, got part; ended before the range began: wanted none, got part; starts after the range ends: wanted none, got part
=== 1 CHECK(S) FAILED ===
```

## Ending a registration can run into the next one

`marker 11`

`ceaseTax`'s overlap guard removed, leaving the EXCLUDE constraint to refuse
it as a `RACE` the guard should have caught first.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R37 an end date running into the next registration is refused  RACE
=== 1 CHECK(S) FAILED ===
```

## Correcting an end date does nothing

`marker 12`

`ceaseTax`'s UPDATE becomes a no-op on a registration that already has an end
date. Re-ceasing is allowed precisely so a mistyped date can be corrected, and
the first version of that check re-ceased to the date the row already held — so
this mutation left all 38 green.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R38 a corrected end date is accepted and written        null, ceased 2026-02-28
FAIL  R39 correcting an end date leaves a trail               [{"actor":"alicio (browser)","before":{"ceased_on":null},"after":{"ceased_on":"2026-02-28"}}]
=== 2 CHECK(S) FAILED ===
```

## db:migrate imports the module that swaps in the test database

`marker 13`

The original defect: the migrator silently targets the test database and
reports success. Checked by `npm run db:check-migrations`.

```
$ db:check-migrations | npm run db:check-migrations
FAIL  M3 db:migrate targets the application database        Migrating figtree_011p_mutation_test ... (dry run — nothing will be applied)
=== 1 CHECK(S) FAILED ===
```

## 0015 reverted — one role read as one tax

`marker 14`

`qst_pst_payable` LIKE 'qst%' is always true, so a BC company's PST looks for
a QST registration that cannot exist. Applied to the test database rather than
to the migration file, which is append-only.

```
$ db:verify-registrations | npx tsx scripts/verify-registrations.ts
FAIL  R19 PST from a PST-registered company is not a false alarm  [{"entry_no":"JE-00001"}]
=== 1 CHECK(S) FAILED ===
```

## A form handler hardcodes who did it

`marker 15`

One of the two tax handlers stops passing the actor it was given and writes a
literal instead. Everything still works and the audit log is still populated —
with a string that is the same for everybody, which is the state 0053 exists to
end. This block used to assert the OPPOSITE: before 0053 the handlers were
required to pass the named constant WEB_ACTOR, because the audit could record
only which surface a change came through. R40 now requires the person.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R40 the web layer passes the person it was given, not a literal  a hardcoded actor remains
FAIL  R43 the cease form ends the registration it names       ok, ceased 2026-09-30 by web
=== 2 CHECK(S) FAILED ===
```

## The audit records something that is not a person

`marker 16`

What goes into the audit log's actor column stops being the signed-in
person's email and
becomes a constant. The row still has an actor and still looks populated, and
it has stopped telling two people apart -- which is the whole of what 0053
buys, and what 0016 bought before it at the level of telling the browser from
a script.

This block used to mutate WEB_ACTOR to the Postgres role, back when the audit
could only record which SURFACE a change came through. That constant is retired
and nothing writes it, so the old mutation changed nothing observable and
db:toothless caught the block turning nothing red -- which is what that check
is for.

```
$ db:verify-users | npm run db:verify-users
FAIL  US13 the trail records a person, not a surface              the bookkeeper's row was created by alicio
FAIL  US31 a deleted person takes their sessions and grants, the trail names the deleter, and every row they wrote still names them  account and session gone; 0 grant rows left; 0 delete_user rows by owner@example.test; 2 set_kind rows; created_by still "alicio"
FAIL  US34 changing a password writes who did it and how many sessions it ended, never the password  alicio ended 2 session(s) for pat@x.test; 0 live
FAIL  US35 every change of grants writes what they had and what they have now  1: 0→1 module(s); 2: 1→0; by alicio
=== 4 CHECK(S) FAILED ===
```

## The form spells its own field name

`marker 17`

`name={F.ceasedOn}` becomes a literal that no longer matches what the
handler reads. This broke every cease from the browser with all 41 checks and
`tsc` green, because nothing rendered the page or submitted the form.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R44 the form spells no field name of its own            name="endedOn"
FAIL  R51 every field the handlers read is inside the form    cease.ceasedOn
FAIL  R57 each cease form ends the registration on its own card  [{"ledgerId":"LEDGER","registrationId":"REG-GST","endedOn":"2026-06-15"},{"ledgerId":"LEDGER","registrationId":"REG-PST","endedOn":"2026-06-15"},{"ledgerId":"LEDGER","registrationId":"REG-QST","endedOn":"2025-12-31"}]
=== 3 CHECK(S) FAILED ===
```

## The handler reads a field the form does not post

`marker 18`

The other direction: the form is unchanged and the handler asks for a name
nobody sends. The cease silently becomes a BAD_DATE refusal.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R43 the cease form ends the registration it names       The date you stopped being registered must be a date., ceased null by null
FAIL  R64 a registration entered wrong is corrected or deleted, never into another, and the trail keeps it  corrected: Saved: 123456789RT0001, from 2024-02-01, still registered. Documents printed from now on carry the new number, including reprints of ones already sent. → 123456789RT0001 from 2024-02-01; into the earlier one: Registration 111111111RT0001 runs from 2023-01-01 to 2023-12-31; these dates would share days with it.; un-ending the earlier one: Registration 123456789RT0001 runs from 2024-02-01; these dates would share days with it.; its end moved: 2023-11-30; deleted: Deleted the registration 111111111RT0001. Its accounts stay, with anything posted to them. (gone, accounts 9 → 9); trail correct_tax_registration, delete_tax_registration; the page offers both doors for its own registration; with a sale posted under it — delete: 123456789RT0001 has 1 posted tax line, the first dated 2026-; start past the sale: osted tax line now falls outside it — the return will list it as outside the registration.; renumbered: Saved: 123456789RT0002, from 2024-02-01, still registered. D; End before the sale: The date you stopped being registered must be a date.; after it: The date you stopped being registered must be a date.; corrected back before it: The date you stopped being registered must be a date. (ends null); cleared then ended before it: The date you stopped being registered must be a date. (ends never); a zero-rated invoice: 222222222RT0001 has 1 posted sales invoice, the fi; ended before it: The date you stopped being registered must be a date.; a supplier's bill alone: deleted
=== 2 CHECK(S) FAILED ===
```

## Today is the UTC day again

`marker 19`

`localToday` goes back to `toISOString().slice(0, 10)`. On this machine
that is tomorrow's date from 17:00 every evening, so a registration ended
effective today reads as already ended — and a check written against
`new Date()` would have passed all morning.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R45 the day is the local day, not the UTC day           both say 2026-08-23 at an instant chosen to separate them
FAIL  R50 the calendar parts are the local ones               partsOf says 2026-08-22, dayIn says 2026-08-23, UTC says 2026-08-23
=== 2 CHECK(S) FAILED ===
```

## The day is formatted for a different country

`marker 20`

`en-CA` becomes `en-US`, so today is `8/22/2026`. It is still not the
UTC day, so a check that only asks "local, not UTC" is satisfied — while
every date comparison against it silently fails and every default date is
refused.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R45 the day is the local day, not the UTC day           "8/22/2026" is not a YYYY-MM-DD date
FAIL  R50 the calendar parts are the local ones               partsOf says 2026-08-22, dayIn says 8/22/2026, UTC says 2026-08-23
=== 2 CHECK(S) FAILED ===
```

## A page asks the UTC day what today is

`marker 21`

The new-entry date default goes back to `new Date().toISOString()`. This is
where the bug actually shipped — not in the helper, but in a caller that never
used it — and it sat in a feature built weeks earlier until critic found it.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R47 nothing reads the current moment through UTC        src/app/ledger/[ledgerId]/entries/new/NewEntryBody.tsx (on the spot)
=== 1 CHECK(S) FAILED ===
```

## The form spells a field name in braces

`marker 22`

`name={F.ceasedOn}` becomes `name={'ceasedOn'}`. A literal, but not a
double-quoted one — which the first version of this check tested for and this
would have slipped past.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R44 the form spells no field name of its own            name={'ceasedOn'}
=== 1 CHECK(S) FAILED ===
```

## The handler reads only the first row

`marker 23`

`accountRowsFrom` matches `code0`/`name0` alone. Every account after
the first silently keeps its proposed code and name however the form was filled
in.

This block was written as `([01])` and came back EMPTY once the row checks
were rewritten for index alignment — R46 posts index 1, which `[01]` still
matches. Recorded here because an empty block is the finding the header
promises: the mutation had stopped discriminating and only running it said so.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R42 the register form creates the accounts it was given  ok, [{"code":"1066","name":"HST Recoverable","role":"gst_hst_recoverable"},{"code":"2150","name":"HST Collected","role":"gst_hst_payable"}]
FAIL  R46 a row configures the account it was posted against  ok, [{"code":"2680","name":"HST Payable","role":"gst_hst_payable"},{"code":"1066","name":"HST Recoverable","role":"gst_hst_recoverable"}]
FAIL  R54 rows reordered on the way still reach the right accounts  ok, [{"code":"2680","name":"HST Payable","role":"gst_hst_payable"},{"code":"1888","name":"What I Reclaim","role":"gst_hst_recoverable"}]
FAIL  R49 what the form renders is what the handler creates   ok, [{"code":"1066","name":"HST Recoverable","role":"gst_hst_recoverable"},{"code":"2777","name":"Tax I Owe","role":"gst_hst_payable"}]
=== 4 CHECK(S) FAILED ===
```

## 0016 reverted — the audit names the database role

`marker 24`

`log_tax_registration()` records a bare `current_user` when a registration
ends, instead of `COALESCE(NEW.ceased_by, current_user)`. On this machine the
Postgres role and the owner's name are both `alicio`, so the check that names
who ended a registration passed with this whole fix reverted until it was made
to compare the two.

```
$ db:verify-registrations | npx tsx scripts/verify-registrations.ts
FAIL  R25 the audit names who ended a registration            role "ft_release", actors ft_release ft_release
FAIL  R39 correcting an end date leaves a trail               [{"actor":"ft_release","before":{"ceased_on":null},"after":{"ceased_on":"2026-02-28"}},{"actor":"ft_release","before":{"ceased_on":"2026-02-28"},"after":{"ceased_on":"2026-02-27"}}]
FAIL  R41 the audit records the person the caller named       ft_release against role ft_release
FAIL  R62 every audit row this suite wrote names a person, not the database role  cease_tax_registration ×14 name the database role
=== 4 CHECK(S) FAILED ===
```

## The code box posts under the name field

`marker 25`

One token in `AccountRow`: `name={F[f.key](index)}` becomes
`name={F.name(index)}`. Both boxes then post as `name<i>`, no code arrives,
and `registerTax` falls back to its proposed defaults — so the accounts are
created with the owner's names and the system's codes, and it reports success.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R48 each box posts under its own field, at its own row  rendered {"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"","registeredOn":"2026-01-01","role0":"gst_hst_payable","name0":"RN0","role1":"gst_hst_recoverable","name1":"RN1"}
FAIL  R54 rows reordered on the way still reach the right accounts  ok, [{"code":"2680","name":"What I Owe","role":"gst_hst_payable"},{"code":"1066","name":"What I Reclaim","role":"gst_hst_recoverable"}]
FAIL  R51 every field the handlers read is inside the form    register.code0
FAIL  R49 what the form renders is what the handler creates   ok, [{"code":"1066","name":"Tax I Reclaim","role":"gst_hst_recoverable"},{"code":"2680","name":"Tax I Owe","role":"gst_hst_payable"}]
=== 4 CHECK(S) FAILED ===
```

## A box starts with the other field's value

`marker 26`

The other direction: the name a box posts under and the value it starts with
come from the same word, so binding one of them to the wrong field has to be
caught too.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R48 each box posts under its own field, at its own row  rendered {"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"","registeredOn":"2026-01-01","role0":"gst_hst_payable","code0":"RN0","name0":"RN0","role1":"gst_hst_recoverable","code1":"RN1","name1":"RN1"}
FAIL  R54 rows reordered on the way still reach the right accounts  ok, [{"code":"What I Owe","name":"What I Owe","role":"gst_hst_payable"},{"code":"What I Reclaim","name":"What I Reclaim","role":"gst_hst_recoverable"}]
FAIL  R49 what the form renders is what the handler creates   ok, [{"code":"Tax I Owe","name":"Tax I Owe","role":"gst_hst_payable"},{"code":"Tax I Reclaim","name":"Tax I Reclaim","role":"gst_hst_recoverable"}]
=== 3 CHECK(S) FAILED ===
```

## Account rows are compacted instead of kept in place

`marker 27`

`accountRowsFrom` drops the holes. A form posting only the second row then
puts that row's code and name on the FIRST account — the recoverable code onto
the payable — and reports success.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R46 a row configures the account it was posted against  ok, [{"code":"1999","name":"Reclaimable Tax","role":"gst_hst_payable"},{"code":"1066","name":"HST Recoverable","role":"gst_hst_recoverable"}]
=== 1 CHECK(S) FAILED ===
```

## A parameter defaulted to now is read through UTC

`marker 28`

`filingPeriods` goes back to `getUTCFullYear()`. On the evening of
31 December it lists the quarters of a year that has not started, without the
one being filed. The first version of this check scanned for a single idiom and
would not have seen it.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R47 nothing reads the current moment through UTC        src/lib/tax.ts (via today)
=== 1 CHECK(S) FAILED ===
```

## The calendar parts come from the UTC clock

`marker 29`

`partsOf` reverts to `getUTCFullYear`/`getUTCMonth`/`getUTCDate`,
putting `filingPeriods` and `currentYearEnd` back on the UTC clock. This
helper had no check of its own: R47 looks for the current moment being read
through UTC, and `partsOf` takes its instant as an argument, so neither of
its shapes matched. Reverting it left every suite green.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R50 the calendar parts are the local ones               partsOf says 2026-08-23, dayIn says 2026-08-22, UTC says 2026-08-23
=== 1 CHECK(S) FAILED ===
$ db:verify-tax | npm run db:verify-tax
FAIL  G13 the quarters on New Year's Eve are the year being filed  wanted 2026, got Q1 2027 Q2 2027 Q3 2027 Q4 2027 2027 2026 Q1 2026 Q2 2026 Q3 2026 Q4 2026
=== 1 CHECK(S) FAILED ===
$ db:verify-setup | npm run db:verify-setup
FAIL  S19 the year end on New Year's Eve is this year's   wanted 2026-12-31, got 2027-12-31
=== 1 CHECK(S) FAILED ===
```

## The row list numbers its rows from one

`marker 30`

`index={i}` becomes `index={i + 1}` in `AccountRows`. Every row is
posted against the NEXT account: the payable code and name land on the
recoverable, the payable is created from the system default, and the success
message names the swapped pair as if it were right. One character.

This block first came back EMPTY: `edit` replaced the first occurrence of
`index={i}`, which is in the doc comment above the JSX explaining this very
defect. It changed a sentence, left the code untouched, and recorded green.
`edit` now refuses a search string that appears more than once.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R48 each box posts under its own field, at its own row  rendered {"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"","registeredOn":"2026-01-01","role1":"gst_hst_payable","code1":"RC0","name1":"RN0","role2":"gst_hst_recoverable","code2":"RC1","name2":"RN1"}
FAIL  R51 every field the handlers read is inside the form    register.code0 register.name0
FAIL  R59 each register form posts the tax it is headed with  [{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"11RT","registeredOn":"2026-01-01","role1":"gst_hst_payable","code1":"2100","name1":"GST Payable"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"PST","number":"PST-2","registeredOn":"2026-02-01","role1":"qst_pst_payable","code1":"2200","name1":"PST Payable"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"","registeredOn":"2026-06-15","role1":"gst_hst_payable","code1":"2100","name1":"GST Payable"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"PST","number":"","registeredOn":"2026-06-15","role1":"qst_pst_payable","code1":"2200","name1":"PST Payable"}]
=== 3 CHECK(S) FAILED ===
```

## The account rows are left out of the form

`marker 31`

`<AccountRows/>` is removed from inside `<form>`. No `code<i>` or
`name<i>` reaches the submission, `accountRowsFrom` returns nothing, and
`registerTax` falls back to its proposal for every field — so both accounts
are created from the system defaults and the owner is told "Registered.
Created …".

The critic's version of this moved the line outside the `</form>` rather than
deleting it; the submitted fields, and so the outcome, are the same.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R48 each box posts under its own field, at its own row  rendered {"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"","registeredOn":"2026-01-01"}
FAIL  R54 rows reordered on the way still reach the right accounts  ok, [{"code":"2680","name":"HST Payable","role":"gst_hst_payable"},{"code":"1066","name":"HST Recoverable","role":"gst_hst_recoverable"}]
FAIL  R51 every field the handlers read is inside the form    register.code0 register.name0
FAIL  R49 what the form renders is what the handler creates   ok, [{"code":"1066","name":"HST Recoverable","role":"gst_hst_recoverable"},{"code":"2680","name":"HST Payable","role":"gst_hst_payable"}]
FAIL  R59 each register form posts the tax it is headed with  [{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"11RT","registeredOn":"2026-01-01"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"PST","number":"PST-2","registeredOn":"2026-02-01"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"","registeredOn":"2026-06-15"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"PST","number":"","registeredOn":"2026-06-15"}]
=== 5 CHECK(S) FAILED ===
```

## The proposal is reversed on the way into the list

`marker 32`

`proposed={[...proposed].reverse()}` inside the component R48 renders. R48
asserts each row posts at its own position, so it sees this — the account rows
appear in the wrong order on the page, which is cosmetic in itself but is also
what a genuine mix-up would look like.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R48 each box posts under its own field, at its own row  rendered {"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"","registeredOn":"2026-01-01","role0":"gst_hst_recoverable","code0":"RC1","name0":"RN1","role1":"gst_hst_payable","code1":"RC0","name1":"RN0"}
=== 1 CHECK(S) FAILED ===
```

## openProposals reverses the rows it pairs — harmless, and that is the point

`marker 32b`

The same `.reverse()`, inside the function that pairs each tax with its
accounts. For five rounds this exact mutation, at five different
hops, silently put the owner's payable code on their recoverable account.

Every row now carries its role and the handler matches on that, so the rows
arrive at the right accounts however they were ordered on the way — the two
boxes simply appear in the other order on screen. This block asserts GREEN, and
asserts it positively: green from a real mutation and green from a mutation that
failed to apply look identical.

The block above is the pair. Reordering inside the rendered markup IS caught,
because R48 and R57-R59 render it and assert each row's position; reordering
before it reaches the markup is not caught and no longer needs to be.

(Titled for `openProposals`, which is what it mutates. An earlier version of
this block was named after a page-level hop it never touched — the same
misattribution critic raised twice.)

```
$ db:verify-registrations | npm run db:verify-registrations
=== ALL CHECKS PASSED ===
```

## A hidden input is dropped

`marker 33`

The `entityId` field is removed. Nothing covered the hidden inputs until the
whole form was rendered — they carry which company is registering, and the
handler reads one the form no longer sends.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R51 every field the handlers read is inside the form    register.entityId
=== 1 CHECK(S) FAILED ===
```

## The role stops travelling with the row

`marker 34`

The hidden `role<i>` input is removed, so the handler has nothing to match
on and falls back to position — which is what made the previous five rounds of
reordering defects possible. With the proposal reversed, the owner's payable
code lands on their recoverable account.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R54 rows reordered on the way still reach the right accounts  ok, [{"code":"1888","name":"What I Reclaim","role":"gst_hst_payable"},{"code":"2888","name":"What I Owe","role":"gst_hst_recoverable"}]
FAIL  R59 each register form posts the tax it is headed with  [{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"11RT","registeredOn":"2026-01-01","code0":"2100","name0":"GST Payable"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"PST","number":"PST-2","registeredOn":"2026-02-01","code0":"2200","name0":"PST Payable"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"","registeredOn":"2026-06-15","code0":"2100","name0":"GST Payable"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"PST","number":"","registeredOn":"2026-06-15","code0":"2200","name0":"PST Payable"}]
=== 2 CHECK(S) FAILED ===
```

## registrationView stops asking whether a registration is live

`marker 35`

Its filter drops `.active`, so a company that has ever
ceased a registration can never register again: the form disappears and the page
announces it is registered for every tax that applies.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R52 the page shows the form each registration needs     a ceased registration re-opens the form
=== 1 CHECK(S) FAILED ===
```

## registrationView starts every cease form on today

`marker 36`

`defaultDate` becomes `today` for every registration. One that has not
started yet is handed a date its own guard refuses, and one with a recorded end
date silently rewrites it on save.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R52 the page shows the form each registration needs     an ended one is badged and offers a correction; one ending later is live and offers a change; one not started yet is badged and defaults to its start date
=== 1 CHECK(S) FAILED ===
```

## The page substitutes its own date at the call site

`marker 38`

`row={{ ...row, defaultDate: today }}` where the page hands the decided row
to the cease form.

This is where critic found the defect, and the previous round recorded it as
caught after moving it into `registrationView` — which is a different line in
a different file. The page-level form of it went on passing. Both shapes are
covered now: replacing a prop, and rebuilding the object around it.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R55 each form is bound to its own action, and the body is rendered  row rebuilt at the call site
FAIL  R57 each cease form ends the registration on its own card  [{"ledgerId":"LEDGER","registrationId":"REG-GST","ceasedOn":"2026-06-15"},{"ledgerId":"LEDGER","registrationId":"REG-PST","ceasedOn":"2026-06-15"},{"ledgerId":"LEDGER","registrationId":"REG-QST","ceasedOn":"2026-06-15"}]
=== 2 CHECK(S) FAILED ===
```

## One tax is offered another tax's accounts

`marker 39`

`proposedAccounts(entityId, open[0].tax)`. In BC, SK, MB or QC the second
form gets the first tax's accounts: code 2100, name "GST Payable", role
`gst_hst_payable` — while the form still posts `tax=PST`.

This was recorded as a GREEN block in the previous round, on the reasoning that
`registerTax` refuses the mismatch so nothing wrong is created. Critic was
right that this is not survival: every submission of the provincial form is
refused, so provincial registration becomes impossible and "Reload the page and
try again" loops forever. The pairing now has a check of its own.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R60 each open tax is offered its own accounts           [{"tax":"GST_HST","roles":["gst_hst_payable","gst_hst_recoverable"]},{"tax":"PST","roles":["gst_hst_payable","gst_hst_recoverable"]}]
=== 1 CHECK(S) FAILED ===
```

## Every cease form ends the first registration

`marker 40`

`row={view.rows[0]}` — one identifier, no object rebuilt, every type
agreeing. Pressing the button under the PST card ends the GST registration.

This is the shape no check over the source can reach, and it passed 56 checks.
The page's body is rendered now, so what each form would submit is read back
instead of inferred.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R57 each cease form ends the registration on its own card  [{"ledgerId":"LEDGER","registrationId":"REG-GST","ceasedOn":"2026-06-15"},{"ledgerId":"LEDGER","registrationId":"REG-GST","ceasedOn":"2026-06-15"},{"ledgerId":"LEDGER","registrationId":"REG-GST","ceasedOn":"2026-06-15"}]
=== 1 CHECK(S) FAILED ===
```

## Every register form registers the first tax

`marker 41`

`proposal={proposals[0]}`. The same substitution on the register side: the
section headed "Register for PST" posts `tax=GST_HST` with the GST
accounts, so provincial registration is unreachable.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R59 each register form posts the tax it is headed with  [{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"11RT","registeredOn":"2026-01-01","role0":"gst_hst_payable","code0":"2100","name0":"GST Payable"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"PST","number":"PST-2","registeredOn":"2026-02-01","role0":"qst_pst_payable","code0":"2200","name0":"PST Payable"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"","registeredOn":"2026-06-15","role0":"gst_hst_payable","code0":"2100","name0":"GST Payable"},{"ledgerId":"LEDGER","entityId":"ENTITY","tax":"GST_HST","number":"","registeredOn":"2026-06-15","role0":"gst_hst_payable","code0":"2100","name0":"GST Payable"}]
=== 1 CHECK(S) FAILED ===
```

## A cease button is labelled from the wrong row

`marker 42`

The submit label takes its tax from `view.rows[0]` instead of its own row,
so two live registrations both read "End the GST/HST registration" and the
owner cannot tell which button ends which.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R58 each cease form is labelled for its own registration  ["End the GST/HST registration","End the GST/HST registration","Save the corrected date"]
=== 1 CHECK(S) FAILED ===
```

## A handler body goes missing from the field scan

`marker 43`

`ceaseTaxFromForm` becomes an unexported function re-exported by const, so
the check's body-slicing finds nothing for it. The per-side minimum it replaced
let this pass: the cease side needs only one read, and the action supplies it.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R40 the web layer passes the person it was given, not a literal  1 handler(s) do not
FAIL  R51 every field the handlers read is inside the form    the scan found no field reads in ceaseTaxFromForm
=== 2 CHECK(S) FAILED ===
```

## The two forms are bound to each other's actions

`marker 44`

`registerAction={ceaseTaxAction} ceaseAction={registerTaxAction}` — one
identifier each. The handlers read disjoint sets of fields, so every button on
the page submits nothing its handler reads and both registering and ceasing
become impossible. Sixty checks passed.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R55 each form is bound to its own action, and the body is rendered  missing: the register forms post to registerTaxAction; missing: the cease forms post to ceaseTaxAction
=== 1 CHECK(S) FAILED ===
```

## The page renders no body at all

`marker 45`

The element renamed, so the page renders nothing. Every form disappears and
sixty checks stayed green, because the checks rendered that component directly
and nothing rendered the page.

The first version of this block came back EMPTY: the check tested
`includes('<RegistrationSections')` and the mutation renamed the element to
`<RegistrationSectionsREMOVED`, which contains it. A check matching more
loosely than the thing it checks — the subject of this whole loop, found once
more in the check written to end it.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R55 each form is bound to its own action, and the body is rendered  missing: the page renders the body at all
=== 1 CHECK(S) FAILED ===
```

## A reused account is offered for editing anyway

`marker 46`

The branch that shows an existing account as text is disabled, so the form
offers an editable code and name for an account `registerTax` will reuse —
and everything typed there is discarded without a word.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R61 an account that will be reused is shown, not offered for editing  existing marked: true; editable boxes rendered: code0 name0
=== 1 CHECK(S) FAILED ===
```

## Quoted cells are split like plain text

`marker 47`

The branch that keeps a quoted cell together never runs, so the reader becomes
a plain line splitter. A description of "PAYMENT, THANK
YOU" then becomes two columns and every column after it shifts by one.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B01 a quoted comma stays inside one cell              ["a","b","c","d"]
FAIL  B02 and a line splitter disagrees with it here        parser=4, splitter=4
FAIL  B03 a newline inside quotes does not end the row      rows=3
FAIL  B04 and the newline is kept in the cell               "line one"
FAIL  B05 a doubled quote becomes one quote                 say hi
FAIL  B39 headers named Withdrawals and Deposits are read as a pair  date,description,ignore,in,ignore
FAIL  B54 a split file reads cleanly                        2 rows, 1 problems
FAIL  B55 money out is negative and money in is positive    320000 / -8820
FAIL  B56 and the comma inside the description survived     PAYROLL
FAIL  B62 the reported row is the grid row, not the file line  row=undefined, file line would be 4
FAIL  B71 two numeric columns with no header leave the amount unguessed  ignore,amount,date,ignore,description,ignore,ignore
FAIL  B75 and the normalised export re-quotes the comma it kept  2024-01-16,1234567.00,DEPOSIT
FAIL  B81 and choosing it reads all three rows              rows=2
=== 13 CHECK(S) FAILED ===
```

## An ambiguous date column is resolved by picking

`marker 48`

`inferDateOrder` returns the first order that still fits instead of reporting
that several do. This is the defect the whole date layer exists to prevent:
03/04/2024 becomes 4 March, silently, and the row files in the wrong quarter.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B20 all-small days stay ambiguous                     "01/02/2024" only reads as Day first — DD/MM/YYYY.
FAIL  B20a (guard) the verdict is ambiguous, so B21 and B22 can be judged  kind was certain
FAIL  B86 (fixture) one column is decidable and the other is not  certain / certain
=== 3 CHECK(S) FAILED ===
```

## The day is bounded at 31 rather than by the month

`marker 49`

31 February and 29 February 2023 both become real dates. JavaScript's own Date
would roll them forward to 3 March and 1 March, which is why the check is
written out by hand — and why it has to be shown failing.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B25 31 February is refused, not rolled forward        
FAIL  B27 29 February 2023 is not                           
FAIL  B95 invalid calendar days, clocks, offsets, trailing junk and time-only values remain refused  
=== 3 CHECK(S) FAILED ===
```

## Reading rows with no date format chosen

`marker 50`

The guard at the top of `applyMapping` tests for undefined instead of null, so
a null order slips past it into `parseDateWith`, whose last branch is month
first. An unanswered question becomes an American answer.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B61 applying with no date format chosen throws        expected ORDER_UNSET, it returned normally
=== 1 CHECK(S) FAILED ===
```

## A blocked mapping produces rows anyway, defaulting the format

`marker 51`

`screenFor` stops returning null when something is blocking and instead reads
the file with month first.

What fails here is the library handing rows to a screen that should have had
none. A person would see the same page either way, because `ImportPreview`
returns on the first error before rendering a row — an earlier version of this
block claimed the screen fills with a tidy table of rows, and it does not.
Two independent guards; this shows the first one gone.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B76 an unanswered date format blocks the screen itself  notice=true results=false
FAIL  B80 an unambiguous file blocks until the format is chosen  notice=true results=false
FAIL  B100 the Time column reaches the UI as Date, while the existing format confirmation still applies  
=== 3 CHECK(S) FAILED ===
```

## The screen is handed no problems to show

`marker 52`

`ImportScreen` passes an empty list to the preview. Everything underneath
still works and still refuses to produce rows — but the person looking at the
screen is told nothing about why it is empty.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B76 an unanswered date format blocks the screen itself  notice=false results=false
FAIL  B80 an unambiguous file blocks until the format is chosen  notice=false results=false
FAIL  B92 and moving the date to another column asks again  notice=false order=null
FAIL  B100 the Time column reaches the UI as Date, while the existing format confirmation still applies  
=== 4 CHECK(S) FAILED ===
```

## Two rejections are given the same sentence

`marker 53`

The message for two Money in columns is changed to say Money out, so it is now
word for word the message for two Money out columns. Every check that a
particular rejection fires still passes — only the one asking whether they are
distinguishable can see it. This is the defect shape this repository keeps
finding, written out on purpose.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B46 and no two rejections say the same thing          8 distinct of 9
=== 1 CHECK(S) FAILED ===
```

## A signed column beside a Money out column is allowed

`marker 54`

The guard against mapping both shapes at once never fires, so a file with an
Amount column and a Withdrawals column counts every withdrawal twice.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B45 AMOUNT_AND_PAIR is caught                         got 
=== 1 CHECK(S) FAILED ===
```

## A headerless file loses its first transaction

`marker 55`

`findHeaderRow` returns 0 rather than null when the first row is already data,
so the first transaction in an RBC export is read as the column names and never
appears again.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B15 a headerless file reports no header               0
FAIL  B69 a headerless file is read end to end, format still unchosen  order=null
FAIL  B73 and every row reads                               2 rows, 0 problems
FAIL  B74 and 2/01/2024 is 1 February, not 2 January        2024-01-16 … undefined
=== 4 CHECK(S) FAILED ===
```

## Every file is assumed to be comma separated

`marker 56`

The delimiter sniffer never accepts a better candidate, so a tab or semicolon
export parses as one wide column per row.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B10 a tab file sniffs as tab                          
FAIL  B11 a semicolon file sniffs as semicolon              
=== 2 CHECK(S) FAILED ===
```

## Accounting brackets are read as positive

`marker 57`

(1,234.56) becomes a deposit of 1,234.56 rather than a withdrawal. The sign is
the whole meaning of the row.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B34 accounting brackets are negative                  123456
=== 1 CHECK(S) FAILED ===
```

## The description is guessed as the first text column

`marker 58`

Instead of the column whose values vary, which in a headerless export means
the account type — "Chequing" on every row, describing nothing.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B72 and the varying column is the description, not the repeated one  description,ignore,date,ignore,ignore,ignore,ignore
FAIL  B75 and the normalised export re-quotes the comma it kept  2024-01-16,3200.00,Chequing
=== 2 CHECK(S) FAILED ===
```

## The software chooses the date format after all

`marker 59`

`guessMapping` fills the format in whenever exactly one reading fits the
first 200 rows — which is what it used to do, and what it was changed to stop
doing. The screen then goes straight to a table of rows without ever asking,
and a file whose later rows read the other way is silently American.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B40b and the format is still left for the user to choose  ymd
FAIL  B69 a headerless file is read end to end, format still unchosen  order=mdy
FAIL  B80 an unambiguous file blocks until the format is chosen  notice=false results=true
FAIL  B80b and the reason given is the unset format         
FAIL  B100 the Time column reaches the UI as Date, while the existing format confirmation still applies  
=== 5 CHECK(S) FAILED ===
```

## A running balance is offered as the amount

`marker 60`

The exclusion that keeps a Balance column out of the amount guess is removed.
In a file whose amount column is not called "Amount", the balance is then a
second candidate of the same shape — and the guess either takes it or gives up.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B42 a Balance column does not stop the amount being found  date,description,ignore,ignore
=== 1 CHECK(S) FAILED ===
```

## The date format is decided from a sample of the column

`marker 61`

`profileColumns` keeps the cheap probe's verdict instead of scanning the whole
column. A file whose first 200 rows are unambiguously day-first and whose 201st
can only be month-first is then called decided, and the disagreement never
surfaces as a conflict.

This was the shipped behaviour until a critic built the file and ran it.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B82 a format change after row 200 is seen             "13/01/2024" only reads as Day first — DD/MM/YYYY.
FAIL  B82b and the offending row is named                   "13/01/2024" only reads as Day first — DD/MM/YYYY.
=== 2 CHECK(S) FAILED ===
```

## The chosen date format survives moving the date column

`marker 62`

`withRole` keeps the order when the date role moves to a different column. The
answer was about the old column; the new one is then read under a format nobody
chose for it, and when it happens to accept that format nothing complains at
all — the rows just come out in the wrong months.

Only visible in a sequence of two actions, which is why the screen check drives
the real handler rather than rendering a single state.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B87 moving the date off a column clears the format    dmy
FAIL  B87b and giving the role to another column clears it too  dmy
FAIL  B92 and moving the date to another column asks again  notice=false order=dmy
=== 3 CHECK(S) FAILED ===
```

## A cell with no digits is read as zero

`marker 63`

The guard in `parseBankAmount` never fires, so a lone currency sign, a lone
minus or an empty pair of brackets strips down to an empty string, which
`parseMoney` reads as zero. The row lands in the middle of the statement as a
0.00 transaction the bank never made, with nothing reported against it.

```
$ db:verify-bank | npm run db:verify-bank
FAIL  B89 a currency sign with no number is refused         expected BAD_AMOUNT, it returned normally
FAIL  B89b and so is a lone minus                           expected BAD_AMOUNT, it returned normally
FAIL  B89c and so are empty brackets                        expected BAD_AMOUNT, it returned normally
FAIL  B90 and the row carrying it is reported, not read as 0.00  3 rows; no problem
=== 4 CHECK(S) FAILED ===
```

## Rows are numbered by their position in the file

`marker 64`

Occurrence becomes the row index, so the same transaction is 1 in one import
and 2 in the next.

Note what the output below actually says: the run ends on `OCCURRENCE_GAP`.
The database refuses this import, because three distinct rows numbered 1, 2, 3
leave 2 and 3 with nothing under them in their own groups. An earlier version of
this block claimed the database catches none of it, directly above the line
showing it catching this — the same shape as 0017's original claim that it
catches all of it. I52, I52b, I52c and I52d hold the halves and the boundary
between them.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  I01 identical rows are numbered within their own group  1,2,3
FAIL  I02 and the biggest number is the biggest group, not the file length  1,2,3,4 over 4 rows whose largest group is 2
FAIL  I03 and the order the file happened to be in does not matter  1,2,3
FAIL  the suite threw before it finished                      OCCURRENCE_GAP: a bank row numbered 2 has no 1 before it (320000 on 2026-01-06)
=== 4 CHECK(S) FAILED ===
```

## The import reports what it sent rather than what landed

`marker 65`

`inserted` counts the rows in the batch instead of the rows the database came
back with, so every import claims to have saved everything and nothing is ever
reported as a duplicate. The rows are still deduplicated correctly — only the
sentence on screen is a lie, which is the harder kind to notice.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  I05 the same file again lands nothing                   3 in, 0 skipped
FAIL  I08 and importing that file again lands neither         0 skipped
FAIL  I09 a later file with one more copy lands exactly one   3 in
FAIL  I10 an overlapping statement lands only what is new     2 in, 0 skipped
FAIL  I11 undescribed rows still deduplicate                  first 2, again 2
FAIL  I54 (known gap) a group split across two imports loses a row  1 landed where the statement had 2
FAIL  I38 a real file read and landed, then landed again with no effect  3 then 3
FAIL  I47 and the second time says how many it skipped        2 rows saved.
=== 8 CHECK(S) FAILED ===
```

## Occurrence numbers may have gaps

`marker 66`

The deferred check never fires, so a row numbered 2 can exist with no 1 before
it — and a hole is what lets a LATER correct import land a duplicate, because
the number it computes is 1 and 1 is free.

The unique constraint is untouched and stays untouched: further down this same
run it refuses the very next insert, which is what ends the suite early here.
The two guards are independent, and an earlier version of this block claimed
disabling one made the other decorative. Its own output said otherwise.

Mutated in 0018, not 0017. Both files contain this function and the search text
is unique in each, so the pre-flight audit is satisfied either way — but 0018
runs later and its `CREATE OR REPLACE` puts the correct version back. Pointed
at 0017 this block turned nothing red, which is how it was noticed.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  I13 a row numbered 2 with no 1 before it is refused     the database allowed it
FAIL  I14 and nothing was left behind                         4 rows
FAIL  the suite threw before it finished                      Failed query: 
=== 3 CHECK(S) FAILED ===
```

## What the bank said can be edited

`marker 67`

The immutability trigger is given a WHEN that never holds. The amount, the date
and the description on a landed row become editable — and editing an amount also
moves the row out from under the deduplication, so the file it came from imports
cleanly all over again.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  I22 the amount on a bank row cannot be changed          the database allowed it
FAIL  I23 nor the date                                        the database allowed it
FAIL  I24 nor the description                                 the database allowed it
FAIL  I25 nor which account it came from                      the database allowed it
FAIL  I37 and the state filter really narrows                 8 unmatched, 1 ignored, 9 in all
=== 5 CHECK(S) FAILED ===
```

## A matched row can be deleted

`marker 68`

The delete guard never runs. Deleting a row that has been reconciled throws
away the only record that it was, and the next import of the same statement
brings it back looking new.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  I27 an ignored row cannot be deleted                    the database allowed it
FAIL  I31 and so is a deletion, with what was deleted         looking for "PAYROLL DEPOSIT" in {"amount": -47500, "txn_date": "2026-01-05", "occurr
FAIL  I37 and the state filter really narrows                 8 unmatched, 1 ignored, 9 in all
=== 3 CHECK(S) FAILED ===
```

## A statement can land in a heading account

`marker 69`

The account check never runs, so rows can be attached to a rollup account that
nothing can be posted to, or to one that has been deactivated.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  I18 a heading account cannot hold a statement           the database allowed it
FAIL  I19 nor can an inactive one                             the database allowed it
FAIL  I49 and a heading account gives a sentence, not a stack trace  no error
=== 3 CHECK(S) FAILED ===
```

## Dollars are accepted where cents are expected

`marker 70`

The wire format stops checking that an amount is whole cents. "12.50" then
reaches `BigInt()`, which throws somewhere with no context — and had it not
thrown, a hundredth of every amount would have landed in the books.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  I41 dollars sent where cents belong are refused         expected BAD_PAYLOAD, got undefined: Cannot convert 12.50 to a BigInt
=== 1 CHECK(S) FAILED ===
```

## A database guard reaches the screen as a stack trace

`marker 71`

`deepMessage` stops walking the error's `cause` — it reads the top message
instead of `causesOf`. Drizzle wraps every driver error as "Failed query", so
none of the named guards below it ever match again and the raw wrapper is what
a person sees. Every guard is still there and still firing; only the sentence
explaining it is gone.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  I49 and a heading account gives a sentence, not a stack trace  it threw instead of answering: Failed query: 
=== 1 CHECK(S) FAILED ===
```

## A statement can be landed in another company's account

`marker 72`

The check that the chosen account belongs to the company whose ledger the form
was submitted from never runs. The dropdown only ever offers this company's
accounts — but the value posted back is a string like any other, and the row
carries no ledger, so nothing downstream would ever notice.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  the suite threw before it finished                      Cannot read properties of undefined (reading 'currency')
=== 1 CHECK(S) FAILED ===
```

## The gapless check goes back on UPDATE

`marker 73`

0019 scoped it to INSERT. Put back on UPDATE it fires on every status change of
a row sitting above a hole — and a hole is what deleting the lower of two
identical rows leaves, which the delete guard permits on purpose.

The row is then permanently unreconcilable: it can never be marked matched or
ignored, and what the person is told is a sentence about re-reading the import
file. The UPDATE arm can never do anything useful: `occurrence` and every other
column this check reads are immutable, so the UPDATE cannot itself change the
answer — it can only re-punish a row for a hole that a permitted DELETE made.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  I53 a row left above a hole can still be updated        OCCURRENCE_GAP: a bank row numbered 2 has no 1 before it (-475 on 2026-05-01)
FAIL  cleanup: un-ignore the survivor                         OCCURRENCE_GAP: a bank row numbered 2 has no 1 before it (-475 on 2026-05-01)
=== 2 CHECK(S) FAILED ===
```

## A match does not have to mean anything

`marker 74`

The sanity trigger never runs, so a bank row can be settled by a draft, by a
reversed entry, by an entry with no line on that account at all, or by one that
moved the account the other way. Every one of those reads as reconciled.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M09 a draft entry cannot settle a bank row                  the database allowed it
FAIL  M10 nor a reversed one                                      expected "ENTRY_NOT_POSTED", got: Failed query: 
FAIL  M12 nor one that moved the account the other way            the database allowed it
FAIL  M17 an ignored row cannot be matched                        the database allowed it
FAIL  M60 and the database refuses it even by hand                the database allowed it
FAIL  M44b and so does one the database refuses                   Matched.
FAIL  M45 the screen shows every row in the state the database says it is in  {"unmatched":6,"part":1,"matched":12}
FAIL  M54 and what the books have unclaimed agrees, computed either way  10895 vs 9200
=== 8 CHECK(S) FAILED ===
```

## A row can be claimed for more than it is

`marker 75`

The bound on a row's own matches is removed. A $42 fee can be settled by a
$90 entry and the row still reports itself accounted for.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M13 a row cannot be matched for more than it is             the database allowed it
FAIL  the suite threw before it finished                          Failed query: 
=== 2 CHECK(S) FAILED ===
```

## One entry can settle every row that looks like it

`marker 76`

The bound on the OTHER side is removed — how much of an entry has already been
claimed. One $500 payment then settles five different $500 deposits, and all
five look reconciled. This is the half that is easy to leave out, because the
row-side bound catches nothing about it.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M16 and the database refuses it as well                     the database allowed it
FAIL  M52 but not into a shape that cannot carry it               the database allowed it
=== 2 CHECK(S) FAILED ===
```

## A reconciled row can be set aside

`marker 77`

Ignoring stops checking whether the row has matches. The row then disappears
from the reconciliation — the state view answers "ignored" first — while its
matches go on claiming parts of entries that nothing can see any more.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M18 and a matched row cannot be ignored                     the database allowed it
FAIL  M20 undoing the match puts the row back                     ignored
FAIL  cleanup: re-match the client deposit                        Failed query: 
FAIL  M45 the screen shows every row in the state the database says it is in  {"unmatched":8,"matched":10,"ignored":1}
=== 4 CHECK(S) FAILED ===
```

## A reconciled row can be deleted

`marker 78`

The delete guard stops looking for matches. Deleting the row leaves the entry
claimed by something that no longer exists, and the next import of the same
statement brings the row back looking new.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M19 a matched row cannot be deleted                         expected "BANK_ROW_MATCHED", got: Failed query: DELETE FROM bank_transaction WHERE id = $1::uuid
=== 1 CHECK(S) FAILED ===
```

## Partly matched and not matched swap places

`marker 79`

The state view's first test is inverted. Rows nothing accounts for report
themselves settled and settled rows report themselves open — the state is
derived rather than stored precisely so there is one place this can be got
wrong, and this is that place.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M01 a landed row starts unmatched                           part, 0 matched
FAIL  M02 matching it to an entry accounts for the whole row      unmatched, 320000 of 320000
FAIL  M03 and the row beside it is untouched                      part
FAIL  M04 a deposit covering more than one invoice is partly matched  unmatched, 200000 left
FAIL  M05 and it is matched once the parts foot to the row        unmatched, 0 left
FAIL  M07 one entry can be settled by two rows                    unmatched / unmatched
FAIL  M14 and matching it for exactly what it is works            unmatched
FAIL  M20 undoing the match puts the row back                     part
FAIL  M24 posting an entry from a row matches it in the same breath  unmatched, entry BNK-00001
FAIL  M27b a bank entry is deleted at the entry door, and the row goes back into the feed  released 1; the row is part; 0 entr(ies) left
FAIL  M31 and the row is left alone when the entry is refused     part
FAIL  M37 the match form matches                                  Matched.
FAIL  M38 and the undo form undoes it                             Match undone.
FAIL  M41 and the un-ignore form puts it back                     Back in play.
FAIL  M43 the post form posts, matches and files its paper        Posted as BNK-00005 and matched. The file is filed against it.
FAIL  M49 and once the match is undone it can be                  reversed, row is part
FAIL  M51 and the row is still accounted for, by the entry that accounts for it  unmatched
FAIL  M56 posting the remainder settles the row                   BNK-00006
FAIL  M57 undoing a different match leaves a different remainder  unmatched, 40000 left
FAIL  M58 and posting again posts THAT remainder rather than replaying the last one  BNK-00007, replayed=false, row is unmatched
FAIL  M79 a row imported by mistake is deleted; one matched or set aside is refused and says what to undo  imported twice: Deleted. Import the right file again if the row belongs elsewhere. (gone, trail alicio@example.test: IMPORTED TWICE); matched: That row settles an entry. Undo the match first.; set aside: That row was set aside on purpose. Put it back first.
FAIL  M37 deleting a matched manual entry releases the match      JE-00023 gone; row back to part; 1 match released
FAIL  M80 equivalent trimmed wording reuses the original posting after unmatching  replayed true; same entry true
=== 23 CHECK(S) FAILED ===
```

## The reconciliation drops its timing difference

`marker 80`

`straddling` becomes zero. A cheque written on the 30th and cleared on the 2nd
is matched, and belongs to a different side of the line on each side — with that
term gone the three explanations no longer add up to the difference, which is
the only thing that made them explanations rather than commentary.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M34 a match spanning the cut-off is named as a timing difference  straddling 0
FAIL  M35 and the identity still holds across it                  196410 = 119805 - -16605 + 0
=== 2 CHECK(S) FAILED ===
```

## Suggestions stop caring which way the money went

`marker 81`

`candidateEntries` drops the sign test, so a row that took $750 out is offered
the entry that put $750 in. Both are the same size and one keystroke apart.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M22 and drafts and wrong-way entries are not suggested at all  6 suggestions
=== 1 CHECK(S) FAILED ===
```

## A match is sized by the row alone

`marker 82`

The default amount stops asking how much of the entry is left and takes the
whole remaining row. Splitting a deposit across two invoices then over-claims
the first one, and the failure arrives at COMMIT from the database rather than
as a sentence.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M03b a match is sized by the smaller of the two remainders  ENTRY_OVER_MATCHED: that entry moved 300000 on this account and 500000 is already claimed agains
FAIL  M04 a deposit covering more than one invoice is partly matched  unmatched, 500000 left
FAIL  the suite threw before it finished                          ENTRY_OVER_MATCHED: that entry moved 200000 on this account and 500000 is already claimed against it
=== 3 CHECK(S) FAILED ===
```

## A database guard reaches the reconcile screen as a stack trace

`marker 83`

`readable` stops translating. Every named guard behind the reconcile forms —
wrong direction, entry already claimed, closed period — arrives as Drizzle's
"Failed query" wrapper instead of a sentence saying what to do about it.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M44b and so does one the database refuses                   it threw instead of answering: Failed query: 
=== 1 CHECK(S) FAILED ===
```

## A reversed entry can go on settling a bank row

`marker 84`

0021's check never runs. Reversing an entry then leaves its match in place: the
row reads accounted for, by an entry that has been unwound.

This is the failure the two amount bounds exist to prevent, reached from the
other side — and nothing in 0020 could see it, because the entry's status was
only ever checked when the match was created.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M48 an entry that settles a bank row cannot be reversed     the database allowed it
FAIL  the suite threw before it finished                          Entry JE-00017 is reversed, not posted.
=== 2 CHECK(S) FAILED ===
```

## Amending a reconciled entry becomes impossible

`marker 85`

`amendEntry` stops carrying the matches across.

Note what 0021 turns this into. Before it, the match stayed on the reversed
original, the replacement was claimed by nothing, and the row could not be
matched to it because it already read as full — silently wrong, and the
correction unreachable. With 0021 the amendment is simply refused: the original
would end up reversed while still settling a bank row, and that is now an
invariant. Refused is the right answer; it is not the same answer as carrying
the match, which is why the carry is still needed.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M63g the amendment M64 inspects went through                it was refused: REVERSED_STILL_MATCHED: entry BNK-00003 settles 1 bank row(s); undo the ma
FAIL  M50 amending an entry carries its match to the replacement  it was refused: REVERSED_STILL_MATCHED: entry JE-00019 settles 1 bank row(s); undo the mat
FAIL  M50g M50 produced a replacement for M52 to amend            it did not
=== 3 CHECK(S) FAILED ===
```

## The reconcile screen's balance stops agreeing with the ledger's

`marker 86`

`books` counts only posted entries, dropping a reversed entry's lines while
keeping the reversal's mirror — wrong by twice the reversed amount. Every other
balance in the system counts both. The screen then prints a figure that
disagrees with the same account's own history page.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M53 the books figure is the account balance the rest of the system uses  1086990 vs 1128095
FAIL  M54 and what the books have unclaimed agrees, computed either way  -31910 vs 9195
=== 2 CHECK(S) FAILED ===
```

## The independent check of the books stops being independent

`marker 87`

The per-entry figure counts different entries from the total it is compared
against, so the two stop agreeing.

It exists because the reconciliation identity cannot fail — substitute the
definitions and the matched totals cancel, so it holds for every input including
wrong ones. This is the half that can.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M54 and what the books have unclaimed agrees, computed either way  9195 vs -31910
=== 1 CHECK(S) FAILED ===
```

## Posting a remainder replays the last entry instead

`marker 88`

The idempotency key goes back to the row rather than the row and the amount, so
a row can only ever carry one generated entry. Post part of it, undo a different
match, and the next post replays the first entry, creates nothing, swallows the
conflicting match — and says the row is settled.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M58 and posting again posts THAT remainder rather than replaying the last one  BNK-00006, replayed=true, row is part
=== 1 CHECK(S) FAILED ===
```

## A ledger can have two opening balances

`marker 89`

The unique index is gone. Two starting positions in one set of books, and no
answer to which one anything is measured from.

```
$ db:verify-opening | npm run db:verify-opening
FAIL  O08 and the database refuses it as well                   expected "one_opening_balance_per_ledger", got: Journal entry 35c2cc57-80d9-441e-95f2-023b4bb41a27 has no lines
=== 1 CHECK(S) FAILED ===
```

## The opening balance can be dated after the entries it opens

`marker 90`

The check that nothing may predate it never fires. Entries go in first, the
starting position is entered after them, and every statement over the gap is
movement measured against a position that did not exist yet.

```
$ db:verify-opening | npm run db:verify-opening
FAIL  O09 an opening balance dated after existing entries is refused  the database allowed it
FAIL  the suite threw before it finished                        These books already have an opening balance — OPN-00001, dated 2026-03-01. Reverse it before entering another.
=== 2 CHECK(S) FAILED ===
```

## A conversion difference is absorbed without a word

`marker 91`

The refusal is removed, so figures that do not balance are simply posted —
whatever `postEntry` makes of them. The whole point of the screen is that the
difference is a number somebody is told; this is what its absence looks like.

```
$ db:verify-opening | npm run db:verify-opening
FAIL  O11 figures that are out are refused, with the amount named  expected OUT_OF_BALANCE, got Error: Failed query: select "id", "entity_id", "code", "name", "foreign_currency", "parent_id", "
FAIL  the suite threw before it finished                        Failed query: select "id", "entity_id", "code", "name", "foreign_currency", "parent_id", "account_type", "norm
=== 2 CHECK(S) FAILED ===
```

## The difference goes in the wrong way round

`marker 92`

The balancing line takes the sign of the difference rather than its opposite,
so it doubles the gap instead of closing it. Caught by the ledger rather than by
this module, which is the arrangement working.

```
$ db:verify-opening | npm run db:verify-opening
FAIL  O12 and once an account is named for it, it goes in and is reported  it was refused: Debits and credits differ by 1200.00. An entry must net to zero.
FAIL  O13 as its own line, saying what it is                    undefined "undefined"
FAIL  O14 and the figures that were given are left exactly as given  undefined
FAIL  O26 and once an account is named, the amount is said out loud  Debits and credits differ by 400.00. An entry must net to zero.
FAIL  O27 a second one through the form is refused with a sentence  no error
=== 5 CHECK(S) FAILED ===
```

## Opening figures are read by position instead of by account

`marker 93`

`linesFrom` numbers the fields it finds rather than reading which account each
one names. Re-render the page in a different order and every balance lands
against the wrong account — the same defect the sales tax round spent six rounds
on, in the one place where getting it wrong is least recoverable.

```
$ db:verify-opening | npm run db:verify-opening
FAIL  O22 amounts follow their account, whatever order the form was in  1000=undefined 1200=undefined 3000=undefined
FAIL  O24 while something that is not a number is refused, naming the account  "about nine hundred" is not an amount — it was entered against 0.
FAIL  the suite threw before it finished                        Failed query: select "id", "entity_id", "code", "name", "foreign_currency", "parent_id", "account_type", "norm
=== 3 CHECK(S) FAILED ===
```

## Correcting an entry forgets where it came from

`marker 94`

The replacement no longer inherits the original's `source_type`, so amending
anything makes it 'manual'.

For an opening balance that frees the one-per-ledger slot: the books can be
entered a second time, and the surviving copy stops anchoring the rule that
nothing may be dated before it. It is not specific to opening balances — a
bank-generated entry loses the row it came from the same way.

```
$ db:verify-opening | npm run db:verify-opening
FAIL  O28 amending an opening balance leaves an opening balance  manual
FAIL  O29 and it is the one the ledger has                      none
FAIL  O30 so the books cannot be entered a second time          expected ALREADY_OPEN, it succeeded
=== 3 CHECK(S) FAILED ===
```

## The conversion difference is folded into a figure that was given

`marker 95`

The balancing account may be one the user typed a balance against, so the
difference disappears into it. The entry balances, the books balance, and the
figure recorded is not the figure entered — and it looks exactly like the honest
version afterwards.

```
$ db:verify-opening | npm run db:verify-opening
FAIL  O31 the difference cannot go against a figure that was given  expected BALANCING_ACCOUNT_IN_USE, it succeeded
=== 1 CHECK(S) FAILED ===
```

## The opening balance is offered as the entry that settles a deposit

`marker 96`

`candidateEntries` stops excluding it. An opening cash balance of 12,500 is
then offered against any deposit up to 12,500 — and the row reads reconciled
afterwards, against a starting position rather than against anything that moved.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M59 the opening balance is not offered to settle a bank row  1 suggestions
FAIL  M61 while an ordinary entry on the same account still is    2 suggestion
=== 2 CHECK(S) FAILED ===
```

## And the database stops refusing it too

`marker 97`

`check_bank_match` reads the entry's status into the variable it was going to
compare against 'opening_balance', so the test can never hold. The suggestion
list is one half of that guard; this is the half a hand-written insert would
otherwise walk straight past.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M60 and the database refuses it even by hand                the database allowed it
=== 1 CHECK(S) FAILED ===
```

## Revenue and tax carried over are filed a second time

`marker 98`

The GST return stops excluding the opening balance. A conversion done mid-year
carries the tax already remitted and the revenue already reported as balances —
counted here they go on a return that says they happened this quarter.

```
$ db:verify-tax | npm run db:verify-tax
FAIL  G14 an opening balance is not this quarter's sales or tax  sales 0, collected 520000
=== 1 CHECK(S) FAILED ===
```

## The corrected entry keeps its kind but forgets which row

`marker 99`

`source_type` still says 'bank'; `source_id` no longer says which statement
row. Nothing about the entry looks wrong afterwards — it is still a bank entry,
still matched, still balanced — but the line back to the row it was generated
from is gone, and there is no way to tell from the entry that it ever existed.

Block 94 cannot catch this: an opening balance has no `source_id` to lose.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M64 an amended entry still knows which statement row it came from  bank null
=== 1 CHECK(S) FAILED ===
```

## The opening balance is left off the return without a word

`marker 100`

It is still excluded — the figures on the return do not change. What changes is
that nobody is told. Absent without a word looks exactly like not existing, and
the one person who needs to know is the one converting mid-year, who has to
confirm that the carried-over revenue and tax were reported wherever the books
were kept before.

```
$ db:verify-tax | npm run db:verify-tax
FAIL  G15 and it is named in the review rather than silently absent  3 periods are still open in this range
=== 1 CHECK(S) FAILED ===
```

## The opening position is computed and then not shown

`marker 101`

`reconciliation()` still returns it and the arithmetic still closes — the
figure is right, it just stops having a line of its own on the screen and goes
back to sitting inside 'Book movement no row claims'.

Which is the state this started in: a reconciliation permanently out by the
opening cash balance, with nothing on the page saying why. M63 cannot catch it,
because M63 checks the arithmetic and the arithmetic is fine.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M65 and where the account started has its own line too      Timing differences
FAIL  M77 the reconciliation PDF carries the gap and the four-part summary  Import gap 250.00: the rows on file do not reach the printed ending ba
=== 2 CHECK(S) FAILED ===
```

## The year end leaves carried-over revenue in the P&L

`marker 102`

The closing entry stops sweeping anything that came in as an opening balance.
The two exclusions that ARE right — the GST return and the bank candidates —
make this one look right too, and it is not: revenue carried in at a mid-year
conversion has to close to retained earnings like any other revenue, or it sits
in a P&L account across a year boundary forever.

```
$ db:verify-opening | npm run db:verify-opening
FAIL  O33 revenue carried in as an opening balance is swept at year end  revenue -500000, retained -200000
=== 1 CHECK(S) FAILED ===
```

## The two halves of one explanation are not netted off

`marker 103`

The reconcile screen prints FOUR rows for THREE explanations, because it splits
'book movement no row claims' into the opening position and the rest. The split
lives in recon-display.ts and nowhere else — the screen's Summary and the PDF
report both eat from it. Stop netting the halves and the opening position is
counted twice: the column no longer adds up to the difference printed above it.

Nothing else catches this. `M32` and `M63` check the library's three-term
identity, which is a tautology; `M65` checks that the row's label is present.
All three stay green.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M66 and the four printed parts add up to the printed difference  300000 + -1250000 + -1550000 + 0 = -1250000
=== 1 CHECK(S) FAILED ===
```

## A period P&L reports the year so far instead of the period

`marker 104`

Detail lines read the closing balance rather than the period's own movement.
The conversion month looks unchanged — the carried-in revenue is the whole
balance at that point either way — and every month after it is overstated by
everything before it.

That is why `O34` alone would not be a check: it holds under this mutation.
`O35` is the half that can fail, and it is the reason the pair exists.

```
$ db:verify-opening | npm run db:verify-opening
FAIL  O35 while the next period reports only what that period earned  April: value -620000, printed 620000
=== 1 CHECK(S) FAILED ===
```

## The refusal no longer says how much the figures are out by

`marker 105`

`OUT_OF_BALANCE` is still raised and the entry is still refused, so nothing is
posted wrong. What goes is the only part that helps: the number. 'The figures do
not balance' sends someone back to a spreadsheet to find a difference the
software had already computed.

```
$ db:verify-opening | npm run db:verify-opening
FAIL  O11 figures that are out are refused, with the amount named  OUT_OF_BALANCE raised, but it does not say 600.00: The figures are out. Either correct them, or choose the account the differen
FAIL  O25 figures that are out are refused through the form too, saying by how much  The figures are out. Either correct them, or choose the account the difference belongs in — it goes in as its own line, so it stays visible.
=== 2 CHECK(S) FAILED ===
```

## Any party at all can be named on any company's books

`marker 106`

`check_line_party` returns without looking — mutated in 0045, which
re-issues the function after 0026 and therefore OWNS the body a fresh
database ends up with (a mutation left in 0026 is silently healed by 0045,
which is exactly what toothless caught on 2026-09-02). `party_id` becomes a free-text
tag: a receivable booked against a director who has never been a customer, or
against a supplier of a different company entirely. The entry balances, the
trial balance is unmoved, and the aging shows a debt owed by someone with no
relationship to the company.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P11 a party with no role here cannot be named on these books       the database allowed it
FAIL  P14 while one dated after it ended does not                        the database allowed it
FAIL  P15c the refusal names the rule, not a stale role list             
FAIL  P42 and so is pointing a draft line at someone with no role here   the database allowed it
=== 4 CHECK(S) FAILED ===
```

## A relationship that ended still explains today's invoice

`marker 107`

The date half of the same check goes. Who someone IS is still tested, so the
obvious cases still pass — a director is still refused, another company's
customer is still refused. What stops being true is WHEN: a supplier who
stopped in March can be invoiced in June, and nothing on the entry says the
relationship had ended.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P14 while one dated after it ended does not                        the database allowed it
FAIL  P38 the role cannot be ended before something posted to it         expected ROLE_STILL_NEEDED, it succeeded
FAIL  P41 and moving a draft past the role is refused too                the database allowed it
FAIL  P58 ending a role still cannot orphan history earlier than a legacy start  expected ROLE_STILL_NEEDED, it succeeded
=== 4 CHECK(S) FAILED ===
```

## A director can be invoiced

`marker 108`

The `transacts` flag stops being consulted, so every role carries money.
Directors and shareholders are in this table because P4 needs them on the
corporate records — letting them onto a journal line turns the aging from a list
of debts into a list of people.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P44 a role cannot stop being one that trades while lines rely on it  the database allowed it
=== 1 CHECK(S) FAILED ===
```

## The reversal forgets who it was about

`marker 109`

`reverseEntryCore` copies every field of the line except the party. The
reversal is posted, the trial balance is right, and every statement in the
system agrees — because none of them read `party_id`.

What is wrong is the one thing that does: the invoice stays in that customer's
balance and the credit lands against nobody. Aging is derived from the ledger,
so there is no second table to disagree and give it away.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P28 a reversal names the party the entry named                     undefined -70000
FAIL  P29 so what they owe nets to nothing, read off the ledger          70000
=== 2 CHECK(S) FAILED ===
```

## Drafting an invoice loses the customer

`marker 110`

`saveDraft` drops the party when it writes the lines. Post it straight away
and it is right; save it, come back, post it, and it is a receivable owed by
nobody. The two paths into the ledger have to carry the same fields, and this is
the one nobody looks at.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P30 and a draft posted later still names them                      null
FAIL  P41 and moving a draft past the role is refused too                the database allowed it
=== 2 CHECK(S) FAILED ===
```

## The duplicate stops being explained

`marker 111`

The check is removed from `createParty`. The duplicate does NOT get in — the
unique index on the normalised name still refuses it, and the captured output
below shows that: a raw query failure rather than the sentence.

That is the whole finding. What is lost is not the guard, it is the ONLY part
that helps: 'Acme Ltd. is already on the list, add the role to that one' tells
you what to do, and 'duplicate key value violates unique constraint' sends you
looking for a record you were not told exists.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P05 the same name a second time is refused, naming the first       expected DUPLICATE_NAME, got Error: Failed query: 
FAIL  P06b and the same name spelled awkwardly is caught by the library, not the index  "\tAcme Ltd.\t" -> Failed query: 
FAIL  P34 a duplicate names the record that already exists, and the next move  Someone with that name is already on the list.
=== 3 CHECK(S) FAILED ===
```

## The deletion is refused by the wrong thing

`marker 112`

The trigger stops counting the lines. The party is still not deleted — the
foreign key from `journal_line.party_id` catches it — so nothing is lost from
the books, and the captured output shows the foreign key firing instead.

What goes is the sentence that says how many lines name it and what to do
instead. A foreign-key violation is a true statement about a constraint; 'Acme
Ltd. is named on 2 journal lines; deactivate it instead' is a true statement
about the books, and only one of them tells you the next move.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P20 a party the books name cannot be deleted                       expected "PARTY_IN_USE", got: Failed query: DELETE FROM party WHERE id = $1::uuid
FAIL  P49 a party on a journal line cannot be deleted                    The books still refer to this party — an invoice or a corporate record
=== 2 CHECK(S) FAILED ===
```

## The page falls over instead of saying what happened

`marker 113`

The add-role form reads only the top-level error message. The driver wraps what Postgres
said, so the constraint name is two levels down and the check for it finds
nothing — the error is re-thrown and the screen breaks.

Nothing is written wrong; the database refused the overlap correctly. What the
person gets is a crash instead of 'that role is already recorded here over those
dates.'

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P35 and so does an overlapping role                                it threw instead of answering: Failed query: 
=== 1 CHECK(S) FAILED ===
```

## A relationship can be ended before the invoices it explains

`marker 114`

The guard on `party_role` stops looking for lines the role was covering.
`endRole` — an ordinary exported function, not hand-written SQL — can then be
pointed at March and every invoice posted to that supplier in April is outside
its own explanation.

Nothing about the ledger changes. The entries are still there, still balanced,
still on the trial balance. What is gone is the reason any of them may name that
party, and the rule 0025 states as a property of the data becomes a property of
the moment the line was written.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P38 the role cannot be ended before something posted to it         expected ROLE_STILL_NEEDED, it succeeded
FAIL  P58 ending a role still cannot orphan history earlier than a legacy start  expected ROLE_STILL_NEEDED, it succeeded
=== 2 CHECK(S) FAILED ===
```

## Moving a draft's date takes it outside the relationship

`marker 115`

The re-check on `entry_date` returns without looking — mutated in 0045,
the file that owns the final body (see block 106). A draft written inside
a supplier's dates can be dragged to a date outside them and posted.

0010 froze a draft's `ledger_id` for exactly this shape and wrote down why —
a check that was true when the line was written, and stops being true when the
header moves. The party rule is a rule about a date, and the date was the one
thing left unfrozen.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P41 and moving a draft past the role is refused too                the database allowed it
=== 1 CHECK(S) FAILED ===
```

## A draft line can be repointed at anyone

`marker 116`

`trg_line_party` goes back to INSERT only. Posted lines are immutable, so
this looks harmless — until you remember a draft's lines are editable, which is
the one path that can rewrite the column, and was the one the original guard did
not watch.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P42 and so is pointing a draft line at someone with no role here   the database allowed it
=== 1 CHECK(S) FAILED ===
```

## Two normalisers, disagreeing about a tab

`marker 117`

The database key goes back to trimming before collapsing. Postgres `trim()`
strips ASCII space only, so a tab-padded name retains leading and trailing spaces.

`P06c` checks the actual installed key and goes red. `P05` does not move:
ASCII-space duplicates still collide, which is why that check alone cannot
establish the tab-normalisation contract.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P06c the key collapses tab and non-breaking space to the same thing  plain "acme ltd.", tab " acme ltd. ", nbsp "acme ltd."
=== 1 CHECK(S) FAILED ===
```

## The duplicate lookup asks about a different name than it stores

`marker 118`

`createParty` looks up with the raw input while storing the trimmed one. For
almost every name those are the same string. For one prefixed with a byte-order
mark they are not: JavaScript `.trim()` strips U+FEFF and Postgres `\\s` does
not match it, so the lookup misses and the insert then collides with the index.

The duplicate is still refused — by the index, as a raw constraint violation
instead of the sentence naming the record you already have. Two normalisers,
one of them invisible.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P06b and the same name spelled awkwardly is caught by the library, not the index  "﻿Acme Ltd." -> Failed query: 
=== 1 CHECK(S) FAILED ===
```

## A role stops being one that trades, and the lines it explained do not notice

`marker 119`

`party_role_definition.transacts` is what the rule reads. Setting 'supplier'
to false orphans every supplier-explained line in every company at once — and
the reference table looked like seed data, so nothing watched it.

The other four guards are all about a party or an entry. This one is about the
vocabulary they are written in, which is why it was the last found.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P44 a role cannot stop being one that trades while lines rely on it  the database allowed it
=== 1 CHECK(S) FAILED ===
```

## An applied migration is edited

`marker 120`

A line is added to a migration the books already ran. `db:migrate` refuses
this — 'has changed since it was applied' — but until `M2b` existed, the suite
named after migrations did not: `M1` counts files against rows and `M2`
counts rows against files, and neither reads a byte.

Not hypothetical. It happened during this round, and this suite reported ALL
CHECKS PASSED in the same minute that `db:migrate` refused. Counting is not
reading.

```
$ db:check-migrations | npm run db:check-migrations
FAIL  M2b applied migrations still match the files          0025_party.sql
=== 1 CHECK(S) FAILED ===
```

## The party is named on every line of the invoice

`marker 121`

The control line is the debt. Naming the party on the revenue lines too doubles
every per-party figure read off the ledger — and since aging is DERIVED, there
is no stored balance to disagree with it. The trial balance is unchanged, the
invoice looks right, and the customer appears to owe twice what they do.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V11 with the party on the control line and nowhere else   1200* 150000 4000* -150000
FAIL  V36 and still only the control line names the party       4 of 4
=== 2 CHECK(S) FAILED ===
```

## A sales invoice may land in any account at all

`marker 122`

The control-account rule stops asking for the role. A sales invoice whose total
lands in an expense account balances perfectly: the entry is sound, the trial
balance is sound, and the receivable is somewhere nobody will look for it.

Asking the ROLE and not the account type is what makes this bite: 'Other
Receivable' is an asset and receivable-shaped, and is still the wrong account.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V05 a sales invoice must land in trade receivables        the database allowed it
FAIL  V06 and not merely in something receivable-shaped         the database allowed it
FAIL  V07 a purchase bill must land in trade payables           the database allowed it
=== 3 CHECK(S) FAILED ===
```

## The lines may go whichever way they like

`marker 123`

A sales invoice whose lines net to a credit is a credit note; a purchase bill
whose lines net to a debit is a supplier credit. Neither is built. With the
direction check gone both post as ordinary invoices, putting money on the wrong
side of the control account — and reading afterwards exactly like the document
they are not.

The rule is not 'the total must be positive'. A purchase bill's control movement
is negative and correct.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V04 a sales invoice whose lines net to a credit is refused  expected WRONG_WAY, it succeeded
FAIL  V04b and so is a purchase bill whose lines net to a debit  expected WRONG_WAY, it succeeded
FAIL  V74 the same lines as an invoice are refused, naming what they are  expected WRONG_WAY, it succeeded
=== 3 CHECK(S) FAILED ===
```

## A posted invoice can be edited after the fact

`marker 124`

The freeze goes. The document and the entry it produced stop having to say the
same thing: change the due date, the party, or the control account, and the
ledger still holds what was posted while the invoice says something else.

Nothing in the ledger notices, because the ledger was right when it was written.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V13 a posted invoice bounces raw SQL                      the database allowed it
FAIL  V28 nor can its party be changed on the way to void       expected "INVOICE_RAW_SQL", got: INVOICE_PARTY_ROLE: Ironbark Supply Co. is not a customer of this company on 2026-05-01 — they are supplier here
FAIL  V29 nor the number the ledger already named it by         the database allowed it
FAIL  V29b nor who issued it                                    the database allowed it
FAIL  V29c nor who posted it                                    the database allowed it
FAIL  V29d while the posting was allowed to write it in the first place  somebody else
FAIL  V77 the kind of a posted document cannot be changed       the database allowed it
=== 7 CHECK(S) FAILED ===
```

## An invoice can claim an entry it did not produce

`marker 125`

`entry_id` becomes a hint. An invoice pointing at another invoice's entry
reads as posted, and the aging — which reads the LEDGER — puts that debt against
whoever the OTHER invoice named. Both documents look right on their own.

Two earlier defences stand in front of this one, which is why the check that
covers it has to claim status and entry in the same statement.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V17 an invoice cannot claim another invoice's entry       the database allowed it
FAIL  V115 what a document still owes is payments.ts answering, once  every document is either untouched or fully settled — nothing to tell apart
FAIL  V113 the list and the browse call a document by the same number  sales —/—: list says null, browse says INV-001
=== 3 CHECK(S) FAILED ===
```

## The control account can stop being one under a posted invoice

`marker 126`

The guard on `account_role` stops looking for invoices. `setAccountRoles`
deletes every role and re-inserts the ones given, and it is reached from the
accounts screen — so this is not a hand-written DELETE. Strip
`trade_receivables` off an account a posted invoice names and the rule that
invoice was checked against is simply false, with nothing looking again.

The ledger does not move. The receivable is still there. What is gone is the
thing that said it was a receivable.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V25 the control account cannot lose the role that made it one  the database allowed it
=== 1 CHECK(S) FAILED ===
```

## Voiding and posting again walks round the freeze

`marker 127`

The status-transition rule goes. A posted invoice can then go back to draft —
which unfreezes its lines — or take a hop through void and come back, changing
the party, the due date and the control account on the way. The entry does not
move, so the ledger holds one document and the invoice describes another.

This is what 'posted is frozen' meant before: frozen only while the status
happened to stay 'posted'.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V27 a posted invoice cannot be voided back into a draft   expected "INVOICE_TRANSITION", got: Failed query: 
=== 1 CHECK(S) FAILED ===
```

## The entry is reversed out from under the invoice

`marker 128`

`ENTRY_HOLDS_AN_INVOICE` goes. Reversing — or amending, which is a reversal
wearing a hat — leaves the invoice pointing at an entry that is no longer
standing. `amendEntry` carries source_type and source_id to the replacement on
purpose, so the live figure is somewhere else entirely while the invoice screen
goes on showing the original total computed from `invoice_line`.

0021 refuses this same shape for bank matches. The invoice analogue was missing.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V30 and the entry it names cannot be reversed under it    the database allowed it
FAIL  V31 nor amended, which is a reversal wearing a hat        the database allowed it
=== 2 CHECK(S) FAILED ===
```

## Voiding leaves the entry standing

`marker 129`

`voidInvoice` releases the invoice's claim and stops there. The invoice reads
void, and the entry it produced is still posted in the ledger — named by
nothing, and still owed by the customer.

Aging is derived from the ledger, so this is not a stale number somewhere that
could be spotted against another: it IS the number. The two halves have to
happen together or the remedy every guard names makes things worse.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V38 voiding a posted invoice reverses its entry in the same breath  undefined
FAIL  V39 leaving nothing owed and nothing claimed              150000, void
FAIL  V40 with the entry it produced taken out of the ledger, not orphaned  posted
FAIL  V69e voiding a taxed invoice takes its tax back off the return  5000 -> 5000
FAIL  V69f while a reversal dated into the next quarter credits THAT return  Q2 keeps 3000, Q3 gets 0
=== 5 CHECK(S) FAILED ===
```

## The sign is read off the typist instead of the direction

`marker 130`

`ledgerAmount` stops flipping for a sale. Somebody types 1,200 on a sales
invoice and the ledger DEBITS revenue by 1,200 — so the receivable is credited,
and the invoice bills the customer minus twelve hundred dollars.

It posts. It balances. The trial balance is sound. The only thing wrong is which
side everything is on, and the screen shows the figure the person typed either
way.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V45 the form saves straight to the books                  These lines credit the control account by 1,200.00, and a sales invoice has to debit it. What you have is a credit note; issue one of those instead.
FAIL  V46 typing 1,200 on a sales invoice credits revenue and bills 1,200  the invoice was never created
FAIL  V47 the sign keys on direction AND kind, like its inverse  120000 / 120000
FAIL  V48 each amount stays with the account typed beside it, whatever the order  0:1100 5:5500
FAIL  V87 the figure under the form is the figure the reader gets for the same rows  screen 60.00, reader -60.00
FAIL  V53g the form made an invoice for V54 to V56 to act on    the invoice was never created
FAIL  V105 a sales tag generates the collected-tax lines        total ?; GST -> undefined, PST -> undefined
FAIL  V107 inclusive amounts back the base out and keep the total  total ?
=== 8 CHECK(S) FAILED ===
```

## A half-finished line is dropped instead of refused

`marker 131`

A slot with an account and no amount is skipped quietly. The invoice posts for
less than the screen showed — and every total agrees with it, because they are
all computed from the lines that made it through.

Nothing is inconsistent afterwards. The document is just wrong, by exactly the
line nobody was told about.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V49 a line with an account and no amount is refused, naming the account  Nothing on it yet. Add at least one line saying what it is for.
=== 1 CHECK(S) FAILED ===
```

## A line's amount is read from a different slot than its account

`marker 132`

`linesFrom` takes the account from slot i and the amount from slot i+1. On a
form filled top to bottom this is invisible for the last line only; fill the
slots in any other order and the figures land against the wrong accounts.

This is the sales tax screen's defect, reproduced deliberately. The reason the
numbering is safe here is that a slot's fields all carry the same number, and
this is what it looks like when they do not.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V87 the figure under the form is the figure the reader gets for the same rows  screen 60.00, reader 80.00
FAIL  V87b and the same figure on a purchase, where every ledger sign is the other way  80.00 both ways
FAIL  V50 and one with an amount and no account, naming the line  Line 2 has an amount but no account.
=== 3 CHECK(S) FAILED ===
```

## The Delete button carries the ledger's id instead of the invoice's

`marker 133`

One hidden field, one identifier swapped for another that is in scope right
beside it. The screen is otherwise perfect: right lines, right total, right
customer, right heading — and a Delete button that deletes some other thing
or nothing. Both values are uuids, so nothing looks wrong anywhere. This is
the seam the sales tax round spent six rounds on, and the only thing that
sees it is rendering the screen and reading what its fields would post.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V59 every form, on every status, carries exactly one correct invoice id  posted form 0 has the wrong id
=== 1 CHECK(S) FAILED ===
```

## A sales invoice can be addressed to a supplier

`marker 134`

The invoice-level party rule goes. The LEDGER's rule survives — a supplier
holds a transacting role, so every journal line is fine — and the receivable
lands under a company you buy from.

The screen makes this the easy mistake: customers and suppliers are rendered
into one select as two groups, so the wrong one is one click away. Nothing
downstream objects, because a line does not know whether it is a sale.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V23 an invoice to someone who is not a customer here is refused  the database allowed it
FAIL  V24 with no draft left behind to be found later           1 invoices
FAIL  V24b and so is a supplier on a sales invoice, saying what they are  the database allowed it
FAIL  V24d and one whose customer relationship had already ended  the database allowed it
=== 4 CHECK(S) FAILED ===
```

## The detail screen shows the ledger's sign instead of the typed one

`marker 135`

`asEntered` becomes the identity. A sales line stored as −1,500 then reads
back as −1,500 on the screen the person just typed 1,500 into.

Nothing is wrong in the ledger. The document is unchanged. The screen simply
disagrees with itself between entering a figure and reading it — and the TOTAL,
which is rendered without the conversion, goes on agreeing with the person, so
a check that watched the total would see nothing.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V61 and a line reads back the way it was typed, not the way it is stored  1,500.00 shown, -1,500.00 absent
=== 1 CHECK(S) FAILED ===
```

## One line slot loses its number

`marker 136`

The amount input on every rendered slot is named for slot 0. Fill line 3 and
the figure arrives as line 1's — the sales tax defect, reproduced in the one
place the narrowed rule says is safe.

The reader is untouched and correct. What breaks is the screen's half of the
agreement, which no amount of reading `linesFrom` can see.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V57 every line slot renders its account, description and amount under one number  6 slots, ["account","description","amount","taxCode","gst","pst","amount","amount","amount","amount","amount"]
FAIL  V88 every button in a row acts on that row, and that row names one position  9 rows across both renders, each button on its own key
FAIL  V95g the third row has the fields the typing checks look for  no field named line.2.amount
=== 3 CHECK(S) FAILED ===
```

## The form stops offering a field the reader still reads

`marker 137`

The note input goes. `createInvoiceFromForm` still reads `F.note`, so every
invoice made through the screen silently has no note — and nothing is
inconsistent afterwards, because the reader reads an empty string and stores a
null.

This is the drift a hand-written list of expected fields cannot see: the list
would have to be updated to notice, and whoever removed the input would have
been the one to update it.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V58 and the form carries every header field the reader reads  note
=== 1 CHECK(S) FAILED ===
```

## A sale's tax is claimed back instead of remitted

`marker 138`

The side check goes. Tax collected on a sale can then be booked to the
recoverable account — which is claiming back tax you charged somebody else.

The entry balances. The invoice total is right. The customer is billed the right
amount. The GST return is wrong in BOTH boxes at once: line 105 short by the
tax, line 108 over by it, so the net is wrong by twice the figure and neither
box looks odd on its own.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V66 a sale cannot put its tax in the recoverable account  the database allowed it
FAIL  V67 nor a purchase put its tax in the collected account   the database allowed it
=== 2 CHECK(S) FAILED ===
```

## The fourth combination is the one that gets copied wrong

`marker 139`

`movesTheRightWay` goes back to reading the direction alone, ignoring whether
this is an invoice or a credit note. Sales invoices and sales credit notes then
have to move the receivable the same way — so every credit note is refused, and
if the flip were the other way round every one would post backwards.

Two axes written as one is the shape this whole feature exists to avoid, and it
is invisible on three of the four cells.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V71 all four combinations move the control account the way they should  sales/credit_note -1
FAIL  V72 a sales credit note credits the receivable, under the customer  it was refused: These lines credit the control account by 300.00, and a sales credit n
FAIL  V72g a credit note exists for V73 to V79 to act on        no credit note could be created
FAIL  V69c while a credit note debits the tax it is giving back  it was refused: These lines credit the control account by 210.00, and a sales credit n
FAIL  V69d and cannot credit it, which is what an invoice does  expected "TAX_WRONG_WAY", got: These lines credit the control account by 190.00, and a sales credit note has to credit it. What you have is a invoice; issue one of those i
FAIL  V110 the create form mints a real credit note, receivable credited  undefined; control no line
FAIL  V109 a credit note saved unchanged stays itself           it threw: These lines credit the control account by 80.00, and a sales credit note has to 
=== 7 CHECK(S) FAILED ===
```

## The list's total and the document's disagree

`marker 140`

`invoicesFor` computes the document total in SQL because it cannot import
`totalOf`. The rule is therefore written twice, and this is what happens when
the two drift: the SQL copy forgets the document kind.

Every credit note then shows a negative total on the list and a positive one on
its own page. Neither figure is wrong on its own terms; they are answers to the
same question from two places that stopped agreeing.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V76 and the SQL total agrees with the TypeScript one on all four cells  SC-001: list -20000 vs 20000; CN-001: list -30000 vs 30000
=== 1 CHECK(S) FAILED ===
```

## A posted credit note can become an invoice

`marker 141`

`document_kind` is left off the frozen column list. 0032 added the column and
the freeze names its columns one by one — so the new one is unfrozen until
somebody remembers, which is what this is.

Flip a posted credit note to an invoice and the document says it bills the
customer while the entry it produced credits them.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V77 the kind of a posted document cannot be changed       the database allowed it
=== 1 CHECK(S) FAILED ===
```

## The tax line points the wrong way and nothing minds

`marker 142`

The sign half of the tax guard goes — the half 0031 never had. The ACCOUNT is
still checked, so a sale still cannot name a recoverable account. What gets
through is the right account pointing backwards: a sales invoice that DEBITS the
tax it collected.

Every other rule is satisfied. The control movement is still the way a sales
invoice must move, so it posts, and the return shows tax remitted rather than
collected — in the very box the original guard's comment was about.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V69a a sale cannot debit the tax it collected             the database allowed it
FAIL  V69b nor a purchase credit the tax it reclaimed           the database allowed it
FAIL  V69d and cannot credit it, which is what an invoice does  the database allowed it
=== 3 CHECK(S) FAILED ===
```

## Who issued a posted invoice can be rewritten

`marker 143`

`created_by` comes off the frozen list. The document cannot otherwise be
edited, and this is the one change that leaves no trace: the audit row records
the status change, not a later edit of the name attached to it.

The freeze names its columns one by one on purpose — a whole-row comparison
would freeze `posted_at`, which the posting itself writes — and the cost of a
list is that things fall off it.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V29b nor who issued it                                    the database allowed it
=== 1 CHECK(S) FAILED ===
```

## The aging joins away the money nobody owes

`marker 144`

`unattributed` is reported as zero rather than as the difference between the
control account and the rows. Aging JOINs to `party`, so a receivable with no
party on it is in NO row — and the account balance goes on including it.

Two numbers that are supposed to be the same, differing in silence. The report
adds up perfectly; it is just about less money than the ledger holds.

```
$ db:verify-aging | npm run db:verify-aging
FAIL  A10 a receivable with no party on it is named, not absorbed  0
FAIL  A11 and the rows plus the unattributed come to the control balance  320000 + 0 = 327000
FAIL  A15 and it still adds up afterwards                       320000
=== 3 CHECK(S) FAILED ===
```

## An aging bucket is off by a day at its boundary

`marker 145`

The 0-30 bucket becomes 0-29, so everything 30 days old moves into 31-60.

The total is unchanged — every line is still in exactly one bucket — and the
report still agrees with the control account. What moves is which column a
figure appears under, which is the only thing anybody reads an aging report
for.

```
$ db:verify-aging | npm run db:verify-aging
FAIL  A02 and every age from -400 to 400 falls in exactly one of them  1 in none, 0 in two
FAIL  A03 with the boundaries where the labels say they are     30 -> -1, 31 -> 2
=== 2 CHECK(S) FAILED ===
```

## The reader goes back to counting to six

`marker 146`

`lineIndicesIn` returns only the first six rows it finds. The form opens with
six and lets a person add more, so this is the exact shape the dynamic reader
replaced: the seventh line is never read, the invoice saves without it, and
every figure on the saved document agrees with every other.

Nothing on the screen says so. The line is simply not there afterwards.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V48b and it reads every row that arrives, past the number the form opens with  6 of 9, form opens with 6
=== 1 CHECK(S) FAILED ===
```

## A line's field name is read as its row number

`marker 147`

The refusal counts by the number IN the field name instead of by where the row
sits among the rows that came back.

They are the same number until a row is removed from the middle. After that the
form renumbers on its next render and a submission already in flight does not,
so `Line 8` names nothing on a five-row form — and the person is being told to
fix a line that is not on the screen.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V81 and it counts rows the way the screen does, not the way the names are numbered  Line 10 has an amount but no account.
=== 1 CHECK(S) FAILED ===
```

## The remove button takes out whichever row is standing there

`marker 148`

`removeRow` filters by position instead of by key.

Until a row moves the two agree. After one move the button under the third row
removes a different row — a different account, a different figure — and the form
still shows well-formed lines. This is the sales tax screen's defect in its
other form: a number read after the render that produced it, against a list that
has moved.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V82 a row is removed by its key, which survives the row having moved  moved to 1,0,2, left 0:first 2:third
FAIL  V82b and position 0 at that moment held a different row, so the two answers differ  position 0 held key 1
FAIL  V83 removing the last row leaves a blank one rather than an empty form  1 row, key 4
FAIL  V92 pressing Remove under a row removes THAT row, not the one in its place  5:moved up from the bottom 2:stayed
FAIL  V92b and every button removes the row its own data-acts-on names  position 0 removed 0 rows, position 1 says 2, removed 9, position 2 removed 0 rows
=== 5 CHECK(S) FAILED ===
```

## Removing the last line leaves nowhere to type

`marker 149`

The blank row that replaces the last removed one goes away.

The form is then a header, a note about signs, and no lines. Everything on the
page still works; there is simply no way to put a line back without reloading,
and the person who emptied it was clearing it, not leaving.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V83 removing the last row leaves a blank one rather than an empty form  0 row, key undefined
=== 1 CHECK(S) FAILED ===
```

## A move carries the figure and leaves the account behind

`marker 150`

`moveRow` swaps the amounts of two rows rather than the rows.

The screen looks right — two rows, both complete, in the new order. One figure
is now against the other line's account. The invoice totals the same, posts, and
is wrong about what it was for, which is the part an aging report and a tax
return both read.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V82 a row is removed by its key, which survives the row having moved  moved to 0,1,2, left 1:second 2:third
FAIL  V82b and position 0 at that moment held a different row, so the two answers differ  position 0 held key 0
FAIL  V84 a move carries the whole row, account and figure together  0:20.00 1:30.00 2:10.00
=== 3 CHECK(S) FAILED ===
```

## A key is handed out twice

`marker 151`

`nextKey` becomes the number of rows, so a key freed by a removal is given to
the next row added.

Every button carries a key. A button rendered before the removal and pressed
after it acts on the new row that took the old one's number — and React, keyed
on the same value, keeps the removed row's element and its contents.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V86 keys are handed out once and never reused after a removal  keys 0,2,3,3, next 4
FAIL  V94 pressing Add appends one blank row with a key nothing has held  4 rows, new key 3
=== 2 CHECK(S) FAILED ===
```

## A row that is not yet an amount is counted as nothing

`marker 152`

`typedTotal` stops counting the rows it cannot read and folds them into the
total as zero.

The figure under the form is then confident and short. Worse, it is a figure for
an invoice that will not save: the reader refuses a line whose amount reads as
zero by name, so the screen is promising a total for a document the next click
will refuse.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V87c and a row that is not yet an amount is counted apart, not read as zero  10.00 across 2 of 3
=== 1 CHECK(S) FAILED ===
```

## A row's button reports acting on a row it does not act on

`marker 153`

The Remove button's `data-acts-on` becomes the position while its handler goes
on using the key.

Only the MARKER moves. The button still removes the right row — so this is not
the wiring defect, it is the audit trail lying about the wiring, which is worth a
block of its own: `V88` reads that marker, and a marker nothing checks is a
label the component writes about itself. The block that breaks the handler
instead is further down.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V88 every button in a row acts on that row, and that row names one position  row 5 has a button on ["5","5","0"]
FAIL  V92b and every button removes the row its own data-acts-on names  position 0 says 0, removed 5, position 1 says 1, removed 2, position 2 says 2, removed 9
=== 2 CHECK(S) FAILED ===
```

## The number a person is shown is the row's key

`marker 154`

The Remove label says `Remove line 4` where 4 is the row's key rather than its
place on the screen.

They start out the same, which is why this survives being looked at. They come
apart the first time a row is removed, and then the labels count 1, 2, 4, 5 down
a form that shows four rows — while the refusals coming back from the reader
count 1, 2, 3, 4.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V89 positions run without a gap, and the number a person is shown is that position  blank 0,1,2,3,4,5, edited 0,1,2 over keys 5,2,9
=== 1 CHECK(S) FAILED ===
```

## The line-name pattern matches a field that is not a line

`marker 155`

`LINE_FIELD` accepts any word after the number, not just the three a row has.

Nothing on the form is named that way today, so nothing breaks today. It breaks
the moment a row gains a fourth field — a tax code, a quantity — under a name
this now reads as a row of its own: the reader refuses the invoice for a line
the person cannot see, naming a row number that is not on the screen.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V80b and nothing else, so a header field cannot be read as a row  [2]
=== 1 CHECK(S) FAILED ===
```

## A saved invoice leaves its lines on the form

`marker 156`

The screen stops being told that the save worked, so the line rows stay.

The header fields are cleared by React and the eight lines are not, and the form
now offers to save them again against whoever is chosen next. Nothing on the
page looks broken; it looks like a form that has been helpfully pre-filled.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V91 the form clears its lines when a save works, and on nothing else (read from source)  the screen does not pass onSucceeded
=== 1 CHECK(S) FAILED ===
```

## The Remove button acts on the place, not on the row

`marker 157`

The handler is given the position while the marker goes on reporting the key.

This is the defect a review found unguarded, and it was unguarded for a precise
reason: `data-acts-on` and the `onClick` beside it were two separate
expressions, so a check comparing the marker with the row compared `row.key`
with `row.key`. Both sides spelled the same, which this repository has already
written down as not being a check.

`V92` presses the button. `InvoiceLines` keeps no state of its own, so the
component can be called and its handlers are the closures a browser would run.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V92 pressing Remove under a row removes THAT row, not the one in its place  5:moved up from the bottom 2:stayed 9:added last
FAIL  V92b and every button removes the row its own data-acts-on names  position 0 removed 0 rows, position 1 removed 0 rows, position 2 says 9, removed 2
=== 2 CHECK(S) FAILED ===
```

## Typing in a row writes the row above it

`marker 158`

The amount field's `onChange` carries the position instead of the key.

Until a row moves the two agree. After one move the figure lands on the line
above or below the one being typed in — and the screen shows exactly what was
typed, in the wrong row, against the wrong account.

The whole form still adds up. It adds up to the right total for the wrong
invoice.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V95 typing in a row writes that row, and leaves the row beside it alone  5:1.00 2:77.00 9:3.00
=== 1 CHECK(S) FAILED ===
```

## Dragging treats a stable row key as its current position

`marker 159`

The arbitrary-position move stops resolving the row's key to its current index.
Once keys differ from positions, the wrong row moves or nothing happens.
`V93` and `V93b` use edited keys to distinguish those cases.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V93 moving the first row to a target position carries its values  5:1.00 2:2.00 9:3.00
FAIL  V93b moving the last row to a target position carries its values  5:1.00 2:2.00 9:3.00
=== 2 CHECK(S) FAILED ===
```

## A payable ages into the next bucket along

`marker 160`

The 61-90 bucket becomes 61-89, and a bill exactly ninety days old falls out of
the report — 'Over 90' begins at 91, so day ninety is now in no bucket at all.
The money is simply gone from every column while the control account goes on
holding it.

The narrower version of this — a figure landing one column along — is block 145
on the other boundary. This one is here for the payables side, where nothing
used to assert a column at all: `A12` checked the total and the sign while its
label said 'age'.

```
$ db:verify-aging | npm run db:verify-aging
FAIL  A02 and every age from -400 to 400 falls in exactly one of them  1 in none, 0 in two
FAIL  A12 payables age the same way, keeping the ledger's sign  -80000 in no bucket
FAIL  A13 and they add up too                                   0 vs -80000
=== 3 CHECK(S) FAILED ===
```

## The marker on the button reports the place it is standing in

`marker 161`

`data-acts-on` becomes the position while the handler goes on using the key.

This is the block that was missing, and its absence is what a review caught.
`V92b` claimed to assert that a button removes the row its `data-acts-on`
names — and read `data-line-row` off the row div instead, which the buttons do
not carry and this mutation does not touch. So the check was green under exactly
the change it was written to catch, and the paragraph in `09-invoices.md`
defending the marker was defending an attribute nothing read.

`V88` goes red beside it: the three buttons in one row now disagree with each
other, two saying the key and one the position.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V88 every button in a row acts on that row, and that row names one position  row 5 has a button on ["5","5","0"]
FAIL  V92b and every button removes the row its own data-acts-on names  position 0 says 0, removed 5, position 1 says 1, removed 2, position 2 says 2, removed 9
=== 2 CHECK(S) FAILED ===
```

## Dragging lands one position beyond the chosen target

`marker 162`

The drop target is a final position after removing the moving row.
Adding one shifts the row beyond that position in either direction.
`V93` and `V93b` assert the complete order and the moved amount.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V93 moving the first row to a target position carries its values  2:2.00 9:3.00 5:1.00
FAIL  V93b moving the last row to a target position carries its values  5:1.00 2:2.00 9:3.00
=== 2 CHECK(S) FAILED ===
```

## Choosing an account sets it on the row above

`marker 163`

The account select's `onChange` carries the position instead of the key.

This is the worst of the six to lose, and it was the one nothing watched. A
figure in the wrong row is visible — the line reads oddly. An AMOUNT that is
right against an ACCOUNT that is wrong posts a balanced entry to the wrong place
in the chart, and every total on the invoice agrees with itself.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V95b typing an account writes that row, not the one beside it  5:cfba4a43-bcf2-4c34-9317-80a0734ef441 2:no-row-holds-this 9:819f5847-5ee8-4855-82be-53c810c861d3
=== 1 CHECK(S) FAILED ===
```

## The description lands on the line above

`marker 164`

The last of the six. Nothing about the ledger is wrong afterwards — the money
is all in the right places — and the invoice still goes out with each line
describing its neighbour.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V95c typing a description writes that row, not the one beside it  5:moved up from the bottom 2:typed into the last row 9:added last
=== 1 CHECK(S) FAILED ===
```

## A spent credit note reports itself available

`marker 165`

The balance derivation loses the second join — applications made BY the
document's entry — so a note that has settled an invoice goes on showing its
full value as left to apply. This is the defect `PM09` caught on the suite's
FIRST RUN: the first version of `OPEN_ITEMS` had only the applications-ON
join, and the note read as unspent while the invoice it settled read as paid.
The same money, available twice.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM09 a credit note settles an invoice through the same table  invoice 60000 -> 45000, note has 15000 left
FAIL  PM21b and the note ends spent exactly once, not twice         12000
=== 2 CHECK(S) FAILED ===
```

## The payment names the party on both of its lines

`marker 166`

`recordPayment` puts the party on the bank line as well as the control line.

Both lines still balance, the invoice still reads as paid, and every figure on
the payment screen is right. What breaks is one level down: anything reading
the ledger BY PARTY now counts the money twice — the aging's control-balance
equality is exactly the check that would catch it there, and `PM02` is the
one that catches it here, at the door.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM02 bank debited, receivables credited, the party on the control line only  -40000:party 40000:party
FAIL  PM16 the purchase side mirrors: payables debited, bank credited  balance 0
=== 2 CHECK(S) FAILED ===
```

## The invoice-side limit is quietly a thousand times looser

`marker 167`

`check_application_valid` compares against a thousand debts instead of one.
Applied to the test database rather than the migration file, which is
append-only — 0015's precedent.

The library's own OVERPAYS check still refuses the ordinary path, which is why
`PM05` stays green: this block is exactly the case `PM05b` exists for, the
limit at the DATABASE with the library dodged.

```
$ db:verify-payments | npx tsx scripts/verify-payments.ts
FAIL  PM05b and the database refuses it even when the library is dodged  expected APPLICATION_OVER_INVOICE, it went through
FAIL  PM21 a note spent as a source cannot also be paid as a target  expected APPLICATION_OVER, it went through
FAIL  PM21b and the note ends spent exactly once, not twice         -12000
FAIL  PM22 an entry that nets to nothing settles nothing            expected APPLICATION_WRONG_WAY, it went through
=== 4 CHECK(S) FAILED ===
```

## An entry that never touched the debt settles it anyway

`marker 168`

The wrong-way branch is removed from the trigger: `settle_cap = 0` now sails
through with a fictitious capacity, so any posted entry in the ledger can be
applied to any invoice. Same applied-state shape as the block above.

`PM07` reddens — its refusal now arrives as the wrong error or not at all —
and the entry-side limit goes with it, since a capacity invented from nothing
is a limit measured against nothing.

```
$ db:verify-payments | npx tsx scripts/verify-payments.ts
FAIL  PM06 an entry cannot settle more than it moved                expected APPLICATION_OVER_ENTRY, it went through
FAIL  PM07 an entry pointing the same way as the debt settles nothing  expected APPLICATION_WRONG_WAY, it went through
FAIL  PM21 a note spent as a source cannot also be paid as a target  expected APPLICATION_OVER, it went through
FAIL  PM21b and the note ends spent exactly once, not twice         -12000
FAIL  PM22 an entry that nets to nothing settles nothing            expected APPLICATION_WRONG_WAY, it went through
FAIL  PM14 an amendment that abandons the debt is refused whole     expected APPLICATION_WRONG_WAY, it went through
=== 6 CHECK(S) FAILED ===
```

## The credit note's form settles with the wrong entry

`marker 169`

The hidden field carries the invoice's own id where the settling entry
belongs. This is the bug the panel's first draft actually had — a comment
saying the entry does the settling, and no field carrying it — kept here as a
mutation so the check that caught it stays watched.

Markup-level: the form still renders, the select still lists the open
invoices, and the POST would arrive with a uuid in the entry slot. It is even
a VALID uuid — of a document, not an entry — so nothing about the request
looks wrong until the database asks what that entry moved.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM20 the apply form carries the note's own entry, the target comes from the select  CN-ID
=== 1 CHECK(S) FAILED ===
```

## Amending a payment strands its application

`marker 170`

The carry in `posting.ts` stops matching anything, so the application stays
on the original while the amendment reverses it — and the deferred trigger
`trg_reversed_holds_no_application` refuses the whole amendment at commit.
`PM13` dies rather than reddening cleanly, the way the bank-match carry
blocks die: the suite's catch-all prints the refusal and the summary counts
it. A death with a summary line is a controlled failure; a death without one
is what `run`'s finished-check exists to refuse.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  the suite threw before it finished                            REVERSED_STILL_APPLIED: entry PAY-00005 settles 1 invoice(s); unapply before reversing it
=== 1 CHECK(S) FAILED ===
```

## The register shows the cessation a day late

`marker 171`

The renderer's as-of comparison goes strict: a director who ceased ON the
as-of day still reads as serving. One character, one day, and a register
printed for a signing date says the signer had authority they had lost that
morning. `CR13c` sits exactly on the boundary; the two checks either side of
it (`CR13`, `CR13b`) cannot see this, which is why it exists.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR13c and the cessation day itself already shows the date       Dana Chen | 4102 Main St, Vancouver, BC, V5V 3P6 | 2020-01-15 | —
=== 1 CHECK(S) FAILED ===
```

## The public is shown the transparency register

`marker 172`

The audience filter answers yes to everyone: `visibleFields` stops asking and
allows every field for every audience.

This is the single most consequential defect this module can have — birth
dates, home addresses and citizenships rendered to an audience the register
must never be shown to — and nothing about the page would look broken: the
table renders beautifully, with more columns than it should have.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR15 a public render withholds the private fields and says so   withheld: 
FAIL  CR21b and the public copy names what it withheld                nothing withheld — the check proves nothing
FAIL  CR25 a public render withholds the new date columns too         CSR shows [Class / series, Holder, Last known address, Shares held, Became holder, Ceased]; withheld 0/0 fields
FAIL  CR28 the holder address is on the register and off the public copy  77 Water St, Vancouver, BC, V6B 1A; public withholds 0 fields
=== 4 CHECK(S) FAILED ===
```

## A transfer group stops having to balance

`marker 173`

`check_transfer_group` accepts any net. Applied to the test database, 0015's
precedent. Shares can now be minted by a one-sided transfer_in — the register
equivalent of an unbalanced journal entry — and every holder's statement still
reads cleanly on its own.

```
$ db:verify-records | npx tsx scripts/verify-records.ts
FAIL  CR07 a one-sided transfer is refused by the database            expected TRANSFER_UNBALANCED, it went through
FAIL  CR08 transferring more than a holder has is refused             expected SHARES_OVERDRAWN, it went through
FAIL  the suite threw before it finished                              SHARES_OVERDRAWN: that holder would be at -16 shares on 2026-02-01; nobody transfers shares they do not hold
=== 3 CHECK(S) FAILED ===
```

## The securities register learns to edit

`marker 174`

`forbid_share_transaction_change` waves everything through. The Act wants the
dates and details of every issue and transfer; an UPDATE that rewrites a
quantity erases a detail while the totals keep balancing. `CR09` and
`CR09b` both watch this door.

```
$ db:verify-records | npx tsx scripts/verify-records.ts
FAIL  CR09 the securities register does not edit                      Failed query: 
FAIL  CR09b and does not delete                                       expected SHARES_APPEND_ONLY, it went through
FAIL  the suite threw before it finished                              SHARES_OVERDRAWN: that holder would be at -25 shares on 2026-02-01; nobody transfers shares they do not hold
=== 3 CHECK(S) FAILED ===
```

## Two overlapping terms for one director

`marker 175`

The EXCLUDE constraint is dropped from the test database — a constraint has no
function to neuter, so the mutation is the DROP itself. One person now holds
two live terms at once, and a register as at any day in the overlap lists them
twice with two different addresses.

```
$ db:verify-records | npx tsx scripts/verify-records.ts
FAIL  CR05 two overlapping terms for one person are refused           expected directorship_no_overlap, it went through
FAIL  CR46 a director's term is corrected, refused where it would overlap or lack an address, moved to a new name, and deleted  un-ceased into the later term: Saved the director.; fixed: 2021-02-01→2022-06-30 at 7 Typed St; new name, no address: Nothing was saved. A director needs a prescribed address, and Robin Vale has none on file  (0 Robin Vale left on the list); with one: Saved the director. Added to this company's list: Robin Vale.; deleted: gone; trail ∅→2022-01-01, 2022-01-01→∅, ∅→2022-06-30 under the person
=== 2 CHECK(S) FAILED ===
```

## A holder may go negative and nobody is watching

`marker 176`

`check_holding_never_negative` waves everything through. A review found that
`CR08`'s only recorded red until now was a FIXTURE CASCADE: block 173's
one-sided +10 lifted the holding so the 26-share transfer no longer overdrew,
and the 'went through' was the setup's doing, not this guard failing. This
block disables the guard ITSELF, so `CR08` and `CR08b`'s reds are their own.

```
$ db:verify-records | npx tsx scripts/verify-records.ts
FAIL  CR08 transferring more than a holder has is refused             expected SHARES_OVERDRAWN, it went through
FAIL  CR08b and a backdated transfer cannot make the past negative    expected SHARES_OVERDRAWN, it went through
FAIL  CR22 a transferred-out holder keeps a seat and gains a date ceased  became 2022-01-01, ceased null; register row carries it
FAIL  CR22b as at an earlier date they still hold, unceased           -11 held, ceased null
FAIL  CR23 a cancellation zeroes the holder and the class total together  ceased null, total issued 0
FAIL  CR34 the certificate says what the register says, in figures and words  no certificate was produced
FAIL  the suite threw before it finished                              Cannot read properties of null (reading 'facts')
=== 7 CHECK(S) FAILED ===
```

## The two ways to spend a note stop being added together

`marker 177`

0036's meeting point is removed: the trigger goes back to 0034's two separate
caps, target consumption and source consumption never summed. This is the
defect a review CONSTRUCTED live — a credit note paid down as a target and
spent as a source, balance −15,000, every row right on its own. `PM21`
reproduces that exact play and goes red; `PM21b` beside it watches the
balance land negative.

```
$ db:verify-payments | npx tsx scripts/verify-payments.ts
FAIL  PM21 a note spent as a source cannot also be paid as a target  expected APPLICATION_OVER, it went through
FAIL  PM21b and the note ends spent exactly once, not twice         -12000
=== 2 CHECK(S) FAILED ===
```

## Applications subtract from one side only

`marker 178`

The consumed CTE counts the document side twice and the settling side never.
Every application now reduces the invoice without reducing the payment, and
the equality `A04` pins — buckets add up to the control account, exactly —
breaks the moment one application is in scope. `A19` reddens beside it with
the invoice over-reduced below zero.

```
$ db:verify-aging | npm run db:verify-aging
FAIL  A19 an applied payment takes the old invoice off the report entirely  over90 -80000, 0-30 -60000, total -140000
FAIL  A19b while the totals still equal the control account, exactly  125000 vs 285000
FAIL  A20 a partial application leaves the remainder in the original bucket  0 | -145000 | 0 | 0 | -150000
FAIL  A22 a contra settlement leaves both sides equal to their control accounts  AR -170000 vs 320000; AP 160000 vs 0
FAIL  A22b and the party owes the 20,000 the ledger says, on one side only  AR total -140000, AP rows with party: 1
FAIL  A11 and the rows plus the unattributed come to the control balance  -170000 + 7000 = 327000
FAIL  A13 and they add up too                                   80000 vs -80000
FAIL  A15 and it still adds up afterwards                       -170000
=== 8 CHECK(S) FAILED ===
```

## Applications stop counting at all

`marker 179`

The open amount ignores consumed entirely — the derivation reverts to pure
per-entry bucketing, which was last month's behaviour. `A04` STAYS GREEN,
because the equality is structural either way; what reddens is `A19` (the
paid invoice back at over-ninety) and `A20` (the remainder gone from its
bucket). That split is this block's point: it proves the open-item checks are
not riding the equality check.

```
$ db:verify-aging | npm run db:verify-aging
FAIL  A19 an applied payment takes the old invoice off the report entirely  over90 80000, 0-30 -60000, total 20000
FAIL  A20 a partial application leaves the remainder in the original bucket  0 | -145000 | 0 | 0 | 180000
=== 2 CHECK(S) FAILED ===
```

## A payment from the future settles the past

`marker 180`

The settling-side as-at filter is dropped: an application counts even when
the payment entry is dated after the report. Asked as at June 20, the report
shows an invoice already reduced by a June 25 payment — and the equality
breaks too, because only one of the two linked entries is in the ledger read.
`A21` and `A21b` both redden.

```
$ db:verify-aging | npm run db:verify-aging
FAIL  A21 while a report as at a date before the payment shows the debt whole  0 | 0 | 0 | 0 | 15000
FAIL  A21b and that earlier report balances to ITS control balance too  365000 vs 530000
=== 2 CHECK(S) FAILED ===
```

## The one wiring hands its dispatcher back to the action prop

`marker 181`

Inside `useActionForm` — the single wiring every screen now goes through —
the action prop takes the dispatcher again. In a browser that is the
React-resets-on-refusal defect for EVERY form at once: the reset is scheduled
before the action runs, so an eight-field bill with one typo comes back empty.

Said precisely: `V96` is a SOURCE check and reddens on the wiring alone —
this block does not run a browser, and its own onSubmit handler would still
be attached. The tripwire is the point: the wiring lives in one file so that
one grep can refuse it, and this block is that grep being watched to fire.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V96 a refused save keeps every field, on every screen, because only one wiring exists  the action prop still carries the dispatcher, so React resets on refusal
=== 1 CHECK(S) FAILED ===
```

## A payable's settlement is subtracted from the receivables report

`marker 182`

The consumed CTE goes back to keying on (entry, party) with no role scoping
and no account keying — the first open-item derivation, reverted whole. This
is the defect a review CONSTRUCTED: one entry netting a receivable against a
payable for the same party, applied to both documents legitimately, and the
receivables report showed the party owing the ledger's figure plus the whole
contra — money manufactured in a bucket while both applications looked right.

The fix has two defenses (role join, account keying) and EACH covers the
contra case alone, which is why this block reverts both together: dropping one
at a time stays green, and a block that stays green would have recorded the
defenses as untested. `A22`/`A22b` pin the constructed case; `A11`,
`A13` and `A15` break beside them because the equality goes with it.

```
$ db:verify-aging | npm run db:verify-aging
FAIL  A22 a contra settlement leaves both sides equal to their control accounts  AR 400000 vs 320000; AP -80000 vs 0
FAIL  A22b and the party owes the 20,000 the ledger says, on one side only  AR total 100000, AP rows with party: 1
FAIL  A11 and the rows plus the unattributed come to the control balance  400000 + 7000 = 327000
FAIL  A13 and they add up too                                   -160000 vs -80000
FAIL  A15 and it still adds up afterwards                       400000
=== 5 CHECK(S) FAILED ===
```

## The invoice shows the ledger's sign to the customer

`marker 183`

One minus sign: the document prints line amounts as the LEDGER stores them
instead of as the person entered them. A consulting invoice arrives showing
-2,500.00 for the work done — the revenue credit, handed to a customer. The
detail screen made this inversion for the same reason and `DC02` reads the
document the customer would.

```
$ db:verify-documents | npm run db:verify-documents
FAIL  DC02 lines read as entered, and the balance is the applications' answer  total 250000, paid 100000, due 150000
=== 1 CHECK(S) FAILED ===
```

## The letterhead reads the registration as of today

`marker 184`

The GST number is looked up as at the RENDER date instead of the ISSUE date.
Nothing changes while the registration stands; the lie arrives later — a
February invoice reprinted in April carries a number the company did not have
in February, and a reprint after deregistering drops a number the original
lawfully bore. `DC03b` holds the issue-date reading.

```
$ db:verify-documents | npm run db:verify-documents
FAIL  DC03b and absent from one issued before the registration began  GST/HST 123456789RT0001
=== 1 CHECK(S) FAILED ===
```

## The statement recomputes its own aging line

`marker 185`

The statement stops handing back `aging()`'s row and sums its items into
buckets with its own arithmetic — by DUE date, a perfectly reasonable choice
that the aging report does not make. Two documents, two answers, both
internally consistent: the report says 110,000 at 31-60 days, the letter in
the customer's hands says something else. `DC07` compares the two rows
figure by figure, which is the whole reason the statement CALLS the report.

```
$ db:verify-documents | npm run db:verify-documents
FAIL  DC07 and its aging line IS the aging report's row, adding to the total  0 | -35000 | 160000 | 0 | 0
=== 1 CHECK(S) FAILED ===
```

## The statement forgets the credit notes

`marker 186`

The items filter keeps only documents whose kind is invoice. An unspent
credit note vanishes from the letter, and the customer is asked for the gross
of their invoices while the books expect the net. The total no longer equals
the aging line either — `DC06` pins the list, `DC07` the agreement.

```
$ db:verify-documents | npm run db:verify-documents
FAIL  DC06 the statement lists the open documents AND the money on account  INV-300,INV-301 + 1 on account = 145000
FAIL  DC06c an unspent credit note appears, and it REDUCES what is owed  undefined -> undefined
FAIL  DC07 and its aging line IS the aging report's row, adding to the total  0 | -35000 | 110000 | 50000 | 0
FAIL  DC06d a partially spent note keeps one arithmetic: original − settled = open  undefined − undefined = undefined; 0 rows break it
=== 4 CHECK(S) FAILED ===
```

## The customer paper signs its lines by direction alone

`marker 187`

`asEnteredAmount` forgets the kind — the exact defect a review caught on the
first printed credit note: every line at −400.00 under a printed total of
+400.00, the lines summing to the negation of the document's own total, on
paper handed to a customer. `totalOf` keys on (direction, kind); the helper
exists so the presentation keys on the same pair, and `DC05` now reads a
note's LINE amounts, which no check did when the defect shipped.

```
$ db:verify-documents | npm run db:verify-documents
FAIL  DC05 a credit note prints as one, its lines summing to its own total  Credit note CN-301: line -40000, total 40000, left 0
=== 1 CHECK(S) FAILED ===
```

## A span P&L quietly reads only its first month

`marker 188`

The movement sum keeps only the period whose start IS the span's start —
`>=` becomes `=`. Every single-month render is untouched, so every check
written before ranges existed stays green; only a range of two or more months
shrinks, and it shrinks to a figure that looks perfectly plausible.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T24 a span P&L is the sum of its months               {"feb":"-700000","mar":"-300000","span":"-700000"}
=== 1 CHECK(S) FAILED ===
```

## The untagged report goes back to watching only the end balance

`marker 189`

The movement arm of the check is removed — the shape it had before ranges.
An untagged account whose money washes in and out inside the range ends at
zero and vanishes from the report, while the range it moved through is missing
that money from a statement whose totals still agree.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T27 untagged movement is reported even at zero balance  {"span":[],"single":[]}
=== 1 CHECK(S) FAILED ===
```

## A closed year's P&L reads zero and nobody is told why

`marker 190`

The sentence goes; the figures were already zero. 'Last year' on a closed
year reports that the company earned nothing, every total agrees, and the only
thing that was ever wrong is the missing explanation — which is why the
explanation is guarded like a figure.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T26 a range covering the close reads zero and says why  {"rev":"0","problems":[]}
=== 1 CHECK(S) FAILED ===
```

## The span trial balance adds up its closing balances

`marker 191`

The FILTER pinning `balance` to the END period goes, so a two-month span
sums two month-end positions into one impossible one. Movements still sum to
themselves and the screen's own total row still foots — the CSV export cannot
disagree either, because it reads the same function, which is exactly why a
check outside that function has to exist.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T28 the span trial balance snaps, sums, and closes at the end  {"snapped":true,"cash":{"id":"c8947129-baf8-421c-8fe9-7d31785ea3d8","code":"1000","name":"Cash — Operating","debit":"25000","credit":"25000","balance":"5925000"},"close":"2975000","revCredit":"1000000","zero":"0"}
=== 1 CHECK(S) FAILED ===
```

## GST paid becomes GST owed

`marker 192`

One word in the role map: an expense's GST now lands on the PAYABLE account.
Every entry still balances, the bank still moves the right total, and the next
GST/HST return both under-claims and over-remits — the same dollars, wrong on
both lines at once.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q1 an expense: bank pays the total, GST is recoverable  {"1000":"-10500","2100":"500","5000":"10000"}
FAIL  Q1b PST on an expense folds into the cost             {"1000":"-11200","2100":"500","5000":"10700"}
FAIL  Q4b GST with no account in the role is refused        No active account carries the gst_hst_payable role. Give one that role in the chart of accounts, or enter the total without GST.
FAIL  Q5 the return sees GST only; income PST stays out of collected  {"itcs":"0","collected":"1000"}
FAIL  Q7c a tagged inclusive amount posts the derived figures  {"ok":"Posted as EXP-00013.","lines":{"1000":"-11200","2100":"500","5000":"10700"}}
FAIL  Q8 several items, one entry, the bank pays the lot    {"rows":4,"lines":{"1000":"-14980","2100":"700","5000":"10000","5150":"4280"},"byCode":{"1000":null,"2100":"GST/HST","5000":"Chair","5150":"Paper"}}
FAIL  Q9 the form posts rows through the one reader         {"1000":"-14200","2100":"500","5000":"10700","5150":"3000"}
=== 7 CHECK(S) FAILED ===
```

## Income posts the way an expense does

`marker 193`

The sign stops depending on the kind. A deposit CREDITS the bank and DEBITS
revenue — money recorded as leaving while it arrived. The entry balances
perfectly; only the direction of every line is wrong.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q2 income: bank receives the total, GST is payable    {"1000":"-21000","2100":"1000","4000":"20000"}
FAIL  Q2b PST collected lands on its own payable account    {"1000":"-22400","2100":"1000","2150":"1400","4000":"20000"}
FAIL  Q5 the return sees GST only; income PST stays out of collected  {"itcs":"1000","collected":"-2000"}
FAIL  Q8b income items: PST collected is one payable line   {"1000":"-27400","2100":"1000","2150":"1400","4000":"20000","4100":"5000"}
=== 4 CHECK(S) FAILED ===
```

## An expense form takes expense accounts again

`marker 194`

The type gate comes back. It was here until 2026-09-07 and read like a
rule; it was a habit. A laptop bought on the company card, a loan
repayment, the financed half of a purchase — all refused by a sentence that
sounds like bookkeeping. What is still refused, and must be, is an account
that is not this company's or not postable. `Q4f` puts an asset on an
expense form.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q4f a line may be any account, not only the type the form is named after  it threw instead of posting: A line must land in an active, postable account of this company.
FAIL  Q4f a line may be any account, not only the type the form is named after  {}
FAIL  Q4l an asset funded by a director                     it threw instead of posting: A line must land in an active, postable account of this company.
FAIL  Q4l a funded asset expense without a supplier stays unassigned  
=== 4 CHECK(S) FAILED ===
```

## A rename stops being told about the name it takes

`marker 195`

updateParty's duplicate check goes — block 111's finding through the other
door. The rename does NOT get in; the index on the normalised name still
refuses. What is lost is the sentence naming the record you collided with,
replaced by a raw constraint violation.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P47 a rename cannot take a living name                             Failed query: 
=== 1 CHECK(S) FAILED ===
```

## The delete refusal arrives as a failed query

`marker 196`

The translation goes. The party is still not deleted — 0025's trigger holds —
but the reader gets 'Failed query: DELETE FROM party' instead of how many
journal lines name them and what to do about it. A refusal that does not say
the next move teaches the reader to stop trusting refusals.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P49 a party on a journal line cannot be deleted                    Failed query: 
=== 1 CHECK(S) FAILED ===
```

## Two reports lose their seat and stay reachable only by URL

`marker 197`

Reports stops covering /aging, /statements and /breakdown. The screens still
render at their addresses, every deep link and bookmark works, and no click
path in the application reaches them — the router and the rail disagreeing
about what the application is, with nothing else holding them together.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N1 every module with a page has a seat, or is a declared detail route  orphans: aging, breakdown, statements
FAIL  N18 every ledger path has a seat somebody chose, and every action names the seat its form is actually under  /aging belongs to no seat and is not declared in DETAIL_ROUTES; /aging/pdf belongs to no seat and is not declared in DETAIL_ROUTES; /breakdown belongs to no seat and is not declared in DETAIL_ROUTES; /breakdown/pdf belongs to no seat and is not declared in DETAIL_ROUTES; /statements belongs to no seat and is not declared in DETAIL_ROUTES; /statements/pdf belongs to no seat and is not declared in DETAIL_ROUTES
FAIL  N19 every door in the rail opens for an owner                        shut for an owner: Reports › Financial statements /statements; Reports › Aging /aging
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 4 CHECK(S) FAILED ===
```

## Picking a month throws the reader back to the top

`marker 198`

The scroll pin goes — the exact complaint that opened this batch, restored
one option at a time. The picker still navigates, the figures still update,
and every pick loses the reader's place on the page.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N5 refining a page replaces in place; going elsewhere pushes         the range picker replaces with scroll:false and never pushes; the box pushes only when it leaves
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The span trial balance quietly reads one month's movement

`marker 199`

The WHERE that gathers the covered months is pinned back to the end period —
the exact shape the function had to grow out of. Closing balances stay right,
debits still equal credits (any subset of whole months balances), and a
two-month range reports one month's activity under a two-month heading. Critic
round 1 found no check held the magnitude; `T28` now pins it to a figure.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T28 the span trial balance snaps, sums, and closes at the end  {"snapped":true,"cash":{"id":"6f418717-d320-4dec-955d-99c4a7f2128a","code":"1000","name":"Cash — Operating","debit":"25000","credit":"0","balance":"2975000"},"close":"2975000","revCredit":"300000","zero":"0"}
=== 1 CHECK(S) FAILED ===
```

## An invoice's entry stops naming its door

`marker 200`

One word in the prefix map: entries from sales invoices go back to calling
themselves JE. Nothing else changes — the entry posts, the books balance, and
the journal stops saying which rows the invoice module wrote, which was the
entire point of the label.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V09 posting it produces one journal entry, numbered by its door  JE-00001, 150000
FAIL  V100 an edit moves the document and its entry together    600.00 -> 750.00, entry JE-00012 follows to 2026-07-06
=== 2 CHECK(S) FAILED ===
```

## PST on an expense stops being part of the cost

`marker 201`

The fold goes. The bank still pays amount + GST + PST, the expense line drops
back to the pre-tax amount, and the entry no longer balances — postEntry
refuses it. What the block proves is that the refusal is CAUGHT as a red
check rather than killing the suite: a crashed suite records nothing, and a
guard nobody has watched fail is a guard on trust.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q1b PST on an expense folds into the cost             it threw instead of posting: Debits and credits differ by -7.00. An entry must net to zero.
FAIL  Q1b PST on an expense folds into the cost             {}
FAIL  Q5 the return sees GST only; income PST stays out of collected  {"itcs":"500","collected":"2000"}
FAIL  Q7c a tagged inclusive amount posts the derived figures  {"ok":"Debits and credits differ by -7.00. An entry must net to zero.","lines":{}}
FAIL  Q8 several items, one entry, the bank pays the lot    it threw instead of posting: Debits and credits differ by -2.80. An entry must net to zero.
FAIL  Q9 the form posts rows through the one reader         Debits and credits differ by -7.00. An entry must net to zero.
=== 6 CHECK(S) FAILED ===
```

## PST collected drifts into the GST box

`marker 202`

The income-side PST role becomes the GST role. Every entry still balances;
the province's money sits in the CRA's account, the next GST/HST return
over-reports what was collected, and the PST return under-reports — the same
dollars wrong on two government forms at once.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q2b PST collected lands on its own payable account    {"1000":"22400","2100":"-1400","4000":"-20000"}
FAIL  Q4d PST collected with no account in the role is refused  No active account carries the gst_hst_payable role. Register for PST in the sale
FAIL  Q5 the return sees GST only; income PST stays out of collected  {"itcs":"1000","collected":"3400"}
FAIL  Q8b income items: PST collected is one payable line   {"1000":"27400","2100":"-1400","4000":"-20000","4100":"-5000"}
=== 4 CHECK(S) FAILED ===
```

## Removing lines from the cache books them on the other side

`marker 205`

The mirror stops mirroring: undoing a debit is recorded as adding a credit.
Every closing balance still agrees — net movement is unchanged — and both
movement columns quietly inflate on every edit. This is the exact defect E2
caught on the door's first run; the block keeps it caught.

```
$ db:verify | npm run db:verify
FAIL  E2 the balance cache moved with the edit        4 disagreements
FAIL  E5b and the cache moved with the delete         4 disagreements
FAIL  E9 a cross-month edit moves the figures with the date  {"may":"286800","june":"4000","period":"6","drift":4}
=== 3 CHECK(S) FAILED ===
```

## Every door opens from the journal side

`marker 206`

The wrong-door gate goes. An invoice's entry can now be deleted directly,
leaving the invoice pointing at nothing and still telling its story; the
document and the ledger stop having to agree.

```
$ db:verify | npm run db:verify
FAIL  E6 an entry from another door names that door   expected WRONG_DOOR, got PERIOD_CLOSED: OPN-00001 sits in 2026-01, which is closed. Reopen the period, or correct it with a reversal — a closed period is the freeze.
=== 1 CHECK(S) FAILED ===
```

## The wall stops asking who is knocking

`marker 207`

0038's flag check is patched out of the database: every UPDATE is treated as
having come through the application. Raw SQL edits a live entry with no
rebalance and no audit — the exact hole the flag exists to close. Applied to
the test database; the migration file is append-only.

```
$ db:verify | npx tsx scripts/verify-posting.ts
FAIL  E3 raw SQL still bounces off the wall           a bare UPDATE went through
=== 1 CHECK(S) FAILED ===
```

## A deletion stops telling anyone what died

`marker 208`

The audit write goes. The entry vanishes, the cache rebalances, the number
gap remains — and the gap now points at nothing: no actor, no date, no lines.
The owner accepted gaps BECAUSE the audit row holds the whole story; without
it a gap is just a hole.

```
$ db:verify | npm run db:verify
FAIL  E5 a delete leaves the gap and the audit tells the whole story  {"still":"0","next":"JE-00007"}
=== 1 CHECK(S) FAILED ===
```

## The invoice door forgets its own name

`marker 209`

editInvoice stops telling the entry layer which door it is, so the wrong-door
gate turns the regeneration away and every edit of a posted invoice is
refused. The failure is loud — but a quieter cousin (regenerating with the
wrong source) would relabel the entry, which is why the door name is passed
rather than assumed.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V55 the edit form moves the document and its entry        INV-00011: this entry belongs to a sales invoice — edit or delete the invoice itself.
FAIL  V100 an edit moves the document and its entry together    it threw: INV-00012: this entry belongs to a sales invoice — edit or delete the invoice it
FAIL  V100 an edit moves the document and its entry together    600.00 -> 750.00, entry INV-00012 follows to 2026-07-05
FAIL  V101 an edit releases what was applied, and says how much  it threw: INV-00012: this entry belongs to a sales invoice — edit or delete the invoice it
FAIL  V101 an edit releases what was applied, and says how much  balance 550.00 -> 800.00, undefined application released
FAIL  V103 a delete takes document and entry together, audited  INV-OB-1 gone, cache clean, audit holds the document
FAIL  V107b retagging recomputes the generated lines, nothing else  total 112.00
FAIL  V109 a credit note saved unchanged stays itself           INV-00017: this entry belongs to a sales invoice — edit or delete the invoice itself.
FAIL  V119 the edit door files its paper, and every receipt on the entry follows the edit  BILL-00006: this entry belongs to a purchase bill — edit or delete the bill itself.; 2026-04-11 300.00.pdf
=== 9 CHECK(S) FAILED ===
```

## Saving an invoice quietly stops entering it

`marker 210`

The posting half of the save goes. The form still says it saved, the list
still shows the document — as a draft, in no balance and on no statement,
and nobody pressed anything that says draft. Open books made the save BE the
entry; this is the save going back on that word silently.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V54 the save has already entered the books                draft
FAIL  V110 the create form mints a real credit note, receivable credited  credit_note; control no line
FAIL  V117 a bill posted with its paper files it against the entry, renamed for the date and amount  Saved to the books. The file could not be filed against it (There is no such entry in these books.); attach it from the entry by hand.; nothing filed
FAIL  V119 the edit door files its paper, and every receipt on the entry follows the edit  Draft saved. Review and post when ready. The file was not attached. Post this draft first, then attach it.; 
=== 4 CHECK(S) FAILED ===
```

## The live cache goes back to netting a wash to nothing

`marker 211`

applyBalanceDeltas nets per account again. An entry that debits AND credits
the same account — the contra-settlement wash is a real, legal shape — lands
in the cache as no movement at all, while the journal, the rebuild, and the
integrity check all count both sides. Every closing balance agrees; the
movement columns are quietly wrong until the first side-comparing probe.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM40b and the cache moved with it                             1 disagreements
=== 1 CHECK(S) FAILED ===
```

## An inclusive total stops reproducing itself

`marker 213`

The rounding remainder stays in the backed-out base instead of being folded,
so base + GST + PST can miss the typed total by a cent. Nobody types 100.01
to watch a penny vanish; they type a till receipt and the books disagree with
the paper in their hand.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q7b inclusive backs the base out and always re-adds to the total  {"base":"8929","gst":"446","pst":"625","total":"10001"}
=== 1 CHECK(S) FAILED ===
```

## A purchase claims its PST back after all

`marker 214`

The fold goes: the PST stays out of the cost line, and since purchases
generate no PST line either, the money simply vanishes from the document —
the bill totals less than the supplier charged, by exactly the PST.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V106 a purchase folds PST into the cost and claims only the GST  line 100.00, GST -> 2310
=== 1 CHECK(S) FAILED ===
```

## A generated tax line forgets who generated it

`marker 215`

The GST line the tags produce loses its provenance mark. The next edit loads
it as a line somebody typed, recomputes tax on top of it, and every save
grows the document by one more tax line — compounding quietly, one edit at a
time.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V105 a sales tag generates the collected-tax lines        total 112.00; GST -> undefined, PST -> 2350
FAIL  V106 a purchase folds PST into the cost and claims only the GST  line 107.00, GST -> undefined
FAIL  V107 inclusive amounts back the base out and keep the total  total 112.00
FAIL  V122 credit-note tax lines preserve actual amounts and direction  GST 4.75; PST 6.80
=== 4 CHECK(S) FAILED ===
```

## The edit door forgets what kind of document it is reading

`marker 216`

ledgerAmount keys on direction alone again — the exact defect the critic's
BLOCK was for. A sales credit note opened in the edit form and saved
UNCHANGED flips every line's sign, and the refusal blames the person: 'what
you have is an invoice; issue one of those instead.' Every credit-note edit
is refused; every check that only edits invoices stays green.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V47 the sign keys on direction AND kind, like its inverse  -120000 / -120000
FAIL  V110 the create form mints a real credit note, receivable credited  undefined; control no line
FAIL  V109 a credit note saved unchanged stays itself           These lines debit the control account by 80.00, and a sales credit note has to credit it. What you have is a invoice; issue one of those instead.
FAIL  V122 credit-note tax lines preserve actual amounts and direction  GST 4.75; PST 6.80
=== 4 CHECK(S) FAILED ===
```

## The cascade stops releasing the applications

`marker 217`

releaseReferences keeps its hands off invoice_application. The delete then
hits the foreign key and dies as a raw failure — nothing is lost, but the
owner's one-action rule is gone and the refusal is a stack trace instead of
a sentence. Caught as a red check, not a dead suite.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM40 deleting a payment releases what it settled              it threw: Failed query: DELETE FROM journal_entry WHERE id = $1::uuid
FAIL  PM42 deleting an applied manual entry releases the application  it threw: Failed query: DELETE FROM journal_entry WHERE id = $1::uuid
=== 2 CHECK(S) FAILED ===
```

## An edit stops saying what changed

`marker 218`

The audit row's action label drifts, and E1b's read finds no 'edit' row: the
books moved, the cache moved, and the trail has a hole exactly where the
owner's open-books trade-off depends on it not having one.

```
$ db:verify | npm run db:verify
FAIL  E1b and the edit audit holds both sides, lines included  "no row"
=== 1 CHECK(S) FAILED ===
```

## A cross-month edit leaves the later months where they were

`marker 219`

removeBalanceDeltas stops shifting the openings after the old month. Moving
an entry from May to June then double-counts it from June onward — May gave
nothing up downstream — and only a check that actually crosses the boundary
can see it.

```
$ db:verify | npm run db:verify
FAIL  E2 the balance cache moved with the edit        28 disagreements
FAIL  E5b and the cache moved with the delete         28 disagreements
FAIL  E9 a cross-month edit moves the figures with the date  {"may":"185100","june":"4000","period":"6","drift":28}
=== 3 CHECK(S) FAILED ===
```

## The cascade stops releasing the bank matches

`marker 220`

The other half of 217: bank_match stays, the foreign key fires, and deleting
a reconciled entry becomes a raw failure instead of the one action the owner
asked for.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  the suite threw before it finished                          Failed query: DELETE FROM journal_entry WHERE id = $1::uuid
=== 1 CHECK(S) FAILED ===
```

## The statement period counts its own beginning twice

`marker 221`

The report's row sum takes txn_date >= the prior statement's date instead of
strictly after it. A row dated exactly ON a statement date is inside that
statement's period and the next one's too, and the import gap moves by that row
while every row-level match stays perfectly green. M73's fixture has a row on
the boundary for exactly this.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M73 the next report chains from the last and the gap names the missing row  begins 1540205 at 2026-12-01, period 2000, gap 20000
FAIL  M74 the report page prints the gap and says a row is missing  Import gap 200.00: the rows on file do not reach the printed ending balance — a row is mis
=== 2 CHECK(S) FAILED ===
```

## A statement continues from itself instead of the one before

`marker 222`

The prior-statement lookup takes <= instead of <, so every report begins at its
own printed ending. The first statement still reads perfectly — it has no prior
either way — and every later one starts from the wrong figure with an empty
period behind it.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M72 the first report starts at zero and the complete import closes the gap  rows 0, implied 1540205, gap 0
FAIL  M73 the next report chains from the last and the gap names the missing row  begins 1562205 at 2026-12-15, period 0, gap 0
FAIL  M74 the report page prints the gap and says a row is missing  
FAIL  M77 the reconciliation PDF carries the gap and the four-part summary  Where the account started — the opening balance — a position, not some
=== 4 CHECK(S) FAILED ===
```

## The import gap changes sign

`marker 223`

Implied minus printed instead of printed minus implied. A zero gap is zero
either way, so the complete-import case — M72, and every statement typed to
agree — stays green; only a statement that actually disagrees can tell the two
apart, and then the report sends the reader hunting in the wrong direction.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M73 the next report chains from the last and the gap names the missing row  begins 1540205 at 2026-12-01, period -3000, gap -25000
FAIL  M74 the report page prints the gap and says a row is missing  Import gap -250.00: the rows on file do not reach the printed ending balance — a row is mi
=== 2 CHECK(S) FAILED ===
```

## The duplicate statement arrives as a stack trace

`marker 224`

The unique-violation translation looks for a constraint that does not exist,
so typing the same date twice surfaces the driver's own error instead of the
sentence that says delete-and-re-enter. The insert is still refused — the
database holds — but the person is handed a Failed query.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M71 the same date twice is refused toward delete-and-re-enter  expected STATEMENT_EXISTS, got Error: Failed query: 
=== 1 CHECK(S) FAILED ===
```

## The report calls every import complete

`marker 225`

The verdict keys on >= 0 instead of === 0. A statement whose printed balance
exceeds what the rows imply — a deposit never imported, the commonest miss —
gets the quiet green sentence, and the one line this feature exists to shout is
shown only for gaps in the other direction.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M74 the report page prints the gap and says a row is missing  
=== 1 CHECK(S) FAILED ===
```

## The report drops the book-side summary

`marker 226`

The shared Summary stops being rendered on the statement report. The import
check above it stays right, so the page still looks like a report — but the
four-part explanation of the book difference, the half that says what is still
outstanding, is simply gone, and nothing else on the page says it.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M75 and the report carries the four-part summary block      
=== 1 CHECK(S) FAILED ===
```

## Every journal line quietly loses its party on the way in

`marker 227`

The form reader stops handing the per-line party over. The select is on the
screen, the ledger column exists and P10 watches it hold what it is given —
but everything typed through the journal form arrives with no party at all,
and aging by party silently stops seeing manual entries. The reader is the
one seam between the screen's JSON and the lib, and it is the seam this
mutation cuts.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P52 the entry form reader carries each line party, blank meaning nobody  undefined / undefined
=== 1 CHECK(S) FAILED ===
```

## The general ledger opens every account on the wrong side

`marker 228`

Opening = closing minus net movement, and the mutation swaps the net. Any
account whose debits equal its credits — the quiet ones — still opens right,
and every other account opens wrong by exactly twice its movement. X16 holds
opening + the shown rows to the closing balance, across two different readers
(period_balance for the summary, journal_line for the rows), so the swap has
nowhere to hide.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X16 the general ledger ties the balance cache to the journal, per account  1000: -300000 + rows != -150000; 1200: 1130000 + rows != 565000; 1900: 60000 + rows != 30000; 2100: -130000 + rows != -65000; 4000: -1000000 + rows != -500000; 5000: 240000 + rows != 120000
FAIL  X26 every trial balance figure opens into opening + rows = closing  1000: opening+rows -450000 != -150000; 1200: opening+rows 2025000 != 675000; 1900: opening+rows 90000 != 30000; 2100: op
FAIL  X29 the breakdown CSV re-adds to the figure that was clicked  opening + rows = -1500.00
FAIL  X31 a balance with no from opens at zero and shows its whole history  opening 13,500.00, 3 rows, closing 6,750.00
FAIL  X31b a statement position row drills to a zero opening, not a window  kind=account&account=e30dcc7c-b55c-42f3-b6ee-98dd640b0a00&to=2026-03-31 -> opening 13,500.00, closing 6,750.00
=== 5 CHECK(S) FAILED ===
```

## Every PDF prints its first column and nothing else

`marker 229`

The one table writer draws only cell zero. Labels survive, so the file still
looks like a report at a glance — and every figure on every generated PDF is
gone. The checks read the files back independently (pdf-text decodes the TJ
arrays) and expect the money.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X17 the trial balance PDF shows every account and its own total  missing: Cash — Operating, main, Receivables, Suspense, GST/HST Payable, Revenue, Fees, professional
FAIL  X18 the statement PDF carries every total line the screen shows  Operating profit 3,800.00; Profit before tax 3,800.00; Profit for the 
FAIL  X19 the general ledger PDF has every account, opened and closed  1000, 1200, 1900, 2100, 4000, 5000
FAIL  X30 the breakdown PDFs carry the rows and the figure  aging cell 800.00; cash closing -1,500.00
FAIL  X47 a year by month leaves as a turned sheet with twelve columns and a total  12 month heading(s) and TOTAL; “Profit for the period” is followed by 0 figure(s); page box 0 0 792 612 for thirteen columns, 0 0 612 792 for four; one month by month: 0 figure(s) after the total line, 0 TOTAL/CLOSING heading(s), and it says why
FAIL  X49 the workbook carries the quarters and their total as numbers, turns when wide, and a breakdown beats a comparison  header 2026-01 – 2026-03 | 2026-04 – 2026-06 | 2026-07 – 2026-09 | 2026-10 – 2026-12 | Total; 15 row(s) whose total is the sum of four, 0 not; orientation by quarter/by month portrait/landscape; asked for both, the total line is followed by 0 figure(s)
FAIL  X50 a figure is never broken across lines, and a heading that wraps pushes the rows down  0 of 13 wide figures drawn whole at ?pt; the last heading is CLOSING, whole; a quarter heading drawn as “2026-01 –” 676.0pt up over “2026-03” at 667.7, and the row 13.4pt under that
=== 7 CHECK(S) FAILED ===
```

## The second profit and loss quietly comes back

`marker 230`

The owner kept ONE P&L (2026-09-02, by nature). Drop the filter and the
by-function template is offered again everywhere statements are listed — the
reopened decision the repo's discipline names. X24 counts the income
statements on offer and names the survivor.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X24 one profit and loss is offered, and it is the by-nature one  IFRS_PL_FUNCTION_EN, IFRS_PL_NATURE_EN
=== 1 CHECK(S) FAILED ===
```

## The trial balance PDF forgets its own total

`marker 231`

The totals row is dropped. Every account line is still right, so a reader
adding the column by hand finds nothing wrong — the file just stops carrying
the figure that lets them NOT add the column by hand. X17 expects the total
the accounts imply.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X17 the trial balance PDF shows every account and its own total  6 accounts, total 7,150.00
FAIL  X40 the trial-balance workbook: numbers in accounting format, bold header, ruled total, frozen header  format xlsx, header bold true, total cell undefined fmt undefined, model 837000, ruled undefined
=== 2 CHECK(S) FAILED ===
```

## The reconciliation PDF drops the four-part summary

`marker 232`

The import check stays; the book-side split goes. The paper still opens with
the gap, so it reads complete — but what explains the difference between
statement and books is exactly the half that vanished, and M77 expects its
rows on the page.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M77 the reconciliation PDF carries the gap and the four-part summary  Import gap 250.00: the rows on file do not reach the printed ending ba
=== 1 CHECK(S) FAILED ===
```

## The invoice PDF bills the total as the balance due

`marker 233`

A part-paid invoice's PDF says the customer owes the full amount again. The
total line is right, the payments are listed — and the one figure a customer
acts on contradicts both. DC10 holds the PDF to the renderer's balance, and
the fixture is part-paid so total and balance differ.

```
$ db:verify-documents | npm run db:verify-documents
FAIL  DC10 the invoice PDF carries the renderer, total to balance to tax number  missing: 1,050.00
=== 1 CHECK(S) FAILED ===
```

## The general ledger PDF starts every account at nothing

`marker 234`

The opening-balance row is dropped. The rows and the closing line survive, so
an account that started the span at zero prints identically — and every
account that carried a balance in loses the line that says so. X19 expects
the opening on paper.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X19 the general ledger PDF has every account, opened and closed  6 accounts on paper
=== 1 CHECK(S) FAILED ===
```

## The register PDF prints its headings over an empty table

`marker 235`

Title, statutory notes, column headers — everything that makes the file look
like a register survives; the rows do not. A director asking for the paper
copy gets a well-formed page that names nobody. CR21 reads the file back and
expects every cell the renderer decided.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR21 the register PDF carries the renderer, cell for cell       missing: Dana Chen, 4102 Main St, Vancouver, BC, V5V 3P6, 2020-01-15
FAIL  CR31 the register PDF carries the particulars and the address   1232 characters of text
=== 2 CHECK(S) FAILED ===
```

## The public register omits quietly instead of out loud

`marker 236`

The withheld-fields note is dropped from the PDF. The public copy already
hides the private columns — rightly — and now nothing on the paper says
anything WAS hidden, so an incomplete register reads as a complete one. CR21b
expects the omission named.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR21b and the public copy names what it withheld                became_on, birth_date, ceased_on, citizen_or_pr, citizenships, how_control, last_known_address, name, tax_resident_ca
=== 1 CHECK(S) FAILED ===
```

## A total line's breakdown forgets which way the statement reads

`marker 237`

The parent's sign flip is dropped from every formula term, so the breakdown
of TOTAL LIABILITIES AND EQUITY presents its terms with the ledger's raw
signs while the statement shows the flipped figure. Each sibling amount looks
plausible alone; only the column refusing to add to the number that was
clicked gives it away, and X25 adds that column for every line.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X25 every IFRS_SFP_EN line's breakdown adds to the line  Total current liabilities: rows sum -65000 != 65000; Total liabilities: rows sum -65000 != 65000; Total equity: rows sum
FAIL  X25 every IFRS_PL_NATURE_EN line's breakdown adds to the line  Operating profit: rows sum -490000 != 490000; Profit before tax: rows sum -490000 != 490000; Profit for the period: rows
=== 2 CHECK(S) FAILED ===
```

## An aging cell collects its own bucket and every older one

`marker 238`

The bucket filter slackens from equality to at-least. The 0-30 cell's
breakdown quietly absorbs the 61-90 entry, its total grows past the matrix
cell it claims to explain, and every row it lists is genuinely open — nothing
about the rows looks wrong. X27 compares every cell against the matrix the
screen printed.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X27 every aging cell opens into rows that sum to it  Drill Down Ltd./0–30: 110000 != 30000; column 0–30
=== 1 CHECK(S) FAILED ===
```

## The account breakdown loses its first entry row

`marker 239`

One slice(1) and the earliest posted line in the range is gone. Opening and
closing still print, the running balances of the remaining rows are still
each true, and the table reads cleanly - it just no longer walks from opening
to closing. X26 redoes that walk from the cells; X29 redoes it from the CSV.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X26 every trial balance figure opens into opening + rows = closing  1000: opening+rows -30000 != -150000; 1200: opening+rows 595000 != 675000; 1900: opening+rows 0 != 30000; 2100: opening+
FAIL  X29 the breakdown CSV re-adds to the figure that was clicked  opening + rows = -1500.00
FAIL  X31 a balance with no from opens at zero and shows its whole history  opening 0.00, 2 rows, closing 6,750.00
=== 3 CHECK(S) FAILED ===
```

## The tax breakdown prints raw amounts instead of contributions

`marker 240`

The exact defect the contribution column was invented for (tax.ts, the
corrected-invoice story), reintroduced at the new exit: each entry shows its
ledger magnitude, a reversal looks like an addition, and the column no longer
adds to the line on the return. X28 adds it.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X28 every GST line breaks down to entries that sum to it  line 101: 610000 vs 610000; line 105: 65000 vs 65000
=== 1 CHECK(S) FAILED ===
```

## The breakdown CSV keeps only its bold rows

`marker 241`

The data rows vanish from the file; the title, the headings and the closing
line survive, so the file opens looking finished. A reader who trusts the
bottom line is fine - one who re-adds the rows, which is the point of
exporting them, gets a different number. X29 is that reader.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X29 the breakdown CSV re-adds to the figure that was clicked  opening + rows = -1500.00
=== 1 CHECK(S) FAILED ===
```

## The breakdown PDF is a title over an empty table

`marker 242`

Every row is dropped at the PDF exit only; the overlay and the CSV still
show them, so clicking around the screen finds nothing wrong. X30 reads the
file back and expects the rows and the figure.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X30 the breakdown PDFs carry the rows and the figure  aging cell 800.00; cash closing -1,500.00
=== 1 CHECK(S) FAILED ===
```

## An untouched account has no breakdown at all

`marker 243`

The fallback lookup for an account the span's balances never met is removed.
Clicking the zero gets 'nothing to break down' - a dead end exactly where a
person is asking why a figure is zero. X26b clicks it.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X26b an untouched account breaks down to an explained zero  no breakdown
=== 1 CHECK(S) FAILED ===
```

## Owed-by-nobody lists everybody instead

`marker 244`

The party-less filter flips, so the unattributed breakdown lists exactly the
entries that ARE attributed. Every row shown is a real receivable and the
page looks perfectly healthy; only the total refusing to match the figure
that was clicked says otherwise. X27b pins that figure.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X27b the unattributed figure breaks down to its entries  1,100.00 with no party named
=== 1 CHECK(S) FAILED ===
```

## The year-so-far breakdown forgets the expenses

`marker 245`

The one query in breakdown.ts that cannot reuse its report's reader — the
renderer keeps a single SUM, this groups it — drops 'expense' from its
predicate. Every row it still lists is a true revenue figure; the column just
no longer re-adds to the profit line the person clicked, which is exactly the
drift a second spelling invites and why X25 adds the column for every line.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X25 every IFRS_SFP_EN line's breakdown adds to the line  Profit for the period: rows sum 610000 != 490000
=== 1 CHECK(S) FAILED ===
```

## A balance with no from explains only its own month

`marker 246`

The missing-from fallback resolves to `to` instead of the books' first
period. The drill behind every closing figure quietly becomes 'opening
20,000, closing 20,000' for any quiet month — the exact useless page the
owner reported — while every row it does show is true. X31 demands the zero
opening and the whole history.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X31 a balance with no from opens at zero and shows its whole history  opening 800.00, 2 rows, closing 6,750.00
FAIL  X31b a statement position row drills to a zero opening, not a window  kind=account&account=e9d337b8-9294-4444-9f19-748233d77083&to=2026-03-31 -> opening 800.00, closing 6,750.00
=== 2 CHECK(S) FAILED ===
```

## A statement position row drills into a window again

`marker 247`

The account link under a balance-sheet line carries the statement's own
range regardless of basis — the shape this feature replaced. Over a Feb–Mar
statement the receivables drill opens at February's opening and January's
800.00 is silently inside it. X31b feeds the link's own address back into
the derivation and demands the zero opening.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X31b a statement position row drills to a zero opening, not a window  kind=account&account=ad9cba51-5b9f-403f-8785-5fd4a6a99b5c&from=2026-02-01&to=2026-03-31 -> opening 800.00, closing 6,750.00
=== 1 CHECK(S) FAILED ===
```

## The trial balance quietly loses its All time button

`marker 248`

One prop dropped and the report is back to four calendar presets; every
range still works, every figure still drills, and the whole-history view the
owner asked for is simply gone. N6 reads the wiring at both ends.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N6 every report range picker offers All time                         not passing allFrom: src/app/ledger/[ledgerId]/reports/trial-balance/page.tsx
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The quick form reads only the first row

`marker 250`

One slice and every receipt is its first item again — the exact complaint
this feature answered. The single-row path still works, the posted entry
balances, and the second row's money simply never arrives. Q9 posts two rows
and counts what landed.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q9 the form posts rows through the one reader         {"1000":"-11200","1300":"500","5000":"10700"}
FAIL  Q9b a half-filled row is refused by name              {"ok":"Posted as EXP-00016.","entryId":"76675aa1-6f58-42f6-878b-30f23c7aff42"}
FAIL  Q9c a described row with no figures is refused, not dropped  {"ok":"Posted as EXP-00017.","entryId":"535563eb-5419-4756-8365-ac1a1b002e8c"}
=== 3 CHECK(S) FAILED ===
```

## The party dropdown quietly shuts directors out again

`marker 251`

The old vocabulary sneaks back as a filter on the dropdown query alone: the
database would accept the director, but no screen ever offers one. P15b asks
the same list the entry screens ask.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P15b the entry screens offer the director, labelled                not offered
=== 1 CHECK(S) FAILED ===
```

## The GST line carries only the last item's tax

`marker 252`

The reduce forgets its accumulator, a one-character slip. With one taxed
item nothing changes — every original check stays green — and a receipt
whose items BOTH carry GST posts an entry that no longer balances and is
refused. Q8 taxes two items and pins the one summed line.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q8 several items, one entry, the bank pays the lot    {"rows":4,"lines":{"1000":"-14480","1300":"200","5000":"10000","5150":"4280"},"byCode":{"1000":null,"1300":"GST/HST","5000":"Chair","5150":"Paper"}}
FAIL  Q8b income items: PST collected is one payable line   {"1000":"26400","2150":"-1400","4000":"-20000","4100":"-5000"}
FAIL  Q9 the form posts rows through the one reader         {"1000":"-13700","5000":"10700","5150":"3000"}
=== 3 CHECK(S) FAILED ===
```

## The receipt is filed under one account and nobody notices

`marker 253`

treePaths keeps only the first touched account. The expense folder has the
receipt, the bank folder silently does not, and every upload still succeeds —
the exact half-filed state the per-entry binding exists to prevent. AT1 looks
in EVERY touched account's folder; AT7's sweep counts what a rebuild lays
down.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT1 one file, filed under every touched account by month  blob + 5000 and 1000 links, month 2026-02
=== 1 CHECK(S) FAILED ===
```

## The integrity sweep stops reading the bytes

`marker 254`

The hash comparison is skipped. Every file 'checks out' forever, including
the one a sync tool half-wrote and the one somebody edited — the sweep is
the only reader that ever re-hashes, so with it blind, corruption is
permanent and silent. AT3 tampers with a blob and expects to be caught.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT3 an altered file is caught by its own hash             nothing reported
=== 1 CHECK(S) FAILED ===
```

## The reminder chases nothing

`marker 255`

The no-attachment condition falls out of missingReceipts, so the reminder
either lists every expense forever or none once each has any history — either
way it stops meaning 'this one lacks its paper'. AT4 files the paper and
expects the entry to leave the list.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT4 the reminder chases expenses only, until the paper arrives  2 chased before, 2 after
=== 1 CHECK(S) FAILED ===
```

## Unfiling one entry shreds the paper itself

`marker 256`

Detach deletes the blob too. The OTHER entry sharing the receipt now points
at nothing; the books still list the attachment and the store cannot produce
it. AT6 unfiles one of two bindings and expects the blob and the other
binding to survive.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT6 unfiling one entry leaves the other entry and the blob alone  filed as 2026-02-10 80.00.pdf,2026-02-10 80.00 (2).pdf; original staples receipt.pdf; link gone true, blob false, other 1, sweep 1
FAIL  AT7 a wrecked tree rebuilds from the truth                rebuild threw: ENOENT: no such file or directory, link '<local-source>
FAIL  AT8 the served file is byte-identical to what was filed   the store could not produce it: ENOENT: no such file or directory, open '<local-source>
=== 3 CHECK(S) FAILED ===
```

## The store files by name as well as content

`marker 257`

The filename leaks into the blob's identity, so the same receipt under two
names is stored twice — the duplication the whole design exists to end, and
nothing about any single upload looks wrong. AT2 counts the physical files.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT1 one file, filed under every touched account by month  blob + 5000 and 1000 links, month 2026-02
FAIL  AT2 same bytes: one blob for two entries, a refusal for one  2 blob file; "This exact file is already on this entry — same by…"
=== 2 CHECK(S) FAILED ===
```

## A closed month starts refusing paper

`marker 258`

A well-meaning gate: the period is closed, so the upload is refused. But an
attachment changes no figure, and receipts are late by nature — the gate
just guarantees the paper never gets filed. The owner chose a reminder over
a gate (2026-09-02), and AT5 files into a closed month on purpose.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT5 a closed month accepts paper, and the filing is audited  refused: The month is closed.
FAIL  AT12 a filed receipt is renamed for the entry's date and amount, keeps its extension, and counts  nothing could be filed: The month is closed.
=== 2 CHECK(S) FAILED ===
```

## The starter chart ships a roleless revenue account

`marker 259`

One template row loses its role. The import still succeeds — untagged is
legal for a person building their own chart — and every dollar of sales in a
NEW company reaches no statement line: the books balance, the P&L is short
by all of revenue, and nothing anywhere looks wrong. A26b refuses a roleless
template row.

```
$ db:verify-accounts | npm run db:verify-accounts
FAIL  A26b every starter role exists and reaches a statement line         unknown: none; reaching no line: none; roleless: 8000
=== 1 CHECK(S) FAILED ===
```

## Tax registration slides back to the pre-GIFI codes

`marker 260`

The proposal vocabulary regresses to 2100/1300. Every new company that
registers gets accounts beside the template's 2680/1066 instead of reusing
them — two spellings of one tax position, born on day one. R26b pins the
fresh-chart proposals; A26c pins the reuse.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R26b a fresh chart is offered the GIFI codes            [{"code":"2100","name":"GST Payable","accountType":"liability","role":"gst_hst_payable","why":"The GST you charge customers, owed to the tax authority until you remit it."},{"code":"1066","name":"GST Recoverable","accountType":"asset","role":"gst_hst_recoverable","why":"The GST you pay on purchases, which you claim back on the return."}]
=== 1 CHECK(S) FAILED ===
```

## Retained earnings drifts off its GIFI item

`marker 261`

3600 becomes the old 3100. Everything still works — roles drive the
statements, not codes — and at tax time the one-to-one mapping the template
exists for has a hole where retained earnings should be. A26 keeps a short
list of anchor codes for exactly this quiet class.

```
$ db:verify-accounts | npm run db:verify-accounts
FAIL  A26 the GIFI starter chart imports whole                            53 rows -> 53 accounts, contras 1061/1741/1775/1788, missing anchors: 3600
=== 1 CHECK(S) FAILED ===
```

## The waiver stops meaning anything

`marker 262`

The reminder forgets to honour receipt_waiver. Every salary run and bank
fee the owner skipped is back on the banner forever, and the skip button
still 'works' — it writes its row, audited and all, into a table nothing
reads. AT11 waives an entry and expects the chase to end.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT11 a waiver ends the chase, reversibly and audited      {"chasedBefore":true,"chasedWaived":true,"chasedAgain":true,"marker":{"created_by":"alicio@example.test","created_at":"2026-10-23 15:23:36.791548-07"},"audit":"2"}
=== 1 CHECK(S) FAILED ===
```

## Corporate records loses a register from its flyout

`marker 263`

One flyout entry gone. Every register still renders at its address, the
records page still links them, and the hover menu the owner asked for is
quietly a third smaller. N7 pins the vocabulary.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N7 the flyouts carry their full vocabulary                           records: 4; reports: 6; payroll: 5; add: 7 doors, literal new-pages present
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The Add menu loses its expense door

`marker 264`

The most-used door falls out of the Add flyout; /expenses still answers,
the rail seat still shows, and the one-hover path the owner asked for is
gone. N7 counts the doors by name.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N7 the flyouts carry their full vocabulary                           records: 5; reports: 6; payroll: 5; add: 6 doors, literal new-pages present
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The browse rows carry the whole entry instead of its expense side

`marker 265`

The account-type filter falls off the aggregate, so every row's amount is
the entry's balanced total: zero. The grouping still looks right, every
entry still shows, and the page sums to nothing while the trial balance
holds the real movement. X32 adds the two readers against each other.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X32 the expenses browse adds to the journal's own sum  1 entries, 0.00 both ways
FAIL  X32 the income browse adds to the journal's own sum  3 entries, 0.00 both ways
=== 2 CHECK(S) FAILED ===
```

## The securities register forgets when a holder ceased

`marker 266`

The CASE that derives 'date ceased' from a zero balance flattens to NULL.
Every former holder still shows — with a dash where BC's template demands a
date — and every current figure is untouched. CR22 and CR23 walk both roads
to zero (transfer and cancellation) and read the date back.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR22 a transferred-out holder keeps a seat and gains a date ceased  became 2023-06-01, ceased null; register row carries it
FAIL  CR23 a cancellation zeroes the holder and the class total together  ceased null, total issued 0
=== 2 CHECK(S) FAILED ===
```

## The transparency register quietly drops former SIs again

`marker 267`

A filter slips back in and ceased significant individuals vanish from the
register — the exact shape this node replaced, where the BCA wants them kept
for six years with their dates. CR24 expects the ceased row, dated.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR14b and a director-audience render shows the sensitive fields  Full name, Born, Last known address, Canadian citizen or PR, Citizenships (if neither), Resident in Canada for tax, How they are a significant individual, Since, Ceased
FAIL  CR24 the transparency register keeps former SIs, dated          0 ceased row(s) on the register; the as-at list drops them
=== 2 CHECK(S) FAILED ===
```

## The new date columns go public again

`marker 268`

0048's visibility rows flip to public — the CSR's dates show beside a
withheld name and holding, and the transparency register hands a lone
Ceased column to anyone who asks. Mutated in 0048 because it OWNS those
rows (the 0045 lesson: a mutation aimed at a file an later migration
re-issues is silently healed). CR25 renders both registers as the public
and refuses the columns.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR25 a public render withholds the new date columns too         CSR shows [Class / series, Became holder, Ceased]; withheld 4/8 fields
=== 1 CHECK(S) FAILED ===
```

## The one date field stops being a date field

`marker 269`

DateInput renders type="text" again. Every date box in the application
still accepts a typed yyyy-mm-dd, still submits, still validates server-side
— and not one of them opens a calendar, which is the whole complaint this
node answers. Nothing about the DATA changes, so only a check that reads the
rendered field can see it: N8.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N8 every date field is the one date field                            DateInput renders type=text, not date
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## One screen goes back to typing its dates

`marker 270`

The register's 'As at' box becomes a plain input — one screen out of
seventeen, which is exactly how this defect spreads: not all at once, but
one field at a time as new screens are written. N8 asks every date-shaped
field NAME which tag carries it, so a single regression is a red line.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N8 every date field is the one date field                            src/app/ledger/[ledgerId]/records/register/[kind]/page.tsx: asOf in <input>
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The browse table's columns stop agreeing with its rows

`marker 271`

The amount column loses its header. Every figure is still right and every
row still complete — the header just declares one column fewer than the rows
carry, which is the ragged-columns defect from the other end. V111 compares
the rendered header against every rendered row rather than trusting either.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V111 the by-party list is one table, every row the same columns  1 table(s), 7 header columns, 28 rows, ragged rows with 8 cells
=== 1 CHECK(S) FAILED ===
```

## The expenses browse shows OUR number as theirs

`marker 272`

The coalesce flips, so a bill browses under the number we filed it as
instead of the supplier's own. The column is full, the heading still says
"Their invoice #", and every figure ties — the one thing wrong is the
identity of the number, which is the only thing the column is for. V112
pins a bill carrying both numbers and names which one must show.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V112 a bill browses under the supplier's own number       doc_ref OURS-1 (ours is OURS-1)
FAIL  V113 the list and the browse call a document by the same number  purchase OURS-1/SUP-7788: list says SUP-7788, browse says OURS-1
=== 2 CHECK(S) FAILED ===
```

## An entry that is its own document loses its number

`marker 273`

The browse reads the invoice's number only, so every quick expense and
every journal entry — the receipts, which are most of them — shows a dash
where its number was recorded. Bills keep theirs, so the column still looks
populated on any page with a bill on it. X33 posts an entry that IS its own
document and reads the number back.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X33 an entry that is its own document carries its own number, once  browse doc_ref none; second home refused by journal_entry_document_ref_has_one_home
=== 1 CHECK(S) FAILED ===
```

## The other side's number gets a second home

`marker 274`

0049's CHECK goes away, and an entry raised by an invoice may keep its own
copy of a number the invoice already holds. Two homes, and the browse's
COALESCE silently prefers one — so the day they disagree, the page shows the
stale one and nothing anywhere says which is right. Mutated in 0049 because
that migration OWNS the constraint (the 0045 lesson). X33 asks for the
refusal by the constraint's own name.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X33 an entry that is its own document carries its own number, once  browse doc_ref R-4021; second home refused by nothing was refused
=== 1 CHECK(S) FAILED ===
```

## The calendar stops opening when the field is clicked

`marker 275`

`showPicker()` goes away. The field is still a native date box — it still
validates, still submits yyyy-mm-dd, still shows Chrome's own 12-pixel icon
at its right edge — and clicking the field, which is what a person actually
does, does nothing. N8 CALLS the component and calls the element's onClick
with a stand-in field, so it can see this; its first version grepped the
source for the string, which the file's own doc comment satisfied (critic,
2026-09-03, who applied this very mutation and watched the check pass).

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N8 every date field is the one date field                            DateInput does not open the calendar when the field is clicked
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The entry form's header forgets the document number

`marker 276`

`entryHeaderFrom` stops reading it, so all four doors that post the journal
form — save, post, edit, amend — go back to dropping it. The amend door is
the one that shows: the Correct panel offers an editable box, accepts the
correction, and re-posts the ORIGINAL number in silence, because amendEntry
inherits what the person just changed. X34 corrects a receipt's number and
reads the replacement back.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X34 correcting an entry corrects the number on its paper  replacement null, reversal R-4021
=== 1 CHECK(S) FAILED ===
```

## The document number rule forgets who raised the paper

`marker 277`

`documentNumber` prefers OUR number on both directions. Every column stays
full and every sales invoice is unaffected, so the invoice list looks
perfect; only a bill changes, and only against the OTHER reader — the
expenses browse still shows the supplier's number, because that rule lives
in SQL. One bill, two numbers, two pages. V113 holds the two languages of
the rule against each other over every document in the fixture.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V113 the list and the browse call a document by the same number  purchase OURS-1/SUP-7788: list says OURS-1, browse says SUP-7788
=== 1 CHECK(S) FAILED ===
```

## The register keeps its particulars to itself again

`marker 278`

The second table stops being built. The holdings summary is unchanged and
correct, every date column still prints, and the half of s.111(1) that asks
for the DATE AND PARTICULARS of each issue and transfer is back in the
table and on no page — which is exactly the state the owner found it in.
CR27 reads the section and ties its balances to the summary; CR31 asks the
PDF for the same thing.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR27 the register prints its particulars, and they add up to the holdings  no particulars section
FAIL  CR31 the register PDF carries the particulars and the address   635 characters of text
=== 2 CHECK(S) FAILED ===
```

## The running balance runs across every holder

`marker 279`

The window loses its holder from the PARTITION, so each line shows the
class's running total instead of that holder's. Every row is present, every
date and certificate is right, and the Balance column quietly answers a
different question — the one thing a reader uses it for is "what did this
shareholder hold at the time". CR27 ties the last balance per holder to
the holding in the summary above.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR27 the register prints its particulars, and they add up to the holdings  1 holder(s) whose last balance is not the holding above: Alicio Xu held 40
FAIL  CR32 a partial transfer surrenders one certificate and issues two  out: surrendered C-10, balance C-12; in: C-11; 2 holdings adrift
=== 2 CHECK(S) FAILED ===
```

## The holder's address goes public

`marker 280`

0050's visibility row flips, and a public inspection copy of the central
securities register carries every shareholder's home address beside a
withheld name. Mutated in 0050 because that migration OWNS the row (the
0045 lesson). CR28 renders the register for the public and refuses it.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR28 the holder address is on the register and off the public copy  77 Water St, Vancouver, BC, V6B 1A; public withholds 5 fields
=== 1 CHECK(S) FAILED ===
```

## The register goes back to saying nothing about later movements

`marker 281`

movementsAfter always answers zero. Every register renders exactly as it
does today, minus one sentence — and a movement dated after the day you
asked about is invisible with nothing to say it exists. This is the owner's
buy-back that appeared to do nothing (2026-09-03): the write was right, the
read was right, and the silence was the defect. CR29 records a later
movement and demands the sentence.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR29 a register says when there are movements after its date    the page said nothing about the later movement
FAIL  CR33 an empty as-at register says what it is not showing        directors: 0 rows, note false; central_securities: 0 rows, note false; transparency: 0 rows, note false
=== 2 CHECK(S) FAILED ===
```

## The confirmation stops mentioning that the date is ahead

`marker 282`

The future arm of the message goes away, so recording a movement for next
month answers with a cheerful sentence and no hint that today's register
will not show it. The other half of the same silence, at the other end of
the same click. CR30 posts a form dated 2099 and reads the message back.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR30 recording a future-dated movement or cessation says so in the message  rows: Entered 1 share movement. It is dated 2099-01-01, which is after today (2026-10-23), so a register as at today does not show it yet. / cease: Ceased — the row keeps its dates — dated 2099-06-30.
=== 1 CHECK(S) FAILED ===
```

## A transfer forgets who it was with

`marker 283`

The paired-row lookup matches the row itself, so every transfer reads
"Transfer from" its own holder. The section still prints, the balances
still add up, and the particular the Act actually asks for — from whom —
is a tautology. CR27 pins both directions by name.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR27 the register prints its particulars, and they add up to the holdings  4 transfer(s) naming their own holder as the other side
=== 1 CHECK(S) FAILED ===
```

## The balance certificate goes to the wrong hands

`marker 284`

On a transfer, the certificate the transferor SURRENDERS and the balance
certificate they get BACK swap places. Both numbers are on the page, on the
right row, in the wrong columns — a minute book that says the certificate
just cancelled is the one the holder still has. CR32 records a partial
transfer with all three certificate numbers and reads each one back off the
row whose holder it belongs to.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR32 a partial transfer surrenders one certificate and issues two  out: surrendered C-12, balance C-10; in: C-11; 0 holdings adrift
FAIL  CR34b the paper names the certificates the register still has out  one holder: none; the other: none of [C-9, C-11]
=== 2 CHECK(S) FAILED ===
```

## A tab reloads itself every time you click something in it

`marker 285`

The frame's src is fed from the tab's CURRENT url instead of the one it
opened with. React then sets src again on every navigation, so each click
inside a tab reloads that tab from scratch — losing the scroll position, the
half-typed expense, and the whole point of having tabs. Everything still
works; it just forgets. N11 reads the wiring, because a check here has no
browser to click in.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N11 both tabs stay mounted, one is shown, and each follows its own page  a frame's src is fed from the tab's current url — it would reload on every click
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## A hidden tab is thrown away instead of hidden

`marker 286`

Only the active tab is rendered. The strip still shows every tab and every
one still opens — from the beginning, each time, because the frame was
unmounted while it was out of sight. This is the same loss as 285 by the
other road, and it is what makes 'keep two companies open' untrue. N11
counts the frames in the markup, not the tabs in the strip.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N11 both tabs stay mounted, one is shown, and each follows its own page  1 frames rendered, not 2
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## Every tab is called Overview

`marker 287`

The tab label stops asking the nav definition which seat a url belongs to
and always finds the first one. Tabs still open, still switch, still hold
their pages — and the strip stops being readable, which is the only thing a
strip is for. N9 asks every seat in LEDGER_NAV to name its own tab.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N9 a tab is named by the sidebar definition                          Search, CRM, Inventory, Project, Documents, Automation, Expenses, Cheques, Income, Bank, Journal entries, Parties, Accounts, Reports, Sales tax, Payroll, Fixed assets, Corporate records, Periods & year-end, Opening balances, SR&ED, Backup, Assistant
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The tabs stop following the pages inside them

`marker 288`

The location watch goes away. Next navigates inside a frame without
reloading the document, so nothing else tells the desk where a tab went:
every tab keeps the label it opened with, forever, and + opens a new tab in
whatever company the ACTIVE tab was in when it opened rather than where it
is now. The first version of this desk shipped exactly this and the browser
pass caught it. N11 reads the wiring.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N11 both tabs stay mounted, one is shown, and each follows its own page  nothing watches where the frames went; the labels would freeze
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## A payment counts as money spent as well as money moved

`marker 289`

Payment rows carry the entry's own amount into the profit-and-loss column.
Every figure on the page is a real figure and the party subtotal doubles: a
1,000 bill and the 1,000 that paid it become 2,000 of something. This is the
whole reason the merged page has two columns instead of one, and it is
invisible to anything that checks a single row. V114 sums the merged page
against the reader the trial balance is tied to.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V114 the merged page adds up the books, not the payments as well  the page adds to -7,470.00, the journal to -9,470.00
=== 1 CHECK(S) FAILED ===
```

## The unpaid column shows the whole debt again

`marker 290`

The page reads the document's ORIGINAL amount instead of what is left of
it, so a bill paid in full still reads as fully owed. Every number is a
number that exists, the column is full, and the one thing it is for — what
is actually still owed — is wrong for every settled document. V115 holds the
page against payments.ts's own answer, document by document.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V115 what a document still owes is payments.ts answering, once  INV-001: page 150000, payments.ts 75000
=== 1 CHECK(S) FAILED ===
```

## Drafts go back to being invisible

`marker 291`

The documents that never reached the books stop being fetched. A draft bill
is then in the database, on nobody's page, and findable only by remembering
it exists — the state the invoice list used to cover and nothing covers once
it is gone. V115 requires unposted paper to be on the page.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V115 what a document still owes is payments.ts answering, once  no draft or void document reached the page
FAIL  V123 every browse record carries the real journal identity, including capital and carried debts  37 rows checked independently against journal_entry/invoice; drafts have no entry
=== 2 CHECK(S) FAILED ===
```

## Every row opens its entry, documents included

`marker 292`

A document row links to the journal entry it raised instead of to the
document. Every link works, every destination is a real page, and the
invoice pages become unreachable by clicking — with the seat already gone,
that is the whole document family orphaned. N12 asks the screen that claims
the rows whether it still opens one; V60 reads each rendered row's own
href. The first version of this block ran ONE command with the second suite as stray arguments to the first, so V60 never ran; N12 stopped covering the screen when invoices got their seat back, and toothless found the block turning nothing red (2026-09-05).

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 1 CHECK(S) FAILED ===
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V60 and each row links to the document or entry that row is about  row 2 links to …5f1e76f7, expected …5f1e76f7
=== 1 CHECK(S) FAILED ===
```

## The certificate prints the figures without the words

`marker 293`

The share count in words comes off the certificate. It still says 120, it
still matches the register, and it has lost the only thing that makes
altering the figure pointless — which is why every certificate ever printed
carries both. CR34 asks the paper for the number twice, once each way.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR34 the certificate says what the register says, in figures and words  the paper does not say: twenty-five
=== 1 CHECK(S) FAILED ===
```

## The number in words loses its and

`marker 294`

`one thousand and five` becomes `one thousand five`. Every certificate
still carries words beside its figures and the words are still nearly right,
which is the shape of this defect: nobody reads them closely until a lawyer
does. CR36 spells the awkward numbers — the teens, the tens, a hundred and
something, a thousand and something — and compares.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR36 a number in words is the number                            1005: one thousand five != one thousand and five; 2000000000001: two trillion one != two trillion and one
=== 1 CHECK(S) FAILED ===
```

## A holder with nothing gets a certificate anyway

`marker 295`

The guard on a zero holding goes, so the day after their shares are bought
back a former holder can still be handed paper saying they hold some. The
register says zero, the certificate says otherwise, and the certificate is
the copy that leaves the building. CR35 asks for one as at the day after a
cancellation and requires a refusal.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR35 a holder with nothing gets no certificate                  issued for 0 shares
=== 1 CHECK(S) FAILED ===
```

## One certificate speaks for two that are still out

`marker 296`

The paper names the NEWEST certificate number whenever there is one, rather
than only when exactly one is outstanding. After a transfer OUT that is
right — the old one was surrendered — and after an ACQUISITION it is a claim
the register does not support: the holder still has the earlier certificate
in their hands, and this paper says it covers everything. Every field looks
filled in, and the register is the thing that disagrees. CR34b holds a
holder with two outstanding certificates beside one with a balance
certificate.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR34b the paper names the certificates the register still has out  one holder: C-12; the other: C-11 of [C-9, C-11]
=== 1 CHECK(S) FAILED ===
```

## The unpaid column waits for the date range again

`marker 297`

Open documents are reached only through the entries the range returned, so
a bill raised before the window has no row and its debt is missing from the
column and from both subtotals — while the heading, the page copy and the
code all call it what is owed TODAY. Pick this month and the supplier who
has been owed since March reads as owing nothing. V115 asks over a two-day
window and requires the same open documents, and the same total, as all
time.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V115 what a document still owes is payments.ts answering, once  a two-day window sees 2 open documents (217.00); all time sees 10 (7,234.50) — the debt moved with the range
=== 1 CHECK(S) FAILED ===
```

## A number is only found the way it was typed

`marker 298`

readQuery stops reading a bare figure as cents as well as dollars. Typing
1498 still finds the 1,498.00 bill, so the box looks like it works — and the
14.98 receipt, which is what somebody who remembers 1498 might equally have
meant, is gone. Money lives here as integer cents; this is the whole reason
the query has two readings. SR4 types the figure both ways.

```
$ db:verify-search | npm run db:verify-search
FAIL  SR1 a query is a word, and an amount, and sometimes a day   1498 -> [149800]; 14.98 -> [1498]; a 20-digit reference -> []
FAIL  SR4 a figure is found however the reader remembers it       1498 finds $1,498.00 and —; 14.98 finds only the smaller one
=== 2 CHECK(S) FAILED ===
```

## A percent sign becomes a wildcard again

`marker 299`

The escaping goes, so what the reader typed is handed to ILIKE as a
pattern. Searching for 50% returns the entire ledger and searching for _
returns every row with at least one character — a search that answers a
question nobody asked, and answers it confidently. SR10 searches for the two
characters themselves.

```
$ db:verify-search | npm run db:verify-search
FAIL  SR10 a percent sign is a percent sign                       % -> 15 hits, _ -> 15 hits
=== 1 CHECK(S) FAILED ===
```

## The search leaves the company it was asked in

`marker 300`

The party read loses the join condition that binds a role to THIS entity,
so a search in one company returns the other company's people. This is the
worst thing this feature could do — companies never mixing is a frozen
decision, and a search is the one screen whose job is to reach everywhere.
Every other section still behaves, so nothing looks wrong. SR9 gives two
companies a supplier with the same name and demands each find only its own.

```
$ db:verify-search | npm run db:verify-search
FAIL  SR9 a search never leaves the company it was asked in       2 hit(s) carry the other company's mark: Party:Harbour Stationery SOUTHMARK | Party:Harbour Stationery NORTHMARK
=== 1 CHECK(S) FAILED ===
```

## A line's own words stop finding their entry

`marker 301`

The EXISTS over journal_line looks up the wrong entry's lines, so nothing
written on a line ever matches. The entry header still answers, so most
searches look fine; what is lost is the thing typed on a LINE — the
account-level note that is often the only place a detail was ever written.
SR3 searches for a word that exists only on a line.

```
$ db:verify-search | npm run db:verify-search
FAIL  SR3 a line puts its own entry on the page, once             nothing found
=== 1 CHECK(S) FAILED ===
```

## The journal's date range stops narrowing anything

`marker 302`

The from filter falls out of the one journal reader. The picker still
moves, the URL still changes, and the list never changes with it — and
because the posted list is capped at a hundred, the reader who narrowed to
April to find something is looking at March. SR8 asks for a month that holds
the entry and a month that does not.

```
$ db:verify-search | npm run db:verify-search
FAIL  SR8 the range narrows the journal                           march 1, april 1
=== 1 CHECK(S) FAILED ===
```

## The chart section forgets which company it is in

`marker 303`

matchingAccounts loses its entity binding, so searching a code or an
account name returns every company's chart. Two companies with the same
codes look identical in a list, which is what makes this one so quiet: the
reader sees the right numbers and clicks through to another company's
account. Nothing exercised this section at all until the fixture gave each
chart a mark of its own. SR9 asks both companies for a shared word and
refuses any hit carrying the other's mark.

```
$ db:verify-search | npm run db:verify-search
FAIL  SR9 a search never leaves the company it was asked in       2 hit(s) carry the other company's mark: Account:5000 — Stationery Supplies SOUTHMARK | Account:5000 — Stationery Supplies NORTHMARK
=== 1 CHECK(S) FAILED ===
```

## A long reference is taken for an amount

`marker 304`

The bound that keeps a candidate inside what a money column can hold goes
away. A bank reference or a long document number — exactly what this box
exists to find — is then bound into abs(amount) IN (...) and Postgres refuses
the whole query, so the page 500s instead of finding the text. SR1 reads a
twenty-digit reference and searches for it.

```
$ db:verify-search | npm run db:verify-search
FAIL  SR1 a query is a word, and an amount, and sometimes a day   a 20-digit reference took the query down: Failed query: 
=== 1 CHECK(S) FAILED ===
```

## The search box jumps the reader to the top

`marker 305`

Refining a search pushes a new history entry instead of replacing, and
scrolls. Every search still works; what breaks is reading — the page jumps
to the top on every refinement, and Back walks through every word you tried
instead of leaving the page. This is the complaint that created the range
picker's rule, arriving through a different box. N5 reads both.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N5 refining a page replaces in place; going elsewhere pushes         the search box does not push only when it leaves the page
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The two income taxes are rounded together

`marker 306`

Federal and BC per-period tax are added first and rounded once, instead of
being rounded separately and then added. It is a cent, sometimes, and the
two PDOC captures cannot see it at all -- both give the same answer either
way, which is exactly why nothing caught this until a case was hunted for.
PR25 pins one: $1,093.00 semi-monthly in January is 37.91 federal plus 0.38
BC, and rounding the sum gives 38.28 instead of 38.29.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR25 the two taxes are rounded apart, then added            federal 37.91 + BC 0.37 = 38.28; rounding the sum instead gives 38.28
=== 1 CHECK(S) FAILED ===
```

## Every pay date gets January's tables

`marker 307`

editionFor stops looking at the date and always answers 2026-01. CRA
revised the tables mid-year -- BC's lowest rate went from 5.06% to 6.14% --
so every pay in the second half of 2026 is then under-deducted, on every
stub, invisibly. PR4 asks for 30 June and 1 July and requires the answer to
move; PR2's July capture requires it to move by the right amount.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR2 BC bi-weekly $2,000.00 paid 2026-07-15 matches PDOC     provincialTax 69.37 ≠ 83.45 | incomeTax 232.60 ≠ 246.68 | employeeDeductions 376.19 ≠ 390.27 | netPay 1,623.81 ≠ 1609.73
FAIL  PR49 the tables are a list, chosen by pay date, and a year off the end is refused  30 June → 2026-01, 1 July → 2026-01; covering 2026, up to 2026-12-31; 2027 NO_TABLES and the refusal names that edge; the year's CPP/EI: 2026 given, 2027 NO_TABLES
FAIL  PR4 one day later is the July table, and BC tax moves       30 Jun BC 136.01 (2026-01) → 1 Jul BC 136.01 (2026-01); federal unchanged at 319.59
FAIL  PR59 a new edition goes in through the form, and a pay date in it resolves to it  a March 2027 pay date before: NO_TABLES; the form said The PDOC example does not come out the same with these tables, so nothing was saved — BC t; after: NO_TABLES; covered to 2026-12-31; the row kept its PDOC case NO ROW; 0 audit row(s); listed as added by nobody
FAIL  PR60 an edition whose figures disagree, or that PDOC does not confirm, or that is out of order, is refused whole  a K constant off by one: refused; the PDOC federal tax a cent out: NOT REFUSED (The editions would not be usable, so nothing was s); a start not after the last edition: NOT REFUSED (The PDOC example does not come out the same with t); a figure that is not a number: refused; rows 0 → 0; with no fault: REFUSED (The editions would not be usable, so nothing was saved: 2027-07 is the first edition of 2027 and starts on 2027-07-01, s)
FAIL  PR61 a preview and a T4 year read the editions added in the app themselves, cold  preview of a January 2027 payday: REFUSED (NO_TABLES); the 2027 T4 year: REFUSED (NO_TABLES)
FAIL  PR62 an edition not loaded is refused, not guessed; only an added edition no stub names, and nothing later rests on, can be removed  unloaded: NO_TABLES; loaded: NO_TABLES; removing a built-in: 2026-07 is built into the app and cannot be removed here.; the January under a July: There is no added edition called 2027-01.; the July: There is no added edition called 2027-07.; removing it while a stub names it: 1 pay stub was computed with 2027-01, so it stays. Its figures are what those stubs were worked out from.; once nothing does: There is no added edition called 2027-01.; covered to 2026-12-31; 0 row(s) left
FAIL  PR64 an added copy of an edition a release builds in is ignored, shown with Remove, and kept while stubs rest on different figures  an August 2026 pay date with the copy on file: 2026-01; listed 1 time(s), the copy different, Remove offered; 0 stub(s) name 2026-07; removing while different: REMOVED (Removed 2026-07. Payroll can now run up to 2026-12-31.); once the same: 2026-07 is built into the app and cannot be removed here. (0 row(s) left, trail keeps its figures and PDOC); again: 2026-07 is built into the app and cannot be removed here.
=== 8 CHECK(S) FAILED ===
```

## The CPP period exemption is forgotten

`marker 308`

Contributory earnings become the whole pensionable amount instead of what
is left after the period's share of the $3,500 basic exemption. Every
employee over-contributes, every period, and the figure still looks like a
plausible CPP deduction. PR1 and PR2 are cent-exact against CRA's own
calculator, so there is nowhere for this to hide.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR1 BC semi-monthly $3,000.00 paid 2026-01-15 matches PDOC  cpp 178.50 ≠ 169.82 | federalTax 318.54 ≠ 319.59 | provincialTax 135.62 ≠ 136.01 | incomeTax 454.16 ≠ 455.60 | employeeDeductions 681.56 ≠ 674.32 | netPay 2,318.44 ≠ 2325.68
FAIL  PR2 BC bi-weekly $2,000.00 paid 2026-07-15 matches PDOC     cpp 119.00 ≠ 110.99 | federalTax 162.11 ≠ 163.23 | provincialTax 82.94 ≠ 83.45 | incomeTax 245.05 ≠ 246.68 | employeeDeductions 396.65 ≠ 390.27 | netPay 1,603.35 ≠ 1609.73
FAIL  PR18 CPP and EI follow pensionable and insurable, not the gross  on $3,000 gross: CPP 178.50 → 166.60 on $2,800 pensionable, EI 48.90 → 42.38 on $2,600 insurable
FAIL  PR21 what the form sends is what gets paid                  2 stubs from 3 rows; Dana's net 2,318.44; submitted twice, one run (Already run — entry PR-00003.)
FAIL  PR24 a run carries pensionable and insurable through to the figures  gross 3,000.00, CPP on 2,800.00 is 166.60, EI on 2,600.00 is 42.38
FAIL  PR25 the two taxes are rounded apart, then added            federal 36.70 + BC 0.00 = 36.70; rounding the sum instead gives 38.28
=== 6 CHECK(S) FAILED ===
```

## Nothing stops at its annual maximum

`marker 309`

capped returns what it was given and ignores the room left. CPP, CPP2 and
EI then run on past their yearly maximums -- the employee is over-deducted
for the rest of the year and the T4 will not reconcile with what was
remitted. PR5 and PR7 pin the last period before each maximum, where the
contribution must be the remainder rather than the full rate; PR23 pins the
period after.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR5 CPP is capped to the room left, then stops              $30.45 of room left → 229.32; at the maximum → 229.32
FAIL  PR6 above the YMPE the second contribution takes over       CPP 229.32, CPP2 160.00 on $4,000 of the second band
FAIL  PR7 EI stops at the maximum premium, employer at 1.4×       65.20 left of $1,123.07, employer 91.28; then 65.20
FAIL  PR23 the derived year to date is what the engine is handed  first period took the whole 4,275.32 maximum; the next contributes CPP 169.82, CPP2 16.00 on the $400 over the YMPE, EI 48.90
=== 4 CHECK(S) FAILED ===
```

## The CPP enhancement is not deducted before tax

`marker 310`

F5A -- the enhanced portion of CPP, which T4127 subtracts from income
before annualising -- stops being subtracted. Income tax is then a few
dollars high every period, on both the federal and the provincial side, and
CPP and EI are untouched, so the stub looks entirely ordinary. PR1 and PR2
catch it on the tax lines alone.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR1 BC semi-monthly $3,000.00 paid 2026-01-15 matches PDOC  federalTax 325.44 ≠ 319.59 | provincialTax 138.20 ≠ 136.01 | incomeTax 463.64 ≠ 455.60 | employeeDeductions 682.36 ≠ 674.32 | netPay 2,317.64 ≠ 2325.68
FAIL  PR2 BC bi-weekly $2,000.00 paid 2026-07-15 matches PDOC     federalTax 165.84 ≠ 163.23 | provincialTax 84.89 ≠ 83.45 | incomeTax 250.73 ≠ 246.68 | employeeDeductions 394.32 ≠ 390.27 | netPay 1,605.68 ≠ 1609.73
FAIL  PR21 what the form sends is what gets paid                  2 stubs from 3 rows; Dana's net 2,317.64; submitted twice, one run (Already run — entry PR-00003.)
FAIL  PR25 the two taxes are rounded apart, then added            federal 39.24 + BC 1.19 = 40.43; rounding the sum instead gives 38.28
=== 4 CHECK(S) FAILED ===
```

## A reversed pay run still eats the year's room

`marker 311`

The year to date stops caring whether the run behind a stub is still
standing in the books. Reverse a payroll that was run wrongly and re-run it,
and the year now counts BOTH -- CPP and EI room is consumed twice and the
employee is under-deducted for the rest of the year. This is the whole
argument for deriving the total instead of storing it, and PR10 is the check
that says it: run, reverse, and the room must come back.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR10 the year to date is summed from standing runs only     after one run 169.82 of CPP; after reversing it 169.82
FAIL  PR31 the whole year is the sum of the year's own standing stubs  3 periods totalling 7,200.00, against 2 standing stubs totalling 4,800.00
=== 2 CHECK(S) FAILED ===
```

## The employer's CPP lands on the liability instead of the expense

`marker 312`

The employer's own contribution is credited away rather than debited to
wages. The entry still balances -- postEntry has nothing to object to -- and
the payroll liability is understated by exactly the employer's share while
the wage expense is short by the same amount. The company's payroll looks
cheaper than it is. PR8 reads the entry account by account against the
run's own totals.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR8 the entry is the shape the owner asked for              bank 4,253.26 = net pay; payroll liabilities 1,269.97 = remittance; wages 5,523.23 across 3 lines, 2 naming the employee and each carrying their own gross
FAIL  PR9 the entry says what the stubs say                       stubs: cost 5,827.17 = net 4,253.26 + CRA 1,573.91; entry debits 5,827.17, bank 4,253.26, liability 1,269.97
FAIL  PR46 what is still owed is the payroll-liabilities balance, which the posted runs add up to  2627 — Payroll liabilities: 5567150 owed, 6225191 withheld by posted runs this year
=== 3 CHECK(S) FAILED ===
```

## The wage lines name nobody

`marker 313`

Each employee's gross line stops carrying their party. Every figure in the
books is still right; what is gone is who the money was for -- the party
ledger, the aging and every by-party report see one anonymous wages total.
PR8 requires the gross lines to name the people the run paid.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR8 the entry is the shape the owner asked for              bank 4,253.26 = net pay; payroll liabilities 1,573.91 = remittance; wages 5,827.17 across 4 lines, 0 naming the employee and each carrying their own gross
=== 1 CHECK(S) FAILED ===
```

## A pay run reaches into another company

`marker 314`

employeesForRun loses its entity binding, so any company can pay any
company's employee -- and postEntry would then refuse the line only because
the party holds no role here, halfway through, or accept it if they happen
to. Companies never mixing is a frozen decision. PR16 asks the second
company to pay the first company's employee and requires a refusal.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR16 one company cannot run another company's payroll       Alder Works paid a Cedar Works employee
=== 1 CHECK(S) FAILED ===
```

## The same person can be on one run twice

`marker 315`

Two lines for one employee in one pay period stop being refused. CRA's
arithmetic is per PERIOD: the basic exemption and the claim amounts are
applied once, so two lines apply them twice and under-deduct on both. The
stubs and the entry both look fine. PR15 submits the same employee twice.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR15 one person, one line — the same period twice is refused  the same employee was paid twice in one run, and the exemption applied twice
=== 1 CHECK(S) FAILED ===
```

## A run reads the gross where it should read pensionable

`marker 316`

previewPayRun stops passing pensionable and insurable through and hands the
engine the gross three times. The engine still honours them perfectly --
PR18 stays green -- and every pay with a benefit that is taxable but not
insurable is over-deducted. This is the seam a check on the engine alone
cannot see, which is why PR24 exists and asks the RUN.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR24 a run carries pensionable and insurable through to the figures  gross 3,000.00, CPP on 3,000.00 is 169.82, EI on 3,000.00 is 48.90
FAIL  PR56 an exempt person is exempt on the stub, in the run, and on the T4's box 28 — for a whole year only  owner: EI 65.20 (employer 91.28), insurable 4,000.00, CPP 229.32; senior: CPP 229.32 + 0.00, pensionable 4,000.00, EI 65.20; box 28: owner "—", senior "—", Dana "—", flagged mid-year "—" (says entire period), flagged and never paid "—" (empty slip, says no pay); Dana's reason is about her; a typed insurable figure for the owner: EXEMPT, a typed pensionable figure for the senior: EXEMPT
=== 2 CHECK(S) FAILED ===
```

## A social insurance number is only counted, not checked

`marker 317`

The check digit test goes away and any nine digits are accepted. A typo
then reaches the T4, where CRA rejects the slip or -- worse -- files it
against somebody else. PR17 offers a number that is nine digits and fails
the check.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR17 a social insurance number is nine digits that check out  123456788 (fails the check digit) → accepted
=== 1 CHECK(S) FAILED ===
```

## A pay stub may say anything about itself

`marker 318`

The two CHECKs that make a stub foot are gone. The engine still computes
correctly, so nothing changes today -- what is gone is the floor under it:
the one figure an employee ALWAYS checks could be stored wrong by anything
that ever writes this table, including a hand-typed repair. Twelve blocks
mutate the TypeScript and none had ever made a constraint fail (critic).
PR13 offers three bad rows and requires each to be refused by the one
constraint that is about it.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR13 a stub that does not add up, or pays less than nothing, is refused  a stub with the wrong net pay was stored | income tax: refused, but by Failed query: 
FAIL  PR37 nothing is deducted for tax that is not taken off the pay  the stub has no constraint saying what net pay is
=== 2 CHECK(S) FAILED ===
```

## Somebody can be paid less than nothing

`marker 319`

The floor under net pay goes away. Extra tax on a TD1 has no ceiling, so one
typo computes a negative net -- and the entry it makes BALANCES, with the
bank DEBITED on payday, so postEntry has nothing to object to. The
application refuses it by name first; this is the backstop under that.
PR13's third row is exactly this row.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR13 a stub that does not add up, or pays less than nothing, is refused  a stub with the wrong negative net pay was stored
=== 1 CHECK(S) FAILED ===
```

## Deleting a posted pay run takes its stubs with it

`marker 320`

The guard on the run goes, leaving only the guard on the stubs -- which
cannot see this: the stubs cascade from the run, and during a cascade the
parent row is already gone when the child's BEFORE DELETE fires, so the
lookup finds no entry_id, reads as an unposted run, and lets every stub go.
The year to date silently gets back room it had used, and the journal entry
is left with nothing behind it. PR26 deletes a posted run and requires both
the refusal and the stubs.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR26 a posted pay run cannot be deleted out from under its stubs  the delete went through and left 0 stubs
FAIL  PR36 the paycheque is the stub, read back off the page      the January run has no stub to draw a paycheque from
=== 2 CHECK(S) FAILED ===
```

## The employer's own contributions stop being the employer's

`marker 321`

The employer multiplier becomes 1.0, so the employer's EI is charged at the
employee's rate rather than 1.4 times it. Every stub still foots, the entry
still balances, and the company under-remits on every payday -- CRA finds it
at the year end. PR7 pins the multiplier on the same period it pins the
maximum premium.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR7 EI stops at the maximum premium, employer at 1.4×       23.07 left of $1,123.07, employer 23.07; then 0.00
=== 1 CHECK(S) FAILED ===
```

## A whole year is read as the year after it

`marker 322`

The year to date takes its calendar year from the EXCLUSIVE bound instead of
the last day it includes. Every pay run is unaffected -- its bound is the pay
date itself -- so no figure in the arithmetic moves. What breaks is the one
caller that asks for a whole year by passing 1 January next: it filters for
the following year and sums nothing, and an employee's page shows 0.00 above
a table of that employee's own stubs. Found in a browser pass, by looking at
the screen; no check had asked the question that way until PR31. Since 0074 the
year is the caller's own argument; this reads the year after it.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR10 the year to date is summed from standing runs only     after one run 0.00 of CPP; after reversing it 0.00
FAIL  PR23 the derived year to date is what the engine is handed  first period took the whole 4,230.45 maximum; the next contributes CPP 169.82, CPP2 0.00 on the $400 over the YMPE, EI 48.90
FAIL  PR31 the whole year is the sum of the year's own standing stubs  0 periods totalling 0.00, against 2 standing stubs totalling 4,800.00
FAIL  PR33 box 24 stops at the MIE and box 26 at the YAMPE        earned 0.00 insurable → box 24 0.00; 0.00 pensionable → box 26 0.00, not the YMPE 74,600.00
FAIL  PR38 the paycheque's year column is the year, and it adds up  period extra tax 25.00, year 0.00; year gross 0.00 against this period's 2,400.00
FAIL  PR54 the year to date is the year the caller names, not the year before its bound  1 January 2027 asked as a pay run: 0 period(s); asked as 2026's T4: 0
FAIL  PR56 an exempt person is exempt on the stub, in the run, and on the T4's box 28 — for a whole year only  owner: EI 0.00 (employer 0.00), insurable 0.00, CPP 229.32; senior: CPP 0.00 + 0.00, pensionable 0.00, EI 65.20; box 28: owner "—", senior "—", Dana "—", flagged mid-year "—" (no reason), flagged and never paid "—" (empty slip, says no pay); Dana's reason is about the room; a typed insurable figure for the owner: EXEMPT, a typed pensionable figure for the senior: EXEMPT
=== 7 CHECK(S) FAILED ===
```

## Box 26 is capped at the first CPP ceiling instead of the second

`marker 323`

The mistake this node shipped and the critic caught: box 26 capped at the
YMPE rather than the YAMPE. Since 2024 box 26 has to support box 16A beside
it, and the second CPP contribution is charged on the band ABOVE the YMPE --
so a slip capped at 74,600 reports pensionable earnings that cannot explain
the CPP2 figure next to them, for everybody paid over that. Nothing looks
wrong: it is a real ceiling, just the other one. PR33 pays somebody past both
and requires 85,000.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR33 box 24 stops at the MIE and box 26 at the YAMPE        earned 87,000.00 insurable → box 24 68,900.00; 87,000.00 pensionable → box 26 74,600.00, not the YMPE 74,600.00
=== 1 CHECK(S) FAILED ===
```

## A box the module cannot fill shows zero instead of saying so

`marker 324`

Box 20 stops being absent and becomes 0.00. Nothing looks wrong: zero is what
somebody with no pension contributions would have. But this module does not
withhold RPP at all, so the zero is not a measurement -- it is a guess that
happens to be right today and will be silently wrong the day withholding is
built. PR32 requires the box to be absent AND to say why -- and requires the same of
box 17, which CRA says to leave blank outside Quebec and which this node first
shipped as a hard zero (critic).

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR32 the T4 boxes are the year to date, and the missing ones say why  box 14 3,000.00, box 22 455.60; 5 boxes shown as absent, each with a reason
=== 1 CHECK(S) FAILED ===
```

## One pay-period count is used for every ROE block

`marker 325`

Block 15A's span is used for Block 15B as well. The blocks look consistent --
the same tidy number everywhere -- and Service Canada asks for 25 semi-monthly
periods of HOURS and 13 of EARNINGS. Reporting 25 periods of earnings roughly
doubles Block 15B, which is the figure a benefit rate is calculated from.
PR34 pins all four counts against the employer guide.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR34 every ROE span is Service Canada's, and newest comes first  semi_monthly: 25/25/13/25 "Semi-monthly" ≠ 25/13/13/25 "Semi-monthly"
=== 1 CHECK(S) FAILED ===
```

## An ROE reports zero hours instead of no hours

`marker 326`

Block 15A falls back to a total when nothing was recorded. Zero hours and no
record of hours are different claims: the first says the person did not work,
which would deny the claim outright. PR35 asks for an employee nobody entered
hours for and requires the summary to refuse to state a figure.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR34 every ROE span is Service Canada's, and newest comes first  twenty_two produced figures with no pay-period type to base them on | ten produced figures with no pay-period type to base them on
FAIL  PR35 hours reach the stub and the ROE, and their absence is said not guessed  72.50 hours stored as 7250, Block 15A 7250; an employee with none recorded reports 0
=== 2 CHECK(S) FAILED ===
```

## The paycheque's net pay is off by a cent

`marker 327`

The net printed in the summary stops being the net the stub stored. A cent is
the whole point: the paycheque is the document an employee reconciles against
what arrived in their account, and the check has to be able to see a
difference that small. It is a cent rather than a second derivation because
there is no second derivation available -- gross less the withholdings is what
pay_stub_net_adds_up already guarantees net_pay to be. PR36 reads the figures
back out of the PDF with a decoder that knows nothing about the builder.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR36 the paycheque is the stub, read back off the page      the net pay is printed 2 times, not 3 — the band, the NET PAY line and the summary must all carry it
=== 1 CHECK(S) FAILED ===
```

## An ROE states a Block 15B for a frequency the form has no type for

`marker 328`

CRA pays on 22 and 10 pay periods a year; Service Canada's form has no
pay-period type for either, so there is no number of periods to look back
over and no honest figure to give. The guard goes and Block 15B becomes a
number anyway -- somebody types it into a form that will compute a benefit
rate from it. The module's own docstring says it refuses to guess rather than
guess; this is the code guessing. PR34 asks for both frequencies and requires
every span figure to be refused.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR34 every ROE span is Service Canada's, and newest comes first  twenty_two produced figures with no pay-period type to base them on | ten produced figures with no pay-period type to base them on
=== 1 CHECK(S) FAILED ===
```

## A rehired employee's ROE reports the old leaving date

`marker 329`

Block 11 goes back to max(held_to) across every employee role. max() skips
nulls, so somebody who left, came back, and is still working reports the date
they left the FIRST time as the last day for which they were paid -- and
Block 12 with it. Every other figure on the sheet is right. PR34's fixture
does not cover it; the guard is the CASE that returns null while any role is
still open.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR42 payroll hiring date overrides party registration, and rehire does not reuse the old leaving date  hired 2026-01-01, registered 2026-02-01, back 2026-06-01, last paid 2026-03-31
=== 1 CHECK(S) FAILED ===
```

## The paycheque prints a year's extra tax as nothing

`marker 330`

The extra-tax line's year-to-date goes back to a hard zero. It is inside the
Income Tax figure printed above it -- income_tax is federal + provincial +
additional by CHECK -- so the line disagrees with the one it is explaining, on
the one piece of paper an employee keeps, and the number that is wrong is the
one they would have to ask about. PR38 reads the second payday of a year,
where the period figure and the year figure differ.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR38 the paycheque's year column is the year, and it adds up  not on the page: 50.00
=== 1 CHECK(S) FAILED ===
```

## A T4 worksheet answers for another company

`marker 331`

t4Year loses the entity binding on the employee list, so one company's
worksheet lists every employee of every company -- with the wrong employer
name and business number at the top of it. Companies never mixing is a frozen
decision, and a T4 is exactly the screen somebody reaches for while looking at
the wrong company. PR39 asks the second company for the first company's people.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR39 the T4, the ROE and the statement stay in their own company  the T4 worksheet listed another company's employee
=== 1 CHECK(S) FAILED ===
```

## Hours typed with nobody to pay are thrown away

`marker 332`

A row is read only when it has a name or an amount, so hours entered on their
own are dropped without a word. It is the shape the invoice reader was fixed
for: the form takes what somebody typed and the reader silently keeps less of
it. PR41 submits a row of hours alone and requires the refusal to name the row.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR41 negative hours are refused, and hours with nobody to pay are not swallowed  NEGATIVE; a row of hours alone → "it posted"
=== 1 CHECK(S) FAILED ===
```

## A password is stored as itself

`marker 333`

hashPassword hands back the password. Signing in still works -- it verifies
against what was stored -- so nothing on any screen changes. What changes is
that the table IS the list of everybody's passwords, and this system's own
backup route hands that table to whoever asks for it. US3 requires two hashes
of one password to differ and neither to contain it.

```
$ db:verify-users | npm run db:verify-users
FAIL  US1 a password verifies, and a different one does not       right → false, wrong → false
FAIL  US3 the same password hashes differently every time         salted; neither hash contains the password, both verify
FAIL  US4 the session table holds a hash, never the token         could not sign in as owner@example.test: That email and password do not match.
=== 3 CHECK(S) FAILED ===
```

## The session table stores the cookie

`marker 334`

The token is written to the table as it is, instead of its SHA-256. Every
session keeps working, so nothing looks wrong. What is now true is that
anybody holding a copy of the database holds a live session for every
signed-in person -- a backup becomes a set of credentials. US4 requires the
stored value to be the hash and the raw token to appear in no row.

```
$ db:verify-users | npm run db:verify-users
FAIL  US4 the session table holds a hash, never the token         stored mCzqemHIZroB-yPp… (43 hex chars); the raw token appears in no row
=== 1 CHECK(S) FAILED ===
```

## A revoked session keeps working

`marker 335`

userForToken stops caring whether the session was revoked. Signing out
appears to work -- the cookie is cleared, the page returns to the sign-in
form -- and the token that was in it is still valid for a month. Somebody who
signs out on a borrowed machine has not signed out. US7 offers a revoked
token and requires nobody back.

```
$ db:verify-users | npm run db:verify-users
FAIL  US7 forged, expired and revoked tokens are all nobody       four tokens offered, four refusals
FAIL  US9 changing a password signs every session out             5 sessions were open; both tokens now answer nobody, and the old password is refused
FAIL  US15 signing one person out leaves everybody else signed in  the bookkeeper is out, the owner is still in
FAIL  US17 signing in again ends the session being replaced       the token the browser was carrying is revoked; the new one works
=== 4 CHECK(S) FAILED ===
```

## The sign-in form says which half was wrong

`marker 336`

An unknown address returns before any password is checked. Every sign-in
still behaves correctly for somebody who knows their password; what the form
now answers, to anybody who asks, is whether a given person has an account
here -- and it answers it faster for the ones who do. US5 requires the three
ways of failing to be one refusal.

```
$ db:verify-users | npm run db:verify-users
FAIL  US5 one refusal, and the same work, whichever half was wrong  wrong password: BAD_CREDENTIALS: That email and password do not match. | unknown: NO_SUCH_USER: No account for that address.
=== 1 CHECK(S) FAILED ===
```

## The superadmin can be removed

`marker 337`

The deferred trigger that keeps somebody in charge stops looking. Everything
works until the day the only superadmin is deactivated or demoted, and then
nobody can add a user, take a backup, or restore either -- the system is
locked out of itself with no path back except SQL. US11 tries three ways of
leaving nobody in charge, by row and by kind. The body is 0057's (0053's was
about owners); the trigger itself stays, because 0058 drops and re-creates it
by name and a tree where it was never made cannot migrate at all -- which is
what this block did for a day, and the battery read it as a suite that died.

```
$ db:verify-users | npm run db:verify-users
FAIL  US11 the superadmin cannot be demoted or deactivated, by row or by kind  demote → (no refusal at all) | deactivate → (no refusal at all) | byKind → (no refusal at all)
FAIL  US15 signing one person out leaves everybody else signed in  could not sign in as owner@example.test: That email and password do not match.
=== 2 CHECK(S) FAILED ===
```

## A page forgets the gate

`marker 338`

One page stops calling requireUser. It is the payroll run list, so what it
hands an anonymous visitor is every payday this company has had. Nothing about
the page looks different and every other page is still gated -- which is the
whole reason the check reads the tree instead of trusting the pattern. N14
requires every page and route to reach gate.ts.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N14 every page, route, layout and server action passes through the gate  1 file(s) without a gate: src/app/ledger/[ledgerId]/payroll/page.tsx
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The backup route answers GET again

`marker 339`

pg_dump behind a GET. This is the shape RISKS 15b calls out: one request is
every company, every entry, every SIN and every birth date, and because GET is
supposed to be a read, an image tag on any page the owner visits triggers a
dump. N15 requires POST, and requires the owner gate.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N15 taking a whole-database backup is a POST, and needs an owner     it still answers GET
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The audit trail goes back to recording a surface

`marker 340`

One form handler writes the old placeholder instead of the person. The audit
log still fills up and every column is still populated; the rows it writes say
web, which cannot tell two people apart, and that is the entire thing 0053
exists to fix. RISKS 15 says this cannot be repaired afterwards -- the history
written in between can never be attributed. N16 reads the code rather than the
prose, because its first version reported the file that DOCUMENTS the change.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N16 the audit trail records a person, not a surface                  still writing WEB_ACTOR: src/lib/bank-forms.ts
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## A server action loses its gate

`marker 341`

discardDraftAction stops calling requireUser. It runs a bare DELETE on
journal_entry, and a server action POSTs to the page's own URL and runs BEFORE
that page renders -- so the requireUser in the page body does not cover it.
Six actions were reachable this way when the gate first shipped, because N14
read only page.tsx and route.ts and believed that was the list (critic). Next's
own documentation says to treat server actions as public API endpoints.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N14 every page, route, layout and server action passes through the gate  1 server action(s) without a gate: src/app/actions.ts:discardDraftAction
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## A layout queries the database with no gate

`marker 342`

The ledger shell stops calling requireUser. It reads the entity name and
calls notFound, so to an anonymous caller it answers 404 for a ledger that
does not exist and 307 for one that does -- an existence oracle for ledger
ids, from a file that is not a page and not a route. N14 walks layouts for
exactly this.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N14 every page, route, layout and server action passes through the gate  1 file(s) without a gate: src/app/ledger/[ledgerId]/layout.tsx
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## Sign-in will send you anywhere

`marker 343`

The destination after sign-in is handed back unchecked. A value beginning with
a slash and a backslash then resolves to another host entirely, because a
browser treats a backslash as a slash -- so a link to this system's own login
page can land somebody on somebody else's, with the address bar showing the
right domain until the redirect. US16 resolves each candidate the way the
browser will, rather than pattern-matching it.

```
$ db:verify-users | npm run db:verify-users
FAIL  US16 signing in cannot send you off this site               escapes: "/\\evil.com" -> /\evil.com, "/\\/evil.com" -> /\/evil.com, "//evil.com" -> //evil.com
=== 1 CHECK(S) FAILED ===
```

## The timing defence stops costing anything

`marker 344`

An address that is not even an address returns without verifying against
anything. The refusal is identical; the TIME is not -- half a millisecond
against ninety -- so the form answers whether a given address could be an
account here, to anybody who measures. This is the shape the first version
shipped: the dummy it verified against had illegal scrypt parameters, so it
threw and the catch returned false, and the defence never ran. US5 compares
the refusals AND the work.

```
$ db:verify-users | npm run db:verify-users
FAIL  US5 one refusal, and the same work, whichever half was wrong  answered without hashing: malformed address in 5.8ms (floor 15ms)
=== 1 CHECK(S) FAILED ===
```

## A company somebody was not given still opens

`marker 345`

The entity half of refuseFor goes away, leaving only the module half. Every
screen still looks right -- the company list shows one company, the rail shows
the granted seats -- and typing another company's ledger id into the address
bar opens its books. This is the half that actually protects anything: a
permission saying "not Payroll" while every company's ledger answers has
moved the lock without locking anything (0054's own header).

```
$ db:verify-users | npm run db:verify-users
FAIL  US18 a company somebody was not given is refused            their own company answers nothing — it opens; the other answers NO_MODULE
FAIL  US38 an escaped ledger id or module is judged as the router reads it  proxy forwards /ledger/3770a318-d614-4353-a2b1-3561dcedbeaf/backup/file?paper=yes → NO_MODULE; the raw escaped path → NO_COMPANY; an escaped /payroll → NO_MODULE; an undecodable path → 400
=== 2 CHECK(S) FAILED ===
```

## A module somebody was not given still opens

`marker 346`

The module half goes. The rail draws the two seats the bookkeeper has and the
other twelve URLs all answer -- including the payroll pages, which carry other
people's pay. A hidden menu whose address still answers is not a permission,
which is the sentence the granting screen prints to whoever uses it.

```
$ db:verify-users | npm run db:verify-users
FAIL  US19 a module somebody was not given is refused, covers included  /parties → opens; /payroll → opens; /aging, a page under the Reports seat → opens
FAIL  US24 a download is refused by the same seats its screen is  ?what=journal opens (they have Journal entries); ?what=trial-balance and ?what=gst-hst refuse; a receipt opens; an unnamed what refuses
FAIL  US25 a ledger path belonging to no seat is shut, not open   an undeclared path answers nothing — it opens
FAIL  US38 an escaped ledger id or module is judged as the router reads it  proxy forwards /ledger/bf607255-95bd-4a98-8e7d-f5f3e14fbf69/backup/file?paper=yes → NO_COMPANY; the raw escaped path → NO_COMPANY; an escaped /payroll → opens; an undecodable path → 400
=== 4 CHECK(S) FAILED ===
```

## A page covered by a seat stops being covered by it

`marker 347`

moduleOf answers only for the seat path itself, instead of asking the same
function the rail highlights with. /aging, /statements and /trial-balance all
sit under the Reports seat; with an exact match they belong to no seat, so
nothing refuses them and a person without Reports reads every report. The
one-spelling rule is the whole point: /aging lighting up Reports in the rail
and /aging being covered by the Reports grant have to be the same fact.

```
$ db:verify-users | npm run db:verify-users
FAIL  US20 the modules on offer are the seats the route tree actually has  route directories belonging to no seat and undeclared: aging, bills, breakdown, fx, getting-started, statements
=== 1 CHECK(S) FAILED ===
```

## The grantable modules become a list of their own

`marker 348`

MODULE_PATHS stops being derived from LEDGER_NAV and is typed out. It is
correct on the day it is typed, which is what makes it the shape this
repository keeps finding: the next module added shows up in the rail, and never
on the screen that grants it, so nobody can ever be given it and nobody is told
why. The same defect as two readers, two lists, two renderers -- here with a
year between cause and symptom.

```
$ db:verify-users | npm run db:verify-users
FAIL  US20 the modules on offer are the seats the route tree actually has  the granting screen and the gate read different lists
=== 1 CHECK(S) FAILED ===
```

## An owner stops being exempt

`marker 349`

accessFor reads the tables for everybody. Nobody grants the owner anything --
there is no screen for it and no reason to -- so the person who administers the
system is refused at every company in it, including the one they need in order
to reach the granting screen and let themselves back in. A system whose
administrator can lock themselves out is a support call with no support.

```
$ db:verify-users | npm run db:verify-users
FAIL  US21 an owner sees everything; everybody else sees what they were given  owner: all 24 seats and any company; the bookkeeper: /entries and /parties
=== 1 CHECK(S) FAILED ===
```

## The gate stops asking the access question for pages

`marker 350`

requireUser goes back to answering only "who are you". Every check in
verify-users still passes, because they call refuseFor directly and refuseFor
is untouched and correct -- a library nobody calls. On screen nothing is wrong
at all: the rail hides what it should hide, and every URL under it answers for
anybody signed in. N17 exists because US18-US22 cannot see this.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N17 the gate asks the access question, the rail draws what was granted, and only an owner may grant  requireUser never calls refuseFor, so no page is refused
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The downloads stop asking, and only the downloads

`marker 351`

guardRoute keeps the sign-in check and drops the access one; requireUser is
left alone, so every PAGE still refuses correctly and the whole application
looks right. What answers is the other fifteen doors -- the payroll PDF, the
transparency register with its dates of birth, the CSV export, every receipt
ever filed -- for any signed-in person, at any company, including the ones they
were refused on screen a moment earlier. The first version of N17 asked whether
refuseFor appeared anywhere in gate.ts, which this passes: I verify the doors I
thought of, and the route half is the one a page-shaped mental model forgets.
N14 had to learn the same thing twice, about server actions and about layouts.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N17 the gate asks the access question, the rail draws what was granted, and only an owner may grant  guardRoute never calls refuseFor, so no download is refused
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The rail draws every seat again

`marker 352`

The ledger shell hands NavRail the whole nav instead of the seats this person
has. The gate still refuses, so nothing leaks -- what breaks is the honesty of
the screen: fourteen doors are offered and twelve of them turn you away with a
refusal page. Not a security hole, and pinned anyway, because the rail is the
only place a person finds out what they may do.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N17 the gate asks the access question, the rail draws what was granted, and only an owner may grant  the rail offers a door somebody would be turned away from (the seat list, the search box, the Add flyout and the item flyouts must all go through mayOpen)
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## Anybody signed in may grant themselves anything

`marker 353`

setGrantsAction is behind requireUser rather than requireOwner. N14 stays
green -- the action does reach the gate, which is all N14 asks -- and the
screen is still owner-only, so nothing is visibly wrong. A server action is a
public endpoint that runs before the page it POSTs to renders (Next's own
words), so the bookkeeper who is refused at every company can post one form and
hold every company and every module. The escalation is silent and it is
permanent, because the audit row it writes names them as the grantor and looks
exactly like an owner's.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N17 the gate asks the access question, the rail draws what was granted, and only an owner may grant  people doors not behind requireOwner: setGrantsAction
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## An action writes to whichever company the form names

`marker 354`

requireLedger stops asking about the company. Every screen is still correct
and every page still refuses correctly -- what changes is that the id in the
FORM is no longer checked against the id in the URL's permission. Standing on a
company they hold, one POST with another company's ledger id in it writes into
books they were refused at on screen a moment earlier. Thirty-one actions read
their ledger out of the form this way. The gate could never have caught it:
refuseFor judges the page a form POSTs to, and a server action POSTs to the
page it is on.

```
$ db:verify-users | npm run db:verify-users
FAIL  US26 an action is judged by the ledger in its form, not the page it was posted from  their own ledger in a seat they hold opens; another company answers NO_MODULE; a seat they lack answers NO_MODULE; a list passes on any one of them; an empty id answers NO_COMPANY rather than reaching the database
=== 1 CHECK(S) FAILED ===
```

## An action runs in a module its caller was never given

`marker 355`

The seat half of the action check goes. The company half still holds, so
nothing crosses a company line -- inside their own books, a person with the
Journal entries seat and nothing else can post the payroll form and create a
pay run, or post the records form and change the directors. The rail does not
offer those doors and the pages refuse; the endpoints behind them do not, and
a server action is a public endpoint that runs before the page it addresses
renders.

```
$ db:verify-users | npm run db:verify-users
FAIL  US26 an action is judged by the ledger in its form, not the page it was posted from  their own ledger in a seat they hold opens; another company answers NO_COMPANY; a seat they lack answers undefined; a list passes on any one of them; an empty id answers NO_COMPANY rather than reaching the database
=== 1 CHECK(S) FAILED ===
```

## A seatless ledger path goes back to being allowed

`marker 356`

refuseFor treats "no seat" as "no objection" again, which is what it did
until a critic read it. Three paths belong to no seat: /export, /attachments
and /invoices. So one seat -- any seat, /opening will do -- buys the whole
journal as a CSV, every filed receipt by id, and every invoice document. The
company half still refuses, so this was never a cross-company leak; it was
every module's data to every colleague. The code's own comment said those paths
were "detail routes reached from a row" and DETAIL_ROUTES held one entry.

```
$ db:verify-users | npm run db:verify-users
FAIL  US25 a ledger path belonging to no seat is shut, not open   an undeclared path answers nothing — it opens
=== 1 CHECK(S) FAILED ===
```

## One route hands out four seats' worth of data

`marker 357`

The export's seat stops depending on what is being exported. /export answers
?what=journal, trial-balance, statement, account and gst-hst through one URL,
which is four different seats of content; with a single declared seat, whoever
holds that one holds all of them. The proxy passes the query string for exactly
this reason, and this is the version that ignores it.

```
$ db:verify-users | npm run db:verify-users
FAIL  US24 a download is refused by the same seats its screen is  ?what=journal opens (they have Journal entries); ?what=trial-balance and ?what=gst-hst refuse; a receipt opens; an unnamed what refuses
=== 1 CHECK(S) FAILED ===
```

## The desk names every company in the system

`marker 358`

The landing page stops filtering. Nothing can be OPENED that could not be
opened before -- the gate refuses each ledger -- and the desk still hands a
bookkeeper the name and primary ledger id of every company the owner keeps
books for, on the first screen after signing in. /companies, two clicks away,
was filtered from the start under a comment about not inviting somebody to a
locked door; the desk was written before there was anything to filter by and
nobody went back (critic). Both read one predicate now.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N17 the gate asks the access question, the rail draws what was granted, and only an owner may grant  a company list is not filtered by mayOpenEntity (the desk, or /companies)
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The gate admits a request it cannot judge

`marker 359`

The path header goes back to being optional. Every request that carries it is
judged exactly as before, so the application behaves identically -- and a
request that arrives without one is admitted, with no company check, no module
check and no line in any log. From inside, "nobody told me where this is
going" and "this is allowed" become the same answer. A boundary that cannot
answer must not answer yes.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N17 the gate asks the access question, the rail draws what was granted, and only an owner may grant  the gate admits a request with no path header instead of refusing it
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The rail offers three kinds of door it will not open

`marker 360`

The seat list stays filtered and the other three link sources stop being: the
search box, the Add flyout and each item's own flyout. Nothing leaks -- every
one of those URLs is refused. What breaks is the only thing the rail is for: a
person without Payroll is offered "Pay run", and the Reports flyout offers the
GST/HST return, which lives in the Sales-tax seat. The first version of this
node filtered one source of four and the check watched that one (critic).

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N17 the gate asks the access question, the rail draws what was granted, and only an owner may grant  the rail offers a door somebody would be turned away from (the seat list, the search box, the Add flyout and the item flyouts must all go through mayOpen)
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## An action's declared seat drifts from where its form lives

`marker 361`

saveEmployeeAction keeps claiming the Payroll seat after its form has moved
to the parties screen -- which is what a written-down seat does the first time
somebody moves a component, and there is no way for the server to notice: it
cannot know which component called it. Here the drift is simulated the other
way round, by declaring a seat the form is not under. Everything still works
for everybody who holds both seats, and quietly widens for everybody who holds
only one. N18 re-derives every declaration from the tree.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N18 every ledger path has a seat somebody chose, and every action names the seat its form is actually under  saveEmployeeAction declares '/parties' but its form lives under /payroll
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## A ledger route stops being accounted for

`marker 362`

The export declaration is removed from DETAIL_ROUTES, putting /export back
in the state a critic found it in: an entrypoint under a ledger that belongs to
no seat and that nobody has decided about. The refusal now defaults to shut, so
no data escapes -- what the check is for is the OTHER direction, the day
somebody adds a route and the permission map does not notice. N18 walks the
tree for this the way N1 and N14 do.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N12 every seatless detail route is still opened by the rows that claim it  export-not-declared: declared, but has neither a page nor a route
FAIL  N18 every ledger path has a seat somebody chose, and every action names the seat its form is actually under  /export belongs to no seat and is not declared in DETAIL_ROUTES
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 3 CHECK(S) FAILED ===
```

## Only an owner may open the people screen, in words

`marker 363`

requireOwner goes back to throwing. The refusal is correct either way -- a
bookkeeper cannot manage people -- and what they meet is a bare 500, because
Next strips a thrown message in production. The sentence explaining what
happened and what to do about it is written in gate.ts and never reaches
anybody. requireUser was changed to redirect for exactly this reason on the day
requireOwner was written, and only one of the two was revisited; it took
opening the page as a bookkeeper to see it.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N17 the gate asks the access question, the rail draws what was granted, and only an owner may grant  requireOwner throws instead of refusing in words, which is a bare 500
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The refusal page loses the sentence for one refusal

`marker 364`

NEEDS_OWNER stops having its own line, so a bookkeeper who opens the people
screen is told "You have not been given that" -- true, and no use to anybody.
requireOwner was changed from a throw to a redirect precisely so a person would
be told what happened and what to do about it; a code that falls through to the
generic sentence is that change made halfway. It shipped that way for an hour:
the redirect was written and the page was not told about the new code.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N17 the gate asks the access question, the rail draws what was granted, and only an owner may grant  the refusal page has no sentence for NEEDS_OWNER
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## A finished reconciliation lets a match be undone

`marker 365`

The freeze stops watching bank_match. Finishing still records who and when,
the screen still says Finished, the statement still cannot be deleted -- and
the match on a row inside it can be undone, which changes the cleared balance
under a difference somebody has signed as zero. Amending a matched entry moves
its match (07 3b), so that goes through too: an amendment inside a finished
period that nothing refuses. RC17 and RC26 push on that door. The body is 0056's: 0055 wrote it first and 0056 re-issued it, and a mutation of the first is shadowed by the second -- toothless caught exactly that on 2026-09-05.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC17 a match inside a finished reconciliation cannot be undone  the database allowed it
FAIL  RC26 amending an entry matched inside the freeze is refused  expected "RECONCILED", got: Cannot read properties of undefined (reading 'entry_id')
FAIL  the suite threw before it finished                          Cannot read properties of undefined (reading 'id')
=== 3 CHECK(S) FAILED ===
```

## A row inside the freeze can be set aside or put back

`marker 366`

The UPDATE branch of the row freeze goes. Set a matched-and-reconciled
period's row aside and its ignore decision changes while the match on it
cannot (0020 forbids ignoring a matched row) -- so it is the put-back that
actually opens: a set-aside row in a finished period comes back into play and
starts counting against a difference that was zero. The body is 0056's: 0055 wrote it first and 0056 re-issued it, and a mutation of the first is shadowed by the second -- toothless caught exactly that on 2026-09-05.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC18 nor can a row there be put back                        the database allowed it
FAIL  RC19 nor set aside                                          expected "RECONCILED", got: Failed query: 
=== 2 CHECK(S) FAILED ===
```

## A late row slips into a finished period

`marker 367`

The INSERT branch of the row freeze goes. Next month's file overlaps March
by a row the bank added after the statement was printed; it lands, the
March rows no longer reproduce the printed ending, and the March
reconciliation reads Finished above an import gap it did not have when it
was finished. An import is one transaction, so the refusal is supposed to
take the whole file with it -- RC21 and RC22 want both halves. The body is 0056's: 0055 wrote it first and 0056 re-issued it, and a mutation of the first is shadowed by the second -- toothless caught exactly that on 2026-09-05.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC21 a late row inside the freeze refuses the whole import  the database allowed it
FAIL  RC22 including the row that was fine                        9 rows before and after
FAIL  RC46b a new row inside it refuses the whole file, in a sentence  2 rows saved.
=== 3 CHECK(S) FAILED ===
```

## A statement is slipped in behind the freeze

`marker 368`

Statements stop being frozen. A February statement is entered after March
is finished; March's beginning balance is now February's ending instead of
zero, its difference is no longer zero, and it still says Finished. This is
the beginning-balance discrepancy QuickBooks warns about, made impossible
rather than warned about.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC23 a statement cannot be slipped in behind the freeze     the database allowed it
FAIL  RC24 nor can the finished statement be deleted              the database allowed it
FAIL  RC25 nor its printed figure changed                         expected "STATEMENT_IMMUTABLE", got: Cannot read properties of undefined (reading 'id')
FAIL  RC26 amending an entry matched inside the freeze is refused  the database allowed it
FAIL  the suite threw before it finished                          Failed query: 
=== 5 CHECK(S) FAILED ===
```

## Finish stops needing the difference to be zero

`marker 369`

The guard finishes a statement whatever the difference. The screen still
prints the difference in amber and still says it must be zero -- and the
button beside it works. A reconciliation that does not reconcile, signed and
frozen. The whole reason the decision is stored is that the arithmetic was
checked at the moment it was made.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC11 and finishing is refused while the difference is not zero  expected "NOT_BALANCED", got: Failed query: 
FAIL  RC12 in a sentence a person can act on                      An earlier statement of this account is not finished. Reconciliations are finished in order.
=== 2 CHECK(S) FAILED ===
```

## Reconciliations can be finished out of order

`marker 370`

April is finished while March is still open. March's rows are now frozen
by April's freeze -- the newest finished date covers them -- so March can
never be balanced by matching anything, and can never be finished. The only
way out is to undo April. RC14 refuses the first step.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC14 finishing April before March is refused                the database allowed it
FAIL  the suite threw before it finished                          Failed query: 
=== 2 CHECK(S) FAILED ===
```

## Any finished reconciliation can be undone

`marker 371`

March is undone while April, which rests on it, stays finished. April's
beginning balance is still March's printed ending -- that did not change --
but March's rows are now free to be unmatched, and April's freeze does not
cover them: it covers everything up to April's date, and it does, but the
newest finished date is now April, so March's rows ARE still frozen. Which
means the undo achieved nothing except a statement that says open while its
rows say frozen. Two answers, and QuickBooks' rule of undoing the last one
first is the one that keeps them at one.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC28 only the newest finished reconciliation can be undone  the database allowed it
FAIL  RC29 and the refusal names which one can                    That statement is not on file, or was not finished.
FAIL  the suite threw before it finished                          That statement is not on file, or was not finished.
=== 3 CHECK(S) FAILED ===
```

## The difference forgets where the last statement ended

`marker 372`

bank_statement_difference counts every match up to the statement date, not
only the ones since the prior statement. April's cleared balance now includes
March's matches on top of March's ending balance -- the same money twice --
and a balanced April shows a difference the size of March. RC13 is the first
to see it: it asks April, which has a prior.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC10 one set-aside row on its own is a difference, not an explanation  difference -436605 = gap 0 + owed -11300, of which the set-aside row is -2500
FAIL  RC13 April balances, and knows March is still open          difference -425305, earlier open 2026-03-31
FAIL  RC14 finishing April before March is refused                expected "EARLIER_OPEN", got: Failed query: 
FAIL  the suite threw before it finished                          Failed query: 
=== 4 CHECK(S) FAILED ===
```

## A row set aside stops counting against the difference

`marker 373`

A set-aside row's amount is treated as cleared. One lone bank error, set
aside with a reason and never accounted for in the books, and the statement
balances to zero and can be finished -- with the books short by that amount
for ever. Two set-aside rows that cancel still balance either way; the
difference is only visible on a lone one, which is what RC10 has.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC10 one set-aside row on its own is a difference, not an explanation  difference -8800 = gap 0 + owed -11300, of which the set-aside row is -2500
=== 1 CHECK(S) FAILED ===
```

## Two exact candidates, and one of them is suggested anyway

`marker 374`

The feed suggests a match when there is AT LEAST one entry with the right
room, instead of exactly one. Two invoices for the same amount on the same
day -- ordinary -- and the row proposes the first of them with a one-click
button, wearing the same confidence as a row with only one. Half of those
clicks are wrong and nothing on the screen says the odds. 07 section 5: a
suggestion is a suggestion, and two is a choice.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC2 two such entries is a choice, not a suggestion          2 exact of 3 candidates, suggestion match
=== 1 CHECK(S) FAILED ===
```

## The remembered account stops ignoring the numbers

`marker 375`

SAME_PAYEE compares descriptions as the bank wrote them. SHAW CABLE 4471 and
SHAW CABLE 9920 are two different payees now, and the second is suggested
nothing -- so the one thing the feature is for, the next month's bill from the
same company, never gets its suggestion. Every bank folds a reference number
or a date into the description.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC3 a row like one posted before is suggested to the same account, digits ignored  none
=== 1 CHECK(S) FAILED ===
```

## Batch accept trusts the screen it was posted from

`marker 376`

acceptMatches matches each ticked row to its first candidate instead of
re-judging whether an exact suggestion still stands. The screen is a minute
old; the entry it suggested was claimed by another row in between; the tick
is still there. Now the row is matched to whatever is nearest -- not the
suggestion the person ticked, and not exact. A batch is the one place a
wrong match goes unnoticed, because nobody looked at each row.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC6 batch accept takes the exact matches and skips the rest, re-judged now, saying why  2 accepted, skipped: {}
FAIL  the suite threw before it finished                          That row is already fully accounted for.
=== 2 CHECK(S) FAILED ===
```

## The excluded tab empties into categorized

`marker 377`

Rows set aside are listed among the categorized ones. Nothing is lost -- the
row is still there, still set aside -- but the tab that exists to be looked
at when a reconciliation will not balance shows nothing, and the categorized
list shows rows the books have no entry for, under a heading that says they
do.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  the suite threw before it finished                          Cannot read properties of undefined (reading 'push')
=== 1 CHECK(S) FAILED ===
```

## The panel offers Finish on a statement that is finished

`marker 378`

The panel stops reading whether the statement is finished. Finish is offered
again above a Finished badge that is no longer printed; pressing it is refused
by the database, in words, so nothing breaks -- what breaks is that Undo is
never offered, and the one way to change anything in a finished period has no
button. RC35 renders the panel for a finished statement and looks for it.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC35 a finished one offers Undo and not Finish              forms /finish
=== 1 CHECK(S) FAILED ===
```

## The Bank seat goes back to being the upload

`marker 379`

nav.ts points the Bank seat at /bank/import again. Everything still renders
and the gate still works -- /bank/... lights the seat by segment either way.
What goes wrong is quiet: 0055 moved every stored grant from /bank/import to
/bank, and a seat that is spelled /bank/import again matches none of them, so
every bookkeeper who had Bank has it no longer, and the screen that grants it
offers a path no row holds. RC32 pins the spelling.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC32 the Bank seat is /bank, and the upload is a step inside it, not a seat  /bank/import
=== 1 CHECK(S) FAILED ===
```

## The batch-accept ticks belong to no form

`marker 380`

The accept form loses its id. Every checkbox in the feed still says
form=accept-matches, and under HTML's form-owner rules a form attribute that
names no <form> associates with nothing -- so the ticks are dropped on the
way out and the headline button of door one answers "tick the rows first"
however many are ticked. It shipped exactly like this, with the id on a span
beside the form (critic); the harness only read inputs INSIDE forms and saw
a form with three hidden fields and nothing wrong.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC36b every box on a row belongs to a form that is on the page  pointing at nothing: accept-matches
FAIL  RC36 every row with a suggested match has a tick that reaches the accept form  0 ticks associated with the accept form, 1 suggested match on screen
=== 2 CHECK(S) FAILED ===
```

## A form's id is trusted to be this company's

`marker 381`

ours() stops asking whether the id belongs to the ledger the form names.
requireLedger still judged the ledger id, so the seat is real -- and the
statement id beside it can be any company's. A person with the Bank seat on
company A finishes company B's reconciliation and freezes B's books, with an
audit row naming them as if they were B's bookkeeper. Nine handlers are
behind this one function; RC37-RC45 post the wrong company's id at each.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC37 match with the other company's id is refused before anything happens  That row is already fully accounted for.
FAIL  RC38 unmatch with the other company's id is refused before anything happens  Match undone.
FAIL  RC39 exclude with the other company's id is refused before anything happens  Set aside.
FAIL  RC40 put back with the other company's id is refused before anything happens  Back in play.
FAIL  RC41 add with the other company's id is refused before anything happens  Choose accounts from this company.
FAIL  RC42 record statement with the other company's id is refused before anything happens  Statement recorded.
FAIL  RC43 delete statement with the other company's id is refused before anything happens  Statement removed.
FAIL  RC44 finish with the other company's id is refused before anything happens  That statement is not on file.
FAIL  RC45b and the other company's books are exactly as they were  statement open, match in place
FAIL  the suite threw before it finished                          PARTY_NOT_TRADING: Someone Else Ltd. holds no transacting role at this company covering 2026-05-02
=== 10 CHECK(S) FAILED ===
```

## The freeze refuses next month's file for rows it already has

`marker 382`

0056's exemption goes: a row identical to one on file is refused like a new
one. Next month's statement overlaps this month's by a few days -- the case
06 section 6 numbers rows for -- and the whole file is refused the moment the
prior month is finished, for rows ON CONFLICT would have discarded anyway.
Every account that has ever been reconciled can never be imported into again
without undoing the reconciliation first.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC46 a file overlapping a finished period by rows already on file lands as usual  the whole file was refused: RECONCILED: a row dated 2026-03-02 is on the finished reconciliation of 2026-03-
=== 1 CHECK(S) FAILED ===
```

## A match can be lifted off a finished period

`marker 383`

The OLD side of the move check is skipped on UPDATE, which is 0055 exactly:
only the row the match is moving TO is judged (a DELETE is still refused, as
it was). Move a match from a March row onto a June row and March's cleared
balance drops by that amount under a reconciliation signed as zero. No
application path moves a match between rows today, so this is the latent
half of the freeze -- and the header of 0055 promised it. RC47 is the only
check that pushes on it.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC47 a match cannot be moved OFF a row inside the freeze either  expected "RECONCILED", got: Failed query: 
=== 1 CHECK(S) FAILED ===
```

## The freeze's refusal loses its sentence

`marker 384`

reconciledSentence returns nothing, so the three places it reaches a person
-- a bank form, an import, deleting an entry -- fall through to the raw
Postgres text or the wrapper around it. The refusal still happens; what is
lost is the one thing the person needs from it, which reconciliation to go and
undo. RC12, RC46b and RC48 each read the sentence.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC48 nor can an entry matched inside it be deleted, and the person is told which reconciliation  Failed query: 
FAIL  RC57b a finished reconciliation refuses both doors on a bank entry, and says which one to undo  difference 0; finish: done; edit → Failed query: 
=== 2 CHECK(S) FAILED ===
```

## The printed Summary stops footing

`marker 385`

reportSummary leaves the Difference line out when the difference is not
zero. Beginning, payments cleared and deposits cleared are still printed and
still right; the ending balance is still the printed one -- and the four no
longer add up, on a report whose whole shape (the owner's QuickBooks
reference) is that they do. A reader adds the column, gets a different
number, and has no line telling them the reconciliation is not finished. RC49
adds the column.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC49b and an unfinished statement prints the Difference line that makes it foot  414005 + 0 + 0 + -119000 = 410905
=== 1 CHECK(S) FAILED ===
```

## The PD7A groups by the period paid for, not the day paid

`marker 386`

remittanceMonths groups stubs by period_end instead of pay_date. For a
semi-monthly payroll the two agree eleven months a year; the pay period
ending 31 December paid on 2 January lands in the wrong year's December, and
the remittance CRA expects by 15 February is shown as due 15 January. The
rule is the day you paid (T4001), and PR43 pays on the 15th and the 31st of
one month so the months only agree if the grouping is by pay date.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR43 a month's remittance is the sum of the runs PAID in it, and its three parts foot  the reader threw: Cannot read properties of null (reading 'split')
=== 1 CHECK(S) FAILED ===
```

## The PD7A counts everybody paid in the month

`marker 387`

The headcount becomes everybody who was paid at any point in the month
instead of the last pay period's. Two on the 15th and one on the 31st reads
as three -- the form asks for the number in the last pay period, and the
figure feeds CRA's own estimate of what the next remittance should be.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR44 the headcount is the last pay period's, not everybody paid that month  2 on the 31st (two were paid on the 15th)
=== 1 CHECK(S) FAILED ===
```

## December's remittance is due in the wrong year

`marker 388`

remittanceDueOn stops carrying the year over: December's figures are due
2026-01-15 -- a year before they were withheld -- and every other month is
right. The one month a year the arithmetic differs is the one that is easy to
never test.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR45 due the 15th of the next month, December included      August → 2026-09-15, December → 2026-01-15
=== 1 CHECK(S) FAILED ===
```

## The PST commission forgets its cap

`marker 389`

pstCommission returns 6.6% of anything over the flat band, with no ceiling.
A company that collects thirty thousand dollars of PST in a quarter is shown
a commission of nearly two thousand where the province allows one hundred and
ninety-eight, and box D is understated by the difference. The tiers are on
the province's page and G18 walks every edge of them.

```
$ db:verify-tax | npm run db:verify-tax
FAIL  G18 the commission follows BC's tiers at every edge   1000000 → 66000 not 19800
FAIL  G31 a back-dated document is taxed at the rate of its own day  on 2026-05-01: GST 5.00, PST 7.00, commission 660.00; with a 2099 entry in front of it, the same $100 on 2099-05-01: GST 9.00, PST 11.00, commission 660.00
=== 2 CHECK(S) FAILED ===
```

## The PST return reads the GST account

`marker 390`

pstReturn asks for the gst_hst_payable role instead of qst_pst_payable. Box B
becomes the GST collected -- a number that is real, on the books, and belongs
on the other return. Two taxes, two accounts, two returns; G17 posts one sale
with both and reads each return's entries by account.

```
$ db:verify-tax | npm run db:verify-tax
FAIL  G16 the PST return: sales, PST collectable, commission, net  A 5000.00 B 250.00 C 22.00 D 228.00
FAIL  G17 each return reads its own tax account and not the other's  GST 250.00, PST entries 2100,2100
FAIL  G20 boxes A and B open their breakdowns               A ok, B 250.00
FAIL  G21 a remittance inside the window is named with its amount on both returns  PST note They debit the PST payable account and move the bank, so the; GST note They debit the GST/HST payable account and move the bank, so
=== 4 CHECK(S) FAILED ===
```

## The audit trail opens to anybody signed in

`marker 391`

The audit page stands behind requireUser instead of requireOwner. Every
company's history -- who created which account, which director was recorded,
what a reconciliation looked like before it was undone -- to a bookkeeper
who holds one company's Bank seat. N14 is satisfied, the page reaches a gate;
N17 asks which one.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N17 the gate asks the access question, the rail draws what was granted, and only an owner may grant  the audit trail page is not behind requireOwner
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The year comparison stops going back a year

`marker 392`

compareDates shifts the span back by nothing. The comparative column shows
this year's figures beside this year's figures, every change reads 0.00, and
the heading says last year. The statements check renders the earlier span
directly and holds the column to it.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T29 the year comparison is the earlier span rendered directly, line for line  aligned false, changes true, reason The books cover only 1 of the 1 fiscal months a year earlier., from 2027-02-01
=== 1 CHECK(S) FAILED ===
```

## The change column runs the other way

`marker 393`

change = compare − current. Revenue that grew shows a negative change and
costs that fell show a positive one, with the two figures beside it both
right. The one column a reader adds nothing to check.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T29 the year comparison is the earlier span rendered directly, line for line  aligned true, changes false, reason null, from 2026-02-01
=== 1 CHECK(S) FAILED ===
```

## The workbook writes money as text

`marker 394`

reportXlsx stops turning a money cell into a number. Every figure is still
on the sheet, right-aligned, in the right row -- as the string "1,234.56".
A column of text adds up to nothing, a SUM over it is zero, and the
spreadsheet the owner asked for so the figures could be worked with is a
picture of the PDF. X40 reads a cell back and asks what type it is.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X40 the trial-balance workbook: numbers in accounting format, bold header, ruled total, frozen header  format xlsx, header bold true, total cell "8,370.00" fmt undefined, model 837000, ruled thin
FAIL  X41 the statement workbook prints each total as the number the render shows  Profit for the period: "4,860.00" vs 486000
FAIL  X49 the workbook carries the quarters and their total as numbers, turns when wide, and a breakdown beats a comparison  header 2026-01 – 2026-03 | 2026-04 – 2026-06 | 2026-07 – 2026-09 | 2026-10 – 2026-12 | Total; 0 row(s) whose total is the sum of four, 0 not; orientation by quarter/by month portrait/landscape; asked for both, the total line is followed by 4 figure(s)
=== 3 CHECK(S) FAILED ===
```

## The workbook's totals lose their rule and their weight

`marker 395`

A rule row is written like any other row: no line above the total, no bold.
The trial balance's total is one more row of figures under the accounts, and
on a two-page print of the general ledger the closing balance of one account
and the first line of the next are the same weight. X40 reads the total row's
font and border back.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X40 the trial-balance workbook: numbers in accounting format, bold header, ruled total, frozen header  format xlsx, header bold true, total cell 8370 fmt #,##0.00;(#,##0.00);"-", model 837000, ruled undefined
FAIL  X41 the statement workbook prints each total as the number the render shows  Profit for the period: 4860 vs 486000
=== 2 CHECK(S) FAILED ===
```

## The row-grid workbook loses its header

`marker 396`

rowsXlsx never recognises the header row, so the journal's and the account
history's column names are ordinary cells: not bold, no rule, nothing frozen
-- and, because the header is also what stops the money parser, a header
that happens to look like money would be turned into a number. X42 reads the
header row of the journal back.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X42 the journal workbook: header found, bold and frozen; money as numbers  header Date bold undefined, frozen undefined, money #,##0.00;(#,##0.00);"-"
=== 1 CHECK(S) FAILED ===
```

## An owner outranks an owner

`marker 397`

mayManage lets an owner manage anybody who is not a superadmin, so an owner
deletes another owner, re-kinds them, and resets their password. The owner's
rule was one sentence -- user由owner删除，owner由superadmin删除 -- and this is
the version where the second half is not true. The screen draws its buttons
from the same function, so it offers them too.

```
$ db:verify-users | npm run db:verify-users
FAIL  US30 an owner manages users; a superadmin manages owners; nobody manages themselves  ownerDeletesOwner → (no refusal); ownerGrantsToOwner → Nobody by that id.; ownerDeletesOwnerByForm → Nobody by that id.
FAIL  US32 there is exactly one superadmin: no door removes them, and no door makes a second  boss2 is gone before this check ran — an owner deleted an owner
=== 2 CHECK(S) FAILED ===
```

## The doors stop asking the ladder

`marker 398`

assertMayManage still refuses your own row and still looks the target up,
but no longer compares ranks. requireOwner stands at every action, so a user
cannot reach them -- an owner can, and the form body's userId is whatever the
browser sent: an owner signs off, re-kinds, deletes, or resets the password
of the superadmin. The keep-one trigger refuses only the LAST active one.

```
$ db:verify-users | npm run db:verify-users
FAIL  US30 an owner manages users; a superadmin manages owners; nobody manages themselves  ownerDeletesOwner → (no refusal); ownerResetsSuperadmin → (no refusal); ownerGrantsToOwner → Nobody by that id.; ownerDeletesOwnerByForm → Nobody by that id.
FAIL  US32 there is exactly one superadmin: no door removes them, and no door makes a second  boss2 is gone before this check ran — an owner deleted an owner
=== 2 CHECK(S) FAILED ===
```

## Every person's grants render all the time again

`marker 399`

The row's Access form stops waiting to be opened -- every user's companies
and modules are on the page for every person, always, which is the wall of
forms the owner asked to have folded away. Nothing is less safe; it is the
screen the owner said was unusable.

```
$ db:verify-users | npm run db:verify-users
FAIL  US33 the screen offers each row exactly what the ladder allows, and no grants until a row is opened  50 grant boxes rendered with no row open; unopened grant boxes: superadmin 25, owner 25
=== 1 CHECK(S) FAILED ===
```

## Anybody's password is yours to change

`marker 400`

The one exception at the password door -- your own -- widens to everybody.
An owner types a new password for the superadmin and signs in as them; the
rung above the owner is decorative from that moment.

```
$ db:verify-users | npm run db:verify-users
FAIL  US30 an owner manages users; a superadmin manages owners; nobody manages themselves  ownerResetsSuperadmin → (no refusal)
=== 1 CHECK(S) FAILED ===
```

## A deletion leaves no trail

`marker 401`

deleteUser drops the row and writes nothing to audit_log. app_user has no
audit trigger, so afterwards the database holds no line saying who deleted
whom or when -- only the created_by text on rows the deleted person wrote,
which is history ABOUT them, not the act. The one irreversible thing the
people screen can do becomes the one thing the trail does not show.

```
$ db:verify-users | npm run db:verify-users
FAIL  US31 a deleted person takes their sessions and grants, the trail names the deleter, and every row they wrote still names them  account and session gone; 0 grant rows left; 0 delete_user rows by owner@example.test; 2 set_kind rows; created_by still "boss@example.test"
=== 1 CHECK(S) FAILED ===
```

## Every PDF becomes a download

`marker 402`

pdfResponse sends the PDF as an attachment too. Eleven routes leave through
it -- the seven reports, invoices, customer statements, certificates and the
registers -- and every Download PDF link targets a new tab, so each click now
opens a blank tab and drops a file. This is the version the Excel node shipped
for a day, and the comment above the function still said inline.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X43 a PDF leaves inline and a workbook as an attachment, each with its own type and extension  attachment; filename="Acme-Consulting-Inc._trial-balance_2026-01-01_2026-03-31.pdf" · attachment; filename="Acme-Consulting-Inc._trial-balance_2026-01-01_2026-03-31.xlsx"
=== 1 CHECK(S) FAILED ===
```

## The tax return's paper loses the entries behind its figures

`marker 403`

taxReturnPdf goes back to the four boxes and a review sentence. The CSV this
paper replaced carried every line's entries with a total under each; the
button that used to reach the CSV now reaches this, so nobody can check a
figure line by line at a desk any more. The workbook is a thinner file than
the one the owner asked to have replaced.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X45 the tax workbook carries every line's entries with a total; a count stays a count, a code stays text  lines with entries 2, headings 0, totals 0, entry rows 1/5; runs=2 fmt undefined, code "1000.00", amount -12.5 fmt #,##0.00;(#,##0.00);"-"
=== 1 CHECK(S) FAILED ===
```

## A count is written as money

`marker 404`

rowsXlsx puts the accounting format on every number, so the PD7A worksheet
shows Runs 2.00 and Employees 3.00, and a month with none shows a dash where
a zero should be. The figures are right; the paper says they are dollars.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X45 the tax workbook carries every line's entries with a total; a count stays a count, a code stays text  lines with entries 2, headings 2, totals 2, entry rows 5/5; runs=2 fmt #,##0.00;(#,##0.00);"-", code "1000.00", amount -12.5 fmt #,##0.00;(#,##0.00);"-"
=== 1 CHECK(S) FAILED ===
```

## A second superadmin can be made

`marker 405`

mayAssign hands out the superadmin kind again, so the superadmin promotes
anybody to their own rung from the Type select and the Add form. The owner
ruled there is exactly one; the table's unique index still refuses the row,
so this is the screen offering, and the library allowing, what the database
then refuses with an index name instead of a sentence.

```
$ db:verify-users | npm run db:verify-users
FAIL  US30 an owner manages users; a superadmin manages owners; nobody manages themselves  superadminMakesSuperadmin → Error: Failed query: 
FAIL  US32 there is exactly one superadmin: no door removes them, and no door makes a second  delete and sign-off refused by the table; a second refused by the index, the library and the form; 1 superadmin
FAIL  US33 the screen offers each row exactly what the ladder allows, and no grants until a row is opened  superadmin sees olive@x.test's type as select:superadmin/owner/user not select:owner/user; superadmin sees bev@x.test's type as select:superadmin/owner/user not select:owner/user
=== 3 CHECK(S) FAILED ===
```

## The trigger half stops asking who is acting

`marker 406`

0060's trigger at the door of audit_log no longer swaps the role's name for
`app.actor`. Every row a trigger writes — a draft discarded, an account
renamed, a year closed — names the Postgres role again, whoever was signed in,
which is RISKS §10 reopened in one line. `D21` asks the drafts suite's whole
trail whether any row names the role.

```
$ db:verify-drafts | npm run db:verify-drafts
FAIL  D21 every audit row this suite wrote names a person, not the database role  close_period ×2, create_account ×10, discard_draft ×8, edit_draft ×1, reopen_period ×2, update_account ×2 name the database role
=== 1 CHECK(S) FAILED ===
```

## A discarded draft is discarded by the database role

`marker 407`

`discardDraft` deletes outside `actingAs`, so the discard trigger fires in a
transaction that never said who is acting and its row names the role. The
door still takes an actor; it just does nothing with it — the shape the old
`unignoreBankRow` comment warned about.

```
$ db:verify-drafts | npm run db:verify-drafts
FAIL  D21 every audit row this suite wrote names a person, not the database role  discard_draft ×4 name the database role
=== 1 CHECK(S) FAILED ===
```

## An account is renamed by the database role

`marker 408`

`updateAccount` runs its UPDATE in a plain transaction. The account trigger's
`update_account` row names the role; `A27` finds it.

```
$ db:verify-accounts | npm run db:verify-accounts
FAIL  A28 creating, renaming and retiring an account are trailed under the person who did it  create_account update_account update_account deactivate_account; actor(s) pat@x.test ft_release
FAIL  A27 every audit row this suite wrote names a person, not the database role  update_account ×3 name the database role
=== 2 CHECK(S) FAILED ===
```

## A year is closed by the database role

`marker 409`

`closeFiscalYear` posts the closing entry and marks the year closed without
saying who. The application's own `close_year` row still names the person; the
trigger's `close_year` row — the one 0003 wrote so the change is captured
however it was made — names the role. Two rows for one act, two names.

```
$ db:verify-periods | npm run db:verify-periods
FAIL  P29 every audit row this suite wrote names a person, not the database role  close_year ×1 name the database role
=== 1 CHECK(S) FAILED ===
```

## A party is taken off the lists by nobody

`marker 410`

`deactivateParty` drops the actor it was handed and says '' instead. The
setting is empty, `nullif` makes it NULL, the trigger keeps the role's name.
An accepted-and-dropped parameter is the exact defect the old comment on
`unignoreBankRow` refused to have.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P53 every audit row this suite wrote names a person, not the database role  update_party ×3 name the database role
=== 1 CHECK(S) FAILED ===
```

## Money is un-applied by nobody

`marker 411`

`unapply` forgets the actor. 0034's `unapply_from_invoice` row names the
role; `PM43` finds it.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM43 every audit row this suite wrote names a person, not the database role  unapply_from_invoice ×2 name the database role
=== 1 CHECK(S) FAILED ===
```

## A bank row is put back in play by nobody

`marker 412`

`unignoreBankRow` takes an actor again since 0060 — and here drops it. The
un-ignore row names the role, which is what this door did on purpose for a
year, and what `M78` now refuses.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M78 every audit row this suite wrote names a person, not the database role  bank_row_unignored ×3 name the database role
=== 1 CHECK(S) FAILED ===
```

## A password change leaves no trail

`marker 413`

`setPassword` changes the hash and ends the sessions and writes no row. The
one door that must never record what it changed now records nothing at all —
not who, not when, not how many sessions it ended. `US34` counts the row.

```
$ db:verify-users | npm run db:verify-users
FAIL  US34 changing a password writes who did it and how many sessions it ended, never the password  no set_password row
FAIL  US36 a password can be set from the shell, and the trail says a shell did it  Password set for pat@x.test (user) in figtree_011p_tail880_test. Every; actor none; sign-in ok
=== 2 CHECK(S) FAILED ===
```

## A change of grants leaves no trail

`marker 414`

`setGrants` replaces what somebody may see and writes no row. A grant
widened and narrowed again leaves no trace — RISKS §15b's open item, reopened.
`US35` reads the before and after.

```
$ db:verify-users | npm run db:verify-users
FAIL  US35 every change of grants writes what they had and what they have now  0 set_grants row(s)
=== 1 CHECK(S) FAILED ===
```

## The shell door ignores the password it was given

`marker 415`

`reset-password.ts` generates a random password whether or not --password was
passed, prints the one it made, and the one the person typed does not sign in.
`US36` signs in with what it passed.

```
$ db:verify-users | npm run db:verify-users
FAIL  US36                                                        could not sign in as pat@x.test: That email and password do not match.
FAIL  US36 a password can be set from the shell, and the trail says a shell did it  Password set for pat@x.test (user) in figtree_011p_tail880_test. Every; actor shell:fiscalcatadmin; sign-in refused
=== 2 CHECK(S) FAILED ===
```

## An import no longer waits for the account

`marker 416`

`importBankRows` says who is acting and then writes without taking the
account's lock. A Finish in flight on the same account computes its difference
without these rows and commits a finished statement over them (RISKS §21b).
`RC51` holds the lock from a second connection and watches the import land
anyway.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC51 an import waits while somebody holds the account       did not wait: landed
=== 1 CHECK(S) FAILED ===
```

## Finish no longer waits for the account

`marker 417`

`finishReconciliation` skips the lock and goes straight to the UPDATE whose
guard computes the difference. Everything that took the lock still serialises
with each other and none of it with Finish — the one door the lock exists for.
`RC52` holds the lock and watches Finish finish under it.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC52 and so does Finish, and it still finishes once the lock is released  did not wait: landed
=== 1 CHECK(S) FAILED ===
```

## Releasing a match no longer waits for the account

`marker 418`

`releaseReferences` deletes an entry's bank matches without taking the
account's lock. A Finish in flight on that account computes its difference
with the match still counted, the freeze trigger judges the delete against a
Finish it cannot see, and both commit — the race RISKS §21b describes, through
the one door the first version of the lock left out. `RC54` holds the lock and
watches the delete land under it.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC54 deleting a matched entry waits for the account too, and its match is released after  did not wait: landed
=== 1 CHECK(S) FAILED ===
```

## Renaming a party from the screen is done by nobody

`marker 419`

`updatePartyFromForm` takes the actor the action hands it and passes
'system' on, which is what the door did before it took an actor at all. The
trigger's row names 'system' — a real value, so the whole-trail check cannot
see it; `P54` reads the row for the party it renamed.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P54 renaming a party from the screen is trailed under the person who did it  system renamed it to Renamed Ltd.
=== 1 CHECK(S) FAILED ===
```

## The year-end closing entry is counted as a flow

`marker 420`

`accountMovements` stops setting closing entries aside: the entry that moves
the year's result into retained earnings reads as the year's transactions. On
a closed year the cash flow statement's profit line reads zero and the
statement of changes in equity grows an "Other movements" row that undoes the
profit — the shape 02-roles-and-statements.md §六 said a linear model would
produce. `T38` reads both statements after the close.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T38 closing the year moves nothing on either statement: the profit is still the profit, retained earnings has no "other" row  cf profit 0 vs ledger 950000; eq profit 0; rows OPEN,PROFIT,SHARES,OTHER_MOVES,CLOSE;  
FAIL  T38b and reopening it moves nothing either            profit 950000 vs 0; rows OPEN,PROFIT,SHARES,CLOSE;  
FAIL  T38c and reversing the reopen moves nothing either: the chain is walked to its root  profit 0 vs 0; rows OPEN,PROFIT,SHARES,OTHER_MOVES,CLOSE;  
=== 3 CHECK(S) FAILED ===
```

## A reversal is classed by its own source, not by what it reverses

`marker 421`

The reversal of a closing entry is an 'adjustment', so when a year is reopened
the close is set aside and its reversal is counted: the profit line doubles.
`T38b` reopens the year and expects nothing to move.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T38b and reopening it moves nothing either            profit 1900000 vs 950000; rows OPEN,PROFIT,SHARES,OTHER_MOVES,CLOSE;  
=== 1 CHECK(S) FAILED ===
```

## The cash effect keeps the ledger's sign

`marker 422`

A bigger receivable reads as cash received and a bigger payable as cash paid.
Every activity total is wrong by twice its size, and the proof line no longer
meets the cash accounts. `T33` and `T34`.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T33 the cash flow statement reconciles to the cash accounts  The statement does not reconcile to the cash accounts: they hold 41000.00 more at the end of the range than beginning cash plus the net change shown. Run the balance checks on the company page. beginning 0 net -1100000 ending 3000000 ledger 3000000
FAIL  T34 operating, investing and financing each hold what the fixture put there, as cash effects  CF_OPER 27000.00 not -8000.00; CF_INV 12000.00 not -12000.00; CF_FIN -50000.00 not 50000.00
FAIL  T35 an account nobody has placed is named, shown apart, and still counted  1 account moved money in the range and belongs to no activity — tag it with cf_operating, cf_investing, cf_financing or cf_non_cash_adjustment: 1900 Mystery deposit | The statement does not reconcile to the cash accounts: they hold 39600.00 more at the end of the range than beginning cash plus the net change shown. Run the balance checks on the company page.; unclassified 70000
FAIL  T36 a cash-flow tag places the account and outranks the default  The statement does not reconcile to the cash accounts: they hold 39600.00 more at the end of the range than beginning cash plus the net change shown. Run the balance checks on the company page. investing 1270000
FAIL  T38 closing the year moves nothing on either statement: the profit is still the profit, retained earnings has no "other" row  cf profit 950000 vs ledger 950000; eq profit 950000; rows OPEN,PROFIT,SHARES,CLOSE; The statement does not reconcile to the cash accounts: they hold 39600.00 more at the end of the range than beginning cash plus the net change shown. Run the balance checks on the company page. 
FAIL  T38b and reopening it moves nothing either            profit 950000 vs 950000; rows OPEN,PROFIT,SHARES,CLOSE; The statement does not reconcile to the cash accounts: they hold 39600.00 more at the end of the range than beginning cash plus the net change shown. Run the balance checks on the company page. 
FAIL  T38c and reversing the reopen moves nothing either: the chain is walked to its root  profit 950000 vs 950000; rows OPEN,PROFIT,SHARES,CLOSE; The statement does not reconcile to the cash accounts: they hold 39600.00 more at the end of the range than beginning cash plus the net change shown. Run the balance checks on the company page. 
=== 7 CHECK(S) FAILED ===
```

## Opening balances are flows

`marker 423`

Beginning cash forgets the opening-balance entries dated inside the span.
A company opened with 4,000 in the bank shows beginning cash of nothing, and
the proof line says the statement does not reconcile. `T39`.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T39 an opening-balance entry is beginning cash and an entered balance, never a flow  beginning 0 net 30000 ending 430000; entered 400000/400000; The statement does not reconcile to the cash accounts: they hold 4000.00 more at the end of the range than beginning cash plus the net change shown. Run the balance checks on the company page. 
=== 1 CHECK(S) FAILED ===
```

## Depreciation is an investing activity

`marker 424`

The default for accumulated depreciation moves from non-cash adjustments to
investing. The statement still foots — every activity is summed into the same
net change — and the operating figure is wrong by the year's depreciation,
which is the kind of error a footing statement hides. `T34` reads the
operating total.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T34 operating, investing and financing each hold what the fixture put there, as cash effects  dep -100000 ar -2260000
=== 1 CHECK(S) FAILED ===
```

## A cash-flow tag no longer places the account

`marker 425`

`sectionOf` ignores the explicit cf_* roles, so an account with no
classification default stays under "Not classified" however it is tagged.
`T36` tags one and expects it to move.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T36 a cash-flow tag places the account and outranks the default  1 account moved money in the range and belongs to no activity — tag it with cf_operating, cf_investing, cf_financing or cf_non_cash_adjustment: 1900 Mystery deposit investing -1200000
FAIL  T38 closing the year moves nothing on either statement: the profit is still the profit, retained earnings has no "other" row  cf profit 950000 vs ledger 950000; eq profit 950000; rows OPEN,PROFIT,SHARES,CLOSE; 1 account moved money in the range and belongs to no activity — tag it with cf_operating, cf_investing, cf_financing or cf_non_cash_adjustment: 1900 Mystery deposit 
FAIL  T38b and reopening it moves nothing either            profit 950000 vs 950000; rows OPEN,PROFIT,SHARES,CLOSE; 1 account moved money in the range and belongs to no activity — tag it with cf_operating, cf_investing, cf_financing or cf_non_cash_adjustment: 1900 Mystery deposit 
FAIL  T38c and reversing the reopen moves nothing either: the chain is walked to its root  profit 950000 vs 950000; rows OPEN,PROFIT,SHARES,CLOSE; 1 account moved money in the range and belongs to no activity — tag it with cf_operating, cf_investing, cf_financing or cf_non_cash_adjustment: 1900 Mystery deposit 
=== 4 CHECK(S) FAILED ===
```

## The year's result is not retained earnings

`marker 426`

`columnOf` stops folding revenue and expense accounts into the retained
earnings column. The profit lands in "Other equity", and closing the year now
moves money between columns — which the proof row catches, and which `T37`
reads directly.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T37 the statement of changes in equity shows the profit under retained earnings, the shares under share capital, and foots  4 equity accounts carry none of share_capital, contributed_surplus, retained_earnings, dividends_declared or accumulated_oci and are shown under "Other equity": 4000 Consulting Revenue, 5000 Salaries, 5100 Professional Fees, 5200 Depreciation cols SC,RE,OTHER rows OPEN:0/0/0/0 PROFIT:0/0/950000/950000 SHARES:5000000/0/0/5000000 CLOSE:5000000/0/950000/5950000
FAIL  T38 closing the year moves nothing on either statement: the profit is still the profit, retained earnings has no "other" row  cf profit 950000 vs ledger 950000; eq profit 0; rows OPEN,PROFIT,SHARES,CLOSE;  4 equity accounts carry none of share_capital, contributed_surplus, retained_earnings, dividends_declared or accumulated_oci and are shown under "Other equity": 4000 Consulting Revenue, 5000 Salaries, 5100 Professional Fees, 5200 Depreciation | The statement does not reconcile: Retained earnings is off by 9500.00; Other equity is off by 9500.00. A year-end closing entry that touched an account outside its column, or a balance the ledger's checks would refuse. Run the balance checks on the company page.
FAIL  T38b and reopening it moves nothing either            profit 950000 vs 950000; rows OPEN,PROFIT,SHARES,CLOSE;  4 equity accounts carry none of share_capital, contributed_surplus, retained_earnings, dividends_declared or accumulated_oci and are shown under "Other equity": 4000 Consulting Revenue, 5000 Salaries, 5100 Professional Fees, 5200 Depreciation
FAIL  T38c and reversing the reopen moves nothing either: the chain is walked to its root  profit 950000 vs 950000; rows OPEN,PROFIT,SHARES,CLOSE;  4 equity accounts carry none of share_capital, contributed_surplus, retained_earnings, dividends_declared or accumulated_oci and are shown under "Other equity": 4000 Consulting Revenue, 5000 Salaries, 5100 Professional Fees, 5200 Depreciation | The statement does not reconcile: Retained earnings is off by 9500.00; Other equity is off by 9500.00. A year-end closing entry that touched an account outside its column, or a balance the ledger's checks would refuse. Run the balance checks on the company page.
FAIL  T39 an opening-balance entry is beginning cash and an entered balance, never a flow  beginning 400000 net 30000 ending 430000; entered 400000/0/400000;  1 equity account carries none of share_capital, contributed_surplus, retained_earnings, dividends_declared or accumulated_oci and is shown under "Other equity": 4000 Consulting Revenue
=== 5 CHECK(S) FAILED ===
```

## The statement door forgets the two derived statements

`marker 427`

`statementPdf` no longer branches on the derived codes; a request for
CASH_FLOW looks for a template of that name and finds none. The page still
draws the statement; the PDF and the workbook are gone. `X46`.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X46 the cash flow and equity statements leave as a PDF and as a workbook through the statement door  CASH_FLOW pdf: null; CASH_FLOW xlsx: null; EQUITY_CHANGES pdf: null; EQUITY_CHANGES xlsx: null
=== 1 CHECK(S) FAILED ===
```

## A reversal chain is walked one hop

`marker 427b`

The recursive walk stops at the roots' direct reversals, so the reversal of
a reopen — reachable from the entry page — wears its own 'adjustment' and
lands in the span's movement: the profit line reads zero and the equity
statement grows an "Other movements" row, while both proofs still foot.
`T38c` reverses the reopen and expects nothing to move.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T38c and reversing the reopen moves nothing either: the chain is walked to its root  profit 0 vs 950000; rows OPEN,PROFIT,SHARES,OTHER_MOVES,CLOSE;  
=== 1 CHECK(S) FAILED ===
```

## The books contributed are everybody's

`marker 428`

`earlierQuestionsFor` reads every company's old questions instead of this
one's. The other company's questions, answers and the books text they sent
show on this company's Assistant page — the one leak this module must never
have. `IQ16` asks one in the other company. (Until 2026-09-14 this block
removed `booksContext`'s filter; that function went with the tick box.)

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ16 earlier questions leave out bill readings, used or discarded, and another company's, and show a narrower seat only its own  owner sees 3: the other company asked t; the clerk asked the old f; the owner asked the old f; clerk sees 1; the reading instruction begins with the shared sentence (source) true
=== 1 CHECK(S) FAILED ===
```

## An answered question leaves no row

`marker 429`

`ask` returns the reply without writing the exchange. The person sees the
answer; the trail of what was asked, and of what the books contributed, is
gone. `AI6` and `AI10` read the rows back.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI6 money is derived from each row's own tokens and typed prices; none without them; no cost, dollar or key column exists  priced row undefinedNaN; unpriced NaN; blank null; cached default 0.5
FAIL  AI10 each company sees its own exchanges only               2 here, 0 there
=== 2 CHECK(S) FAILED ===
```

## A refusal reads as an answer of nothing

`marker 430`

`ask` stops treating a refusal stop reason as a failure: the row keeps an
empty answer and no error, and the page shows a question with a blank under
it — indistinguishable from a model with nothing to say. `AI4`.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI4 a refusal is recorded as one: no answer, the stop reason, the explanation  answer null, stop refusal, error null
=== 1 CHECK(S) FAILED ===
```

## The trail can be edited

`marker 431`

0061's trigger lets an UPDATE through. An answer can be rewritten after the
fact, which makes the record of what the assistant said a record of what
somebody later wished it had said. `AI7`.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI7 an exchange can be neither edited nor deleted           update: … delete: Failed query: DELETE FROM ai_exchange WH…
=== 1 CHECK(S) FAILED ===
```

## No service is not a refusal at the door

`marker 432`

`ask` no longer refuses a question that came with no service. The sender is
reached with nothing to send to, and the line that builds the row then reads
a field of that nothing and crashes: the asking leaves neither the sentence
that says what to fill in nor a row. `AI1` hands in a sentinel sender and
expects it never to be reached; the red is the sender being reached once.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI1 with no service of their own, the person is refused in a sentence; nothing is sent or recorded  Cannot read properties of null (reading 'model'); sender reached 1 time(s); 0 row(s); two of three fields → null
=== 1 CHECK(S) FAILED ===
```

## Output tokens are priced as input

`marker 433`

`costOf` multiplies the answer's tokens by the input price. Every figure on
the page is understated by whatever the two prices differ by, and nothing
else changes, because money is derived and this arithmetic is the only place
it comes from — which is why `AI6` checks the arithmetic, not a stored number.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI6 money is derived from each row's own tokens and typed prices; none without them; no cost, dollar or key column exists  priced row ¥0.0105; unpriced null; blank null; cached default 0.5
=== 1 CHECK(S) FAILED ===
```

## The sender signs the request the Anthropic way

`marker 434`

`sendToRelay` puts the key in an `x-api-key` header instead of
`Authorization: Bearer`. Anthropic's own endpoint would accept it; every
OpenAI-compatible relay answers 401. `AI13` reads the header the suite's
service received.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI13 the sender speaks the OpenAI-compatible shape: one POST, a bearer token, two messages, the first choice read back; cached tokens are not counted twice  POST /v1/chat/completions auth=undefined…; model relay-model-under-test; 2 messages; reply end_turn 100/7/20
FAIL  AI14 the key is in no row: a service that echoes it in an error is recorded with it struck out  error: 401 Unauthorized: {"error":{"message":"key undefin; rows carrying the key: 0
=== 2 CHECK(S) FAILED ===
```

## A content filter reads as a broken service

`marker 435`

`content_filter` maps to end_turn. The service's empty content is then
'no text' — a failed asking with the wrong story: the model declined, and the
row says the service broke, with no explanation of what was declined.
`AI13b` expects a refusal with its reason.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI13b a content filter and a refusal text are both a refusal with an explanation, never an empty answer  filter: FAILED the service answered with no text (finish_reason c; refusal field: refusal "I cannot help with that."
=== 1 CHECK(S) FAILED ===
```

## The key goes into the trail through an error

`marker 436`

`withoutKey` returns its text untouched. A service that echoes the bearer
token in an error body — some do, on a malformed one — now puts the key into
`ai_exchange.error`, and from there into every backup, which is exactly the
one place the owner ruled it must never be. `AI14` asks such a service and
reads the row.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI14 the key is in no row: a service that echoes it in an error is recorded with it struck out  error: 401 Unauthorized: {"error":{"message":"key sk-suit; rows carrying the key: 1
=== 1 CHECK(S) FAILED ===
```

## The key is kept in the clear

`marker 437`

`encryptKey` returns the key as bytes. The column is still called
`key_enc` and still holds something that looks binary in psql, so nothing
reads as wrong — and every backup now carries every person's key in plain
text, which is the one thing the owner asked this table to prevent.
`AI16` looks for the key IN THE BYTES (`position(convert_to(...) in
key_enc)`): the first version compared the row rendered as text, where a
bytea prints as hex, and reported a clean row while the key sat in it.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI15 a key encrypts and comes back; a different secret or an altered blob gives nothing, not garbage  46 bytes, twice different: true; wrong secret → null; altered → null
FAIL  AI16 the key is nowhere in the bytes of the saved row, which keep only ciphertext and its last four characters  key found in key_enc: true; hint 3a9c; 100 hex chars
FAIL  AI16b and reading the row back under the same secret gives the key again  saved: Saved: relay-model-under-test at 127.0.0.1:64182, key ending …3a9c.; state unreadable
FAIL  AI17 a blank key keeps the saved one, and an address that is not a web address is refused  model now unchanged, key kept: false (refused: INCOMPLETE); bad address → BAD_ADDRESS
FAIL  AI19 what the page hands the panel carries no key and no ciphertext, and the panel names the service by its hint and says where the secret goes  props carry the key: false (131 chars); markup clean: true; ready 4413, none 4052, no secret 4405, unreadable 4413
=== 5 CHECK(S) FAILED ===
```

## A key read under the wrong secret comes back as noise

`marker 438`

`decryptKey` returns the raw blob instead of null when the cipher refuses
it. After the secret changes, every saved key 'reads' as a string of noise:
the page shows a service that is ready, and the first question goes out with
a key made of ciphertext. `AI15` and `AI18` expect nothing, not noise.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI15 a key encrypts and comes back; a different secret or an altered blob gives nothing, not garbage  46 bytes, twice different: true; wrong secret → " �rg��9�]p�����\u001f4W"; altered → " �rg��9�]p�����\u001f4�"
FAIL  AI18 a changed secret makes the key unreadable and says so; with no secret nothing saves; forgetting removes it and is trailed without it  changed secret → ready; no secret → NO_SECRET: Keys cannot be kept until the; cleared → none, newest trail row clear_ai_service; rows carrying the key: 0
=== 2 CHECK(S) FAILED ===
```

## Changing the model forgets the key

`marker 439`

A blank key box no longer keeps the saved key: `saveService` refuses, so
changing the model or a price means typing the key again — and a person who
does not have it to hand loses the service they had. `AI17` saves with a
blank key on purpose.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI17 a blank key keeps the saved one, and an address that is not a web address is refused  model now unchanged, key kept: false (refused: INCOMPLETE); bad address → BAD_ADDRESS
=== 1 CHECK(S) FAILED ===
```

## Forgetting a service leaves no trail

`marker 440`

`clearService` deletes the row and writes no audit line. Somebody else's
service disappearing is then indistinguishable from one that was never
saved, on a table whose whole purpose is a credential. `AI18` reads the
trail after forgetting.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI18 a changed secret makes the key unreadable and says so; with no secret nothing saves; forgetting removes it and is trailed without it  changed secret → unreadable; no secret → NO_SECRET: Keys cannot be kept until the; cleared → none, newest trail row set_ai_service; rows carrying the key: 0
=== 1 CHECK(S) FAILED ===
```

## The panel is handed the key it must not have

`marker 441`

`panelStateFrom` — the one function that decides what the screen may know —
carries the key as well as the hint. Nothing on the screen prints it, so the
markup looks the same; but a client component's props are serialised into the
page the browser downloads, so the key ships to every device that opens the
assistant. `AI19` reads what that function returns, not markup it built
itself: the first version of this block changed a mapping no check could see.

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI19 what the page hands the panel carries no key and no ciphertext, and the panel names the service by its hint and says where the secret goes  props carry the key: true (174 chars); markup clean: false; ready 758, none 4052, no secret 4405, unreadable 4413
=== 1 CHECK(S) FAILED ===
```

## A PDF is read anyway

`marker 442`

`readBill` accepts anything at all — a spreadsheet, an archive, a video.
The refusal that keeps a file this system cannot read from ever reaching a
service, and from becoming a reading with an unhelpful error, is gone.
`BR1` sends a Word document to a sender that throws if it is reached.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR1 a file that is not a bill, an empty one and a big one are refused before anything leaves  read / EMPTY: The file is empty — not / TOO_BIG: That file is 8.0 MB; ; sender reached 1; 1 reading(s), 1 asking(s)
FAIL  BR3 the proposal is kept with the file: unknown code → no account, unknown tag → no tag, unreadable line dropped; this company only  3 lines; codes 5300,,5400; tags GST_PST,GST_PST,∅; here 2, there 0
FAIL  BR4 prose and a failed call are readings with an error and no proposal; the file is kept; the key is in no row  The model answered, but not with a proposal this c / 401 Unauthorized: {"error":{"message":"i; 4 readings; key in rows: false
=== 3 CHECK(S) FAILED ===
```

## The picture stays home

`marker 443`

`sendToRelay` sends the instruction and the chart but not the picture — the
image part is skipped, the content is plain text. A model asked to read a
bill it was not given answers about a bill it imagined. `BR2` reads the
request the loopback service received: two parts, the second a data URL of
the bytes that were uploaded.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR1b a PDF is read: it goes as a file part with its name, not as a picture, and is kept as it arrived  string; named undefined; proposal true
FAIL  BR2 the picture and the chart leave — codes, names, types; no balances, no other company  string; system 991 chars, chart in books_sent: true; balance in it: false
FAIL  BR2b a long file name is shortened before it leaves                 404 characters named, 0 sent (cap 200), ellipsis false
FAIL  BR21 a sentence and a document leave together in one question and are kept together  string; file named false, sentence false; row both.png / Staples again, paid by card
=== 4 CHECK(S) FAILED ===
```

## A code the chart lacks is kept

`marker 444`

`parseProposal` keeps whatever account code the model named. A plausible
code from some other chart then opens the review form on an account this
company does not have — which the form cannot show, and the person cannot
see. `BR3` feeds a proposal naming 9999 and reads back no account.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR3 the proposal is kept with the file: unknown code → no account, unknown tag → no tag, unreadable line dropped; this company only  3 lines; codes 5300,9999,5400; tags GST_PST,GST_PST,∅; here 1, there 0
FAIL  BR18 an account the model could not place is filled from where this supplier went last time, and its own suggestion is kept  remembered 5400; a stranger → null; after a correction still 5400; "Taple" is not "Staples": true; an account the form does not offer → blank; the model's unmatched 6200 kept as 6200; without a memory the box stays blank: true
=== 2 CHECK(S) FAILED ===
```

## A used reading is attached again

`marker 445`

`attachReadingTo` no longer asks whether the reading has been used. The same
photo, posted from two tabs, becomes two entries with the same receipt filed
against each. `BR8` attaches a used reading a second time and expects the
sentence, and one file.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR8 a used reading cannot be attached, moved or deleted; a reading is attachable and discardable in its own company only  again: ALREADY_ENTERED: That reading has alread; moved: Failed query: UPDATE ai_bill_r; deleted: Failed query: DELETE FROM ai_b; elsewhere: NO_READING: That reading is not in these; 1/1/0 files
=== 1 CHECK(S) FAILED ===
```

## A reading from another company can be attached here

`marker 446`

`attachReadingTo` looks the reading up by id alone. A reading id is a
UUID in a URL; with this line, one company's bill can be filed against
another company's entry and closed. `BR8` tries exactly that from the
other company and expects to be told the reading is not in these books.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR8 a used reading cannot be attached, moved or deleted; a reading is attachable and discardable in its own company only  again: ALREADY_ENTERED: That reading has alread; moved: Failed query: UPDATE ai_bill_r; deleted: Failed query: DELETE FROM ai_b; elsewhere: attached; 1/0/1 files
=== 1 CHECK(S) FAILED ===
```

## An unknown account becomes the first one

`marker 447`

`accountIdOf` fills a line the model could not place with the first account
in the chart instead of leaving it blank. The form then opens complete, and
the review the owner asked for — the door refusing until a person picks —
never happens, because there is nothing to pick. `BR5` and `BR6` expect
the blank.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR5 the expense form opens with the proposal: account by code or blank, date from the document or today  rows acct,acct,acct; date 2026-02-03; undated → 2026-09-06
FAIL  BR6 the bill form opens with the supplier matched by name or named as unknown, the payable account, the dates, the rows  party matched; stranger → Grand & Toy; 6 rows
FAIL  BR18 an account the model could not place is filled from where this supplier went last time, and its own suggestion is kept  remembered 5400; a stranger → null; after a correction still 5400; "Taple" is not "Staples": true; an account the form does not offer → USED ANYWAY; the model's unmatched 6200 kept as 6200; without a memory the box stays blank: false
=== 3 CHECK(S) FAILED ===
```

## Any supplier will do

`marker 448`

`invoiceInitialFrom` opens the bill on the first party in the list when the
document names one the books do not have. The party box is filled, the
amber notice does not appear, and the bill lands on the wrong supplier's
account. `BR6` names a stranger and expects the box blank and the stranger
named.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR6 the bill form opens with the supplier matched by name or named as unknown, the payable account, the dates, the rows  party matched; stranger → null; 6 rows
FAIL  BR19 a supplier name matches across scripts, accents, full-width letters, symbols and a closing company suffix, and only the same name  chineseWithSuffix NO; differentChinese NO; accents NO; withoutAccents NO; decomposed NO; fullWidth NO; suffixInsideAWord NO; legalWordInTheMiddle NO; symbol NO; traditionalSuffix NO
FAIL  BR25 a sales invoice opens on the customer by name, the receivable account and the document's number as ours; a bill keeps it as theirs  customer matched; number INV-042 / theirs ∅; stranger → null; as a bill → theirs INV-042, ours ∅; sides sales/revenue/customer,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier; remembered lines 2; the page body uses 4 of 4
=== 3 CHECK(S) FAILED ===
```

## Every company's readings

`marker 449`

`readingsFor` drops the company. The assistant page of one company lists
the bills read for another, with links that open its review forms on them.
`BR3` reads the other company's list and expects it empty.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR3 the proposal is kept with the file: unknown code → no account, unknown tag → no tag, unreadable line dropped; this company only  3 lines; codes 5300,,5400; tags GST_PST,GST_PST,∅; here 1, there 1
=== 1 CHECK(S) FAILED ===
```

## The expense door forgets the reading

`marker 450`

The link that opens the quick-expense form drops `?reading=`. The form
opens blank, nothing says why, and the bill that was read is never filed
against what the person then types. `BR12` reads the rendered link.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR12 the page's cards, from real rows: both doors with the id, likelier first; a missing account said; used and broken ones offer no door  used card → its entry; bill card: expense link false, bill link true; no-account 1; used doors false
=== 1 CHECK(S) FAILED ===
```

## A filing that failed reads as a posting that failed

`marker 451`

`quickEntryFromForm` lets the attachment's refusal fall through to the
form's error. The entry is in the books; the screen says it is not; the
person presses Post again and the bill is entered twice. `BR14` makes the
store refuse and expects the sentence to begin with what happened.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR14 a posting whose filing failed is reported as posted, with why the bill is not on it  ENOTDIR: not a directory, mkdir '<local-source> Support/NSP See; entry none; 0 file(s); used: null
=== 1 CHECK(S) FAILED ===
```

## Deleting the entry a bill was filed against is refused by the reading

`marker 452`

The reading trigger (0064, replaced whole by 0077 and again by 0080) refuses the transition back to unused — which is what the
foreign key's ON DELETE SET NULL performs when the entry is deleted while its
month is open. An entry with a bill filed against it can then never be
deleted, and the trigger's own message says to delete it. `BR15` deletes
the entry `BR7` posted and expects the reading back on the page.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR15 deleting the entry puts the reading back on the page, unused and with its file, and it can be entered again  delete: refused: Failed query: DELETE FROM journal_entry WHERE id = ; used after delete: c2b34049-575f-4103-b4d7-111300d47a19/2026-10-23 15:23:34.965277-07; re-entered: That reading has already been entered.
=== 1 CHECK(S) FAILED ===
```

## The reading is looked at after the posting

`marker 453`

`quickEntryFromForm` stops asking `readingRefusal` before it posts. A
form already open with the reading's id — a second tab, a page resubmitted —
posts a second entry, and the refusal arrives from the filing step, after
the entry is in the books. `BR16` posts twice from one reading and
expects one entry.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR16 one reading, one entry: a used or foreign reading refuses the form before anything posts, at both doors  Posted as EXP-00005.; second: undefined; bill: That reading has already been entered.; foreign: undefined; entries 7 → 10
=== 1 CHECK(S) FAILED ===
```

## At the bill door a filing that failed reads as a save that failed

`marker 454`

`createInvoiceFromForm` lets the attachment's refusal fall through. The
bill is saved and posted; the screen says the save failed; the person saves
it again. `BR14b` makes the store refuse at this door too and expects the
sentence to begin with what happened.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR14b at the bill door too: saved and posted, not filed, and the door says which  threw: ENOTDIR: not a directory, mkdir '<local-source> Support/; invoice posted; 0 file(s); used: null
=== 1 CHECK(S) FAILED ===
```

## Every card offers the doors

`marker 455`

`readingCards` — the one function that decides what the page hands the
browser for a reading — forgets which entry a reading became. Every card,
entered or not, offers both doors; the reader refuses the second entry, but
only after the person has filled the form in again. `BR12` builds its
cards from real rows through this function and reads the used one back.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR12 the page's cards, from real rows: both doors with the id, likelier first; a missing account said; used and broken ones offer no door  used card → null; bill card: expense link true, bill link true; no-account 1; used doors true
=== 1 CHECK(S) FAILED ===
```

## The Add forgets who it was with

`marker 456`

The party the person chose is dropped on the way to the line. The entry
posts, the money is right, and the expense belongs to nobody — which is the
one thing that made an Added expense different from every other kind
(owner, 2026-09-07). `RC55` reads the line back and asks whose it is.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC55 an Add names the party and splits the tax the row already includes, each way  out: bank -11200, expense 10667, recoverable 533, party on undefined; in: bank 22400, revenue -21333, payable -1067; another company's party → That is not in this company's books.
=== 1 CHECK(S) FAILED ===
```

## A tag on a bank row adds tax on top of what the bank moved

`marker 457`

`splitTaggedLine` computes exclusive. The bank moved 112.00 and the entry
now says 112.00 of expense plus 5.60 of tax against a 112.00 bank line, so it
does not balance — or, where it does, the expense is overstated by the tax
that was already inside it. `RC55` adds the lines up.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  the suite threw before it finished                          Debits and credits differ by 5.60. An entry must net to zero.
=== 1 CHECK(S) FAILED ===
```

## Tax paid and tax collected land on the same account

`marker 458`

The side is no longer read off the line's sign: everything goes to the
recoverable account. GST collected on a sale is then claimed back instead of
remitted — the return is wrong in both boxes at once and the entry balances
perfectly. `RC55` posts one of each and reads both accounts; `D22` does the
same on a journal line.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC55 an Add names the party and splits the tax the row already includes, each way  out: bank -11200, expense 10667, recoverable 533, party on 5100; in: bank 22400, revenue -21333, payable undefined; another company's party → That is not in this company's books.
=== 1 CHECK(S) FAILED ===
```

## A bank entry goes back to being uneditable

`marker 459`

`bank` leaves the open-edit sources, so the entry made from a row can only
be corrected by reversal again — three entries for every typo, which is what
the owner asked to be rid of. `M27b` deletes one at the entry door and
`RC56` edits one.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  the suite threw before it finished                          BNK-00001: this source has its own door.
=== 1 CHECK(S) FAILED ===
```

## Editing a bank entry unreconciles its row

`marker 460`

The carry goes: an edit releases the match like any other source. Fixing the
expense account on an Added row then puts the row back in the feed as
unaccounted, and a reconciliation that was finished last month disagrees with
itself. `RC56` edits one and counts what was released.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC56 a bank entry is edited in place and keeps its match; an edit that stops settling the row is refused  moved to 1000+5100; released 1; kept 0 match(es); off the account → allowed; smaller than the match → allowed
=== 1 CHECK(S) FAILED ===
```

## The carried match is never re-judged

`marker 461`

`recheckMatches` stops touching the rows, so the guards that live on
`bank_match` never fire for an edit that changed the lines underneath them.
An Added entry can then be edited off the bank account entirely while the row
goes on reading as settled by it. `RC56` makes exactly that edit and expects
the whole thing refused.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC56 a bank entry is edited in place and keeps its match; an edit that stops settling the row is refused  moved to 1000+5100; released 0; kept 1 match(es); off the account → allowed; smaller than the match → allowed
FAIL  RC57b a finished reconciliation refuses both doors on a bank entry, and says which one to undo  difference 0; finish: done; edit → allowed; delete → RECONCILED
=== 2 CHECK(S) FAILED ===
```

## Adding a row again replays the first entry

`marker 462`

The replay key knows only how much was left, not what is being posted
against it. Deleting a wrong Add and adding the row again with the right
account then returns the deleted entry's number and reports success, and
nothing was posted. `RC58` adds the same row twice against two accounts.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC58 Adding a row again against a different account is a new entry, not a replay  replayed true; landed on 1000+5000; the first entry is still there: true
=== 1 CHECK(S) FAILED ===
```

## A correction's reversal is offered as a candidate

`marker 463`

`candidateEntries` takes the reversal half of a correction pair back. It
moves the account the opposite way from the entry it cancels, so every
corrected payment reads as a deposit waiting to be claimed, and a real
deposit is offered a match that is not money — the owner's feed did exactly
this. `M49b` reverses an entry and reads the next row's candidates.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M49b neither half of a correction pair is offered as a candidate  the reversal moves 90000 the same way as the row; 7 candidate(s); it is OFFERED; original out
=== 1 CHECK(S) FAILED ===
```

## The quick screens demand a description again

`marker 464`

The refusal comes back, so an expense with nothing to add beyond its account
and its amount cannot be posted at all. `Q10` posts three: one described,
one that borrows its line's wording, one with neither.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q10 the description is optional and says what it falls back to  Coffee for the office /  /  / 
=== 1 CHECK(S) FAILED ===
```

## The quick form is free to squeeze

`marker 465`

The minimum width goes. In a narrow window, or in the overlay, ten fields
share whatever is left and the amount box ends up four characters wide — the
state the owner reported. `Q11` renders the screen and reads the class off
the form.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q11 the screen: no required description, one grid template for the rows, no width told twice  <input id="q-desc" type="text" class="mt-1 w-full ui-field min-h-control rounded | <form class="mt-6 space-y-4">
=== 1 CHECK(S) FAILED ===
```

## A tagged journal line posts with the tax inside it

`marker 466`

`expandTaggedLines` passes every line through untouched. The tag on the
screen then means nothing: the whole amount lands on the account it was typed
against, the GST return never sees it, and the entry balances — which is why
nobody notices. `D22` reads the lines the door would post.

```
$ db:verify-drafts | npm run db:verify-drafts
FAIL  D22 a tagged line splits inclusive, on the side its sign says, and the entry still balances  {"1000":"-11344","5100":"11344"} / {"1000":"11344","4000":"-11344"} / allowed
FAIL  D42 one entry asking two tax roles lands each on its own account  GST nowhere on 2100 (expected -500), PST nowhere on 2110 (expected -700), balanced true
=== 2 CHECK(S) FAILED ===
```

## PST paid is claimed back

`marker 467`

The non-recoverable half of the rule goes: PST on something bought is put on
a tax account instead of folded into what the thing cost. In BC that is
claiming back a tax nobody may claim, and the expense is understated by it.
`D22` tags a purchase GST+PST and reads the expense line.

```
$ db:verify-drafts | npm run db:verify-drafts
FAIL  D22 a tagged line splits inclusive, on the side its sign says, and the entry still balances  {"1000":"-11344","1300":"506","5100":"10129"} / {"1000":"11344","2100":"-540","4000":"-10804"} / No active account carries the qst_pst_payable role. Register
=== 1 CHECK(S) FAILED ===
```

## Closing a period asks to be asked twice

`marker 468`

The panel starts collapsed again on top of the URL that already chose this
period, so the person presses "Close…", gets a button that says "Close
January 2026", and must press that before the readiness, the override box
and the lock tick appear — the state the owner reported. `P30` renders the
panel and expects the form without pressing anything.

```
$ db:verify-periods | npm run db:verify-periods
FAIL  P30 the close and reopen panels are open on arrival — no press of their own before the options  clean: form false, nothing outstanding false; blocked: reason box false; reopen: reason true
=== 1 CHECK(S) FAILED ===
```

## The tab goes back to the scaffold's name

`marker 469`

`APP_NAME` returns to what create-next-app wrote. Every tab of every
company then says the same three words, and the one thing a tab is for —
telling one open company from another — is gone. `P31` reads the constant,
the template under it and the shell that names the company.

```
$ db:verify-periods | npm run db:verify-periods
FAIL  P31 the tab is named, and the ledger resolves its company as the title  named "Create Next App"; the ledger's title resolves to "Acme Consulting Inc."; an unknown one to "Company"; the scaffold text is gone: true
=== 1 CHECK(S) FAILED ===
```

## An archived company still takes postings

`marker 470`

The trigger 0065 put on `journal_entry` goes. A company put away because
it was dissolved goes on accepting entries — through the door, and through
any SQL anybody writes later. The screens hide it, which is exactly what
makes it worse: the entries land where nobody is looking. `CO2` posts into
one, through the door and by hand.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO2 nothing enters an archived company: not an entry, a year, an invoice, a pay run, a reading, a bank row or a statement  door: landed; by hand: landed; year: created; invoice/run/reading/row/statement: landed | landed | landed | refused | refused
=== 1 CHECK(S) FAILED ===
```

## A company with books can be removed

`marker 471`

`deleteCompany` stops counting what is in the books. The refusal that
stands between a typed code and a real company's entries, invoices, payslips
and bank statements is gone; what happens next is whatever the foreign keys
happen to allow, which is not a guard. `CO4` tries it on a company that
has one entry and expects to be told to archive it instead.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO4 a company with books cannot be removed, and the refusal says to archive it  Failed query: DELETE FROM journal_entry WHERE ledger_id IN (SELECT id FROM ledge
=== 1 CHECK(S) FAILED ===
```

## Removing a company leaves its ledger behind

`marker 472`

One table drops out of the delete's list. The company row goes and its
ledger stays, pointing at nothing — every query that joins entity to ledger
silently loses it, and the row cannot be reached to be cleaned up. `CO5`
counts what is left; `CO7` reads the list against the database's own
foreign keys.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO5 a company with no books is removed with everything under it, and the trail keeps its name  refused: Failed query: DELETE FROM entity WHERE id = $1::uuid params: 928e7bdd-
FAIL  CO12 a company holding only share movements is removed, register and all  refused: Failed query: DELETE FROM entity WHERE id = $1::uuid params: 9525b0af-a4fe-4cff-8d02-1c1fb
FAIL  CO6 the form doors: a reason to archive, the code typed to remove, and both refusals by name  Type FORM to confirm — this ca; Form Door Ltd. is archived. It; undefined
FAIL  CO7 every table reachable from a company is named in the delete, removed by a cascade, or shared on purpose  unaccounted: ledger; not reachable: none
=== 4 CHECK(S) FAILED ===
```

## Archiving asks for no reason

`marker 473`

The reason becomes optional. In three years the only thing that can explain
a company nobody remembers is the sentence somebody typed, and there is
none. `CO1` archives with blanks and expects the refusal.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO1 archiving needs a reason, records who and why, and happens once  archived with no reason; by pat@x.test; ALREADY_ARCHIVED: Archivable H
FAIL  CO6 the form doors: a reason to archive, the code typed to remove, and both refusals by name  Type FORM to confirm — this ca; undefined; Form Door Ltd. (FORM) is gone.
=== 2 CHECK(S) FAILED ===
```

## The archived company is hidden instead of listed

`marker 474`

`companiesWithState` drops the archived ones. Its books are still there and
still readable by URL, but nothing on any screen says the company exists, so
the door back is unreachable and a person concludes their books are gone.
`CO8` archives one and reads the list.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO8 the list still holds archived companies, after the live ones whatever their code  10 compan(ies), 0 archived; AAAA sat among them while archived and first once back
=== 1 CHECK(S) FAILED ===
```

## The typed code is not compared

`marker 475`

The delete form stops checking what was typed against the company's code, so
the confirmation is a box a person tabs through. The library still refuses a
company with books, but the empty one it was never meant to remove goes on
the first stray click. `CO6` types the code in lower case.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO6 the form doors: a reason to archive, the code typed to remove, and both refusals by name  undefined; undefined; undefined
=== 1 CHECK(S) FAILED ===
```

## The archive gate goes back to covering two doors

`marker 476`

0066's triggers go, leaving 0065's two. An archived company then accepts an
invoice, a pay run, a bill the assistant read, an imported bank file and a
statement — every one of them a document that exists BEFORE it posts, so the
refusal at Post (where there is one) arrives after the paper is already
there. `CO2` tries all five.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO2 nothing enters an archived company: not an entry, a year, an invoice, a pay run, a reading, a bank row or a statement  door: refused; by hand: refused; year: refused; invoice/run/reading/row/statement: landed | refused | refused | refused | refused
=== 1 CHECK(S) FAILED ===
```

## Archiving a company deletes everybody's access to it

`marker 477`

`allCompanies` filters on `is_active` again, which since 0065 means 'not
archived'. The grants screen sends back every tick, so the archived company
— absent from the ticks — has its grants deleted the next time ANYBODY's
access is saved, and bringing the company back does not bring them back.
`CO9` archives a granted company, saves an unrelated person's access, and
reads the grants.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO9 archiving leaves people and permissions alone, and a later save does not drop them  offered while archived: false (flagged undefined); grants after a save: 5
=== 1 CHECK(S) FAILED ===
```

## A filed receipt keeps whatever the phone called it

`marker 478`

The derivation goes: the list hands back the name the row stores instead of
working it out from the entry. Receipts are called IMG_4471.HEIC and
scan0003.pdf again — names that say nothing about which entry they belong
to — and, because the name is no longer worked out at all, an edited entry's
paper keeps whatever it was called before. `AT12` files three and reads
their names; `AT13` edits an entry and re-reads its paper.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT6 unfiling one entry leaves the other entry and the blob alone  filed as staples receipt.pdf,late statement.pdf; original staples receipt.pdf; link gone true, blob true, other 1, sweep 0
FAIL  AT10 the form path files like the library path            from the form.pdf filed — it now sits in every touched account's folder.
FAIL  AT12 a filed receipt is renamed for the entry's date and amount, keeps its extension, and counts  IMG_4471.HEIC / scan0003.pdf / another scan.pdf; uploaded as IMG_4471.HEIC
FAIL  AT13 the filed name is derived, so an edited entry renames its paper with it  before.pdf → before.pdf; served as 2026-05-09 99.00.pdf; uploaded before.pdf
=== 4 CHECK(S) FAILED ===
```

## Two receipts on one entry get the same name

`marker 479`

The counter goes. Every receipt on one entry is then called the same thing
in the app and in the download — the folder link keeps them apart by their
sha, so nothing is lost on disk, but a person reading a list of three
identically named files cannot tell which is which. `AT12` files a second
and a third on one entry.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT12 a filed receipt is renamed for the entry's date and amount, keeps its extension, and counts  2026-02-15 200.00.heic / 2026-02-15 200.00.pdf / 2026-02-15 200.00.pdf; uploaded as IMG_4471.HEIC
=== 1 CHECK(S) FAILED ===
```

## A store that refuses unposts the entry

`marker 480`

`attachIfAny` lets the store's refusal out as a throw. The entry is in the
books and the screen says the posting failed, so the person posts it again —
the duplicate this door was shaped to avoid. `Q12` blocks the store and
expects the sentence to begin with what happened.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q12 a receipt posted with the entry is filed against it and renamed; a store that refuses does not unpost it  2026-03-25 60.00.pdf; ENOTDIR: not a directory, mkdir '<local-source> Support/NSP Seed Desktop/temp/ft011-L6XDFN/portal-phase/tail880/tmp/erp-quick-XN65H9/not-a-directory/Quick Books Ltd./blobs'; Posted as EXP-00021.
=== 1 CHECK(S) FAILED ===
```

## The quick form's receipt is dropped on the floor

`marker 481`

The quick door stops filing what the form carried. The person chose a file,
the entry posted, and nothing anywhere says the file went nowhere. `Q12`
posts one and counts what is on the entry.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q12 a receipt posted with the entry is filed against it and renamed; a store that refuses does not unpost it  nothing filed; Posted as EXP-00020.; Posted as EXP-00021.
=== 1 CHECK(S) FAILED ===
```

## The invoice's own bill is dropped

`marker 482`

Same at the invoice door: the supplier's bill goes with the form and is
never filed. `V117` saves a purchase bill with its scan and reads the
entry's attachments.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V117 a bill posted with its paper files it against the entry, renamed for the date and amount  Saved to the books.; nothing filed
FAIL  V119 the edit door files its paper, and every receipt on the entry follows the edit  Saved. The entry moved with it. The file is filed against it.; 2026-04-11 320.00.pdf
=== 2 CHECK(S) FAILED ===
```

## The journal entry's paper is dropped

`marker 483`

And at the journal entry door. `D23` posts an entry with a file and reads
the entry back.

```
$ db:verify-drafts | npm run db:verify-drafts
FAIL  D23 a journal entry posted with its paper files it, renamed for the date and amount  Posted as JE-00007.; nothing filed
=== 1 CHECK(S) FAILED ===
```

## The quick form is told its width twice again

`marker 484`

ONE field of a line row goes back to carrying `w-full` beside its own
width — the amount box, which is enough to show the defect. Two width
utilities of equal specificity, and the stylesheet's order decides:
`w-full` is emitted after `w-28`, so that box takes the whole row and
what shares the row with it is squeezed. The owner's screenshot is this,
four times over. `Q11` reads the row's field tags and reddens on any class
list carrying two width tokens.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q11 the screen: no required description, one grid template for the rows, no width told twice  <input id="q-desc" type="text" class="mt-1 w-full ui-field min-h-control rounded | <form class="mt-6 space-y-4">
=== 1 CHECK(S) FAILED ===
```

## The invoice edit door drops the file it offered

`marker 485`

`updateInvoiceFromForm` stops filing what the edit form carried. The form
still shows the box — it is the same component as the create form — so a
person picks a file, is told the change saved, and the file is gone without
a word. That is the defect this node exists to remove, at the one door that
had it. `V119` edits an invoice with a file and reads the entry.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V119 the edit door files its paper, and every receipt on the entry follows the edit  Saved. The entry moved with it.; 2026-04-11 320.00.pdf
=== 1 CHECK(S) FAILED ===
```

## The line editor's headings drift off their columns

`marker 486`

The last grid track goes back to `auto`. The headings and the rows are two
grid containers: over the empty heading cell `auto` is 0, over each row it
is the width of the up/down/remove cluster, and the flexible description
column absorbs the difference — so every heading from "Line description"
rightward sits to the left of what it names. `V118` renders both and
compares the templates.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V118 the line editor has column headings, on the same template as its rows, with no auto track  3 grid(s), 1 distinct template(s): 2rem_13rem_minmax(6rem,1fr)_6.5rem_8rem_auto_4.5rem; headings true
=== 1 CHECK(S) FAILED ===
```

## A PDF goes as a picture

`marker 487`

A PDF is put in an `image_url` part instead of the `file` part the format
defines for a document. A service reading the OpenAI shape looks for an
image there and finds a PDF's bytes, so the bill is never read — and the
failure arrives as whatever that service happens to say. `BR1b` reads the
request the loopback service received.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR1b a PDF is read: it goes as a file part with its name, not as a picture, and is kept as it arrived  text+image_url; named undefined; proposal true
=== 1 CHECK(S) FAILED ===
```

## A PDF is refused again

`marker 488`

PDFs leave the readable list, so most bills — which arrive as PDFs — are
turned away with a sentence telling the person to photograph their own
screen. That is the state the owner called unusable. `BR1b` sends one.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR1b a PDF is read: it goes as a file part with its name, not as a picture, and is kept as it arrived  refused: NOT_A_BILL: A bill is read from a PDF, a photo or a screenshot (PDF, P
=== 1 CHECK(S) FAILED ===
```

## The reader's door refuses the screen it sits on

`marker 489`

`readBillAction` goes back to the assistant seat alone, while the reader
now sits on Expenses and on Invoices. Somebody granted those two and not the
Assistant sees the upload box and is thrown to /no-access the moment they
use it — the attachment doors' defect, at a new door. `BR17` reads the
seats each door accepts.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR17 the reader shares the + AI workspace and accepts every seat that opens it  Read & add page true, separate + AI control true; expenses clear, invoices clear, assistant clear; route moved true; readBillAction accepts requireLedger(ledgerId, '/assistant'); the route is declared for /expenses /invoices /assistant
=== 1 CHECK(S) FAILED ===
```

## The file picker refuses what the reader reads

`marker 490`

The upload control's `accept` list drops PDFs while every sentence around
it — its own caption, the doc, the changelog — goes on saying a bill may be
one. The file dialog simply does not offer them, so the capability is
unreachable from either screen and nothing looks broken. That is the state
this node shipped in until the review caught it. `BR17` reads the control.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR17 the reader shares the + AI workspace and accepts every seat that opens it  Read & add page true, separate + AI control true; expenses clear, invoices clear, assistant clear; route moved true; readBillAction accepts requireLedger(ledgerId, ['/expenses', '/invoices', '/assista; the route is declared for /expenses /invoices /assistant
=== 1 CHECK(S) FAILED ===
```

## The moved route belongs to no seat again

`marker 491`

The `readings` entry leaves `DETAIL_ROUTES`. `seatsForPath` then returns
nothing for it and `refuseFor` reads that as a refusal, so nobody but an
owner can open the bill beside the form that was filled in from it — and
before 2026-09-03 the same shape meant the opposite, handing a seatless
route's data to anybody holding any seat at all. `BR17` reads the
declaration; `N18` and `US20` read the whole tree.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR17 the reader shares the + AI workspace and accepts every seat that opens it  Read & add page true, separate + AI control true; expenses clear, invoices clear, assistant clear; route moved true; readBillAction accepts requireLedger(ledgerId, ['/expenses', '/invoices', '/assista; the route is declared for NOTHING
=== 1 CHECK(S) FAILED ===
```

## The books are not asked where this supplier went last time

`marker 492`

The remembered account is dropped on the way into the form, so a line the
model could not place opens blank even though this company posted the same
supplier's last bill to a particular account. The account is the one box a
person cannot fill from the bill alone, and it was the one box that never
filled. `BR18` posts last month's bill, then reads what the form opens on.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR18 an account the model could not place is filled from where this supplier went last time, and its own suggestion is kept  remembered 5400; a stranger → null; after a correction still 5400; "Taple" is not "Staples": true; an account the form does not offer → blank; the model's unmatched 6200 kept as 6200; without a memory the box stays blank: true
FAIL  BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type  destinations offered 14/14; opened Beta Services on 4000; remembered blank; unnamed → Income; party beta; a sale's number as income → ∅, a bill's → B-1; the page asks by kind true and offers its own parties true
FAIL  BR25 a sales invoice opens on the customer by name, the receivable account and the document's number as ours; a bill keeps it as theirs  customer matched; number INV-042 / theirs ∅; stranger → Nobody Known Ltd; as a bill → theirs INV-042, ours ∅; sides sales/revenue/customer,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier; remembered lines none; the page body uses 4 of 4
=== 3 CHECK(S) FAILED ===
```

## Any supplier's last account will do

`marker 493`

`rememberedAccount` stops comparing the name, so the most recent posted
expense in the whole company is offered for every bill — a phone bill opens
on whatever last month's legal fees went to, in a box that looks filled in
and reviewed. `BR18` asks it about a supplier the books have never seen.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR18 an account the model could not place is filled from where this supplier went last time, and its own suggestion is kept  remembered 5400; a stranger → c97ebebf-56cc-490e-b79e-335b7bb81087; after a correction still 5400; "Taple" is not "Staples": false; an account the form does not offer → blank; the model's unmatched 6200 kept as 6200; without a memory the box stays blank: true
=== 1 CHECK(S) FAILED ===
```

## The model's own suggestion is thrown away

`marker 494`

A code the chart does not have is dropped without trace again, so a model
that answered 6200 for a chart with no 6200 leaves a blank box and no sign
it had an opinion — the person cannot tell a silent model from a mismatched
one, and does not learn which account they are missing. `BR18` reads a
proposal naming a code this ledger has not.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR18 an account the model could not place is filled from where this supplier went last time, and its own suggestion is kept  remembered 5400; a stranger → null; after a correction still 5400; "Taple" is not "Staples": true; an account the form does not offer → blank; the model's unmatched 6200 kept as null; without a memory the box stays blank: true
=== 1 CHECK(S) FAILED ===
```

## The payee comparison deletes the letter S

`marker 495`

The description branch goes back to its own copy of the normalisation, with
a backslash-s written inside a tagged template — which cooks away, so
Postgres deletes runs of the letter S instead of collapsing whitespace.
"Staples" and "Taple" become the same payee and two suppliers can hand
each other their accounts. `BR18` asks about "Taple" after posting to
"Staples".

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR18 an account the model could not place is filled from where this supplier went last time, and its own suggestion is kept  remembered 5400; a stranger → null; after a correction still 5400; "Taple" is not "Staples": false; an account the form does not offer → blank; the model's unmatched 6200 kept as 6200; without a memory the box stays blank: true
=== 1 CHECK(S) FAILED ===
```

## A corrected account is remembered as the right one

`marker 496`

The reversal half of a correction pair is taken back into the memory. It
carries the same account and the same party as the entry it cancels, so
after somebody corrects a bill the newest entry naming that supplier is the
account they corrected AWAY, and the next bill opens on it. `BR18` posts a
wrong account, reverses it, and asks.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR18 an account the model could not place is filled from where this supplier went last time, and its own suggestion is kept  remembered 5400; a stranger → null; after a correction still 0d07b33e-af2f-4d61-bba4-49fbf0d3e740; "Taple" is not "Staples": true; an account the form does not offer → blank; the model's unmatched 6200 kept as 6200; without a memory the box stays blank: true
=== 1 CHECK(S) FAILED ===
```

## A remembered account the form does not offer is used anyway

`marker 497`

`accountIdOf` stops asking whether this form offers the remembered
account. A box handed a value matching no option holds neither the memory
nor the blank, and looks like something a person chose. It was a REVENUE
account that showed this, on the grounds that a quick-expense form offered
only expense ones — that stopped being true on 2026-09-07, when the form
began offering the whole chart so a laptop could be entered on it. It is
ANOTHER COMPANY'S account now, which no form offers and no door would
take. `BR18` hands it one.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR18 an account the model could not place is filled from where this supplier went last time, and its own suggestion is kept  remembered 5400; a stranger → null; after a correction still 5400; "Taple" is not "Staples": true; an account the form does not offer → USED ANYWAY; the model's unmatched 6200 kept as 6200; without a memory the box stays blank: true
=== 1 CHECK(S) FAILED ===
```

## A box filled from the books looks like one a person chose

`marker 498`

The row stops saying where its account came from, so an account taken from
last month's bill is indistinguishable from one the person picked — and the
sentence above the lines, the only thing asking them to check it, never
appears. `BR18` reads the flag the form renders from.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR18 an account the model could not place is filled from where this supplier went last time, and its own suggestion is kept  remembered 5400; a stranger → null; after a correction still 5400; "Taple" is not "Staples": true; an account the form does not offer → blank; the model's unmatched 6200 kept as 6200; without a memory the box stays blank: true
FAIL  BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type  destinations offered 14/14; opened Beta Services on 4000; remembered 4000; unnamed → Income; party beta; a sale's number as income → ∅, a bill's → B-1; the page asks by kind true and offers its own parties true
=== 2 CHECK(S) FAILED ===
```

## The overlay is handed nothing

`marker 499`

The intercepting route stops reading `searchParams`, so `?reading=<id>`
reaches the deep link and never the overlay — and the overlay is what a
person gets when they press the card's button. The form opens blank, with
no sign anything was meant to be in it. The one-renderer rule keeps the two
screens from drifting in what they DRAW; this is them drifting in what they
are GIVEN. `N20` compares what each hands the body — not whether the word appears in
the file, because a route that keeps the parameter and ignores it reads the
same either way, which is exactly the shape this had.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
FAIL  N20 an overlay is handed what its page is handed — no intercept ignores a query its page reads  entries/quick/[kind] passes QuickBody.readingId on the page and not in the overlay
=== 2 CHECK(S) FAILED ===
```

## Any one word typed is enough to keep an option

`marker 500`

The matching rule goes from every word to any word, so typing "office
rent" leaves "5200 Office and Supplies" in the list — the second word
does the narrowing and this stops doing it. Half-remembering a name is
exactly when a person types two words. `PK3` types a word the option does
not have.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK3 nothing typed matches everything, and a word nobody has matches nothing  blank matches; "office rent" does not match 5200 Office and Supplies
=== 1 CHECK(S) FAILED ===
```

## Only the name is searched, not what it is

`marker 501`

The hint beside an option stops being searched, so "supplier" no longer
narrows the list to suppliers and "expense" no longer finds expense
accounts. The hint is the only thing on the row that says what the option
IS. `PK2` types a role.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK2 the hint beside the name is searched too, so a role narrows the list  the supplier answers to "supplier"; the expense account does not
=== 1 CHECK(S) FAILED ===
```

## Typing in lower case finds nothing

`marker 502`

Folding stops folding case, so a chart written in Title Case answers to
nothing anybody types. This is the defect that looks like an empty list
rather than like a bug. `PK4` types in the wrong case.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK1 every word typed must appear, in any order            both orders find Coastal Office Supply Co.
FAIL  PK4 case and runs of spaces are folded, and a code is just another word  "COASTAL   office" and "52 office" both match
=== 2 CHECK(S) FAILED ===
```

## A picker with no name posts anyway

`marker 503`

The hidden field stops being conditional, so the journal entry — which
serialises all its lines into one JSON field — grows a nameless input
beside them. A field nothing reads today is a field something starts
reading by accident. `PK6` renders the nameless shape.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK6 given no name it posts nothing, for a form that serialises its own rows  no hidden input in the nameless render
=== 1 CHECK(S) FAILED ===
```

## The choices are only in the page once it is open

`marker 504`

The list stops being rendered-and-hidden and becomes rendered-when-open.
Nothing on the screen changes. What changes is that a static render can no
longer see what the form offers — and a great deal of this project's
evidence is exactly that reading, so replacing selects with this would have
blinded those checks rather than failed them. `PK7` reads the closed list.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK7 every choice is in the markup although the list is closed, chosen or not  2 options empty, 2 with one chosen, listbox hidden
=== 1 CHECK(S) FAILED ===
```

## The box opens showing a UUID

`marker 505`

What is chosen is put in the box as its id instead of its name, so a form
opened on an existing invoice shows the person a UUID where the account
was. `PK8` opens on a chosen option.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK8 it opens showing the NAME of what is chosen, and posts the id  the box says 4000 — Revenue
=== 1 CHECK(S) FAILED ===
```

## A required picker can be left empty

`marker 506`

The requirement comes off the box a person types in. The forms here call
`reportValidity()` before they dispatch, so the browser stops scrolling to
the empty field and saying so — the refusal arrives from the server
instead, after the press, naming a field. `PK9` reads where required sits.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK9 required sits on the box a person types in, not on the hidden one  the combobox carries required
=== 1 CHECK(S) FAILED ===
```

## The creating row appears only once it is already open

`marker 507`

The condition on the creating button is flipped, so the row that makes the
thing you were looking for is offered only while it is being filled in —
which is to say never. The list simply has nothing in it and no way out.
`PK10` looks for the button.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK10 the creating row is offered only where a door was given  offered on the creating render, absent from the plain one
=== 1 CHECK(S) FAILED ===
```

## Making an account needs the chart seat again

`marker 508`

The creating door goes back to asking for `/accounts` alone. Every picker
outside the chart screen then offers a button that refuses — somebody who
may enter a bill is told they may not add the account it belongs in, from
inside the form that will not accept the bill without one. `N18` re-derives
each door's seat from the pages its form is actually on.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N18 every ledger path has a seat somebody chose, and every action names the seat its form is actually under  createAccountAction declares '/accounts' but its form lives under /bank, /cheques, /entries, /invoices, /opening, /payroll
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## Adding a party needs the address book seat again

`marker 509`

The same, one door along. The widening is deliberate and narrow — only
the CREATING door, never renaming or ending a role — and a check that
re-derives it from the tree is what keeps the narrowness honest. `N18`
names the screens the form is on.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N18 every ledger path has a seat somebody chose, and every action names the seat its form is actually under  createPartyAction declares '/parties' but its form lives under /bank, /cheques, /entries, /invoices, /payroll
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## An invoice line's account is chosen and the row never hears

`marker 510`

The line editor stops listening to its own picker. The hidden field still
posts the right account, so the invoice saves correctly — and the running
total on the screen, which counts the rows it holds, goes on saying the
line is empty. Right answer, wrong screen. What this block proves is the
first half of that: `V95bg` is the guard saying the field has no
`onChange` at all, so the choice reaches nobody. The stale total is the
consequence, and nothing in this tree can press a button to watch it
happen.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V95bg the account field reports what was chosen           the field named line.2.account has no onChange
=== 1 CHECK(S) FAILED ===
```

## A chosen picker offers only what is already chosen

`marker 511`

Filtering goes back to reading the BOX instead of what was typed. Choosing
puts the option's label in the box, so opening a picker that already holds
an account shows that account and nothing else — the person has to clear
the words before they can see the list they came to look at. It also drops
every other option out of the markup, which is where this project's
select-shaped evidence reads what a form offers. `PK7` renders one with
something chosen.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK7 every choice is in the markup although the list is closed, chosen or not  2 options empty, 1 with one chosen, listbox hidden
=== 1 CHECK(S) FAILED ===
```

## Only cash can pay for anything again

`marker 512`

The money side goes back to demanding the cash role, so a credit card and
a shareholder loan stop being places money can come out of — which is where
most of a small company's money actually goes out from. Every such receipt
has to be entered as a journal entry instead. `Q4h` pays for fuel with a
shareholder loan.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q4f a line may be any account, not only the type the form is named after  it threw instead of posting: Paid from needs an active, postable asset or liability account of this company.
FAIL  Q4f a line may be any account, not only the type the form is named after  {}
FAIL  Q4h the money may come from a credit card or a loan   it threw instead of posting: Paid from needs an active, postable asset or liability account of this company.
FAIL  Q4h the money may come from a credit card or a loan   {}
FAIL  Q4k a director funds an expense, but Expenses groups it under the supplier  {"posted":{"error":"Paid from needs an active, postable asset or liability account of this company."},"loanLines":[],"fundingChoices":[{"id":"cf1959bd-1ed4-4450-8bfe-51ae89010eb0","label":"Pat Director","hint":"Director"}]}
FAIL  Q4l an asset funded by a director                     it threw instead of posting: Paid from needs an active, postable asset or liability account of this company.
FAIL  Q4l a funded asset expense without a supplier stays unassigned  
FAIL  Q4m a creditor requires the due-to account and shareholder/director role  WRONG_FUNDING_ACCOUNT / NOT_A_BANK_ACCOUNT
FAIL  Q4j the accounts the door accepts are exactly the ones the form offers  2100: door refused it, form offers it | 2150: door refused it, form offers it | 2400: door refused it, form offers it | 2500: door refused it, form offers it
=== 9 CHECK(S) FAILED ===
```

## The offer and the door stop agreeing about the money side

`marker 513`

The list the form is built from narrows back to cash while the door goes
on accepting liabilities. Nothing refuses anything; the credit card simply
is not in the box, and the only way to find out it would have been accepted
is to read the source. Two spellings of one question, which is this
repository's oldest defect shape. `Q4j` tries every account in a chart
against both.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q4k a director funds an expense, but Expenses groups it under the supplier  {"posted":{"ok":"Posted as EXP-00010.","entryId":"6eeca235-ad51-4909-9032-bdaa02596774"},"loanLines":[{"code":"2500","party":"34666d9f-0cfe-4f5f-925a-08090f07ed05"},{"code":"5150","party":"e79421f5-9cb5-4c5c-a384-51784e2cfe0d"}],"loanRow":{"key":"e6eeca235-ad51-4909-9032-bdaa02596774","kind":"Expense","state":"posted","on_date":"2026-03-19","description":"Paper advanced by director","doc_ref":null,"entry_id":"6eeca235-ad51-4909-9032-bdaa02596774","entry_no":"EXP-00010","party_id":"e79421f5-9cb5-4c5c-a384-51784e2cfe0d","party_name":"Coastal Office Supply Co.","href":{"kind":"entry","id":"6eeca235-ad51-4909-9032-bdaa02596774"},"pl_amount":"3600","unpaid":null},"fundingChoices":[{"id":"34666d9f-0cfe-4f5f-925a-08090f07ed05","label":"Pat Director","hint":"Director"}]}
FAIL  Q4j the accounts the door accepts are exactly the ones the form offers  2100: door took it, form does not offer it | 2150: door took it, form does not offer it | 2400: door took it, form does not offer it | 2500: door took it, form does not offer it
=== 2 CHECK(S) FAILED ===
```

## A line that gives money back is refused again

`marker 515`

Zero and negative are refused together, so a rebate on the same receipt,
a returned deposit, or a trade-in cannot be entered where the rest of the
receipt is. The refusal reads as an arithmetic rule and is a habit. `Q4g`
enters 300 out and 50 back.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q4g a negative line takes money back and the bank line is the net  it threw instead of posting: A line needs an amount that is not zero.
FAIL  Q4g a negative line takes money back and the bank line is the net  {}
=== 2 CHECK(S) FAILED ===
```

## The receipt stops saying who it was with

`marker 516`

The party is dropped from the item lines. The entry is right, the money is
right, and the Expenses screen — which groups by the line's own party — no
longer knows the receipt belongs to that supplier, so it appears under
nobody. The box on the form goes on accepting a name. `Q4i` reads the
posted lines.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q4i the party lands on the lines the browse screens read  [{"code":"1000","party":null},{"code":"5150","party":null}]
FAIL  Q4k a director funds an expense, but Expenses groups it under the supplier  {"posted":{"ok":"Posted as EXP-00010.","entryId":"bfe83f9a-3e34-4316-8736-ef17d6fff6e0"},"loanLines":[{"code":"2500","party":"afcc63a8-8c50-4add-8f4d-78f6d28e9337"},{"code":"5150","party":null}],"loanRow":{"key":"ebfe83f9a-3e34-4316-8736-ef17d6fff6e0","kind":"Expense","state":"posted","on_date":"2026-03-19","description":"Paper advanced by director","doc_ref":null,"entry_id":"bfe83f9a-3e34-4316-8736-ef17d6fff6e0","entry_no":"EXP-00010","party_id":null,"party_name":null,"href":{"kind":"entry","id":"bfe83f9a-3e34-4316-8736-ef17d6fff6e0"},"pl_amount":"3600","unpaid":null},"fundingChoices":[{"id":"afcc63a8-8c50-4add-8f4d-78f6d28e9337","label":"Pat Director","hint":"Director"}]}
=== 2 CHECK(S) FAILED ===
```

## The party is put on every line, the bank one included

`marker 517`

The other half of the same seam. The bank line carries the supplier too,
so the Expenses screen counts the receipt twice under that supplier — once
for what was bought and once for the money leaving. Both figures are real
and the total is wrong. `Q4i` names which lines may carry it.

```
$ db:verify-quick | npm run db:verify-quick
FAIL  Q4i the party lands on the lines the browse screens read  [{"code":"1000","party":"edd9b917-7903-4dd9-a74a-37b9d8871778"},{"code":"5150","party":"edd9b917-7903-4dd9-a74a-37b9d8871778"}]
FAIL  Q4k a director funds an expense, but Expenses groups it under the supplier  {"posted":{"ok":"Posted as EXP-00010.","entryId":"b0dd1c0f-a6e7-4b30-8bb3-a24feb15ae91"},"loanLines":[{"code":"2500","party":"edd9b917-7903-4dd9-a74a-37b9d8871778"},{"code":"5150","party":"edd9b917-7903-4dd9-a74a-37b9d8871778"}],"loanRow":{"key":"eb0dd1c0f-a6e7-4b30-8bb3-a24feb15ae91","kind":"Expense","state":"posted","on_date":"2026-03-19","description":"Paper advanced by director","doc_ref":null,"entry_id":"b0dd1c0f-a6e7-4b30-8bb3-a24feb15ae91","entry_no":"EXP-00010","party_id":"edd9b917-7903-4dd9-a74a-37b9d8871778","party_name":"Coastal Office Supply Co.","href":{"kind":"entry","id":"b0dd1c0f-a6e7-4b30-8bb3-a24feb15ae91"},"pl_amount":"3600","unpaid":null},"fundingChoices":[{"id":"c56d8050-1dc4-445b-8df6-a55c21a456af","label":"Pat Director","hint":"Director"}]}
=== 2 CHECK(S) FAILED ===
```

## A table quietly drops out of the backup

`marker 518`

`journal_line` stops being carried. The file still packs, still restores,
and the restored company still opens — with a chart, periods, invoices and
entries, and not one line of money in any of them. A backup that leaves a
table out is worse than no backup, because it looks complete. `BK1` holds
every table in the database to a decision.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK1 every table in the database is backed up or declared not to be  forgotten: journal_line | named but absent: 
=== 1 CHECK(S) FAILED ===
```

## A restore keeps the ids it was given

`marker 519`

Every row goes back in under the id it had. Restoring a company beside the
one it came from then collides on the primary key — but restoring into an
EMPTY database succeeds, so this passes every test somebody runs once and
fails the first time it matters. `BK2b` restores beside the original.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK-OPS valid financial operations backup restores beside its source  Failed query: 
=== 1 CHECK(S) FAILED ===
```

## The restore loads with the guards still on

`marker 520`

The line that turns the triggers off goes, and the load fights every guard
the live books have: a closed period refusing its own entries, a posted
invoice refusing raw SQL, a payroll record arriving before the role it
needs, a share transfer refused half-written. Five restores died that way
before this was the answer (owner, 2026-09-07). The guards protect live
books from a hand at a prompt; a restore is neither. `BK2b` restores a
company with all four of those things in it.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK-OPS valid financial operations backup restores beside its source  Failed query: 
=== 1 CHECK(S) FAILED ===
```

## Nothing checks what the file pointed at

`marker 521`

The refusal goes, so a file that does not hold everything it names is
restored anyway — and because the foreign keys are off during the load,
nothing else notices. An id the file does not carry is not remapped, and
unchanged it names the row it was COPIED FROM: the restored company reads
another company's rows and looks perfectly well. That is worse than a
restore that fails. `BK11` offers a file with a bank row taken out of it.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK11 a file that does not hold everything it points at is refused whole  it was restored; 1 company left behind
FAIL  BK11b a composite CRM company reference is checked and refused whole  it was restored; 1 company left behind
=== 2 CHECK(S) FAILED ===
```

## A restore copies the shared party instead of finding it

`marker 522`

The match by name goes. The address book is one list for every company
and the database refuses two active parties with one name, so this fails
outright on a party that is already here — and on a name that has
changed since, it silently splits the supplier in two. Restoring into
the database a backup came from finds the party by ID and never looks
further, so this is invisible there: `BK7b` takes the road every
restore onto a fresh machine takes.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK7b a party whose id is not here is found by name, not copied  1 party row(s); the role landed on refused: Failed query: 
=== 1 CHECK(S) FAILED ===
```

## A backup file is trusted whatever is in it

`marker 523`

The checksum is not read back. A file edited by hand — a name, a figure, a
whole entry — restores as though it were the one that was saved, and the
only sign is that the books do not add up to what they used to. `BK9` edits
one and offers it.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK3d audit evidence keeps its source values while its locators are remapped with provenance  source.auditor@example.test at 2025-01-01 19:04:05-08; record wrong; source 174
FAIL  BK8 receipts, CRM, minute book, statements and signing paper travel with the books  7 file(s) in the backup, 0 on the restored entry, CRM link remapped, CRM bytes read back, 1 on the restored minute book, whose bytes read back
FAIL  BK9 every wrong file is refused by name                    a backup somebody edited: ACCEPTED
=== 3 CHECK(S) FAILED ===
```

## A backup from a newer FigTree is restored anyway

`marker 524`

The version gate goes. A file holding columns this database has no place
for is restored with those columns dropped on the floor — a company that
looks whole and has quietly lost whatever the newer version knew. `BK9`
offers a file claiming five migrations more than this database has run.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK9 every wrong file is refused by name                    a backup from a newer FigTree: A company called Backup Books Ltd. is already here
=== 1 CHECK(S) FAILED ===
```

## The check that reads the file asks nothing

`marker 525`

The reference check keeps its refusal and stops finding anything to refuse:
every foreign key is skipped, so it reports a clean file whatever is in one.
A guard that cannot fail is the shape this repository hunts — and this one
is the whole reason it is safe to load with the foreign keys off. `BK11`
offers a file that is missing a row something else names.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK11 a file that does not hold everything it points at is refused whole  it was restored; 1 company left behind
FAIL  BK11b a composite CRM company reference is checked and refused whole  it was restored; 1 company left behind
=== 2 CHECK(S) FAILED ===
```

## The key that catches a double click is copied too

`marker 526`

`journal_entry.idempotency_key` travels with the entry. It is unique across
the WHOLE table, so restoring beside the company it came from is refused by
`journal_entry_idempotency_key_key` — which is what the owner met on their
second real restore. And a restore into an empty database, where nothing
collides, produces a copy claiming to be the same submission as the
original. `BK4c` looks for it in the restored company.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK-OPS valid financial operations backup restores beside its source  Failed query: 
=== 1 CHECK(S) FAILED ===
```

## The restored company keeps the code it came from

`marker 527`

The code and name chosen for the restored company stop being applied, so it
arrives under the original's — and the original is right there, so
`entity_code_key` refuses the whole thing. On a machine where the original
is NOT there it succeeds, and two companies that are copies of each other
then share a code the moment one is moved. `BK2b` restores beside the
company the file came from.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK-OPS valid financial operations backup restores beside its source  Failed query: 
=== 1 CHECK(S) FAILED ===
```

## A unique value nobody thought about stops being a decision

`marker 528`

One entry leaves `UNIQUE_HANDLED`, which is what the guard is made of. The
same defect reached the owner twice — ids, then an idempotency key — and
both times what was missing was not the fix but the question. `BK1b` asks
it of every unique index in the database: either one of its columns is a
value the restore rewrites, or somebody has written down what happens
instead.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK1b every unique value a restore copies is one the restore rewrites, or is named  pay_run_idempotency_key (idempotency_key)
=== 1 CHECK(S) FAILED ===
```

## The blob a receipt names is left out of the file

`marker 529`

`attachment_blob` rows stop travelling. The bytes may still be in
`files`, but the ROW every attachment points at is not — and with the
foreign keys off during the load, the attachment goes in naming nothing.
Restored onto a fresh machine the receipt is a dead link with no error
anywhere. `BK11` is the refusal; the file is checked before it is loaded.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK-P3 valid migration lifecycle backup restores beside its source  That backup does not hold everything it points at: 7 migration_file row(s) break migration_file_sha256_fkey to attachment_blob. Nothing was restored.
=== 1 CHECK(S) FAILED ===
```

## One payroll fixture can go while another still proves the backup

`marker 530`

The example company's payroll goes, while the independent financial-operations
fixture still creates and restores real pay runs and stubs. This is deliberately
GREEN: `BK0` checks the union of the business, P3, P5 and financial-operations
fixtures. Removing one redundant provider must not be mistaken for losing
payroll coverage altogether. All existing restore and financial checks remain.

```
$ db:verify-backup | npm run db:verify-backup
=== ALL CHECKS PASSED ===
```

## A screen keeps its own idea of what a button is

`marker 531`

One screen goes back to writing the button out by hand. Nothing looks
broken — it is a rounded box with white text, the same as the others were
until they all became one string — and the next change to how a button
looks reaches every screen but that one. Fourteen files were doing this,
eleven of them identically, which is what made the other three drift rather
than decisions. `N21` reads the tree for a second spelling.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N21 one definition of a button, a warm scale, and required names bolded by one rule  src/components/PartyCreateForm.tsx keeps its own BUTTON
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## Required names stop being bold

`marker 532`

The one rule that bolds the name of every required field goes. Nothing
errors and nothing is missing — the forms simply stop saying which boxes
have to be filled in, and the only way to find out is to press the button
and be refused. It is one rule keyed on the control itself, which is why it
cannot go stale against a field that stops being required. `N21` reads the
stylesheet for it.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N21 one definition of a button, a warm scale, and required names bolded by one rule  819 files, none with a second spelling; clay and neutral in @theme; the required-label rule is there
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## A theme is offered, saved, and has no colours

`marker 533`

The fig palette's block of CSS goes. Everything else about it stays: it is
on the settings screen with its swatch, the door saves it, the database
accepts it, and the page does not change — a setting that does nothing and
says nothing. `N22` asks of every palette named in `appearance.ts` whether
it has colours, a value the database takes, and the same tokens as the
others.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N22 every palette has colours, a name the database takes, and the same tokens as the rest  figtree has no colours
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## Dark goes back to asking the machine

`marker 534`

The `dark:` variant stops being redefined, so the six hundred `dark:`
classes this tree is written in follow the operating system again. Choosing
Dark then darkens the page background and nothing on it — every border,
panel and heading stays in the light palette, on a dark page. `N22` reads
the variant.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N22 every palette has colours, a name the database takes, and the same tokens as the rest  the dark: variant still asks the machine, not the person
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The shell stops saying which theme this is

`marker 535`

`<html>` loses the attribute the palette is keyed on. Every screen falls
back to the default colours whatever the person chose, and the settings
screen goes on reporting their choice back to them correctly — the one
thing on the page that still agrees with the database. `N22` reads the
shell.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N22 every palette has colours, a name the database takes, and the same tokens as the rest  the shell does not stamp the choice on <html>
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 2 CHECK(S) FAILED ===
```

## The form that renames an account is written and never opened

`marker 536`

The account page stops rendering the editor. `AccountForm` still takes an
`existing` account, still switches to `updateAccountAction`, still freezes
the type once anything is posted — and nothing opens it, so a name is final
from the moment it is made. That is how it shipped, and the owner found it
by trying to rename one. `A29` asks whether a screen opens the door, not
whether the door exists.

```
$ db:verify-accounts | npm run db:verify-accounts
FAIL  A29 the form that renames an account is opened by a screen, not only written  the edit form is reachable from nowhere
=== 1 CHECK(S) FAILED ===
```

## An account that stood at a figure counts as empty

`marker 537`

`isEmptyRow` stops looking at the closing balance. An account that moved
in an earlier year and has sat still since — most of the balance sheet, in
a quiet month — is then hidden from the trial balance by a box labelled
"only accounts with a figure", while holding a figure. `R40` asks it about
a row that stood without moving.

```
$ db:verify-reports | npm run db:verify-reports
FAIL  R40 a row is empty only when nothing moved and nothing stood  false/true/true
=== 1 CHECK(S) FAILED ===
```

## The download does not know what the screen was showing

`marker 538`

The PDF stops reading the switch. The report on the screen hides its empty
rows and the one that comes out of it does not — two answers to one
question, and the person would be right to trust neither. `R40c` requires
the screen and both downloads to read the same name.

```
$ db:verify-reports | npm run db:verify-reports
FAIL  R40c the screen and both downloads read the same switch  not read by: src/app/ledger/[ledgerId]/reports/trial-balance/pdf/route.ts
=== 1 CHECK(S) FAILED ===
```

## A folded entry does not say how much it is hiding

`marker 539`

The count comes off the button, so a folded pay run says only "more". A
fold that does not say what it hides is a line you have to open to find out
whether you wanted it — which is the scrolling the fold was for. `D40`
reads the button.

```
$ db:verify-drafts | npm run db:verify-drafts
FAIL  D40 an entry over two lines folds, and says how many it is hiding  2 / 3; false
=== 1 CHECK(S) FAILED ===
```

## A box on a bank row belongs to a form that is not there

`marker 540`

The form in a pending row's last cell is given a different id from the one
every box in that row points at. Nothing looks wrong — the tax, the party
and the category are all there, in their columns, as on any other row — and
pressing Post sends none of them. A table cannot hold a form spanning its
cells, so the boxes name one by id, and this is what that arrangement costs
when it is got wrong. It cost one build. `RC36b` reads every id pointed at
against the ids that exist.

```
$ db:verify-bank-reconcile | npm run db:verify-bank-reconcile
FAIL  RC36b every box on a row belongs to a form that is on the page  pointing at nothing: post-f810d807-93fb-4601-8ce5-bf767b75e104, post-4919e983-15f1-495e-ab02-9b61b9144f84
=== 1 CHECK(S) FAILED ===
```

## The card counts drafts as money

`marker 541`

An account card's books figure stops asking whether an entry is posted, so
a draft somebody is halfway through typing moves the balance on the card —
and the card sits beside a statement figure, inviting the two to be
compared. This system has no bank to ask; the honest pair is the POSTED
books beside the last statement. `I58` compares the card with what the
ledger holds.

```
$ db:verify-bank-import | npm run db:verify-bank-import
FAIL  I58 an account card carries the posted books balance, and no draft  1000: books 124000, statement none on file
=== 1 CHECK(S) FAILED ===
```

## The banking landing comes back in front of the feed

`marker 542`

`/bank` goes back to being a page: a list of the accounts with rows, and a
link into one of them. Bank transactions grew a card per account across its
own top, so this is that list again, one click earlier and worse — and the
seat now opens a page whose only content is a poorer copy of the next
page's header. `N24` asks what `/bank` does.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
FAIL  N24 Banking sends you to an account, and only renders when there is none  sends false, empty state true, no list true
=== 2 CHECK(S) FAILED ===
```

## The specified-employee cap is applied to each pay

`marker 543`

The salary allocations are gathered per STUB rather than per person, so the
five-times-YMPE cap is tested against a fortnight — and every fortnight
passes a cap the year fails by a mile. An owner paid 480,000 is claimed in
full. `S5` adds the year up and compares it with the cap.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S5 the cap is applied to the year, and the paper’s two bonus sentences agree with each other  528,000.00 claimed; the cap alone is 373,000.00, uncapped it would have been 528,000.00; the warning does NOT show it as money; the sentences do NOT agree
FAIL  S9 the proxy base takes a specified employee at 75%, and a bonus never exceeds what it leaves  line 502 is 217,800.00, expected 121,687.50 — a base of 221,250.00 after 126,000.00 of bonus should have come out
FAIL  S12 the paper prints what the person filing still has to settle  29 item(s) to confirm; naming an unconfirmed rate, naming the related party, NOT naming the cap
FAIL  S18 “specified employee” is set through a door, and it is what makes the cap bite  unticked 528,000.00, ticked 528,000.00; unticked the paper says nothing about a cap
FAIL  S29 a bonus bigger than the salary left after the cap takes out only the salary  390,000.00 of bonus against 373,000.00 of counted salary (the cap is 373,000.00): the proxy amount is 153,862.50, and the note names something else
FAIL  S27 line 300 says where its employer CPP and EI went, and 502 what came out of its base  9,328.08 of employer CPP/EI: line 300 sends it to 360 under traditional, with the figure; line 502 admits nothing; a claim with no bonus still carries the hedge
=== 6 CHECK(S) FAILED ===
```

## A related-party contract counts at 80% as well

`marker 544`

The 80% rule is applied to every contract, including one with a party this
company does not deal with at arm's length. That rule is for arm's-length
contracts; a related one is a different calculation this system does not
attempt, which is why it is counted in full and named instead. `S6` adds
the line up both ways.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S6 an arm’s-length contract counts at 80%, a related one is flagged instead  line 340 is 11,200.00, expected 12,000.00 (80% of 10,000 plus 4,000 in full); the related party is named on the paper
FAIL  S17 arm’s length is set through a door, and it moves the contract line  at arm's length 11,200.00 vs related 11,200.00; and the paper names the related party
=== 2 CHECK(S) FAILED ===
```

## Capital is dropped rather than listed

`marker 545`

Capital expenditures stop appearing on the paper at all. They have not been
eligible federally since 2014, so leaving them out changes no total — and
that is the point: the money spent is invisible, and the day the rule is
restored there is nothing to add back. `S7` asks for the figure under what
is excluded.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S7 capital is shown, and is not in the total                0.00 listed under what is excluded, and the proxy column has none
=== 1 CHECK(S) FAILED ===
```

## The proxy base takes a specified employee in full

`marker 546`

A specified employee goes into the prescribed proxy base at 100% rather than
75%. The salary line is still capped, so nothing on the paper looks wrong;
the proxy amount is simply larger than the provision allows, on the method
most claims use. `S9` computes the base from the rate table.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S9 the proxy base takes a specified employee at 75%, and a bonus never exceeds what it leaves  line 502 is 162,250.00, expected 121,687.50 — a base of 221,250.00 after 126,000.00 of bonus should have come out
=== 1 CHECK(S) FAILED ===
```

## A CCPC never gets the enhanced rate

`marker 547`

The company's CCPC status stops being read, and every claim is priced at the
basic 15% and marked non-refundable. For the owner's companies that is the
difference between money back and a credit against tax they may not owe —
and the paper would state it with the same confidence either way. `S10`
asks a CCPC what its credit is.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S10 a CCPC gets 35% refundable, and BC’s 10% is named as assistance next year  federal 84,103.12 at 15% NOT refundable, BC 56,068.75 at 10%, named as next year’s assistance, and no limit applied
FAIL  S16 the CCPC answer is set through a door, and it moves the credit  not a CCPC 15% not refundable 84,103.12 vs CCPC 15% NOT refundable 84,103.12; unanswered is priced at 15% and says nobody has said
=== 2 CHECK(S) FAILED ===
```

## The reporting deadline becomes a number in the code

`marker 548`

Eighteen months becomes twelve, typed here rather than read from the rate
table with its provision beside it. Missing that date loses the claim
outright — there is no relief provision — so a deadline six months early is
not the safe direction to be wrong in either: it is a date nobody can check
against anything. `S11` derives it from the year end.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S11 the reporting deadline is 18 months after the year end, worked out from it  2027-12-31 (434 days from today)
=== 1 CHECK(S) FAILED ===
```

## A time record with nothing written in it

`marker 549`

`logSredTime` accepts an empty activity. The hours still add up and the
salary share still computes, so every number downstream is unchanged — and
the one thing CRA actually reads, the sentence saying what was done, is
blank. `S2` writes three spaces into it.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S2 a time record must say what was done, and it is what a salary share is worked out from  ; 18h of 18h = 100%
=== 1 CHECK(S) FAILED ===
```

## Salary is reachable twice — as a stub and as a line

`marker 550`

Two fences, both down: the payroll entry is offered as an allocatable
journal line, and the door stops refusing salary claimed that way. The same
wages can then be claimed once through the stub, where the
specified-employee cap applies, and again through the entry, where nothing
applies. `S4` watches both halves.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S4 salary is claimed through the pay stub, where the cap can be applied  not refused on an ordinary cost line; payroll offered as 44 line(s)
FAIL  S5 the cap is applied to the year, and the paper’s two bonus sentences agree with each other  421,600.00 claimed; the cap alone is 373,000.00, uncapped it would have been 528,000.00; the warning shows it as money; the sentences agree — one person’s bonus in the warning, everybody’s in line 502, and an uncapped specified employee is warned too
FAIL  S9 the proxy base takes a specified employee at 75%, and a bonus never exceeds what it leaves  line 502 is 122,017.50, expected 121,687.50 — a base of 221,250.00 after 126,000.00 of bonus should have come out
FAIL  S18 “specified employee” is set through a door, and it is what makes the cap bite  unticked 528,600.00, ticked 421,600.00; unticked the paper says nothing about a cap
=== 4 CHECK(S) FAILED ===
```

## A filed year is edited underneath the return

`marker 551`

`saveClaim` stops asking whether the year has been filed. The method, the
narrative and the assistance answer can all be changed after the T661 has
gone, and the books then disagree with the return in a way nothing records.
`S13` files a year and tries to change its method.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S13 a filed year cannot have its method changed underneath the return  ; still traditional
=== 1 CHECK(S) FAILED ===
```

## The cap bites and the paper says nothing

`marker 552`

The specified-employee cap is still applied — the number is right — but the
paper stops saying it happened. Somebody reading it sees a salary figure
that is neither what was paid nor obviously anything else. The page still says
somebody is a specified employee and that specified employees are capped at
5 x YMPE — what it no longer says is WHICH figure was cut, or by how much.
`S12` reads the list of what is still unsettled.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S5 the cap is applied to the year, and the paper’s two bonus sentences agree with each other  421,000.00 claimed; the cap alone is 373,000.00, uncapped it would have been 528,000.00; the warning does NOT show it as money; the sentences agree — one person’s bonus in the warning, everybody’s in line 502, and an uncapped specified employee is warned too
FAIL  S12 the paper prints what the person filing still has to settle  7 item(s) to confirm; naming an unconfirmed rate, naming the related party, NOT naming the cap
=== 2 CHECK(S) FAILED ===
```

## The evidence gaps stop being named

`marker 553`

The standing still counts what is held; it stops saying what is missing. A
project with invoices and no trial records reads as three tidy fractions,
and the one thing that cannot be fixed after the year ends — a record made
at the time — is the thing nobody is told about. `S14` asks for the gaps
by name.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S14 evidence is counted by the question it answers, and the gaps are named  why 1/3, how 1/8, cost 1/2; an unknown kind is refused; 0 gap(s) named under how
=== 1 CHECK(S) FAILED ===
```

## A project shows another project's claims

`marker 554`

`claimsFor` stops filtering by project. Two projects in one company share a
fiscal year, so the year selector on one project lists the other's claim,
and opening it edits a narrative belonging to work it does not describe.
`S15` counts the claims a project has.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S15 a project has one claim per fiscal year                 2 claim, year ending 2026-12-31
FAIL  S30 a second year opens, and the button opens the year in front of you  5 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 2 CHECK(S) FAILED ===
```

## Both methods print the same number

`marker 555`

The traditional method's overhead line is filled with the proxy amount, so
the two columns agree and the choice between them looks like no choice at
all. The whole reason both are computed is that the decision is irrevocable
for the year and should be made in sight of the difference. `S8` subtracts
one from the other.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S8 the paper carries both methods, and only traditional claims the employer CPP and EI  proxy 560,687.50 vs traditional 560,687.50; line 502 is 121,687.50; line 360 is 121,687.50, expected 12,328.08 (3,000.00 recorded plus 9,328.08 of employer CPP/EI)
=== 1 CHECK(S) FAILED ===
```

## The same dollar may be claimed by two projects

`marker 556`

`check_sred_allocation_total` waves everything through. Applied to the test
database, 0015's precedent, because the migration it comes from is
append-only. Two projects may now each claim 60% of one fortnight, which is
the first arithmetic an auditor does and the one rule a spreadsheet cannot
hold.

```
$ db:verify-sred | npx tsx scripts/verify-sred.ts
FAIL  S3 one dollar cannot be claimed twice, and what is left of it still can  50% + 60% NOT refused: ; 50% + 50% allowed
=== 1 CHECK(S) FAILED ===
```

## The rates stop naming the provision they come from

`marker 557`

Every seeded rate loses its authority — the state a rate table drifts into
one edit at a time, and the reason this one carries the citation in a NOT
NULL column beside the number. A rate with no provision is a rate somebody
remembered, and this is a document somebody files. The rows are emptied in
the test database rather than in the migration, which is append-only.

```
$ db:verify-sred | npx tsx scripts/verify-sred.ts
FAIL  S1 every rate names the provision it comes from, and every doubt is written down  11 rates, 11 with no authority, 2 of 2 unconfirmed ones carrying a note
FAIL  S36 a rate can be put in, corrected and taken away, and each row edits itself  11 rate(s) to start; adding worked and it landed as sent; refusals: a jurisdiction nobody prices BAD_JURISDICTION, a confidence off the list BAD_CONFIDENCE, no name NO_NAME, no authority NO_AUTHORITY, a value that is not a number BAD_VALUE, an end before the start BACKWARDS, no start at all NO_DATE, a delete with no row named NO_ROW; correcting worked to 0.43; deleting worked, back to 11; with a year filed (yes), a rate that year's paper is built from: editing NO_AUTHORITY, deleting FILED_YEAR, while a new row from a later day went in and un-filing worked; the screen gives each row its own id twice and shows concise consequences only when editing
=== 2 CHECK(S) FAILED ===
```

## The BC figure stops saying no limit was applied to it

`marker 558`

The federal credit splits at the expenditure limit; the BC one is taken on the
whole qualified amount, and the province's own credit is refundable for a CCPC
only up to a limit — the seeded rate says so. The number stays as it is here,
because that rule is not one this system works out. What goes is the SENTENCE
beside it admitting so, which turns the figure into an assertion of a rule
nobody applied. `S10` reads the basis line.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S10 a CCPC gets 35% refundable, and BC’s 10% is named as assistance next year  federal 196,240.62 at 35% refundable, BC 56,068.75 at 10%, named as next year’s assistance, and silent on the limit
=== 1 CHECK(S) FAILED ===
```

## The CCPC answer is taken and never stored

`marker 559`

`saveProfile` reads the answer off the form and writes it nowhere. The
screen accepts it, says Saved, and the working paper goes on pricing the
company as though nobody had ever said — 15% and not refundable instead of
35% and refundable. This is the exact state the module shipped in before the
door existed. `S16` sets it through the door and asks the paper.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S10 a CCPC gets 35% refundable, and BC’s 10% is named as assistance next year  federal 84,103.12 at 15% NOT refundable, BC 56,068.75 at 10%, named as next year’s assistance, and no limit applied
FAIL  S16 the CCPC answer is set through a door, and it moves the credit  not a CCPC 15% not refundable 84,103.12 vs CCPC 15% NOT refundable 84,103.12; unanswered is priced at 15% and says nobody has said
=== 2 CHECK(S) FAILED ===
```

## Nobody has said collapses into no

`marker 560`

The three-state answer becomes two: an unanswered CCPC question is stored as
a definite No. The number does not move — an unclassified company was already
priced as though it were not one — but the to-confirm line saying nobody has said
disappears, and a guess becomes an assertion. `S16` asks the unanswered
case what the paper says about it.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S16 the CCPC answer is set through a door, and it moves the credit  not a CCPC 15% not refundable 84,103.12 vs CCPC 35% refundable 196,240.62; unanswered is priced at 15% and says NOTHING about nobody having said
=== 1 CHECK(S) FAILED ===
```

## Arm's length is accepted and never written

`marker 561`

`updateParty` always leaves the stored answer alone, so unticking the box
does nothing. Every contract goes on counting at 80%, including one with a
party this company does not deal with at arm's length — the rule that does
not apply to them, applied to them silently. `S17` moves the switch both
ways and reads the contract line.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S6 an arm’s-length contract counts at 80%, a related one is flagged instead  line 340 is 11,200.00, expected 12,000.00 (80% of 10,000 plus 4,000 in full); the related party is NOT named
FAIL  S12 the paper prints what the person filing still has to settle  7 item(s) to confirm; naming an unconfirmed rate, NOT naming the related party, naming the cap
FAIL  S17 arm’s length is set through a door, and it moves the contract line  at arm's length 11,200.00 vs related 11,200.00; and the paper does NOT name it
=== 3 CHECK(S) FAILED ===
```

## Specified employee cannot be turned on for somebody already on the payroll

`marker 562`

The INSERT still carries it; the UPDATE stops. So the flag can only ever be
set when a person is first added — and the owner-employee whose cap this
exists for is normally already on the payroll when anybody works out that
they are a specified employee. The 5 x YMPE cap then never bites, and
nothing says it did not. `S18` edits an existing record.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S18 “specified employee” is set through a door, and it is what makes the cap bite  unticked 421,000.00, ticked 421,000.00; unticked the paper STILL claims a cap bit
=== 1 CHECK(S) FAILED ===
```

## A year can be filed twice

`marker 563`

`fileClaim` stops asking whether the year was already filed, so a second
press overwrites the filing date with today's. The date that gets overwritten
is the one the eighteen months were counted to and the one the audit trail
would be read against. `S19` presses it twice.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S19 a filed year can be taken back, and only with a reason the trail keeps  filed twice; NO_REASON; undone; the trail says “The return did not go on that …”; the year is a draft again
=== 1 CHECK(S) FAILED ===
```

## Un-filing stops asking why

`marker 564`

A filed year can be turned back into a draft with nothing recorded but the
fact. Filing says a return went to CRA on a date; taking it back says it did
not, and the difference between a correction and a quiet edit is the sentence
that is no longer required. `reopenPeriod` has asked for that sentence since
0024. `S19` un-files with a blank reason.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S19 a filed year can be taken back, and only with a reason the trail keeps  ALREADY_FILED; no reason wanted; NOT_FILED; the trail says “…”; the year is a draft again
=== 1 CHECK(S) FAILED ===
```

## The CCPC question is on the screen but posts nothing

`marker 565`

The field loses its name. It still renders, a person still picks an answer,
and the form submits without it — so the door is handed nothing and the
company stays unclassified no matter what anybody selects. A door with no
form posting to it is not a door, which is the whole defect this node closed;
`S20` reads the tree for a field and a reader behind every switch the paper
depends on.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S20 every switch the working paper reads is one a person can actually set  entity.is_ccpc: no screen offers it
=== 1 CHECK(S) FAILED ===
```

## A filed year's money can still be moved

`marker 566`

`allocate` stops asking whether the year has been filed, so a percentage can
be changed after the return has gone. Every figure on that return was
produced by these rows; moving one makes the working paper quietly stop
agreeing with the T661 that was sent, and nothing anywhere records that they
ever differed. `S21` files a year and tries to move a share.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S21 filing freezes the money and leaves the project record open  allocate allowed, unallocate FILED; time and evidence still go in
=== 1 CHECK(S) FAILED ===
```

## A filed year's money can still be dropped

`marker 567`

The same fence, the other side of it: an allocation can be deleted out of a
filed year. Worse than moving one, because the figure simply gets smaller and
there is no second version to compare against. `S21` watches both doors,
and it also watches that the time log and the evidence stay OPEN — a freeze
that took the project record with it would punish the one habit this module
exists to encourage.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S21 filing freezes the money and leaves the project record open  allocate FILED, unallocate allowed; time and evidence still go in
=== 1 CHECK(S) FAILED ===
```

## The CCPC answer never leaves the form reader

`marker 568`

`saveProfileFromForm` stops passing the answer on. The screen offers the
field, the person picks Yes, the door is handed nothing, and the company
stays unclassified — a door with a form in front of it that posts to
something else. `S20` names the reader and the door for each switch and
asks whether that file carries the field; an earlier version only asked
whether the name appeared somewhere under src, which a comment would have
satisfied.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S10 a CCPC gets 35% refundable, and BC’s 10% is named as assistance next year  federal 84,103.12 at 15% NOT refundable, BC 56,068.75 at 10%, named as next year’s assistance, and no limit applied
FAIL  S16 the CCPC answer is set through a door, and it moves the credit  not a CCPC 15% not refundable 84,103.12 vs CCPC 15% NOT refundable 84,103.12; unanswered is priced at 15% and says nobody has said
FAIL  S20 every switch the working paper reads is one a person can actually set  entity.is_ccpc: src/lib/record-forms.ts does not carry it to saveProfile()
=== 3 CHECK(S) FAILED ===
```

## The over-allocation rule counts the row it is about to replace

`marker 569`

0068's body is put back on the test database: it excludes `id <> NEW.id`
instead of the claim. `allocate` writes with ON CONFLICT DO UPDATE, and
Postgres fires the BEFORE INSERT trigger on a proposed row with a FRESH id
before it discovers the conflict — so that exclusion excludes nothing on the
path the screen's Change button actually takes, and lowering a share on a
source already fully claimed is refused with a sentence saying it would go
over 100%. `S22` lowers one.

```
$ db:verify-sred | npx tsx scripts/verify-sred.ts
FAIL  S22 a share can be lowered — the rule counts what other claims took, not this one  Failed query:  | SRED_OVER_ALLOCATED: pay_stub is already %100.00 claimed; 60.00
=== 1 CHECK(S) FAILED ===
```

## A row that changes hands is counted against itself

`marker 570`

0069's body goes back on the test database: it excludes the claim and not the
id. Every write this application makes keeps `claim_id`, so that version is
right for all of them — and wrong for the one path nothing here takes yet. An
UPDATE that MOVES a row to another claim leaves the pre-image carrying the old
one, so the exclusion misses it, its own percent is summed in, and the row is
refused for over-claiming a source by exactly the amount it was already
claiming. `S23` moves one.

```
$ db:verify-sred | npx tsx scripts/verify-sred.ts
FAIL  S23 moving an allocation between claims is not refused by counting it against itself  Failed query:  | SRED_OVER_ALLOCATED: journal_line is already %60.00 claimed by other year
=== 1 CHECK(S) FAILED ===
```

## Tagged accounts stop sorting first

`marker 571`

The accounts a person has told the system hold SR&ED costs go back to date
order, mixed in with every other expense of the year. Nothing is wrong with
any number; the rows they came to allocate are simply somewhere in the
middle of several hundred, which on a real set of books is the same as not
having tagged them. `S24` reads the first row.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S24 a tagged account sorts first and arrives with its category and 100% offered  first is untagged; tagged mixed in with untagged; row says which; category pre-selected; 100% offered
=== 1 CHECK(S) FAILED ===
```

## A tagged row stops offering the whole cost

`marker 572`

The percent box opens empty on a line whose account is tagged SR&ED. The tag
says this account holds nothing else, so 100 is the answer nearly every time
— and an empty box on four hundred rows is four hundred keystrokes and four
hundred chances to type 10 for 100. The basis sentence is still required
either way. `S24` reads the box.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S24 a tagged account sorts first and arrives with its category and 100% offered  first is overhead; tagged all above untagged; row says which; category pre-selected; 100% not offered
=== 1 CHECK(S) FAILED ===
```

## A tagged row forgets which line it feeds

`marker 573`

The category select ignores what the account said and opens on the first
choice. Every tagged row then reads 'materials', and a contract or a
third-party payment goes to T661 line 320 unless the person notices — which
is exactly the noticing the tag existed to spare them. `S24` reads the
selected option in that row.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S24 a tagged account sorts first and arrives with its category and 100% offered  first is overhead; tagged all above untagged; row says which; category not pre-selected; 100% offered
=== 1 CHECK(S) FAILED ===
```

## The cost table renders the whole year again

`marker 574`

Pagination goes away and every posted cost of the year is rendered at once.
On the fixture that is nothing; on a real set of books it is the wall the
owner would have met the first time they opened this screen on their own
ledger. The search box and the filter are still there, which is what makes
it look fine. `S25` renders 120 rows and counts them.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S25 one page of costs at a time, with a way to search and to narrow  120 of 120 rows rendered; the counter says page 1 of 3; the search box is there and the lens is there
=== 1 CHECK(S) FAILED ===
```

## An account's SR&ED tag is taken and never stored

`marker 575`

The SR&ED screen's tag door reads the select and drops it (it was the account
form's until 0156), so the chart can never say what any account holds — and
every tagged-row behaviour below it is unreachable no matter how well it works.
The same shape as the four switches in the node before this one. `S20`
catches it: it reads the tree for a field on a screen AND the module that
carries it to the door, which is the half `S24` cannot see — S24 tags through
the library, not through the form.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S20 every switch the working paper reads is one a person can actually set  sred_account_category.category: src/app/ledger/[ledgerId]/sred/actions.ts does not carry it to setSredAccountCategory()
=== 1 CHECK(S) FAILED ===
```

## The lens stops narrowing

`marker 576`

`matchesCost` ignores which lens is chosen and keeps every row. The box, the
dropdown and the count all still work; picking 'SR&ED accounts only' simply
shows the whole year, which on a real ledger reads as the filter being broken
rather than as the list being right. Until today no check called this
function at all. `S26` calls each branch of it.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S26 the search and the lens narrow the list, and the table shows what is left  not filtering: tagged drops an untagged row
=== 1 CHECK(S) FAILED ===
```

## One matching word is enough

`marker 577`

The search keeps a row when ANY typed word appears instead of all of them, so
narrowing by a second word widens the list. Typing more to find less is the
one thing a search box promises. `S26` asks for a row that matches one word
and not the other.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S24 a tagged account sorts first and arrives with its category and 100% offered  first is overhead; tagged all above untagged; row says nothing; category not pre-selected; 100% not offered
FAIL  S25 one page of costs at a time, with a way to search and to narrow  0 of 120 rows rendered; the counter does not say page 1 of 3; the search box is there and the lens is there
FAIL  S26 the search and the lens narrow the list, and the table shows what is left  not filtering: a word that is not there fails, tagged keeps a tagged row, unclaimed keeps an unclaimed row, a category keeps its own, all keeps everything
FAIL  S38 every SR&ED list reads as text until a row is opened    hours: 3 row(s), 0 box(es); evidence: 3 row(s), 0 box(es); rates: 3 row(s), 0 box(es); the project: 1 row(s), 0 box(es); costs: 5 row(s), 0 box(es); the three answers and filing: 2 row(s), 0 box(es); the year strip: 1 row(s), 0 box(es); opened: hours 3, evidence 4, rates 8, the project 6, costs 0
=== 4 CHECK(S) FAILED ===
```

## The salary line stops saying it is gross only

`marker 578`

Line 300 goes back to a note about the cap and nothing else. The number is
unchanged and correct; what goes is the sentence naming the employer's half of
CPP and EI and saying where it went — line 360 under the traditional method,
and nowhere at all under proxy. Without it a reader cannot tell whether that
money was claimed, left out, or forgotten, and the three look identical on the
page. `S27` reads the note and checks the amount in it against the stubs.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S27 line 300 says where its employer CPP and EI went, and 502 what came out of its base  9,328.08 of employer CPP/EI: line 300 says nothing, without the figure; line 502 names the bonus out and the benefits still in; a claim with no bonus still carries the hedge
=== 1 CHECK(S) FAILED ===
```

## The proxy base stops saying what came out of it

`marker 579`

Line 502's note drops the sentence saying what came out of its base and what
could not. The base still nets off the bonus, so the number is unchanged; what
goes is the figure that left, and the two things this cannot take out — a
bonus nobody entered in the pay run's column, and taxable benefits, which
nothing here records apart from gross pay. A base that says nothing about its
own gaps reads as though it had none. `S27` reads it, on a claim with a
bonus and on one without.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S5 the cap is applied to the year, and the paper’s two bonus sentences agree with each other  421,000.00 claimed; the cap alone is 373,000.00, uncapped it would have been 528,000.00; the warning shows it as money; the sentences do NOT agree
FAIL  S29 a bonus bigger than the salary left after the cap takes out only the salary  390,000.00 of bonus against 373,000.00 of counted salary (the cap is 373,000.00): the proxy amount is 0.00, and the note names something else
FAIL  S27 line 300 says where its employer CPP and EI went, and 502 what came out of its base  9,328.08 of employer CPP/EI: line 300 sends it to 360 under traditional, with the figure; line 502 admits nothing; a claim with no bonus claims compliance anyway
=== 3 CHECK(S) FAILED ===
```

## A fiscal year can be planned short

`marker 580`

`planFiscalYear` builds its twelve periods from eleven months instead of
twelve, so a year comes out short and nobody chose it. The
specified-employee cap is prorated for a short tax year and this module does
not prorate it, so a claim in such a year is capped too generously — the
paper says so when it can see the year is short, and a planner quietly
producing one is the case nobody would look at. `S28` plans five year ends
and measures each.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S28 a short tax year is said — from the year’s own dates, and from an incorporation inside it  planner: 2026-07-15, 2026-01-01
=== 1 CHECK(S) FAILED ===
```

## A short fiscal year stops being mentioned

`marker 581`

The paper goes quiet about a year that is not twelve months long. A restore
writes `fiscal_year` rows verbatim from a file with triggers off, and 0007's
guard lets an OPEN year with no posted entries be redefined — so a short row
is a state this system reaches. The cap above it is then applied in full,
prorated by nothing, and the only thing that said so is gone. `S28` puts a
201-day year in front of it.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S28 a short tax year is said — from the year’s own dates, and from an incorporation inside it  5 end dates each planned as exactly twelve months; a 201-day row is NOT named; a mid-year incorporation is named; one after the year end is not
=== 1 CHECK(S) FAILED ===
```

## A company born inside its own year stops being mentioned

`marker 582`

The other half, and the one no ledger date can show: a company incorporated
mid-year has a FIRST TAX YEAR shorter than the twelve months this ledger
keeps for it. The fiscal year looks full, the cap is applied in full, and the
figure is too generous with nothing on the page to hint at it. This is the
case that made deleting the disclosure the wrong call. `S28` reads the
recognition date.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S28 a short tax year is said — from the year’s own dates, and from an incorporation inside it  5 end dates each planned as exactly twelve months; a 201-day row is named; a mid-year incorporation is NOT named; one after the year end is not
=== 1 CHECK(S) FAILED ===
```

## Recognised after the year ends still counts as inside it

`marker 583`

The upper half of the bound goes, so any recognition date after the year
STARTS reads as an incorporation inside it. `createFiscalYear` will plan a
year flush before the earliest one, and a claim on a year that closed before
the company existed is then told that year contains its incorporation —
false about that year at both ends, and the sort of sentence a person would
believe because nothing else on the page contradicts it. `S28` puts a
recognition date after the year end in front of it.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S28 a short tax year is said — from the year’s own dates, and from an incorporation inside it  5 end dates each planned as exactly twelve months; a 201-day row is named; a mid-year incorporation is named; one after the year end is WRONGLY named
=== 1 CHECK(S) FAILED ===
```

## The cap warning goes back to printing raw cents

`marker 584`

The sentence under 'Settle these before this becomes a return' prints
37300000 where every amount beside it reads 373,000.00. Nothing is wrong with
the arithmetic and nothing on the page contradicts it — a person simply reads
a number two decimal places out and has no reason to doubt it. This is the
same defect the employer CPP/EI note shipped with for one round, and the
check that now holds it exists because fixing that one left this one
unguarded. `S5` reads the warning.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S5 the cap is applied to the year, and the paper’s two bonus sentences agree with each other  421,000.00 claimed; the cap alone is 373,000.00, uncapped it would have been 528,000.00; the warning does NOT show it as money; the sentences agree — one person’s bonus in the warning, everybody’s in line 502, and an uncapped specified employee is warned too
=== 1 CHECK(S) FAILED ===
```

## The employer's CPP and EI stop reaching line 360

`marker 585`

Traditional overhead goes back to the recorded overhead alone. The owner
settled this on 2026-09-11: the employer's half of CPP and EI on the claimed
pay is directly attributable overhead and belongs on line 360 under that
method. Dropped, a traditional claim is understated by real money spent on
the work — and the note beside line 300 goes on saying it was claimed there.
`S8` adds the line up from the stubs.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S8 the paper carries both methods, and only traditional claims the employer CPP and EI  proxy 560,687.50 vs traditional 442,000.00; line 502 is 121,687.50; line 360 is 3,000.00, expected 12,328.08 (3,000.00 recorded plus 9,328.08 of employer CPP/EI)
=== 1 CHECK(S) FAILED ===
```

## The bonus goes back into the proxy base

`marker 586`

The prescribed proxy amount is computed on the whole of the capped salary
again, bonuses included. In law the salary base is the narrower figure, so
the PPA comes out too large on the method most claims use — and the paper
says the bonus was taken out while it was not. `S9` computes the base from
the rule.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S9 the proxy base takes a specified employee at 75%, and a bonus never exceeds what it leaves  line 502 is 173,662.50, expected 121,687.50 — a base of 221,250.00 after 126,000.00 of bonus should have come out
FAIL  S29 a bonus bigger than the salary left after the cap takes out only the salary  390,000.00 of bonus against 373,000.00 of counted salary (the cap is 373,000.00): the proxy amount is 153,862.50, and the note names 373,000.00
=== 2 CHECK(S) FAILED ===
```

## The bonus box on a payday posts nothing

`marker 587`

The pay run reads every other figure off the form and drops this one, so
`pay_stub.bonus` is always zero however carefully a person fills the column
in. Every payroll number is unaffected — that is the point of the memo — and
the SR&ED proxy base silently goes back to including bonuses it was told
about. The same shape as the four switches nobody could set — and `S9` cannot
see it, because the SR&ED fixture calls `runPayroll` directly rather than
through this reader. `S20` is the one that catches it: it reads the tree for
a field on a screen and the module that carries it to the door.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S20 every switch the working paper reads is one a person can actually set  pay_stub.bonus: src/lib/payroll/forms.ts does not carry it to runPayroll()
=== 1 CHECK(S) FAILED ===
```

## A bonus may be bigger than the pay it is part of

`marker 588`

`previewPayRun` stops asking whether the bonus fits inside the gross. Every
other figure on that row is asked — pensionable, insurable, the gross itself
— and this one was shipped without it, so a typed 4,000 against a 3,000
payday reached the INSERT and came back as 0072's raw CHECK violation
instead of a sentence naming the person. `PR48` types one.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR48 a bonus cannot be negative, nor more than the gross it is part of  NEGATIVE; a bonus above the gross was ACCEPTED; a bonus inside the gross is accepted
=== 1 CHECK(S) FAILED ===
```

## A negative bonus is accepted at the door

`marker 589`

The other half of the same fence. Pay cannot be less than nothing and neither
can a part of it; without the guard a minus sign travels to the database and
the refusal a person reads is a constraint name. The column's own CHECK is
the backstop for anything that skips this door — it is not the thing a person
should ever meet. `PR48` types a negative one.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR48 a bonus cannot be negative, nor more than the gross it is part of  a negative bonus was ACCEPTED; MORE_THAN_GROSS; a bonus inside the gross is accepted
=== 1 CHECK(S) FAILED ===
```

## Only a capped specified employee is warned

`marker 590`

The claim-side sentence goes back to firing only when the 5 x YMPE cap bit.
The gap it describes — the law keeps profit-based pay out of the claim itself
and this paper keeps it only out of the proxy base — belongs to every
specified employee, and somebody paid under the cap then gets no sentence at
all while their line 300 carries exactly the same thing. `S5` reads the
sentence for the one who is under it.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S5 the cap is applied to the year, and the paper’s two bonus sentences agree with each other  421,000.00 claimed; the cap alone is 373,000.00, uncapped it would have been 528,000.00; the warning shows it as money; the sentences do NOT agree
=== 1 CHECK(S) FAILED ===
```

## The base reports the bonus entered, not the bonus taken out

`marker 591`

`bonusTaken` becomes the whole bonus again, so line 502 reports a reduction
larger than the base it came out of whenever a capped person was paid more
bonus than the salary that survived the cap. The number the paper prints then
describes something that did not happen, in the direction that makes the base
look narrower than it is. `S9` calls the clamp branches directly; `S29`
watches it on a real paper, where a founder paid 390,000 in bonus has only
373,000 of counted salary for it to come out of.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S9 the proxy base takes a specified employee at 75%, and a bonus never exceeds what it leaves  line 502 is 121,687.50, expected 121,687.50 — a base of 221,250.00 after 126,000.00 of bonus should have come out; clamp broken: a bonus larger than the salary comes out at the salary, and never more, so the base cannot go negative
FAIL  S29 a bonus bigger than the salary left after the cap takes out only the salary  390,000.00 of bonus against 373,000.00 of counted salary (the cap is 373,000.00): the proxy amount is -7,012.50, and the note names 390,000.00 — including the whole bonus, which never left the base
=== 2 CHECK(S) FAILED ===
```

## The working paper stops calling the clamp

`marker 592`

The helper is still correct and still tested; the line that USES it hands the
whole bonus through instead. On a specified employee whose bonus is larger
than the salary the cap left, the base then goes negative — a reduction
bigger than the thing it came out of — and line 502 reports it. Extracting
the arithmetic into a helper covered the arithmetic and left this wire bare
until `S29` existed. `S29` reads the paper.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S29 a bonus bigger than the salary left after the cap takes out only the salary  390,000.00 of bonus against 373,000.00 of counted salary (the cap is 373,000.00): the proxy amount is -7,012.50, and the note names something else — including the whole bonus, which never left the base
=== 1 CHECK(S) FAILED ===
```

## The year button opens the newest year, whatever year you are on

`marker 593`

Half of the defect this node removed, put back: the opener submits
`years[0]` instead of the year in front of you. Look at 2027, press the
button, and 2028 is what opens — and since a project may only have one claim
per year, the year you actually wanted may now be the one you cannot reach.
`S30` renders the strip on a year that is not the newest.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits c and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The button to open a year disappears after the first one

`marker 594`

The other half, and the worse one: whether the opener renders goes back to
asking whether the project has ANY claim rather than whether THIS year does.
A project's first claim then closes the door behind it and no second year can
ever be opened — which is exactly how this shipped, and `S15` passed the
whole time because its fixture opens one year. `S30` opens a second.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits (no opener at all) and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
FAIL  S38 every SR&ED list reads as text until a row is opened    hours: 3 row(s), 0 box(es); evidence: 3 row(s), 0 box(es); rates: 3 row(s), 0 box(es); the project: 1 row(s), 0 box(es); costs: 5 row(s), 0 box(es); the three answers and filing: 2 row(s), 0 box(es); the year strip: 0 row(s), 0 box(es); opened: hours 3, evidence 4, rates 8, the project 6, costs 3; NOTHING TO RENDER for the year strip
=== 2 CHECK(S) FAILED ===
```

## Asking for a year with nothing in it hands back another year's claim

`marker 595`

`viewedYear` borrows again. The screen then shows one year's narrative,
method and figures under another year's heading, and the year you asked for
reports itself as claimed. Nothing about the page looks wrong. `S30` asks
for a year that has no claim.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; NOT a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The year strip marks the newest year rather than the one you are on

`marker 596`

Only the highlight, and only on a screen where the newest year is not the one
being looked at — so the person reads the figures of 2027 while the strip says
2028. The mutation is invisible on any fixture whose viewed year IS the newest,
which is the condition `S30` puts on the strip's own year array: the year it
looks at has no claim AND is not the first one.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is NOT marked; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The page stops reading the year out of the address

`marker 597`

`?year=` is parsed and then not passed, so every year button leads back to
the same year. `S30` reads the page for the call.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx NO LONGER has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The page hands the strip the newest year instead of the resolved one

`marker 598`

The resolver is right and its answer is thrown away one line later. Same
outcome as 593, reached from the other side. `S30` reads the page for the
prop.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, NO LONGER has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The costs a year can reach are the newest year's, whatever year you are on

`marker 599`

The allocation table's window stops following the year being looked at and
takes the newest year's dates instead, so a person working on 2027 is offered
2028's costs to claim — and would claim them, because the table is the only
place those dates appear. This line was in the page until the critic pointed
out that a DECISION spelled out in a server component is one no check here can
run; it is in `viewedYear` now, and `S30` calls it.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; NOT no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; NOT the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## A project with no claim anywhere lands on no year at all

`marker 600`

The last arm of `viewedYear` goes. With a claim somewhere, nothing changes —
the year is found by the claim. With NO claim, there is nothing to find it by,
so the answer becomes null, the strip is handed `yearId={null}`, and the
opener does not render: the FIRST claim can no longer be opened either. The
same defect this node removed, one arm along, and no fixture reached it until
`S30` passed an empty claim list.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; NOT a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The years a project's claims come back in are reversed

`marker 601`

`claimsFor` orders by year end ascending. Nothing refuses; the screen opens
on the OLDEST year instead of the newest, because `viewedYear` lands on
`claims[0]` and it is this ORDER BY that makes the first one the newest.
A person opening a project sees a closed year and can file against it by
pressing what looks like the default. No literal array can catch this — the
order has to be asked of the database, which is why `S30` reads the claims
back rather than assuming a list.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, NOT newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## Opening a year silently reuses the year the project already has

`marker 602`

The door takes the fiscal year it was given and, if the project already has a
claim, substitutes that claim's year for it. Nothing refuses: the insert
conflicts on the year it swapped in, `DO UPDATE` hands back the first
claim's id, and the screen goes on as though a second year had been opened.
Every other `openClaim` in the suite is a project's FIRST claim, so the
subquery is empty there and they are untouched — which is precisely why this
one is worth having: the comment beside `S30` used to say no such mutation
existed, and a reviewer wrote this one out.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  1 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
FAIL  S33 the record can be corrected, except where a filed return rests on it  an hour changed to 4.50; inside a filed year — edit ALLOWED, delete ALLOWED, paper ALLOWED; a draft row redated into it WENT IN, a draft paper redated into it WENT IN; 25 hours through the edit door BAD_HOURS; the first year filed yes, an hour ADDED to it afterwards went in and the paper says “1 hour record(s) in this year were written dow”, un-filed again yes; setting it up: hour written, paper written, filed no second year to file, un-filed not reached; the draft year still edits; after un-filing the delete NO_ROW and the row is gone
FAIL  S39 the working paper reads a year's tables added in the app itself, and caps salary at five times that YMPE  the 2027 claim with no 2027 tables: no next-year claim; with an edition added and the process cold: no next-year claim; the cap: —
=== 3 CHECK(S) FAILED ===
```

## The year in the address stops being the year you land on

`marker 603`

`viewedYear` drops the arm that says the year asked for IS the year, and
falls back to the year of whichever claim it found — so a year with nothing in
it resolves to the newest year instead of itself. The claim half of the answer
is still right, which is the point: the two halves are computed separately and
one can be wrong while the other is not.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; NOT a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; NOT the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The costs the screen offers reach past the window it was given

`marker 604`

The page stops using the window `viewedYear` handed it and takes the newest
year's dates straight off the year list. Same outcome as 599 — a person on
2027 is offered 2028's costs to claim — reached from the page rather than the
resolver. This hand-off was held by nothing until `S30` read it: moving the
DECISION out of the page left the HAND-OFF behind.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, NO LONGER has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The costs a claim can reach come from the newest year too

`marker 605`

The other half of 604, and the half that carries the money: materials,
contracts, third-party work and equipment. The page keeps using the window it
was given for salary and reaches past it for everything else, so a person on
2027 is offered 2028's invoices. One repair took the salary line and called it
"the window's one consumer"; there are two.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, NO LONGER has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The dot moves to the years that already have a claim

`marker 606`

The strip's only way of saying which years are still empty is inverted, so
every year that has a claim is marked as if it had none and every empty year
looks done. Nothing else on the screen says it: the working paper is per year
and you have to be on the year to see it. `S30` reads the two buttons.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026 ·” for the claimed year and “FY2027” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The screen is handed another year's claim

`marker 607`

The page resolves the year correctly and then hands the body
`claims[0]` — the newest claim — instead of the one belonging to the year
being looked at. This is block 595 reached from the page, and it is worse
there: the Record tab shows another year's 242/244/246 and method, and every
form on the screen carries that claim's id, so an allocation made on 2027 is
written against 2026 and pressing file files 2026. The strip goes on offering
to open 2027 at the same time, because it reads the claim LIST, not this prop.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, NO LONGER has `claim={claim}`, has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The working paper is computed for a year nobody asked about

`marker 608`

Same substitution, one line earlier and money-side only: the figures, the
credit and the eighteen-month countdown all come from the newest claim while
the heading says the year you are on. Nothing refuses, because both are real
claims of the same project.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, NO LONGER has `workingPaper(claim.id)`, has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## The allocations already made are read from another year

`marker 609`

The cost table's "already claimed" column and its pre-filled percentages
come from the newest claim's allocations. So a cost claimed at 60% in 2026
shows as claimed on the 2027 screen, and a person correcting it edits a row
that is not there — while the money they meant to claim looks untouched.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S30 a second year opens, and the button opens the year in front of you  2 year(s) claimed on one project, newest first; no year asked → the first claim given, on its own year and dates; a claimed year → that year’s own claim; a year with nothing in it → NO claim, and that year; an id that is not a year → the first claim given; a project with no claim anywhere → the newest year, and its dates; the window of the year asked for is that year’s own dates; the opener on an unclaimed year submits b and that year is marked as the one being looked at; on a year that has a claim the opener is not offered; the buttons read “FY2026” for the claimed year and “FY2027 ·” for the bare one; page.tsx has `viewedYear(years, claims, asked)`, has `yearId={year?.id ?? null}`, has `ORDER BY end_date DESC`, has `allocatableSalary(ledgerId, span.from, span.to)`, has `allocatableLines(ledgerId, span.from, span.to)`, has `claim={claim}`, has `workingPaper(claim.id)`, NO LONGER has `claim_id = ${claim.id}::uuid`
=== 1 CHECK(S) FAILED ===
```

## A pasted day can be longer than a day

`marker 610`

The upper bound goes off the hours a batch may carry, so `25` is accepted
and the database's own CHECK refuses the INSERT — which in an all-or-nothing
batch means forty good rows fail on a constraint error instead of one line
being named. `S31` pastes 25 hours.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S31 a pasted batch is read line by line, and every bad line says which and why  hours: 3 kept of 9 read, first is Dana Owner from line 3; L5 4 fields expected, 3 given; L6 "03-05-2026" is not yyyy-mm-dd; L7 "4.005" is not hours to two decimals; L8 (not refused); L9 0 hours is not between 0 and 24; L10 no activity — the sentence is the evidence; L11 no name; paper: 1 kept of 5 read, first is trial_record from line 2; L3 "lab_book" is not one of the kinds CRA asks for; L4 no title; L5 "April" is not yyyy-mm-dd; L6 3 fields expected, 4 given
FAIL  S33 the record can be corrected, except where a filed return rests on it  an hour changed to 4.50; inside a filed year — edit FILED_YEAR, delete FILED_YEAR, paper FILED_YEAR; a draft row redated into it FILED_YEAR, a draft paper redated into it FILED_YEAR; 25 hours through the edit door Failed query:  | new row for relation "sred_time" violates check constraint "sred_time_hours_check"; the first year filed yes, an hour ADDED to it afterwards went in and the paper says “1 hour record(s) in this year were written dow”, un-filed again yes; setting it up: hour written, paper written, filed yes, un-filed yes; the draft year still edits; after un-filing the delete went through and the row is gone
=== 2 CHECK(S) FAILED ===
```

## Pasted hours may carry more decimals than the column keeps

`marker 611`

`numeric(5,2)` rounds 4.005 to 4.01 without saying so, and the person who
pasted it never learns which number the claim is actually made of. `S31`
pastes three decimals.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S31 a pasted batch is read line by line, and every bad line says which and why  hours: 3 kept of 9 read, first is Dana Owner from line 3; L5 4 fields expected, 3 given; L6 "03-05-2026" is not yyyy-mm-dd; L7 (not refused); L8 25 hours is not between 0 and 24; L9 0 hours is not between 0 and 24; L10 no activity — the sentence is the evidence; L11 no name; paper: 1 kept of 5 read, first is trial_record from line 2; L3 "lab_book" is not one of the kinds CRA asks for; L4 no title; L5 "April" is not yyyy-mm-dd; L6 3 fields expected, 4 given
=== 1 CHECK(S) FAILED ===
```

## A short line in a batch is read as if a field were blank

`marker 612`

The field count stops being checked, so `Sam | 2026-03-04 | 8` reaches the
destructuring with no activity and comes back refused for the wrong reason —
"no activity" on a line whose real fault is a missing pipe. The refusal is
what a person navigates by. `S31` pastes a three-field line.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S31 a pasted batch is read line by line, and every bad line says which and why  hours: 2 kept of 9 read, first is Dana Owner from line 3; L5 no activity — the sentence is the evidence; L6 "03-05-2026" is not yyyy-mm-dd; L7 "4.005" is not hours to two decimals; L8 25 hours is not between 0 and 24; L9 0 hours is not between 0 and 24; L10 no activity — the sentence is the evidence; L11 no name; paper: 1 kept of 5 read, first is trial_record from line 2; L3 "lab_book" is not one of the kinds CRA asks for; L4 no title; L5 "April" is not yyyy-mm-dd; L6 3 fields expected, 4 given
=== 1 CHECK(S) FAILED ===
```

## The template's own headings are refused as bad rows

`marker 613`

`### TIME` stops being skipped, so pasting the block exactly as the intake
list asks the other agent to produce it fails on its first line — and since a
batch is all or nothing, nothing goes in. `S31` pastes the heading.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S31 a pasted batch is read line by line, and every bad line says which and why  hours: 2 kept of 10 read, first is Dana Owner from line 3; L5 4 fields expected, 3 given; L6 "03-05-2026" is not yyyy-mm-dd; L7 "4.005" is not hours to two decimals; L8 25 hours is not between 0 and 24; L9 0 hours is not between 0 and 24; L10 no activity — the sentence is the evidence; L11 no name; paper: 1 kept of 6 read, first is trial_record from line 2; L3 "lab_book" is not one of the kinds CRA asks for; L4 no title; L5 "April" is not yyyy-mm-dd; L6 3 fields expected, 4 given
FAIL  S32 a batch goes in whole or not at all, and says which line stopped it  one unknown name: 0 added, 0 row(s) appeared, refused no active employee called "Nobody At All"; a clean batch: 0 added, 0 appeared; the same batch again: 1 added, NOT refused; the same line twice in ONE paste: 0 added, 1 appeared, line 2 already on file, to the word; paper: 0 added, 0 appeared
FAIL  S33 the record can be corrected, except where a filed return rests on it  an hour changed to 4.50; inside a filed year — edit FILED_YEAR, delete FILED_YEAR, paper FILED_YEAR; a draft row redated into it FILED_YEAR, a draft paper redated into it no pasted evidence to carry; 25 hours through the edit door BAD_HOURS; the first year filed yes, an hour ADDED to it afterwards went in and the paper says “1 hour record(s) in this year were written dow”, un-filed again yes; setting it up: hour written, paper written, filed yes, un-filed yes; the draft year is REFUSED: no pasted evidence reached the draft year; after un-filing the delete went through and the row is gone
=== 3 CHECK(S) FAILED ===
```

## A pasted evidence kind is taken on trust

`marker 614`

The controlled vocabulary stops being checked in the parser, so `lab_book`
gets past it and the door refuses the whole batch with UNKNOWN_KIND naming no
line. Thirteen kinds is CRA's list, not a suggestion. `S31` pastes one that
is not on it.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S31 a pasted batch is read line by line, and every bad line says which and why  hours: 2 kept of 9 read, first is Dana Owner from line 3; L5 4 fields expected, 3 given; L6 "03-05-2026" is not yyyy-mm-dd; L7 "4.005" is not hours to two decimals; L8 25 hours is not between 0 and 24; L9 0 hours is not between 0 and 24; L10 no activity — the sentence is the evidence; L11 no name; paper: 2 kept of 5 read, first is trial_record from line 2; L3 (not refused); L4 no title; L5 "April" is not yyyy-mm-dd; L6 3 fields expected, 4 given
=== 1 CHECK(S) FAILED ===
```

## A batch puts in whatever part of it was good

`marker 615`

All or nothing becomes some: the readable rows go in and the bad ones are
reported, so the person fixes two lines and pastes the batch again — and the
good half arrives twice. Nothing in this system can tell a genuine repeat of a
day's work from a double paste. `S32` pastes a batch with one bad name.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S32 a batch goes in whole or not at all, and says which line stopped it  one unknown name: 1 added, 1 row(s) appeared, refused no active employee called "Nobody At All"; a clean batch: 1 added, 2 appeared; the same batch again: 0 added, already on file, to the word; the same line twice in ONE paste: 1 added, 1 appeared, line 2 already on file, to the word; paper: 1 added, 1 appeared
=== 1 CHECK(S) FAILED ===
```

## Pasting the same batch twice records the work twice

`marker 616`

The already-on-file test goes. Two identical hours on the same day for the
same person is a plausible thing to have happened once and an implausible
thing to have happened by hand, and the second copy inflates the salary the
claim is built on. `S32` pastes the same row twice.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S32 a batch goes in whole or not at all, and says which line stopped it  one unknown name: 0 added, 0 row(s) appeared, refused no active employee called "Nobody At All"; a clean batch: 2 added, 2 appeared; the same batch again: 1 added, NOT refused; the same line twice in ONE paste: 2 added, 3 appeared, line 2 NOT refused; paper: 1 added, 1 appeared
=== 1 CHECK(S) FAILED ===
```

## A pasted name has to match the payroll's name lowercased

`marker 617`

Only the LOOKUP stops folding case; the map is still keyed on the payroll name
lowercased. So `Sam Engineer` — the spelling the intake list asks the other
agent for, and the one a payroll actually holds — is nobody, and an all-lowercase
spelling is the only one that resolves. The list that comes back is prose, not a
key. `S32` pastes names as they are written.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S32 a batch goes in whole or not at all, and says which line stopped it  one unknown name: 0 added, 0 row(s) appeared, refused no active employee called "Sam Engineer" / no ac; a clean batch: 0 added, 0 appeared; the same batch again: 0 added, no active employee called "Sam Engineer"; the same line twice in ONE paste: 0 added, 0 appeared, line 2 no active employee called "Sam Engineer"; paper: 1 added, 1 appeared
FAIL  S33 the record can be corrected, except where a filed return rests on it  an hour changed to no pasted row to edit; inside a filed year — edit FILED_YEAR, delete FILED_YEAR, paper FILED_YEAR; a draft row redated into it no draft row to carry, a draft paper redated into it FILED_YEAR; 25 hours through the edit door no draft row to over-fill; the first year filed yes, an hour ADDED to it afterwards went in and the paper says “1 hour record(s) in this year were written dow”, un-filed again yes; setting it up: hour written, paper written, filed yes, un-filed yes; the draft year still edits; after un-filing the delete went through and the row is gone
=== 2 CHECK(S) FAILED ===
```

## An hour can be carried INTO a filed year by editing its date

`marker 618`

The door checks the year the row is in and not the year it is going to, so a
row in a draft year is redated into a filed one and the return that has gone
quietly acquires an hour it never rested on. The check that catches this has
to move a row the OTHER way — a row already inside a filed year is refused by
the first test whatever the second one does. `S33` redates a draft row into
the filed year.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S33 the record can be corrected, except where a filed return rests on it  an hour changed to 4.50; inside a filed year — edit FILED_YEAR, delete FILED_YEAR, paper FILED_YEAR; a draft row redated into it WENT IN, a draft paper redated into it FILED_YEAR; 25 hours through the edit door BAD_HOURS; the first year filed yes, an hour ADDED to it afterwards went in and the paper says “1 hour record(s) in this year were written dow”, un-filed again yes; setting it up: hour written, paper written, filed yes, un-filed yes; the draft year still edits; after un-filing the delete went through and the row is gone
=== 1 CHECK(S) FAILED ===
```

## The fence looks at the years that were not filed

`marker 619`

The test is inverted: a row inside a FILED year is edited and deleted freely,
and a row in a draft year is refused instead. Both halves are wrong and only
one of them is visible to the person — the refusal. `S33` walks both sides
of the line.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S33 the record can be corrected, except where a filed return rests on it  an hour changed to FILED_YEAR; inside a filed year — edit ALLOWED, delete ALLOWED, paper ALLOWED; a draft row redated into it FILED_YEAR, a draft paper redated into it FILED_YEAR; 25 hours through the edit door BAD_HOURS; the first year filed yes, an hour ADDED to it afterwards went in and the paper says “1 hour record(s) in this year were written dow”, un-filed again yes; setting it up: hour written, paper written, filed yes, un-filed yes; the draft year is REFUSED: FILED_YEAR; after un-filing the delete NO_ROW and the row is gone
=== 1 CHECK(S) FAILED ===
```

## A project a return has gone on can be deleted

`marker 620`

The guard goes, and with it the claims, hours and evidence of a year already
filed — 0068 cascades all three off the project. There is no undo and the
backup is the only way back. `S35` files a year on a project of its own and
presses delete.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S35 a project can be corrected, given a status, and put away — unless a year of it is filed  saved as GONE2/abandoned/1.03 Physical sciences/2026-11-30 from 2026-01-06; a status off the list UNKNOWN_STATUS; opening its year worked and filing it worked; with that year filed, renaming FILED_YEAR and setting the status still works; the delete WENT THROUGH and the project IS GONE; un-filing NO_CLAIM and the delete then went cleanly, 4 project(s) to 3
=== 1 CHECK(S) FAILED ===
```

## A project can be given a status the database will not hold

`marker 621`

The status list stops being checked in the door, so `shelved` reaches the
UPDATE and 0068's CHECK refuses it — a constraint error where a sentence
belonged. Four statuses is the whole list, and `abandoned` is on it because
work that did not resolve its uncertainty is still SR&ED. `S35` sends one
that is not.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S35 a project can be corrected, given a status, and put away — unless a year of it is filed  saved as GONE2/abandoned/1.03 Physical sciences/2026-11-30 from 2026-01-06; a status off the list Failed query:  | new row for relation "sred_project" violates check constraint "sred_project_status_check"; opening its year worked and filing it worked; with that year filed, renaming FILED_YEAR and setting the status still works; the delete FILED_YEAR and the project is still there; un-filing worked and the delete then went cleanly, 4 project(s) to 3
=== 1 CHECK(S) FAILED ===
```

## Every row's buttons act on the first row

`marker 622`

The id written once per row and used by both its forms becomes the first
row's, so pressing Save on the fourth hour edits the first and pressing Delete
on the fourth deletes the first. Nothing on the screen says so — the row still
shows its own figures in its own inputs. `S34` renders two rows and reads
each row's own forms.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S34 every correction is reachable from a screen, and each form carries its own row  2 hour row(s): each does NOT, and NAMES ANOTHER ROW; 2 paper row(s): each carries its own id twice, and names no other row; the paste box prints “employeeName | onDate | hours | activity” and has its box, and the add forms have 2 of the 2 shared field lists; the project offers fieldOfScience, status, endedOn of fieldOfScience, status, endedOn and all 4 statuses
=== 1 CHECK(S) FAILED ===
```

## The paste box stops saying what shape it wants

`marker 623`

The format line loses half its fields, so the box asks for two columns and
refuses every four-column row it is given. The sentence is built from the
field names precisely so it cannot drift from them; this is what drifting
looks like. `S34` reads the sentence back.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S34 every correction is reachable from a screen, and each form carries its own row  2 hour row(s): each carries its own id twice, and names no other row; 2 paper row(s): each carries its own id twice, and names no other row; the paste box does NOT, and the add forms have 2 of the 2 shared field lists; the project offers fieldOfScience, status, endedOn of fieldOfScience, status, endedOn and all 4 statuses
=== 1 CHECK(S) FAILED ===
```

## The project's status is posted under another field's name

`marker 624`

The select still shows four statuses and sends them as something the action
does not read, so the status silently stays whatever it was — which for every
project is `active`, including the ones that were abandoned. `S34` reads
the field names off the form.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S34 every correction is reachable from a screen, and each form carries its own row  2 hour row(s): each carries its own id twice, and names no other row; 2 paper row(s): each carries its own id twice, and names no other row; the paste box prints “employeeName | onDate | hours | activity” and has its box, and the add forms have 2 of the 2 shared field lists; the project offers fieldOfScience, endedOn of fieldOfScience, status, endedOn and all 4 statuses
=== 1 CHECK(S) FAILED ===
```

## A filed return's project can be renamed underneath it

`marker 625`

The project's own fence goes. T661 carries the project's title, identifier
and field of science, so once a year of it has gone those are what a return
said — and this lets them be changed with nothing recorded and nothing
refused. The status and the end date stay open on purpose and are not touched
here. `S35` renames a project whose year is filed.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S35 a project can be corrected, given a status, and put away — unless a year of it is filed  saved as GONE2/abandoned/1.03 Physical sciences/2026-11-30 from 2026-01-06; a status off the list UNKNOWN_STATUS; opening its year worked and filing it worked; with that year filed, renaming WENT THROUGH and setting the status still works; the delete FILED_YEAR and the project is still there; un-filing worked and the delete then went cleanly, 4 project(s) to 3
=== 1 CHECK(S) FAILED ===
```

## The Save button beside one row can put 25 hours in a day

`marker 626`

The edit door stops applying the hours rule the paste door applies, so the
figure goes straight at `numeric(5,2)` and 0068's CHECK — a raw constraint
error where a sentence belonged, and the one outcome block 610's own narrative
calls wrong. One rule, one place, both doors. `S33` edits a row to 25.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S33 the record can be corrected, except where a filed return rests on it  an hour changed to 4.50; inside a filed year — edit FILED_YEAR, delete FILED_YEAR, paper FILED_YEAR; a draft row redated into it FILED_YEAR, a draft paper redated into it FILED_YEAR; 25 hours through the edit door Failed query:  | new row for relation "sred_time" violates check constraint "sred_time_hours_check"; the first year filed yes, an hour ADDED to it afterwards went in and the paper says “1 hour record(s) in this year were written dow”, un-filed again yes; setting it up: hour written, paper written, filed yes, un-filed yes; the draft year still edits; after un-filing the delete went through and the row is gone
=== 1 CHECK(S) FAILED ===
```

## The same line twice in one paste goes in twice

`marker 627`

The batch is deduped against the table and not against itself, so two
identical rows in one block both insert — which is the exact case the rule
exists for, since nothing here can tell a genuine repeat of a day's work from
a double paste. `S32` pastes one line twice in one go.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S32 a batch goes in whole or not at all, and says which line stopped it  one unknown name: 0 added, 0 row(s) appeared, refused no active employee called "Nobody At All"; a clean batch: 2 added, 2 appeared; the same batch again: 0 added, already on file, to the word; the same line twice in ONE paste: 2 added, 2 appeared, line 2 NOT refused; paper: 1 added, 1 appeared
=== 1 CHECK(S) FAILED ===
```

## A piece of paper can be redated into a filed year

`marker 628`

The evidence door checks where the paper is and not where it is going, so a
draft year's photograph is moved into a filed return one date at a time. The
hours door has had both checks since it was written; this is its twin, and
until `S33` redated a paper nothing reached it.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S33 the record can be corrected, except where a filed return rests on it  an hour changed to 4.50; inside a filed year — edit FILED_YEAR, delete FILED_YEAR, paper FILED_YEAR; a draft row redated into it FILED_YEAR, a draft paper redated into it WENT IN; 25 hours through the edit door BAD_HOURS; the first year filed yes, an hour ADDED to it afterwards went in and the paper says “1 hour record(s) in this year were written dow”, un-filed again yes; setting it up: hour written, paper written, filed yes, un-filed yes; the draft year is REFUSED: FILED_YEAR; after un-filing the delete went through and the row is gone
=== 1 CHECK(S) FAILED ===
```

## Hours written down after the return went are not mentioned

`marker 629`

Adding time to a filed year stays allowed — the project record goes on being
kept — and the paper stops saying it happened. The figures do not move, which
is the trap: what moves is the DENOMINATOR of an allocation basis that says
"118 of 190 hours", and that sentence was frozen when the year was filed.
`S33` files a year, adds an hour to it, and reads the paper.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S33 the record can be corrected, except where a filed return rests on it  an hour changed to 4.50; inside a filed year — edit FILED_YEAR, delete FILED_YEAR, paper FILED_YEAR; a draft row redated into it FILED_YEAR, a draft paper redated into it FILED_YEAR; 25 hours through the edit door BAD_HOURS; the first year filed yes, an hour ADDED to it afterwards went in and the paper says “NOTHING about it”, un-filed again yes; setting it up: hour written, paper written, filed yes, un-filed yes; the draft year still edits; after un-filing the delete went through and the row is gone
=== 1 CHECK(S) FAILED ===
```

## Filing records the date on the return and not the moment

`marker 630`

`filed_at` stops being set, so nothing can tell a record written before the
filing from one written after it — `filed_on` is a business date and a year
filed today with a date next June makes every record look early. That is what
0073 exists for, and the only thing that reads it is the disclosure above.
`S33` reads the paper after adding an hour.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S33 the record can be corrected, except where a filed return rests on it  an hour changed to 4.50; inside a filed year — edit FILED_YEAR, delete FILED_YEAR, paper FILED_YEAR; a draft row redated into it FILED_YEAR, a draft paper redated into it FILED_YEAR; 25 hours through the edit door BAD_HOURS; the first year filed yes, an hour ADDED to it afterwards went in and the paper says “NOTHING about it”, un-filed again yes; setting it up: hour written, paper written, filed yes, un-filed yes; the draft year still edits; after un-filing the delete went through and the row is gone
=== 1 CHECK(S) FAILED ===
```

## The paste box is handed its own copy of the field names

`marker 631`

The screen stops passing the array the PARSER counts against and passes a
literal that happens to match today. The sentence on the box and the shape the
parser reads are then two things, and the next rename leaves the instructions
describing the old one — which is what the comment above the box used to claim
could not happen. `S34` reads the screen for the hand-off.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S34 every correction is reachable from a screen, and each form carries its own row  2 hour row(s): each carries its own id twice, and names no other row; 2 paper row(s): each carries its own id twice, and names no other row; the paste box prints “employeeName | onDate | hours | activity” and has its box, and the add forms have 1 of the 2 shared field lists; the project offers fieldOfScience, status, endedOn of fieldOfScience, status, endedOn and all 4 statuses
=== 1 CHECK(S) FAILED ===
```

## A table that does not add up is computed with anyway

`marker 632`

`vetted` stops refusing, so an edition whose CPP maximum disagrees with its
own rate and ceiling still runs a payroll. The figures it produces look
entirely ordinary — that is the whole difficulty with tax tables, and the
reason the arithmetic is checked before anything is computed rather than
after somebody notices. `PR52` hands it a bent edition.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR52 nothing is computed from a table that does not add up  a bent edition WENT THROUGH and the refusal does NOT name the figure; a second edition under an id already seen came back as itself
=== 1 CHECK(S) FAILED ===
```

## The bracket constants are no longer re-derived

`marker 633`

The tolerance on the K identity goes to a million dollars, so any constant
at all passes. K is what makes a bracket table work — a mistyped one is a
few hundred dollars a year on every stub in that bracket and nothing else
would catch it, because CRA is the only other source. `PR50` mistypes one.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR50 an edition that cannot be right is caught by the arithmetic, not by a paycheque  9 of 10 caught; MISSED a K constant off by a hundred
FAIL  PR60 an edition whose figures disagree, or that PDOC does not confirm, or that is out of order, is refused whole  a K constant off by one: NOT REFUSED (The PDOC example does not come out the same with t); the PDOC federal tax a cent out: refused; a start not after the last edition: refused; a figure that is not a number: refused; rows 1 → 1; with no fault: added
=== 2 CHECK(S) FAILED ===
```

## The CPP and EI maximums are taken on trust

`marker 634`

Same slackening, on the four figures that are products of two others: the
CPP maximum, its base half, the CPP2 maximum and the EI premium ceiling.
These are the numbers a year's update is most likely to half-apply — the
ceiling moves and the maximum does not. `PR50` moves one.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR50 an edition that cannot be right is caught by the arithmetic, not by a paycheque  8 of 10 caught; MISSED the CPP maximum not the rate times the base; the EI premium ceiling not the MIE times the rate
FAIL  PR52 nothing is computed from a table that does not add up  a bent edition BAD_TABLES and the refusal does NOT name the figure; a second edition under an id already seen came back as itself
=== 2 CHECK(S) FAILED ===
```

## A pay date takes the newest edition on file, whatever year it is for

`marker 635`

The clause that keeps an edition inside the pay date's own year goes, and the
search falls through to the last edition that starts before the date — so a
2027 pay date is computed with July 2026's tables. They are a real table,
correctly formed, so `vetted` passes them; every figure is wrong and every
stub looks normal, which is the one failure this module was built not to
have. `PR49` asks for a date one year past the last one covered.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR49 the tables are a list, chosen by pay date, and a year off the end is refused  30 June → 2026-01, 1 July → 2026-07; covering 2026, up to 2026-12-31; 2027 ACCEPTED and the refusal does NOT name that edge; the year's CPP/EI: 2026 given, 2027 NO_TABLES
FAIL  PR3 a pay date outside the tables is refused, saying so     it computed an answer with the wrong year's constants
FAIL  PR59 a new edition goes in through the form, and a pay date in it resolves to it  a March 2027 pay date before: 2026-07; the form said Added 2027-01. Its figures agree with each other and the PDOC example matched to the cent;; after: 2027-01; covered to 2027-12-31; the row kept its PDOC case yes; 1 audit row(s); listed as added by alicio@example.test
FAIL  PR62 an edition not loaded is refused, not guessed; only an added edition no stub names, and nothing later rests on, can be removed  unloaded: 2026-07; loaded: 2027-01; removing a built-in: 2026-07 is built into the app and cannot be removed here.; the January under a July: Removing 2027-01 would leave editions payroll cannot use (2027-07 is the first e; the July: Removed 2027-07. Payroll can now run up to 2027-12-31.; removing it while a stub names it: 1 pay stub was computed with 2027-01, so it stays. Its figures are what those stubs were worked out from.; once nothing does: Removed 2027-01. Payroll can now run up to 2026-12-31.; covered to 2026-12-31; 0 row(s) left
=== 4 CHECK(S) FAILED ===
```

## The BC credit stops being questioned when it does not add up

`marker 636`

The one identity CRA is not obliged to keep — the tax reduction's credit
being its phase-out span times its rate — stops being reported. It is a
question rather than a refusal on purpose, because the July 2026 edition
breaks it legitimately as a mid-year true-up; take the question away and the
next edition that breaks it by accident goes in silently. `PR51` bends the
credit and requires exactly one question and no refusal.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR51 every edition on file adds up, and what only CRA can settle is named  2 edition(s), 0 that cannot be right; 0 problem(s) with the list itself; 0 to confirm against the PDF; a credit that does not match its own phase-out gave 0 refusal(s) and 0 question(s)
FAIL  PR55 the confirmed July reduction is no longer queried, an unconfirmed or inherited one still is, and an edition is named for its year  2026-07: 0 query(ies), confirmed for 2026-07 by "T4127 123rd ed. (July 2026), BC Option 1…"; the same table unconfirmed: 0, spread into 2027-07: 0; a 2027 id on the 2026 table: 2027-01 is named for 2027 but starts on 2026-01-01
=== 2 CHECK(S) FAILED ===
```

## A document is taxed at today's rate, not its own day's

`marker 637`

The figures in force are chosen by the LAST entry rather than by the date
asked for, so every document is priced at whatever is newest on file. It
changes nothing until a rate moves — and the day one does, every invoice
entered late for an earlier period is out by the difference, on a document
that already went to somebody. `G31` puts a second, different set of
figures in front of the same call and asks for a date in each.

```
$ db:verify-tax | npm run db:verify-tax
FAIL  G30 the tax figures are dated both ways — in force from, and last read on  a 2001 date: rates ACCEPTED, commission ACCEPTED; 2013-03-31 ACCEPTED and 2013-04-01 itself is in force; 2 entr(ies), 0 without a source or a read date; a year later reads as 365 days, and 365 is the age the screen is told to colour at (nothing here renders it); the callers: has `pstCommission(collected, to)`, has `computeEnteredTax(p.typed, p.taxCode, inclusive, issuedOn, p.overrides)`
FAIL  G31 a back-dated document is taxed at the rate of its own day  on 2026-05-01: GST 9.00, PST 11.00, commission 500.00; with a 2099 entry in front of it, the same $100 on 2099-05-01: GST 9.00, PST 11.00, commission 500.00
=== 2 CHECK(S) FAILED ===
```

## A date before any figures on file is given the earliest anyway

`marker 638`

The refusal goes and the oldest entry is handed back instead. It reads as
harmless — the oldest is probably right for an old date — and it is the same
shape as computing 2027 payroll with 2026's tables: a real set of figures for
a period nobody entered them for. `G30` asks for a date in 2001.

```
$ db:verify-tax | npm run db:verify-tax
FAIL  G30 the tax figures are dated both ways — in force from, and last read on  a 2001 date: rates ACCEPTED, commission ACCEPTED; 2013-03-31 ACCEPTED and 2013-04-01 itself is in force; 2 entr(ies), 0 without a source or a read date; a year later reads as 365 days, and 365 is the age the screen is told to colour at (nothing here renders it); the callers: has `pstCommission(collected, to)`, has `computeEnteredTax(p.typed, p.taxCode, inclusive, issuedOn, p.overrides)`
=== 1 CHECK(S) FAILED ===
```

## The PST commission is worked out on the wrong end of the period

`marker 639`

Box C is taken from the scale in force at the START of the period rather
than its end. Today the two are the same and nothing moves; the day BC
changes the scale mid-period, a return is worked out on the scale it was not
under, and box C is money owed. `G30` reads the caller — and says plainly
that reading it is all a single scale on file allows.

```
$ db:verify-tax | npm run db:verify-tax
FAIL  G30 the tax figures are dated both ways — in force from, and last read on  a 2001 date: rates NO_FIGURES, commission NO_FIGURES; 2013-03-31 NO_FIGURES and 2013-04-01 itself is in force; 2 entr(ies), 0 without a source or a read date; a year later reads as 365 days, and 365 is the age the screen is told to colour at (nothing here renders it); the callers: NO LONGER has `pstCommission(collected, to)`, has `computeEnteredTax(p.typed, p.taxCode, inclusive, issuedOn, p.overrides)`
=== 1 CHECK(S) FAILED ===
```

## An invoice is taxed at the oldest rate on file

`marker 640`

`resolveTaggedLines` stops passing the issue date and pins the epoch, so
every invoice is priced on the first entry whatever its own date. Same class
as 637, one caller along, and the one a person actually meets: entering last
month's paperwork is the ordinary case. `G30` reads the caller; the
arithmetic itself is `G31`.

```
$ db:verify-tax | npm run db:verify-tax
FAIL  G30 the tax figures are dated both ways — in force from, and last read on  a 2001 date: rates NO_FIGURES, commission NO_FIGURES; 2013-03-31 NO_FIGURES and 2013-04-01 itself is in force; 2 entr(ies), 0 without a source or a read date; a year later reads as 365 days, and 365 is the age the screen is told to colour at (nothing here renders it); the callers: has `pstCommission(collected, to)`, NO LONGER has `computeEnteredTax(p.typed, p.taxCode, inclusive, issuedOn, p.overrides)`
=== 1 CHECK(S) FAILED ===
```

## A rate can be filed under a jurisdiction nobody prices

`marker 641`

The door stops checking, so `Mars` reaches 0068's CHECK and comes back as
a constraint error rather than a sentence. Worse, a typo like `Federal`
would be refused by the database with no hint that the list is two words
long. `S36` sends one that is not on the list.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S36 a rate can be put in, corrected and taken away, and each row edits itself  11 rate(s) to start; adding worked and it landed as sent; refusals: a jurisdiction nobody prices Failed query:  | new row for relation "sred_rate" violates check constraint "sred_rate_jurisdiction_check" (wanted BAD_JURISDICTION), a confidence off the list BAD_CONFIDENCE, no name NO_NAME, no authority NO_AUTHORITY, a value that is not a number BAD_VALUE, an end before the start BACKWARDS, no start at all NO_DATE, a delete with no row named NO_ROW; correcting worked to 0.43; deleting worked, back to 11; with a year filed (yes), a rate that year's paper is built from: editing FILED_YEAR, deleting FILED_YEAR, while a new row from a later day went in and un-filing worked; the screen gives each row its own id twice and shows concise consequences only when editing
=== 1 CHECK(S) FAILED ===
```

## A rate can go in with no authority

`marker 642`

0068's own words: a rate with no authority is a rate somebody remembered.
The column is NOT NULL so an empty string satisfies it, and the working
paper then prints a percentage citing nothing. `S36` sends a blank one.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S36 a rate can be put in, corrected and taken away, and each row edits itself  11 rate(s) to start; adding worked and it landed as sent; refusals: a jurisdiction nobody prices BAD_JURISDICTION, a confidence off the list BAD_CONFIDENCE, no name NO_NAME, no authority ALLOWED (wanted NO_AUTHORITY), a value that is not a number BAD_VALUE, an end before the start BACKWARDS, no start at all NO_DATE, a delete with no row named NO_ROW; correcting worked to 0.43; deleting worked, back to 12; with a year filed (yes), a rate that year's paper is built from: editing FILED_YEAR, deleting FILED_YEAR, while a new row from a later day went in and un-filing worked; the screen gives each row its own id twice and shows concise consequences only when editing
=== 1 CHECK(S) FAILED ===
```

## Every rate row's Save edits the first rate

`marker 643`

The id written once per row and used by both its forms stops being written
at all, so each form posts with no `rateId` — which the door reads as
"add a new one". Pressing Save on the 35% line would leave that line
untouched and add a twelfth rate beside it. `S36` renders two rows and
counts each row's own id.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S36 a rate can be put in, corrected and taken away, and each row edits itself  11 rate(s) to start; adding worked and it landed as sent; refusals: a jurisdiction nobody prices BAD_JURISDICTION, a confidence off the list BAD_CONFIDENCE, no name NO_NAME, no authority NO_AUTHORITY, a value that is not a number BAD_VALUE, an end before the start BACKWARDS, no start at all NO_DATE, a delete with no row named NO_ROW; correcting worked to 0.43; deleting worked, back to 11; with a year filed (yes), a rate that year's paper is built from: editing FILED_YEAR, deleting FILED_YEAR, while a new row from a later day went in and un-filing worked; the screen does NOT and shows concise consequences only when editing
=== 1 CHECK(S) FAILED ===
```

## A rate a filed return was worked out with can be rewritten or deleted

`marker 644`

The fence goes. Editing one moves a filed year's figures underneath a return
that has already gone; DELETING one is worse than that — the working paper
reads the rates live, so `rateOf` throws and the year stops opening at all.
The rest of this module refuses both and says so in prose above these very
doors; the first version of them refused neither. `S36` files a year and
then reaches for a rate that year's paper is built from.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S36 a rate can be put in, corrected and taken away, and each row edits itself  11 rate(s) to start; adding worked and it landed as sent; refusals: a jurisdiction nobody prices BAD_JURISDICTION, a confidence off the list BAD_CONFIDENCE, no name NO_NAME, no authority NO_AUTHORITY, a value that is not a number BAD_VALUE, an end before the start BACKWARDS, no start at all NO_DATE, a delete with no row named NO_ROW; correcting worked to 0.43; deleting worked, back to 11; with a year filed (yes), a rate that year's paper is built from: editing WENT THROUGH, deleting WENT THROUGH, while a new row from a later day went in and un-filing worked; the screen gives each row its own id twice and shows concise consequences only when editing
FAIL  S39 the working paper reads a year's tables added in the app itself, and caps salary at five times that YMPE  the 2027 claim with no 2027 tables: NO_YMPE; with an edition added and the process cold: NO_RATE; the cap: —
=== 2 CHECK(S) FAILED ===
```

## The rename takes away the backups already on disk

`marker 645`

The picker stops offering the old name, so every `.figtree` file made
before the rename is greyed out in the dialog — invisible, on the one screen
whose whole job is to get a company back. The button still says the right
thing and the code still reads both, which is exactly how this went wrong
once before: the bill reader said it took PDFs in its code, its help text,
its doc and its changelog while its own `accept` filtered them out.
`BK19` reads the rendered control.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK19 a backup is saved as .fig, old files remain visible, and the owner gets web restore  the button offers ACME.fig; the picker accepts .fig — THE OLD NAME IS GONE; owner restore true
=== 1 CHECK(S) FAILED ===
```

## A backup is written under the old name again

`marker 646`

The file a person downloads goes back to `.figtree` while every sentence
around it says `.fig`. Nothing breaks — the reader takes both — which is
what makes it worth a block: the only symptom is a name, and a name is what
somebody looks for a year later. `BK19` reads the button.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK19 a backup is saved as .fig, old files remain visible, and the owner gets web restore  the button offers ACME.figtree; the picker accepts .fig,.figtree; owner restore true
=== 1 CHECK(S) FAILED ===
```

## The desk shows a different mark from the browser tab

`marker 647`

The tab uses the fig but the desk brand falls back to scaffold art.
`P39` requires both to use the same shipped icon.

```
$ db:verify-periods | npm run db:verify-periods
FAIL  P39 the tab wears our own mark, and the browser is allowed to fetch it  icon.png is 512×512, 228056 bytes; brand copy matches, desk false, no duplicate rail mark true; no scaffold art left; the gate skips /icon.png, skips /figtree-icon.png, skips /favicon.ico, skips /_next/static/x.js, runs on /login, runs on /ledger/abc/entries
=== 1 CHECK(S) FAILED ===
```

## The sidebar repeats the desk brand above the company

`marker 648`

A second brand row returns above the company selector, using vertical space
and repeating the tab bar. `P39` checks that the rail has no brand block.

```
$ db:verify-periods | npm run db:verify-periods
FAIL  P39 the tab wears our own mark, and the browser is allowed to fetch it  icon.png is 512×512, 228056 bytes; brand copy matches, desk true, no duplicate rail mark false; no scaffold art left; the gate skips /icon.png, skips /figtree-icon.png, skips /favicon.ico, skips /_next/static/x.js, runs on /login, runs on /ledger/abc/entries
=== 1 CHECK(S) FAILED ===
```

## A quarter is one month

`marker 649`

`groupPeriods` cuts the span into groups of one whatever was asked, so
"by quarter" is by month with the wrong word over it. `T41` counts four.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T41 a year is cut into twelve months or four quarters, edge to edge  12 monthly column(s) “2027-01” … “2027-12”; 12 quarterly, the first 1 month(s) from 2027-01-01, the last ending 2027-04-30; one month asked for columns: 0 and “The span is one fiscal month, so there is nothing to break it into.”
FAIL  T43 five months by quarter is three and two, and the short one says so  5 column(s): 2027-01 (1), 2027-02 (1), 2027-03 (1), 2027-04 (1), 2027-05 (1); 0 of 12 detail line(s) do not add up to the total
=== 2 CHECK(S) FAILED ===
```

## A group of three months is named after its first

`marker 650`

The heading over a quarter column says 2026-01, which is a month, and the
reader takes a quarter's figure for a month's. `T43` reads the short last
group's heading for the dash between its ends.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T43 five months by quarter is three and two, and the short one says so  2 column(s): 2027-01 (3), 2027-04 (2); 0 of 12 detail line(s) do not add up to the total
=== 1 CHECK(S) FAILED ===
```

## A balance sheet's last column is called Total

`marker 651`

The word invites the reader to add the columns, and on a balance sheet the
columns are balances at twelve dates — adding them is nonsense with a label
telling you to do it. `T42` asks the balance sheet for Closing.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T42 the columns add up on a flow statement and end on a position one  profit and loss: “Total”, totalIsSum true, 12 detail line(s), 0 that do not add up; balance sheet: “Total”, totalIsSum false, 38 position line(s) (current earnings included), 0 whose last column is not the closing figure, and summing them gives something else, as it should
=== 1 CHECK(S) FAILED ===
```

## Every statement claims its columns add up

`marker 652`

`totalIsSum` is true for the balance sheet too, so the screen and the
export stop saying the columns are not to be added. `T42` holds it false
on the position statement.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T42 the columns add up on a flow statement and end on a position one  profit and loss: “Total”, totalIsSum true, 12 detail line(s), 0 that do not add up; balance sheet: “Closing”, totalIsSum true, 38 position line(s) (current earnings included), 0 whose last column is not the closing figure, and summing them gives something else, as it should
=== 1 CHECK(S) FAILED ===
```

## One month is cut into one column and a total of the same figure

`marker 653`

The refusal on a single fiscal month is lifted, and the page shows the
month and then the month again under Total. `T41` asks a one-month span
for columns and expects none, with the sentence that says why.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T41 a year is cut into twelve months or four quarters, edge to edge  12 monthly column(s) “2027-01” … “2027-12”; 4 quarterly, the first 3 month(s) from 2027-01-01, the last ending 2027-12-31; one month asked for columns: 1 and “no reason given”
=== 1 CHECK(S) FAILED ===
```

## The export runs the comparison under a breakdown

`marker 654`

The comparison is rendered whatever was asked, and since the export lays
out whichever of the two came back first, a file asked for by month leaves
with the comparison's columns — three figures, none of them a month. `X47`
counts twelve month headings; `X49` asks for both and counts four figures.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X47 a year by month leaves as a turned sheet with twelve columns and a total  0 month heading(s) and no TOTAL; “Profit for the period” is followed by 1 figure(s); page box 0 0 612 792 for thirteen columns, 0 0 612 792 for four; one month by month: 1 figure(s) after the total line, 0 TOTAL/CLOSING heading(s), and it says why
FAIL  X48 a turned balance sheet breaks pages against its own shorter edge and says why the columns do not add  2 page(s) boxed 0 0 612 792; the lowest table line sits 90.9pt above the bottom edge, against a 72pt margin; last column NOT called closing; the note is on the sheet
FAIL  X49 the workbook carries the quarters and their total as numbers, turns when wide, and a breakdown beats a comparison  header (none); 0 row(s) whose total is the sum of four, 0 not; orientation by quarter/by month portrait/portrait; asked for both, the total line is followed by 1 figure(s)
=== 3 CHECK(S) FAILED ===
```

## Thirteen columns on an upright sheet

`marker 655`

The sheet turns only past thirteen money columns, which a year by month
does not reach, so twelve months and a total are set across 504 points.
`X47` reads the page box of the wide file.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X47 a year by month leaves as a turned sheet with twelve columns and a total  12 month heading(s) and TOTAL; “Profit for the period” is followed by 13 figure(s), the twelve summing to 4,860.00 against a thirteenth of 4,860.00 and the render's 4,860.00; page box 0 0 612 792 for thirteen columns, 0 0 612 792 for four; one month by month: 1 figure(s) after the total line, 0 TOTAL/CLOSING heading(s), and it says why
FAIL  X48 a turned balance sheet breaks pages against its own shorter edge and says why the columns do not add  2 page(s) boxed 0 0 612 792; the lowest table line sits 90.2pt above the bottom edge, against a 72pt margin; last column CLOSING; the note is on the sheet
FAIL  X49 the workbook carries the quarters and their total as numbers, turns when wide, and a breakdown beats a comparison  header 2026-01 – 2026-03 | 2026-04 – 2026-06 | 2026-07 – 2026-09 | 2026-10 – 2026-12 | Total; 15 row(s) whose total is the sum of four, 0 not; orientation by quarter/by month portrait/portrait; asked for both, the total line is followed by 4 figure(s)
=== 3 CHECK(S) FAILED ===
```

## The note about balances goes on the wrong statement

`marker 656`

The sentence that the columns are balances and are not to be added is
printed under the profit and loss, whose columns do add, and left off the
balance sheet, whose columns do not. `X48` reads the balance sheet for it.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X48 a turned balance sheet breaks pages against its own shorter edge and says why the columns do not add  3 page(s) boxed 0 0 792 612; the lowest table line sits 94.8pt above the bottom edge, against a 72pt margin; last column CLOSING; the note is MISSING
=== 1 CHECK(S) FAILED ===
```

## A turned sheet is laid out against the upright one's edges

`marker 657`

The page box turns and the layout does not: rows are placed against a
bottom 720 points down on a sheet 612 points tall, and the last hundred
points of every page are drawn below the paper. Nothing reports it — the
writer does not know where the paper ends. `X48` reads where the lowest
line of the table was drawn.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X48 a turned balance sheet breaks pages against its own shorter edge and says why the columns do not add  33 page(s) boxed 0 0 792 612; the lowest table line sits -81.7pt above the bottom edge, against a 72pt margin; last column CLOSING; the note is on the sheet
=== 1 CHECK(S) FAILED ===
```

## The sheet is told to turn and does not

`marker 658`

`landscape` reaches the builder and the document is still opened upright,
so the wide layout is drawn on the narrow page and the right-hand columns
fall off it. `X47` reads the page box.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X47 a year by month leaves as a turned sheet with twelve columns and a total  12 month heading(s) and TOTAL; “Profit for the period” is followed by 13 figure(s), the twelve summing to 4,860.00 against a thirteenth of 4,860.00 and the render's 4,860.00; page box 0 0 612 792 for thirteen columns, 0 0 612 792 for four; one month by month: 1 figure(s) after the total line, 0 TOTAL/CLOSING heading(s), and it says why
FAIL  X48 a turned balance sheet breaks pages against its own shorter edge and says why the columns do not add  3 page(s) boxed 0 0 612 792; the lowest table line sits 274.8pt above the bottom edge, against a 72pt margin; last column CLOSING; the note is on the sheet
=== 2 CHECK(S) FAILED ===
```

## The workbook prints upright whatever its width

`marker 659`

The sheet's page setup ignores `landscape`, and a year by month prints
thirteen columns squeezed onto a portrait page. `X49` reads the setup of
both workbooks.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X49 the workbook carries the quarters and their total as numbers, turns when wide, and a breakdown beats a comparison  header 2026-01 – 2026-03 | 2026-04 – 2026-06 | 2026-07 – 2026-09 | 2026-10 – 2026-12 | Total; 15 row(s) whose total is the sum of four, 0 not; orientation by quarter/by month portrait/portrait; asked for both, the total line is followed by 4 figure(s)
=== 1 CHECK(S) FAILED ===
```

## A figure wider than its column is broken across two lines

`marker 660`

Money cells go back to being drawn with a width, and PDFKit — which wraps
anything given a width, by character once a word is too long — turns
-1,234,567.89 in a thirty-eight point column into two figures, neither of
them the amount. `X50` counts the wide figures drawn whole.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X50 a figure is never broken across lines, and a heading that wraps pushes the rows down  0 of 13 wide figures drawn whole at ?pt; the last heading is CLOSING, whole; a quarter heading drawn as “2026-01 –” 676.0pt up over “2026-03” at 667.7, and the row 13.4pt under that
=== 1 CHECK(S) FAILED ===
```

## A heading that wrapped is given one line's height

`marker 661`

The header row is twelve points tall however many lines its headings
took, so the first row of figures is drawn through the second line of
"2026-01 – 2026-03". `X50` measures the gap between that line and the
row.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X50 a figure is never broken across lines, and a heading that wraps pushes the rows down  13 of 13 wide figures drawn whole at 7pt; the last heading is CLOSING, whole; a quarter heading drawn as “2026-01 –” 676.0pt up over “2026-03” at 667.7, and the row 4.7pt under that
=== 1 CHECK(S) FAILED ===
```

## A fourteen-column table is set at the ordinary size

`marker 662`

The step down never happens, and a seven-figure amount at 8.5pt is fifty-two
points wide in a column of thirty-five (the gutters stay at ten) — drawn
whole, and lying across the figure to its left. `X50` reads the size the
wide figures were set in.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X48 a turned balance sheet breaks pages against its own shorter edge and says why the columns do not add  3 page(s) boxed 0 0 792 612; the lowest table line sits 84.4pt above the bottom edge, against a 72pt margin; last column NOT called closing; the note is on the sheet
FAIL  X50 a figure is never broken across lines, and a heading that wraps pushes the rows down  13 of 13 wide figures drawn whole at 8.5pt; the last heading is NOT drawn whole; a quarter heading drawn as “2026-01 –” 676.0pt up over “2026-03” at 667.7, and the row 13.4pt under that
=== 2 CHECK(S) FAILED ===
```

## The tab's icon is sent to the login page

`marker 663`

The gate's matcher stops excluding `icon.png`, and every request for the
mark is redirected to sign in — the tab sits blank, on the login page too,
which is the first thing anybody sees. This is the defect the owner reported
as 「网页没有正常运行」. `P39` compiles the matcher and runs it on that path.

```
$ db:verify-periods | npm run db:verify-periods
FAIL  P39 the tab wears our own mark, and the browser is allowed to fetch it  icon.png is 512×512, 228056 bytes; brand copy matches, desk true, no duplicate rail mark true; no scaffold art left; the gate runs on /icon.png, skips /figtree-icon.png, skips /favicon.ico, skips /_next/static/x.js, runs on /login, runs on /ledger/abc/entries
=== 1 CHECK(S) FAILED ===
```

## Another company's account reads as ours

`marker 664`

`belongsToLedger('account', …)` — which `ours('account', …)` answers from — joins
the ledger and never compares it, so any account whose company has any ledger
passes. The Accounts seat on company A renames and retags B's chart again.
`A30` posts B's account under A's ledger at both doors.

```
$ db:verify-accounts | npm run db:verify-accounts
FAIL  A30 renaming or retagging another company's account under this ledger is refused before anything happens  rename went through; retag went through
FAIL  A47 an account is deactivated and reactivated, and deleted only while nothing uses it  cash: IN_USE: 1000 Cash — Operating is used — 1 journal line — so it stays. Deactivate; parent: IN_USE: 6990 Grouping is used — 1 sub-account — so it stays.; typo: ok (0 left); deactivate ok → active false, reactivate ok → true; theirs: ok; trail delete_account, deactivate_account, reactivate_account
=== 2 CHECK(S) FAILED ===
```

## The delete door stops asking whose entry it is

`marker 665`

`deleteEntry` takes the ledger and ignores it. `D41` deletes B's posted entry under A's ledger and finds it gone.

```
$ db:verify-drafts | npm run db:verify-drafts
FAIL  D41 editing, deleting, reversing, amending or discarding another company's entry under this ledger is refused before anything happens  delete went through
=== 1 CHECK(S) FAILED ===
```

## The invoice delete door stops asking whose invoice it is

`marker 666`

`deleteInvoiceFromForm` no longer judges the invoice id against the ledger the form came from. `V120` deletes B's draft invoice under A's ledger.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V120 deleting, posting or editing another company's invoice under this ledger is refused before anything happens  delete: Deleted. The number stays retired; the audit log keeps the document.
=== 1 CHECK(S) FAILED ===
```

## Unapply stops asking whose application it is

`marker 667`

`unapplyFromForm` releases any application id it is handed. `PM44` unapplies B's payment under A's ledger.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM44 paying, applying, unapplying or deleting a payment on another company's invoice under this ledger is refused before anything happens  unapply: Unapplied. The balance is back.
=== 1 CHECK(S) FAILED ===
```

## Renaming a party stops asking whose party it is

`marker 668`

`updatePartyFromForm` renames any party id it is handed — a supplier only Beta deals with, from Alpha's screen. `P55` posts exactly that.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P55 touching a party only another company deals with, under this ledger, is refused before anything happens  rename: Saved.
=== 1 CHECK(S) FAILED ===
```

## Ceasing a director stops asking whose directorship it is

`marker 669`

`ceaseDirectorFromForm` ends any directorship id it is handed. `CR37` ends B's director's term under A's ledger.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR37 the id doors refuse another company's entity or directorship; the rows door enters only here and says whom it used from elsewhere  cease their director: Ceased — the row keeps its dates — dated 2026-01-31.; the rows door said Entered 1 share movement. Found on another company's list and used here: Their Director (n; movements landed: 1 here, 0 theirs; their director CEASED 2026-01-31, 1 term(s) of theirs; the use of their party is said
=== 1 CHECK(S) FAILED ===
```

## Ceasing a tax registration stops asking whose it is

`marker 670`

`ceaseTaxFromForm` ends any registration id it is handed. `R63` ends B's GST registration under A's ledger.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R63 registering, ceasing, correcting or deleting a tax for another company under this ledger is refused before anything happens  cease theirs: Registration 987654321RT0001 ends 2026-06-30. The accounts stay.
=== 1 CHECK(S) FAILED ===
```

## Another company's SR&ED project reads as ours

`marker 671`

`ours('sred_project', …)` joins the ledger and never compares it. `S37` asks the predicate about B's project under A's ledger.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S37 another company's project, claim, time, evidence or allocation under this ledger is not ours, and every SR&ED door asks  their project reads as ours; our project reads as theirs; sredAction asks refuseUnlessOurs of the form's ids; all seven id fields listed, and the allocation source by its kind
=== 1 CHECK(S) FAILED ===
```

## A stored file is shown as whatever type its uploader said

`marker 672`

`fileResponse` echoes the stored type again, so a receipt.pdf sent as text/html is served as HTML on this origin. `AT14` replays exactly that file.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT14 a file stored as HTML is shown as bytes with nosniff, a PDF as a PDF  text/html -> text/html (nosniff); application/pdf -> application/pdf (nosniff), inline
=== 1 CHECK(S) FAILED ===
```

## The browser is left to guess a stored file's type

`marker 673`

The nosniff header goes, and a browser that disagrees with application/octet-stream may render the bytes as it sees fit. `AT14` reads the header.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT14 a file stored as HTML is shown as bytes with nosniff, a PDF as a PDF  text/html -> application/octet-stream (no nosniff); application/pdf -> application/pdf (no nosniff), inline
=== 1 CHECK(S) FAILED ===
```

## The SR&ED doors stop asking

`marker 674`

`sredAction` no longer asks `refuseUnlessOurs` about the ids on the form; sixteen doors are open to another company's project, claim, time, evidence and allocation ids at once. `S37` reads the door for the question.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S37 another company's project, claim, time, evidence or allocation under this ledger is not ours, and every SR&ED door asks  the predicate tells the two companies apart both ways; sredAction DOES NOT ASK about the form's ids; all seven id fields listed, and the allocation source by its kind
=== 1 CHECK(S) FAILED ===
```

## The allocation's source is not asked about

`marker 675`

`sredAction` still asks about the seven id fields but stops judging the
allocation's source — a pay stub or a journal line of any company can be
claimed. `S37` reads the door for that one question and asks the predicate
about a pay stub both ways.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S37 another company's project, claim, time, evidence or allocation under this ledger is not ours, and every SR&ED door asks  the predicate tells the two companies apart both ways; sredAction asks refuseUnlessOurs of the form's ids; all seven id fields listed, but NOT the allocation source
=== 1 CHECK(S) FAILED ===
```

## A New Year's Day pay run inherits the whole old year

`marker 676`

The year to date takes its year from the day before its bound again. A T4
still gets its year; a pay run dated 1 January gets the year before, every
ceiling already met, and withholds no CPP and no EI. `PR54` asks the same
bound the two ways.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR54 the year to date is the year the caller names, not the year before its bound  1 January 2027 asked as a pay run: 6 period(s); asked as 2026's T4: 6
=== 1 CHECK(S) FAILED ===
```

## A next year's table inherits this year's confirmation

`marker 677`

The checker honours any `confirmed` at all rather than one naming the
edition in hand, so a 2027 table built by spreading the 2026 one is never
asked about its own numbers. `PR55` spreads the July table into 2027-07 and
expects the query back.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR55 the confirmed July reduction is no longer queried, an unconfirmed or inherited one still is, and an edition is named for its year  2026-07: 0 query(ies), confirmed for 2026-07 by "T4127 123rd ed. (July 2026), BC Option 1…"; the same table unconfirmed: 1, spread into 2027-07: 0; a 2027 id on the 2026 table: 2027-01 is named for 2027 but starts on 2026-01-01
=== 1 CHECK(S) FAILED ===
```

## An edition may be named for a year it does not start in

`marker 678`

The id's year is no longer held to the start date's year: a 2027 id on
the 2026 table sits on the payroll page claiming a year it does not cover.
`PR55` names an edition wrongly and expects the refusal.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR55 the confirmed July reduction is no longer queried, an unconfirmed or inherited one still is, and an edition is named for its year  2026-07: 0 query(ies), confirmed for 2026-07 by "T4127 123rd ed. (July 2026), BC Option 1…"; the same table unconfirmed: 1, spread into 2027-07: 1; a 2027 id on the 2026 table: not refused
=== 1 CHECK(S) FAILED ===
```

## An owner marked not insurable is charged EI anyway

`marker 679`

The run stops zeroing insurable earnings for an EI-exempt person, so the
engine withholds EI from an owner the law says is not in insurable
employment, and remits the employer's share on top. `PR56` reads the
owner's stub.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR56 an exempt person is exempt on the stub, in the run, and on the T4's box 28 — for a whole year only  owner: EI 65.20 (employer 91.28), insurable 4,000.00, CPP 229.32; senior: CPP 0.00 + 0.00, pensionable 0.00, EI 65.20; box 28: owner "—", senior "CPP", Dana "—", flagged mid-year "—" (says entire period), flagged and never paid "—" (empty slip, says no pay); Dana's reason is about her; a typed insurable figure for the owner: EXEMPT, a typed pensionable figure for the senior: EXEMPT
=== 1 CHECK(S) FAILED ===
```

## Box 28 is blank for the exempt

`marker 680`

The T4 stops marking box 28, so an exempt person's slip shows nought in
box 18 or 16 with nothing to say why — the shape CRA queries. `PR56`
reads box 28 for both exempt people.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR56 an exempt person is exempt on the stub, in the run, and on the T4's box 28 — for a whole year only  owner: EI 0.00 (employer 0.00), insurable 0.00, CPP 229.32; senior: CPP 0.00 + 0.00, pensionable 0.00, EI 65.20; box 28: owner "—", senior "—", Dana "—", flagged mid-year "—" (says entire period), flagged and never paid "—" (empty slip, says no pay); Dana's reason is about her; a typed insurable figure for the owner: EXEMPT, a typed pensionable figure for the senior: EXEMPT
=== 1 CHECK(S) FAILED ===
```

## Every period is said to have had hours

`marker 681`

The ROE summary counts every period in the span as one whose hours were
entered, so Block 15A over twenty-seven periods with hours on three reads as
twenty-seven periods of hours and the page says nothing. `PR57` builds a
two-period ROE with hours on one.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR57 an ROE whose hours were entered on some periods only says on how many  2 of 2 period(s) had hours; 15A total 4000
=== 1 CHECK(S) FAILED ===
```

## A confirmed figure is queried anyway

`marker 682`

The checker stops honouring `confirmed` altogether and asks about the July
reduction again, so the payroll page carries a warning about a number that
was read against T4127 and found right. `PR55` expects no query on the
confirmed edition.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR55 the confirmed July reduction is no longer queried, an unconfirmed or inherited one still is, and an edition is named for its year  2026-07: 1 query(ies), confirmed for 2026-07 by "T4127 123rd ed. (July 2026), BC Option 1…"; the same table unconfirmed: 1, spread into 2027-07: 1; a 2027 id on the 2026 table: 2027-01 is named for 2027 but starts on 2026-01-01
=== 1 CHECK(S) FAILED ===
```

## Box 28 is marked from today's flag

`marker 683`

The T4 marks box 28 from the exemption as it stands on the payroll record,
not from the year's stubs, so a person flagged in October after nine pays
had EI withheld gets a slip that says exempt beside a box 18 that says
otherwise — the shape CRA queries. `PR56` pays Lee Latecomer first and
flags him second.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR56 an exempt person is exempt on the stub, in the run, and on the T4's box 28 — for a whole year only  owner: EI 0.00 (employer 0.00), insurable 0.00, CPP 229.32; senior: CPP 0.00 + 0.00, pensionable 0.00, EI 65.20; box 28: owner "EI", senior "CPP", Dana "—", flagged mid-year "EI" (says entire period), flagged and never paid "EI" (empty slip, says no pay); Dana's reason is about her; a typed insurable figure for the owner: EXEMPT, a typed pensionable figure for the senior: EXEMPT
=== 1 CHECK(S) FAILED ===
```

## A typed insurable figure for an exempt person is quietly replaced

`marker 684`

The run stops refusing an insurable figure typed for a person the record
says is not insurable, and silently carries nought instead — the person
typing it is never told their figure went nowhere. `PR56` types one for
the owner and expects the EXEMPT refusal.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR56 an exempt person is exempt on the stub, in the run, and on the T4's box 28 — for a whole year only  owner: EI 0.00 (employer 0.00), insurable 0.00, CPP 229.32; senior: CPP 0.00 + 0.00, pensionable 0.00, EI 65.20; box 28: owner "EI", senior "CPP", Dana "—", flagged mid-year "—" (says entire period), flagged and never paid "—" (empty slip, says no pay); Dana's reason is about her; a typed insurable figure for the owner: accepted, a typed pensionable figure for the senior: EXEMPT
=== 1 CHECK(S) FAILED ===
```

## A person never paid this year is told contributions were withheld

`marker 685`

The slip for a flagged person with no pay in the year takes the same reason
as one flagged after a withheld pay, so it says contributions were withheld
when nothing was. `PR56` flags Nia Nopay and never pays her.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR56 an exempt person is exempt on the stub, in the run, and on the T4's box 28 — for a whole year only  owner: EI 0.00 (employer 0.00), insurable 0.00, CPP 229.32; senior: CPP 0.00 + 0.00, pensionable 0.00, EI 65.20; box 28: owner "EI", senior "CPP", Dana "—", flagged mid-year "—" (says entire period), flagged and never paid "—" (empty slip, no reason); Dana's reason is about her; a typed insurable figure for the owner: EXEMPT, a typed pensionable figure for the senior: EXEMPT
=== 1 CHECK(S) FAILED ===
```

## The restore check's fingerprint skips payroll, SR&ED, attachments and registers

`marker 686`

The fingerprint leaves out every table whose name says payroll, SR&ED,
attachment, share or minute book — the old eleven-figure shape, in effect —
so a backup that brings none of them back compares equal. `BK20` asks that
every catalogue table is a figure and names those five by name.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK20 the restore check fingerprints every table in the database, and the money  173 figures over 184 tables — FORGOTTEN: attachment, attachment_blob, minute_book_attachment, minute_book_entry, pay_run, pay_stub, share_class, share_transaction, sred_account_category, sred_allocation, sred_claim, sred_evidence, sred_project, sred_rate, sred_time; not asked: pay_stub, sred_claim, sred_time, attachment_blob, share_transaction, minute_book_entry; one changed count reads back as "nothing"
=== 1 CHECK(S) FAILED ===
```

## A backup without its attachments shows the calm grey line

`marker 687`

The banner stops reading the attachments note backup.sh writes when the
schedule cannot reach the store, so receipts nobody copied sit under
'Backed up 3 hours ago'. `backup:states` hands it a record saying
ATTACHMENTS NOT BACKED UP and expects partial.

```
$ backup:states | npm run backup:states
FAIL  attachments not backed up                       -> ok, expected partial; line "Restore-checked today (erp_dev-x.dump)."
=== 1 STATE(S) WRONG ===
```

## A restore check that condemned the backup is shown as fine

`marker 688`

The banner no longer fails closed on a restore check that found the newest
dump does not come back as the books, so the schedule's green record stands
over a backup the check said cannot be trusted. `backup:states` writes such
a check record and expects failed.

```
$ backup:states | npm run backup:states
FAIL  the check found the backup wrong                -> ok, expected failed; note "The restore check today failed in its ow…"; message "Complete backup less than an hour ago.…" should match /CANNOT BE TRUSTED: R3 the restored database/
=== 1 STATE(S) WRONG ===
```

## A restore check is never overdue

`marker 689`

The banner's threshold for nagging about the restore check is a thousand
times too far away, so a check last run forty days ago says nothing, and the
habit the RISKS file admits is the only defence has nothing reminding anyone.
`backup:states` expects the note at forty days.

```
$ backup:states | npm run backup:states
FAIL  restore-checked 40 days ago                     -> ok, expected ok; line "Restore-checked 40 days ago (erp_dev-x.dump)."; expected note /over 35 days/; expected line none
=== 1 STATE(S) WRONG ===
```

## Never having restore-checked is not mentioned

`marker 690`

With no record of any restore check the banner says nothing, which is the
state every fresh installation is in and the one the note exists for.
`backup:states` removes the check record and expects the note.

```
$ backup:states | npm run backup:states
FAIL  never restore-checked                           -> ok, expected ok; no note, no line; expected note /No backup has ever been restore-checked/
=== 1 STATE(S) WRONG ===
```

## PG_BIN is ignored

`marker 691`

The resolver skips the directory it was told and goes straight to guessing,
so a machine whose tools are somewhere unusual cannot say so and every
backup, restore check and reset fails with 'not found' — or worse, finds an
older PostgreSQL first. `BK21` tells it a path and expects that path back.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK21 the PostgreSQL tools and the backup directory are resolved, not spelled out  PG_BIN told: /opt/homebrew/opt/postgresql@17/bin/pg_dump; found here: /opt/homebrew/opt/postgresql@17/bin; dir on a Mac …n/Library/Application Support/erp-backup, on Linux /data/erp-backup / …in/.local/share/erp-backup, told /mnt/x
=== 1 CHECK(S) FAILED ===
```

## A store full of receipts the backup never mentioned reads as ok

`marker 692`

The banner stops asking whether this machine has an attachments store when
the record says nothing about one, so an installed copy of the script older
than the archive step — or one never told where the store is — keeps the
calm grey line over receipts it never copied. `backup:states` puts a file
in the store and hands it a record with no attachments field.

```
$ backup:states | npm run backup:states
FAIL  the store has files the record never mentioned  -> ok, expected partial; line "Restore-checked today (erp_dev-x.dump)."; message "Complete backup less than an hour ago.…" should match /said nothing about the attachments/
FAIL  the store has files, the run saw no directory   -> ok, expected partial; line "Restore-checked today (erp_dev-x.dump)."; message "Complete backup less than an hour ago.…" should match /saw no attachments store/
=== 2 STATE(S) WRONG ===
```

## The condemnation names nothing

`marker 693`

The banner's red line for a restore check that failed no longer says which
check failed, so the person is told the backup cannot be trusted and not
why. `backup:states` hands it a check record naming R3 and expects the
label in the message.

```
$ backup:states | npm run backup:states
FAIL  the check found the backup wrong                -> failed, expected failed; no note, no line; message "The last restore check, today, found the backup CANNOT BE TRUSTED. Run npm run b…" should match /CANNOT BE TRUSTED: R3 the restored database/
=== 1 STATE(S) WRONG ===
```

## The quiet line shows under a condemnation

`marker 694`

The calm 'Restore-checked today' line is printed for a check that found
the backup cannot be trusted, directly under the red line saying so.
`backup:states` expects no quiet line on a failed check.

```
$ backup:states | npm run backup:states
FAIL  the check found the backup wrong                -> failed, expected failed; line "Restore-checked."; expected line none
=== 1 STATE(S) WRONG ===
```

## A store the schedule was told of and cannot see is recorded as no store

`marker 695`

backup.sh makes an unavailable configured attachment store a raw shell
failure instead of writing the explicit incomplete-backup status.
`BK22` tells it, by the config file, of a store that is not there.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK22 backup.sh says when it cannot see the store it was told of, and archives one it can  told by config of a store that is not there: ok=false, "the backup stopped unexpectedly at line 142…"; told by the environment of a real one: ok=true, "attachments archived and verified"
=== 1 CHECK(S) FAILED ===
```

## Finder's .DS_Store counts as a receipt

`marker 696`

The banner counts every directory entry in the store as a file to be backed
up, so a store emptied of receipts but shown once in Finder keeps the amber
line for ever. `backup:states` fills the store with nothing but .DS_Store.

```
$ backup:states | npm run backup:states
FAIL  the store holds only .DS_Store                  -> partial, expected ok; line "Restore-checked today (erp_dev-x.dump)."
=== 1 STATE(S) WRONG ===
```

## A break-even year is never offered for closing

`marker 697`

The company page lists years to close by a nonzero TOTAL again, so a year
whose revenue and expenses net to zero — accounts to close, a year-end to
mark — is closable by the library and never from the page. `P40` asks for
the even fixture's year before it is closed.

```
$ db:verify-periods | npm run db:verify-periods
FAIL  P40 a break-even year is offered for closing          not listed (0 year(s) listed)
=== 1 CHECK(S) FAILED ===
```

## The periods overview counts a reversed pair twice

`marker 698`

The period's total sums every posted and reversed entry, so an entry and
the reversal that undid it are two amounts about no money, and the period
reads twice as busy as it was. `P41` reverses one entry and reads the row.

```
$ db:verify-periods | npm run db:verify-periods
FAIL  P41 a reversed pair is left out of the period total, and the overview carries the year  {"entries":"4","outside":"2","total":"240000","year":"open"}
=== 1 CHECK(S) FAILED ===
```

## The reopen-year panel waits for a status no year has

`marker 699`

The periods page mounts the reopen-year control only for a 'locked' year,
and years are open or closed, so a closed year again has no screen to reopen
it from — four refusals point at nothing, as before. `P42` reads the page
for the closed-year condition.

```
$ db:verify-periods | npm run db:verify-periods
FAIL  P42 a closed year can be reopened from the periods page, with a reason on the record  control: form true, year id true, reason true; page mounts it true, for a closed year only false
=== 1 CHECK(S) FAILED ===
```

## The cash flow statement stops asking whether the cache drifted

`marker 700`

renderCashFlow no longer asks check_balance_integrity, so a drifted cache
warns on the balance sheet and stays quiet on the cash flow statement that
shows the same wrong figures. `T44` puts one row out by a cent and reads
all three statements.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T44 every statement says when the balance cache drifted, and stops when it is rebuilt  drifted: balance sheet true, cash flow false, equity true; after the rebuild 0 still warn
=== 1 CHECK(S) FAILED ===
```

## The equity statement stops asking whether the cache drifted

`marker 701`

The same for renderEquityChanges. `T44` reads it too.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T44 every statement says when the balance cache drifted, and stops when it is rebuilt  drifted: balance sheet true, cash flow true, equity false; after the rebuild 0 still warn
=== 1 CHECK(S) FAILED ===
```

## The balance sheet stops asking whether the cache drifted

`marker 702`

And the templated statements — the question moved into drift.ts and this
is the balance sheet's call dropped. `T44` expects the warning on it.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T23 a stale balance cache is reported                 ["The statement does not balance: assets and the other side differ by 5000.00."]
FAIL  T44 every statement says when the balance cache drifted, and stops when it is rebuilt  drifted: balance sheet false, cash flow true, equity true; after the rebuild 0 still warn
=== 2 CHECK(S) FAILED ===
```

## A purchase that landed on the balance sheet vanishes from money out

`marker 703`

The party ledger stops reading documents whose entry has no line of this
direction's P&L type, so a laptop bought and paid on the spot is on no page
but the journal. `V121` buys one and looks for it.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V121 a purchase that landed on the balance sheet is on the money-out page, outside the total  the laptop is not on the page (5 rows)
FAIL  V123 every browse record carries the real journal identity, including capital and carried debts  49 rows checked independently against journal_entry/invoice; drafts have no entry
=== 2 CHECK(S) FAILED ===
```

## An account only the cash flow reaches is still said to reach nothing

`marker 704`

0075's new reason is never chosen, so an account tagged only cf_operating is
reported as carrying roles that no statement uses — the sentence RISKS §8
went stale on. `A18` tags one and reads the reason.

```
$ db:verify-accounts | npm run db:verify-accounts
FAIL  A18 an account only the cash flow statement reaches is reported, and says so  ["5400:carries only roles that no statement uses"]
=== 1 CHECK(S) FAILED ===
```

## Any company's year can be reopened from any ledger

`marker 705`

reopenFiscalYear stops asking whether the year is this ledger's, so a
Periods seat on one company can reverse another company's closing entry —
the class node 1 closed for every other id, reopened at the door node 4
added. `P43` reopens the even fixture's year from the other ledger.

```
$ db:verify-periods | npm run db:verify-periods
FAIL  P43 a year is reopened only from its own ledger       expected NOT_OURS, got NOT_CLOSED: That year has no closing entry to reverse.
=== 1 CHECK(S) FAILED ===
```

## A redirect index points at a page that is not there

`marker 706`

The /payroll/runs index sends a typed URL to a misspelt path, so the
person lands on the 404 the index exists to prevent. `N25` follows every
redirect index to a page.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
FAIL  N25 every ledger segment answers, and every redirect index lands on a page  no folder without an index; 30 redirect indexes; dead: /payroll/runs → /payrol
=== 2 CHECK(S) FAILED ===
```

## A credit note discards its actual tax overrides

`marker 707`

A credit note silently recalculates its GST/PST instead of preserving the
entered actual amounts. `V122` checks the stored tax amounts and direction,
independent of explanatory copy that the owner removed.

```
$ db:verify-invoices | npm run db:verify-invoices
FAIL  V122 credit-note tax lines preserve actual amounts and direction  GST 4.75; PST 6.80
=== 1 CHECK(S) FAILED ===
```

## A receipt already spent in full is still offered

`marker 708`

The read of unapplied receipts keeps an entry whose applications equal
what it moved, so an invoice is offered money that has nothing left — and
the trigger refuses it only after the person chose it. `PM46` records a
receipt, applies all of it, and expects it gone from the list.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM46 a receipt on account is offered to the invoice with what is still unapplied — its own share of a shared one — and a refund or a spent receipt is not  before: 3 offered, deposit 70000 of 70000 unapplied, the shared cheque 60000 of 60000 (the neighbour's 400.00 already spent); after applying 300.00: 40000; refund offered false, spent receipt offered true
=== 1 CHECK(S) FAILED ===
```

## The invoice page keeps its credits to itself

`marker 709`

DetailBody computes the party's credit notes and unapplied receipts and
hands the panel an empty list, so the door exists in the library and the
panel and opens from nowhere. `PM47` reads the hand-off.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM47 an invoice offers the party's credit notes and unapplied receipts, by entry; none when there are none  picker present with 1 option(s); without credits no picker; the page reads unappliedReceipts true and hands credits over false
=== 1 CHECK(S) FAILED ===
```

## Last year's quarters are this year's again

`marker 710`

The filing periods offered name last year's quarters with this year's
dates, so a January filing of Q4 is offered a quarter that has not happened.
`G11` asks for Q4 of last year by its own dates.

```
$ db:verify-tax | npm run db:verify-tax
FAIL  G11 the filing periods offered are real quarters, last year's too  [{"name":"Q1 2026","from":"2026-01-01","to":"2026-03-31"},{"name":"Q2 2026","from":"2026-04-01","to":"2026-06-30"},{"name":"Q3 2026","from":"2026-07-01","to":"2026-09-30"},{"name":"Q4 2026","from":"2026-10-01","to":"2026-12-31"},{"name":"2026","from":"2026-01-01","to":"2026-12-31"},{"name":"2025","from":"2025-01-01","to":"2025-12-31"},{"name":"Q1 2026","from":"2026-01-01","to":"2026-03-31"},{"name":"Q2 2026","from":"2026-04-01","to":"2026-06-30"},{"name":"Q3 2026","from":"2026-07-01","to":"2026-09-30"},{"name":"Q4 2026","from":"2026-10-01","to":"2026-12-31"}]
=== 1 CHECK(S) FAILED ===
```

## A shared receipt is charged for the other customer's use of it

`marker 711`

The unapplied figure subtracts every application the entry has made, not
those toward this party, so a cheque split across two customers is offered
to the first short by whatever the second has drawn. `PM46` splits one
600/400 and spends the 400.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM46 a receipt on account is offered to the invoice with what is still unapplied — its own share of a shared one — and a refund or a spent receipt is not  before: 2 offered, deposit 70000 of 70000 unapplied, the shared cheque 20000 of 60000 (the neighbour's 400.00 already spent); after applying 300.00: 40000; refund offered false, spent receipt offered false
=== 1 CHECK(S) FAILED ===
```

## A handed-in drift answer is ignored

`marker 712`

renderStatement asks check_balance_integrity even when the caller already
did, so the columned view is back to a scan per column — the cost the option
exists to remove — and a handed answer is not the one printed. `T45` hands
a sentinel and a null and expects both honoured.

```
$ db:verify-statements | npm run db:verify-statements
FAIL  T45 the drift answer is asked once, handed to every column, and a handed answer is honoured  a sentinel handed on a clean cache: ignored; null handed on a drifted cache: asked anyway; the columned view's one ask: found it
=== 1 CHECK(S) FAILED ===
```

## The general ledger's running balance runs across accounts

`marker 713`

The one-read window loses its partition, so the running balance carries
from one account into the next and every account after the first reconciles
to nothing. `X16` ties opening + rows to the closing per account.

```
$ db:verify-exports | npm run db:verify-exports
FAIL  X16 the general ledger ties the balance cache to the journal, per account  1000: 0 + rows != -150000; 2100: 0 + rows != -65000; 4000: 0 + rows != -500000
=== 1 CHECK(S) FAILED ===
```

## The attachment sweep forgets which accounts an entry touched

`marker 714`

The one-read context hands every attachment an empty account list, so the
rebuild links nothing into the account folders and the sweep checks no
folder paths. The attachments suite counts the links and the folders.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT7 a wrecked tree rebuilds from the truth                0 missing before, 0 links after, sweep clean
=== 1 CHECK(S) FAILED ===
```

## The customer statement reads every party again

`marker 715`

The SQL party filter goes, so the statement is built from every open entry
in the ledger — the shape the JS filter used to hide, and the audit's
finding. `DC12` renders a second customer's statement and expects only
their items.

```
$ db:verify-documents | npm run db:verify-documents
FAIL  DC12 a statement holds only its own party's items               Bystander's: INV-300, INV-301, CN-302, INV-BYS, PAY-00002; the customer's 5 item(s), INV-BYS among them: true
=== 1 CHECK(S) FAILED ===
```

## The tax-role memo hands every role the first-asked account

`marker 716`

The memo loses its key, so a sale tagged GST+PST posts the PST to the GST
account — the exact wrong-account shape a per-line query never had. `D42`
posts one and reads both payable accounts.

```
$ db:verify-drafts | npm run db:verify-drafts
FAIL  D42 one entry asking two tax roles lands each on its own account  GST -1200 on 2100 (expected -500), PST nowhere on 2110 (expected -700), balanced true
=== 1 CHECK(S) FAILED ===
```

## A person on payroll is unfindable again

`marker 717`

The search drops its employee read, so a name that is in the payroll module
answers nothing — the shape all five kinds were in before this node. `SR11`
searches for Quimby and expects the Employee hit.

```
$ db:verify-search | npm run db:verify-search
FAIL  SR11 people, pay runs, SR&ED, registrations and readings are findable, in their own ledger only  5 hit(s): Pay run:Pay run — paid 2026-03-31; SR&ED:QX-1 — Quixotic solvent recovery; Registration:GST/HST — 724466638RT0001; Reading:quayside-hydro-bi; the other company sees 0
=== 1 CHECK(S) FAILED ===
```

## A screen spells its own red box again

`marker 718`

One refusal site goes back to a hand-rolled red class, so the box drifts
from the shared spelling the moment anyone edits it. `N26` sweeps every
file under src for a bg-red-50 outside the named tone sets.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
FAIL  N26 the refusal box is spelled once, and every screen says it the same way  off: src/app/ledger/[ledgerId]/accounts/RoleEditor.tsx (1); 39 files use REFUSAL
=== 2 CHECK(S) FAILED ===
```

## A screen spells its own input again

`marker 719`

One field goes back to the second style, so the forms stop looking like one
application one control at a time. `N27` sweeps for the literal.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
FAIL  N27 the input is spelled once — no screen keeps the second style     still spelled out in: src/app/audit/page.tsx
=== 2 CHECK(S) FAILED ===
```

## Tables stop scrolling at phone width

`marker 720`

The one rule that makes every table scroll sideways on a narrow screen
goes, so forty screens clip their columns again. `N28` reads the rule.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
FAIL  N28 every table scrolls sideways at phone width, from one rule       no narrow-width table rule in globals.css
=== 2 CHECK(S) FAILED ===
```

## The journal cannot see that another page exists

`marker 721`

The posted read loses its one lookahead row, but Next still depends on more
than 100 rows. Every visible page looks complete while later entries become
unreachable. N29 ties the bounded read to the displayed page and Next gate.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
FAIL  N29 journal paginates its bounded read; readings name their cap      journal pagination false; readings: cap 10, sentence says 10, gated at the cap true
=== 2 CHECK(S) FAILED ===
```

## The options lose their names

`marker 722`

Every option's id goes, so aria-activedescendant points at nothing and a
screen reader hears silence as the highlight moves. `PK16` reads the
rendered options for their ids.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK16 every option is named and the input points at the active one  option ids none; the input wires aria-activedescendant true
=== 1 CHECK(S) FAILED ===
```

## The input stops naming the active option

`marker 723`

aria-activedescendant goes, so the options are named and nothing points at
the one the arrows are on. `PK16` reads the component for the wiring.

```
$ db:verify-picker | npm run db:verify-picker
FAIL  PK16 every option is named and the input points at the active one  option ids _R_0_-list-opt-0, _R_0_-list-opt-1; the input wires aria-activedescendant false
=== 1 CHECK(S) FAILED ===
```

## The overlay keeps the focus it took

`marker 724`

The overlay stops handing focus back to its opener, so closing a sub-page
strands the keyboard at the top of the document. `N30` reads the cleanup.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
FAIL  N30 the overlay takes focus on open and hands it back on close       panel focusable true, focused on mount true, connected opener or visible launcher restored false, background inert true
=== 2 CHECK(S) FAILED ===
```

## The third input spelling comes back

`marker 725`

UserAdmin's input goes back to the px-3 spelling the first sweep missed and
the critic found in sixteen files, so N27's widened net must catch what its
first net could not.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
FAIL  N27 the input is spelled once — no screen keeps the second style     still spelled out in: src/app/users/UserAdmin.tsx
=== 2 CHECK(S) FAILED ===
```

## The breakdown's download row prints again

`marker 726`

The print:hidden comes off the row the audit named and the first pass
dismissed, so a printed breakdown carries 'Download Excel · Download PDF'
as body text. `N31` reads every offering page.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
=== 1 CHECK(S) FAILED ===
```

## An unspent credit note counts as debt again

`marker 727`

`owedAmount` stops turning a credit note's remaining value negative, so a
customer with a 1,000.00 invoice and a 150.00 credit note reads as owing
1,150.00. `PM48` sums both sides of one party.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM48 an unspent credit note reduces what is owed on either side, where adding balances counted it as more  sales: sizes 115000, owed 115000; purchase: sizes 45000, owed 45000; 4 open
FAIL  PM48c the income and expense pages' Unpaid subtotal for one party nets its unspent credit note  income page 115000; expense page 45000
=== 2 CHECK(S) FAILED ===
```

## The party page adds sizes again

`marker 728`

The page's "They owe us" total goes back to adding each document's balance
as it stands, so the credit note under it counts as more debt while the rows
above still print it negative. `PM48b` reads both sums.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM48b the party page totals and prints each document through owedAmount, so each direction's rows add up to its total  sums through owedAmount 1; raw balance sums 1; rows printed through it true
=== 1 CHECK(S) FAILED ===
```

## The assistant's rows let the delete through

`marker 729`

The gate stops counting questions and bill readings, so a company whose only
rows are the assistant's reaches the delete — which then fails on 0061's
trigger with its own message, or removes a reading with no exchange. `CO10`
tries both.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO10 a company holding only the assistant's rows is refused at the gate with a sentence to archive, not by the trigger  Failed query: DELETE FROM ai_exchange WHERE ledger | removed | Failed query: DELETE FROM ai_inquiry WHERE ledger_
=== 1 CHECK(S) FAILED ===
```

## A supplier's name in another script reads as nothing

`marker 730`

The name match goes back to keeping a-z and 0-9, so every Chinese supplier
name normalises to an empty string and the bill form never finds the
supplier. `BR19` matches one.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR19 a supplier name matches across scripts, accents, full-width letters, symbols and a closing company suffix, and only the same name  chineseWithSuffix NO; differentChinese yes; accents NO; withoutAccents yes; decomposed NO; fullWidth yes; suffixInsideAWord NO; legalWordInTheMiddle yes; symbol yes; traditionalSuffix NO
=== 1 CHECK(S) FAILED ===
```

## The by-party pages count a credit note as unpaid debt again

`marker 731`

`partyLedger` puts `openItemsQuery`'s size straight into the Unpaid column,
so the income page's subtotal for a customer with a 1,000.00 invoice and a
150.00 credit note reads 1,150.00. `PM48c` adds one party's column.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM48c the income and expense pages' Unpaid subtotal for one party nets its unspent credit note  income page 115000; expense page 45000
=== 1 CHECK(S) FAILED ===
```

## Credit held reads as a negative debt

`marker 732`

`owedSummary` keeps "They owe us" whatever the sign, so a customer holding
only a 150.00 credit note is shown as owing -150.00. `PM48d` asks for each
sign on each side.

```
$ db:verify-payments | npm run db:verify-payments
FAIL  PM48d a party whose credit notes outweigh its documents reads as credit held, not as a negative debt  They owe us -15000; We owe them 35000; We have credit with them 5000; page words it through owedSummary true
=== 1 CHECK(S) FAILED ===
```

## The companies list offers Remove to a company the assistant knows

`marker 733`

The row stops asking about the assistant's rows, so a company whose only
records are questions to the assistant is offered Remove… — which the library
then refuses. `CO11` renders the row for each pair of counts.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO11 the companies list offers Remove only with nothing in the books and nothing asked of the assistant  empty offered; asked offered; books not offered
=== 1 CHECK(S) FAILED ===
```

## A full-width or decomposed supplier name stops matching

`marker 734`

The name match stops folding with NFKC, so "Ｓｏｎｙ Ｃａｎａｄａ" is not "Sony Canada"
and an accent typed as a combining mark is not the same letter. `BR19`
tries both.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR19 a supplier name matches across scripts, accents, full-width letters, symbols and a closing company suffix, and only the same name  chineseWithSuffix yes; differentChinese yes; accents yes; withoutAccents yes; decomposed NO; fullWidth NO; suffixInsideAWord yes; legalWordInTheMiddle yes; symbol yes; traditionalSuffix yes
=== 1 CHECK(S) FAILED ===
```

## A Chinese company suffix makes a different name

`marker 735`

The match stops dropping 有限公司 and its kin, so the bill's 北方贸易有限公司
never finds the party 北方贸易 — while "Staples Canada ULC" still finds
"Staples Canada". `BR19` matches the Chinese one.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR19 a supplier name matches across scripts, accents, full-width letters, symbols and a closing company suffix, and only the same name  chineseWithSuffix NO; differentChinese yes; accents yes; withoutAccents yes; decomposed yes; fullWidth yes; suffixInsideAWord yes; legalWordInTheMiddle yes; symbol yes; traditionalSuffix NO
=== 1 CHECK(S) FAILED ===
```

## A legal word in the middle of a name disappears

`marker 736`

The name match drops Inc, Company and the rest wherever they stand rather
than only at the end, so a bill from "The Company Store" opens on the party
"The Store". `BR19` asks for no match.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR19 a supplier name matches across scripts, accents, full-width letters, symbols and a closing company suffix, and only the same name  chineseWithSuffix yes; differentChinese yes; accents yes; withoutAccents yes; decomposed yes; fullWidth yes; suffixInsideAWord yes; legalWordInTheMiddle NO; symbol yes; traditionalSuffix yes
=== 1 CHECK(S) FAILED ===
```

## A trademark sign becomes part of the name

`marker 737`

The match folds before dropping symbols, so ™ turns into the letters TM
stuck to the word and "Fido™" no longer finds the party "Fido". `BR19`
matches it.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR19 a supplier name matches across scripts, accents, full-width letters, symbols and a closing company suffix, and only the same name  chineseWithSuffix yes; differentChinese yes; accents yes; withoutAccents yes; decomposed yes; fullWidth yes; suffixInsideAWord yes; legalWordInTheMiddle yes; symbol NO; traditionalSuffix yes
=== 1 CHECK(S) FAILED ===
```

## The companies list hands the row a count of its own

`marker 738`

The page stops passing the library's assistant count to the row, so a
company whose only records are questions to the assistant is offered
Remove… again while the row itself still decides correctly. `CO11b` reads
what the page hands it.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO11b the companies list hands each row the library's two counts, not a count of its own  the page hands the row something else
=== 1 CHECK(S) FAILED ===
```

## A round gets eighty look-ups

`marker 739`

`LOOKUPS_PER_ROUND` goes from 8 to 80, so a model that only ever calls keeps
sending requests long past the round. `IQ3` counts nine.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ3 eight look-ups then an answer-only turn; the character cap and the clock stop a round, never an answer  81 requests ending call_after_limit; cap at step 6 rebuilt true; slow call → too_slow; slow answer → answer
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed refused, padded refused, shouted refused, paddedReport refused, unknownReport refused; its own side read; clerk sees 1 of its own; clerk presses an offered question → NOT_YOURS (0 presses kept); outsider asks → NO_SEAT, sees 0, presses its own → NO_SEAT; spender offered party_activity true
FAIL  IQ18 Keep looking is written before it asks again, gives a fresh round, is pressed once, and is not offered past the cap  offered false; press on record before the request -1; fresh round false; again → NOT_OFFERED; racing presses kept 0, refused NOT_OFFERED, NOT_OFFERED; changed service → SERVICE_CHANGED; refusal, error, cut-off offered false
FAIL  IQ14d the page's line names a failure even after the character limit, and Keep looking is offered only to the asker on the service it was asked with  after the cap: The call failed: the relay said 502; capped only: This question looked up too much to go on. Ask a narrower one.; offers to owner / owner on another model / clerk / no service: null, null, null, null
=== 4 CHECK(S) FAILED ===
```

## A question may look up without end

`marker 740`

The character cap is lifted out of reach, so results pile up in every request
and no step is ever `too_much`. `IQ3` asks for the cap on the heavy question.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ3 eight look-ups then an answer-only turn; the character cap and the clock stop a round, never an answer  9 requests ending call_after_limit; cap at step 0 rebuilt false; slow call → too_slow; slow answer → answer
FAIL  IQ14c a question that looked up too much is told to ask a narrower one, not to keep looking  last step call_after_limit, capped false; the form said It stopped at the limit before answering. You can let it keep looking.
FAIL  IQ14d the page's line names a failure even after the character limit, and Keep looking is offered only to the asker on the service it was asked with  after the cap: The call failed: the relay said 502; capped only: It stopped at the limit before answering.; offers to owner / owner on another model / clerk / no service: button, elsewhere, null, null
=== 3 CHECK(S) FAILED ===
```

## The clock never stops a round

`marker 741`

The five-minute limit is never read, so a slow call is sent back and the
round goes on. `IQ3` moves the clock past it.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ3 eight look-ups then an answer-only turn; the character cap and the clock stop a round, never an answer  9 requests ending call_after_limit; cap at step 6 rebuilt true; slow call → error; slow answer → answer
=== 1 CHECK(S) FAILED ===
```

## A reply with both a call and an answer counts as an answer

`marker 742`

The parser stops refusing an object that holds both, so a model hedging
between looking and answering has its guess taken as the answer. `IQ2` parses one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ2 a reply is a call, an answer or neither, and a cut-off, a refusal and a failure each stop as themselves  parsed unreadable,answer,unreadable,unreadable,answer,call; cut_off; refusal; error; unreadable+answer
=== 1 CHECK(S) FAILED ===
```

## Every address in this ledger is clickable

`marker 743`

A link in an answer becomes clickable when it merely starts with a ledger
path, so an address the model made up, or another company's, can be opened.
`IQ10` offers three that no result carried.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ10 a link is clickable only when a result carried that exact address in this ledger, whatever text sat around it  clickable: $9,999.99, the customer, aging, theirs, sneaky
=== 1 CHECK(S) FAILED ===
```

## A dollar amount without cents escapes the check

`marker 744`

Only numbers with two decimals are figures, so "$5,000" in an answer is
never marked though no result carried it. `IQ8` writes one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ8 a figure is marked unless a result carried it, sign aside, in a link label or after letters too; whole numbers and percentages are not figures  marked: 3,141.59, 2,718.28, 6,543.21, 7,777.77, $9,999.99
=== 1 CHECK(S) FAILED ===
```

## Keep looking is offered past the cap

`marker 745`

The capped step stops mattering, so a question that already looked up too
much is offered another round. `IQ18` asks about a capped one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ18 Keep looking is written before it asks again, gives a fresh round, is pressed once, and is not offered past the cap  offered true; press on record before the request 1; fresh round true; again → NOT_OFFERED; racing presses kept 1, refused ALREADY; changed service → SERVICE_CHANGED; refusal, error, cut-off offered false
FAIL  IQ14c a question that looked up too much is told to ask a narrower one, not to keep looking  last step call_after_limit, capped true; the form said It stopped at the limit before answering. You can let it keep looking.
FAIL  IQ14d the page's line names a failure even after the character limit, and Keep looking is offered only to the asker on the service it was asked with  after the cap: The call failed: the relay said 502; capped only: This question looked up too much to go on. Ask a narrower one.; offers to owner / owner on another model / clerk / no service: button, elsewhere, null, null
=== 3 CHECK(S) FAILED ===
```

## Anyone may keep someone else's question going

`marker 746`

The asker check stops refusing, so a person with a narrower seat continues the
owner's question on the owner's system text. `IQ6` presses as the clerk.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed refused, padded refused, shouted refused, paddedReport refused, unknownReport refused; its own side read; clerk sees 1 of its own; clerk presses an offered question → not refused (1 presses kept); outsider asks → NO_SEAT, sees 0, presses its own → NO_SEAT; spender offered party_activity true
=== 1 CHECK(S) FAILED ===
```

## Every question shows to every viewer

`marker 747`

The history stops filtering by asker, so a person with only the Assistant seat
reads the owner's look-ups — pay stubs, registers, bank rows. `IQ6` lists as the clerk.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed refused, padded refused, shouted refused, paddedReport refused, unknownReport refused; its own side read; clerk sees 11 of its own; clerk presses an offered question → NOT_YOURS (0 presses kept); outsider asks → NO_SEAT, sees 0, presses its own → NO_SEAT; spender offered party_activity true
=== 1 CHECK(S) FAILED ===
```

## A look-up that never ran reads as if it did

`marker 748`

The transcript stops saying a call after the limit or past the clock was not
run, so the next round's model believes it has a result it never saw.
`IQ18` rebuilds one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ18 Keep looking is written before it asks again, gives a fresh round, is pressed once, and is not offered past the cap  offered true; press on record before the request 1; fresh round true; again → NOT_OFFERED; racing presses kept 1, refused ALREADY; changed service → SERVICE_CHANGED; refusal, error, cut-off offered false
=== 1 CHECK(S) FAILED ===
```

## The key is written into a step

`marker 749`

The model's words go into the row as they came back, so a service that echoes
the key leaves it in the table. `IQ11` searches every row.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ11 a question and its steps are neither edited nor deleted, and the key is in no row  rows with the key: 2; edit → refused; delete → refused
=== 1 CHECK(S) FAILED ===
```

## A tool runs without asking the seat

`marker 750`

`runTool` stops refusing a seat the person does not hold, so a clerk's forced
call reads the aging. `IQ6` forces one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed Owed to us as at 2026-10, padded Money in with one party,, shouted party_activity: "directi, paddedReport PD7A remittances — North, unknownReport report_link: There is no; its own side read; clerk sees 1 of its own; clerk presses an offered question → NOT_YOURS (0 presses kept); outsider asks → NO_SEAT, sees 0, presses its own → NO_SEAT; spender offered party_activity true
=== 1 CHECK(S) FAILED ===
```

## calculate launders a made-up amount

`marker 751`

`calculate` stops asking whether an amount was looked up, so two invented
numbers add into a figure the check then trusts. `IQ9` invents one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ9 calculate adds and subtracts in cents, and refuses an amount no result carried without repeating it  Result: 0.30; Result: 1,000.00; invented → calculate sum
=== 1 CHECK(S) FAILED ===
```

## Another company's employee id is read without asking

`marker 752`

`pay_stubs` stops asking whether the employee is this company's; the reader
still binds the ledger, so the answer is an empty table rather than the
refusal. `IQ5` hands it the other company's id.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ5 no tool brings back the other company, and an id of theirs is refused by name  36 look-ups, leaking: none; foreign ids: stubs Pay stubs for 2026 — Northwind NORTHMARK, activity refused, link refused, owed refused, documents refused
=== 1 CHECK(S) FAILED ===
```

## What we owe reads negative

`marker 753`

`owed` stops turning the payable side around, so a supplier we owe 400.00
reads -400.00. `IQ4` reads the payable total.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ4 the tools write the fixture's own figures: signs, a reversed run left out, the cut, pay stubs equal to T4 box 14  receivableTotal yes; payablePositive NO; creditNoteNegative yes; partiesCut yes; stubsPostedOnly yes; runsPostedOnly yes; t4Agrees yes; remittancesAgree yes; journalSaysMore yes; searchSaysCut yes; nothingBroke yes
=== 1 CHECK(S) FAILED ===
```

## A reversed pay run counts as pay

`marker 754`

`pay_runs` stops leaving out a run whose entry was reversed, so the wrong run
and its correction both count. `IQ4` looks for the reversed gross.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ4 the tools write the fixture's own figures: signs, a reversed run left out, the cut, pay stubs equal to T4 box 14  receivableTotal yes; payablePositive yes; creditNoteNegative yes; partiesCut yes; stubsPostedOnly yes; runsPostedOnly NO; t4Agrees yes; remittancesAgree yes; journalSaysMore yes; searchSaysCut yes; nothingBroke yes
=== 1 CHECK(S) FAILED ===
```

## An unspent credit note is sent as owed

`marker 755`

`open_documents` writes the unsigned size again, so the model reads a
150.00 credit note as 150.00 more owed. `IQ4` looks for -150.00.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ4 the tools write the fixture's own figures: signs, a reversed run left out, the cut, pay stubs equal to T4 box 14  receivableTotal yes; payablePositive yes; creditNoteNegative NO; partiesCut yes; stubsPostedOnly yes; runsPostedOnly yes; t4Agrees yes; remittancesAgree yes; journalSaysMore yes; searchSaysCut yes; nothingBroke yes
=== 1 CHECK(S) FAILED ===
```

## The employee list sends the SIN

`marker 756`

`employees` names the SIN where it named the occupation, which is the one
column the owner kept back. `IQ7` looks for it in every result.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ7 no tool result carries the SIN, while the employee lists and the T4 still name the person  36 look-ups; carrying a SIN: employees {} (only employees and t4 read the column; the rest are probes)
=== 1 CHECK(S) FAILED ===
```

## Totals by party read each line's own party

`marker 757`

An entry's lines stop belonging to the party named on its first party line,
so a bill's expense — whose only named line is the payable — falls into No
party and a supplier's spend is split. `IQ17` adds one supplier's bill and counter expense.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ17 totals agree with the trial balance, round to periods, name a closing entry, and give an entry to its first named party  trial balance debit 31,117.24 credit 31,117.24; by account 31,117.24 / 31,117.24 / 0.00; by party 31,117.24 / 31,117.24 / 0.00; by month 31,117.24 / 31,117.24 / 0.00; Quayside "Quayside Paper Supply | 57.00 | 0.00 | 57.00 | /ledger/c030c56b-cb38-4b77-b977-a5e8c0f74ecb/parties/cb55df0b-acec-4908-bd6a-5c293d37f872"; Harbour ""; rounded true; closing posted true, named true
=== 1 CHECK(S) FAILED ===
```

## The aging link names a parameter the page does not read

`marker 758`

The catalogue writes `as_of` where the aging page reads `asOf`, so the link
opens today's aging whatever date was asked for. `IQ15` reads the page.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ15 every report address names a page or route that exists and reads every parameter it is given  aging: src/app/ledger/[ledgerId]/aging/page.tsx does not read as_of
=== 1 CHECK(S) FAILED ===
```

## A backup leaves a question's steps behind

`marker 759`

The step table drops out of the company data, so a restored company has its
questions and none of what they looked up. `BK1` names every table.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK1 every table in the database is backed up or declared not to be  forgotten: ai_inquiry_step | named but absent: 
=== 1 CHECK(S) FAILED ===
```

## A company that only asked the books slips past the gate

`marker 760`

The delete gate stops counting questions to the books, so a company whose only
rows are `ai_inquiry` reaches the delete and fails on the append-only
trigger with its own message. `CO10` tries one.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO10 a company holding only the assistant's rows is refused at the gate with a sentence to archive, not by the trigger  HAS_AI_RECORDS: Asked Only Ltd. has asked the assi | HAS_AI_RECORDS: Read Only Ltd. has asked the assis | Failed query: DELETE FROM ai_inquiry WHERE ledger_
=== 1 CHECK(S) FAILED ===
```

## A seat is chosen from untrimmed arguments

`marker 761`

`runTool` hands the seat and the tool the arguments as typed, so a direction written " out " chooses no seat at all and a person refused nothing reads nothing either. `IQ6` asks the spender for its own side with spaces around it.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed refused, padded refused, shouted refused, paddedReport refused, unknownReport refused; its own side REFUSED; clerk sees 1 of its own; clerk presses an offered question → NOT_YOURS (0 presses kept); outsider asks → NO_SEAT, sees 0, presses its own → NO_SEAT; spender offered party_activity true
=== 1 CHECK(S) FAILED ===
```

## A direction that is neither asks for either seat

`marker 762`

`party_activity` offers both pages' seats for a direction it does not know, so a person holding only Expenses passes the seat with "IN" and is told the argument is wrong instead of being refused. `IQ6` forces it.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed refused, padded refused, shouted party_activity: "directi, paddedReport refused, unknownReport refused; its own side read; clerk sees 1 of its own; clerk presses an offered question → NOT_YOURS (0 presses kept); outsider asks → NO_SEAT, sees 0, presses its own → NO_SEAT; spender offered party_activity true
=== 1 CHECK(S) FAILED ===
```

## An unknown report needs no seat

`marker 763`

`report_link` answers an unknown report with no seat at all, so the refusal and its company check are skipped. `IQ6` forces "PD7A" as the clerk.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed refused, padded refused, shouted refused, paddedReport refused, unknownReport report_link: There is no; its own side read; clerk sees 1 of its own; clerk presses an offered question → NOT_YOURS (0 presses kept); outsider asks → NO_SEAT, sees 0, presses its own → NO_SEAT; spender offered party_activity true
=== 1 CHECK(S) FAILED ===
```

## A refusal repeats the code it was given

`marker 764`

The account refusal quotes the code back, so an account called 777.77 puts 777.77 into the question's looked-up amounts. `IQ9` asks for one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ9 calculate adds and subtracts in cents, and refuses an amount no result carried without repeating it  Result: 0.30; Result: 1,000.00; invented → calculate: Amount 2 is not a figure from this ques; refusals repeat no amount false
=== 1 CHECK(S) FAILED ===
```

## Another ledger's address in a result becomes clickable

`marker 765`

`sentLinks` keeps any ledger address a result spelled out, so a bank line naming another company's page makes that link clickable. `IQ10` carries one in free text.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ10 a link is clickable only when a result carried that exact address in this ledger, whatever text sat around it  clickable: $9,999.99, the customer, theirs
=== 1 CHECK(S) FAILED ===
```

## A figure in a link label goes unchecked

`marker 766`

A clickable link's label is printed as it came, so "[$9,999.99](…)" is never marked though nothing carried it. `IQ8` writes one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ8 a figure is marked unless a result carried it, sign aside, in a link label or after letters too; whole numbers and percentages are not figures  marked: $5,000, 3,141.59, 2,718.28, 6,543.21, 7,777.77
=== 1 CHECK(S) FAILED ===
```

## An amount glued to letters escapes the check

`marker 767`

The figure pattern refuses a number after a letter again, so "CAD2,718.28" is never marked. `IQ8` writes one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ8 a figure is marked unless a result carried it, sign aside, in a link label or after letters too; whole numbers and percentages are not figures  marked: $5,000, 3,141.59, 6,543.21, 7,777.77, $9,999.99
=== 1 CHECK(S) FAILED ===
```

## A journal cut by characters hides that the reader stopped too

`marker 768`

The row note stops saying there are more beyond the rows counted, so a journal cut by the character limit reads as if 101 rows were all there were. `IQ4` reads the note.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ4 the tools write the fixture's own figures: signs, a reversed run left out, the cut, pay stubs equal to T4 box 14  receivableTotal yes; payablePositive yes; creditNoteNegative yes; partiesCut yes; stubsPostedOnly yes; runsPostedOnly yes; t4Agrees yes; remittancesAgree yes; journalSaysMore NO; searchSaysCut yes; nothingBroke yes
=== 1 CHECK(S) FAILED ===
```

## Search stops saying a kind was cut

`marker 769`

`search` stops naming the kinds that reached 25 matches, so a model reports 25 suppliers as all there are. `IQ4` searches for 105.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ4 the tools write the fixture's own figures: signs, a reversed run left out, the cut, pay stubs equal to T4 box 14  receivableTotal yes; payablePositive yes; creditNoteNegative yes; partiesCut yes; stubsPostedOnly yes; runsPostedOnly yes; t4Agrees yes; remittancesAgree yes; journalSaysMore yes; searchSaysCut NO; nothingBroke yes
=== 1 CHECK(S) FAILED ===
```

## Totals say nothing about a closing entry

`marker 770`

`totals` stops naming a year-end closing entry in its range, so monthly revenue over a closed year reads as zero without a word. `IQ17` posts one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ17 totals agree with the trial balance, round to periods, name a closing entry, and give an entry to its first named party  trial balance debit 31,117.24 credit 31,117.24; by account 31,117.24 / 31,117.24 / 0.00; by party 31,117.24 / 31,117.24 / 0.00; by month 31,117.24 / 31,117.24 / 0.00; Quayside "Quayside Paper Supply | 450.00 | 0.00 | 450.00 | /ledger/d2ec1a44-709d-4ebe-ab6d-47b4ffddeac2/parties/97d4a18b-5eba-4f6a-b08c-001d432d4504"; Harbour "Harbour Customer NORTHMARK | 7.00 | 0.00 | 7.00 | /ledger/d2ec1a44-709d-4ebe-ab6d-47b4ffddeac2/parties/5cfd0020-aa6c-4353-9cab-be44d40032e4"; rounded true; closing posted true, named false
=== 1 CHECK(S) FAILED ===
```

## Keep looking goes to a different service than the record says

`marker 771`

`askedWith` stops comparing the person's saved service with the question's, so a round after a change of model is recorded as sent to the old one, and the page offers the button for it. `IQ18` changes the model.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ18 Keep looking is written before it asks again, gives a fresh round, is pressed once, and is not offered past the cap  offered true; press on record before the request 1; fresh round true; again → NOT_OFFERED; racing presses kept 1, refused ALREADY; changed service → not refused; refusal, error, cut-off offered false
FAIL  IQ14d the page's line names a failure even after the character limit, and Keep looking is offered only to the asker on the service it was asked with  after the cap: The call failed: the relay said 502; capped only: This question looked up too much to go on. Ask a narrower one.; offers to owner / owner on another model / clerk / no service: null, null, null, null
=== 2 CHECK(S) FAILED ===
```

## A question is asked without the Assistant seat

`marker 772`

`inquire` stops asking the Assistant seat itself, so a library caller that skipped the action's gate sends the books for a person who may not ask. `IQ6` asks as the outsider.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed refused, padded refused, shouted refused, paddedReport refused, unknownReport refused; its own side read; clerk sees 1 of its own; clerk presses an offered question → NOT_YOURS (0 presses kept); outsider asks → not refused, sees 0, presses its own → NO_SEAT; spender offered party_activity true
=== 1 CHECK(S) FAILED ===
```

## A capped question gets another look-up

`marker 773`

The answer-only turn stops following a capped step, so a question that already looked up too much is sent back to look up more. `IQ3` rebuilds the request after the cap.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ3 eight look-ups then an answer-only turn; the character cap and the clock stop a round, never an answer  9 requests ending call_after_limit; cap at step 6 rebuilt false; slow call → too_slow; slow answer → answer
=== 1 CHECK(S) FAILED ===
```

## owed takes another company's party without asking

`marker 774`

`owed` stops asking whether the party is this company's; the result is an empty table instead of the refusal. `IQ5` hands it the other company's customer.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ5 no tool brings back the other company, and an id of theirs is refused by name  36 look-ups, leaking: none; foreign ids: stubs refused, activity refused, link refused, owed Owed to us as at 2026-10-23 — Northwind , documents refused
=== 1 CHECK(S) FAILED ===
```

## open_documents takes another company's party without asking

`marker 775`

`open_documents` stops asking whether the party is this company's. `IQ5` hands it the other company's customer.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ5 no tool brings back the other company, and an id of theirs is refused by name  36 look-ups, leaking: none; foreign ids: stubs refused, activity refused, link refused, owed refused, documents Unsettled documents today — Northwind NO
=== 1 CHECK(S) FAILED ===
```

## party_activity takes another company's party without asking

`marker 776`

`party_activity` stops asking whether the party is this company's. `IQ5` hands it the other company's customer.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ5 no tool brings back the other company, and an id of theirs is refused by name  36 look-ups, leaking: none; foreign ids: stubs refused, activity Money in with one party, 2026-01-01 to 2, link refused, owed refused, documents refused
=== 1 CHECK(S) FAILED ===
```

## report_link builds a link for another company's party

`marker 777`

`report_link` stops asking whether the party is this company's, and an address carrying the other company's id comes back clickable. `IQ5` asks for their statement.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ5 no tool brings back the other company, and an id of theirs is refused by name  36 look-ups, leaking: none; foreign ids: stubs refused, activity refused, link Customer statement — Northwind NORTHMARK, owed refused, documents refused
=== 1 CHECK(S) FAILED ===
```

## A single-page seat is not offered party_activity

`marker 778`

`party_activity` loses the seats that put it on a list, so a person holding only Expenses is never told the tool exists though a call would run. `IQ6` reads the spender's list.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed refused, padded refused, shouted refused, paddedReport refused, unknownReport refused; its own side read; clerk sees 1 of its own; clerk presses an offered question → NOT_YOURS (0 presses kept); outsider asks → NO_SEAT, sees 0, presses its own → NO_SEAT; spender offered party_activity false
=== 1 CHECK(S) FAILED ===
```

## An amount with letters after it escapes the check

`marker 779`

The figure pattern refuses a letter after an amount's cents again, so "6,543.21USD" is never marked. `IQ8` writes one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ8 a figure is marked unless a result carried it, sign aside, in a link label or after letters too; whole numbers and percentages are not figures  marked: $5,000, 3,141.59, 2,718.28, 7,777.77, $9,999.99
=== 1 CHECK(S) FAILED ===
```

## A looked-up amount after letters is not counted

`marker 780`

`lookedUp` refuses a number after a letter again, so a result's "CAD4,444.44" does not count and an answer citing it is marked. `IQ8` cites one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ8 a figure is marked unless a result carried it, sign aside, in a link label or after letters too; whole numbers and percentages are not figures  marked: $5,000, 3,141.59, 2,718.28, 6,543.21, 7,777.77, 4,444.44, $9,999.99
=== 1 CHECK(S) FAILED ===
```

## An address that climbs out of this ledger is clickable

`marker 781`

`sentLinks` stops refusing a `..` segment, so "/ledger/<this>/../<other>/parties/x" in a bank line passes as this ledger's. `IQ10` carries one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ10 a link is clickable only when a result carried that exact address in this ledger, whatever text sat around it  clickable: $9,999.99, the customer, sneaky
=== 1 CHECK(S) FAILED ===
```

## A result's link keeps the sentence's full stop

`marker 782`

`sentLinks` stops taking punctuation off the end, so the link a result wrote at the end of a sentence never equals the one the answer copies. `IQ10` ends one with a full stop.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ10 a link is clickable only when a result carried that exact address in this ledger, whatever text sat around it  clickable: none
=== 1 CHECK(S) FAILED ===
```

## The history shows a person who lost the Assistant seat

`marker 783`

`inquiriesFor` stops asking the seat, so somebody whose Assistant seat was taken away still reads what their questions looked up. `IQ6` removes the outsider's seat.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed refused, padded refused, shouted refused, paddedReport refused, unknownReport refused; its own side read; clerk sees 1 of its own; clerk presses an offered question → NOT_YOURS (0 presses kept); outsider asks → NO_SEAT, sees 1, presses its own → NO_SEAT; spender offered party_activity true
=== 1 CHECK(S) FAILED ===
```

## Keep looking runs for a person who lost the Assistant seat

`marker 784`

`keepLooking` stops asking the seat, so a question asked with it can be continued without it. `IQ6` presses as the outsider.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own  clerk offered 5 tools; forced: owed refused, padded refused, shouted refused, paddedReport refused, unknownReport refused; its own side read; clerk sees 1 of its own; clerk presses an offered question → NOT_YOURS (0 presses kept); outsider asks → NO_SEAT, sees 0, presses its own → not refused; spender offered party_activity true
=== 1 CHECK(S) FAILED ===
```

## A refused question is offered another round

`marker 785`

`offersKeepLooking` offers a round after a refusal, which is not a question stopped for want of look-ups. `IQ18` asks about refusal, error and cut-off.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ18 Keep looking is written before it asks again, gives a fresh round, is pressed once, and is not offered past the cap  offered true; press on record before the request 1; fresh round true; again → NOT_OFFERED; racing presses kept 1, refused ALREADY; changed service → SERVICE_CHANGED; refusal, error, cut-off offered true
FAIL  IQ14b Keep looking from the form asks again on the question it names, and a question not offered it is refused in a sentence  at the limit → It stopped at the limit before answering. You can let it keep looking.; pressed → Answered.; sent 2; not offered → The assistant could not answer: the script ran out
=== 2 CHECK(S) FAILED ===
```

## A range rounded to periods says it was not

`marker 786`

`span` stops saying the dates were rounded to whole periods, so a model reports mid-month figures for a range it did not get. `IQ17` asks from the 10th.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ17 totals agree with the trial balance, round to periods, name a closing entry, and give an entry to its first named party  trial balance debit 31,117.24 credit 31,117.24; by account 31,117.24 / 31,117.24 / 0.00; by party 31,117.24 / 31,117.24 / 0.00; by month 31,117.24 / 31,117.24 / 0.00; Quayside "Quayside Paper Supply | 450.00 | 0.00 | 450.00 | /ledger/97835d03-09c2-449e-920e-df641382d943/parties/9e02d379-6a9c-4824-8a34-9d825992f250"; Harbour "Harbour Customer NORTHMARK | 7.00 | 0.00 | 7.00 | /ledger/97835d03-09c2-449e-920e-df641382d943/parties/9a4e6d1a-07c8-49e7-91b6-413e1f1316f4"; rounded false; closing posted true, named true
=== 1 CHECK(S) FAILED ===
```

## The key is written into a step's arguments

`marker 787`

A call's arguments go into the row as the model sent them, so a model that searches for the key leaves it in the table. `IQ11` does.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ11 a question and its steps are neither edited nor deleted, and the key is in no row  rows with the key: 1; edit → refused; delete → refused
=== 1 CHECK(S) FAILED ===
```

## An unknown tool's name is repeated back

`marker 788`

The unknown-tool sentence names what the model called, so a tool called 888.88 puts 888.88 into the looked-up amounts. `IQ9` calls one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ9 calculate adds and subtracts in cents, and refuses an amount no result carried without repeating it  Result: 0.30; Result: 1,000.00; invented → calculate: Amount 2 is not a figure from this ques; refusals repeat no amount false
=== 1 CHECK(S) FAILED ===
```

## An unknown report's name is repeated back

`marker 789`

The catalogue names the report it could not find, so a report called 999.99 puts 999.99 into the looked-up amounts. `IQ9` asks for one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ9 calculate adds and subtracts in cents, and refuses an amount no result carried without repeating it  Result: 0.30; Result: 1,000.00; invented → calculate: Amount 2 is not a figure from this ques; refusals repeat no amount false
=== 1 CHECK(S) FAILED ===
```

## Two amounts joined by a comma are one

`marker 790`

The answer stops splitting at a comma straight after cents, so "1,084.56,7,777.77" hides the second amount from the check. `IQ8` writes the pair.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ8 a figure is marked unless a result carried it, sign aside, in a link label or after letters too; whole numbers and percentages are not figures  marked: $5,000, 3,141.59, 2,718.28, 6,543.21, $9,999.99
=== 1 CHECK(S) FAILED ===
```

## A bill reading is an earlier question

`marker 791`

`earlierQuestionsFor` stops leaving out the exchanges a bill reading points
at. Every reading's instruction, file name and chart of accounts shows under
Earlier questions as if a person had asked it. `IQ16` files a reading whose
question is worded another way, so only the link can leave it out.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ16 earlier questions leave out bill readings, used or discarded, and another company's, and show a narrower seat only its own  owner sees 3: a reading whose question ; the clerk asked the old f; the owner asked the old f; clerk sees 1; the reading instruction begins with the shared sentence (source) true
=== 1 CHECK(S) FAILED ===
```

## A discarded reading comes back as a question

`marker 792`

The first-sentence test is dropped. Discarding a reading deletes its row, so
no link is left and only the question's first sentence says it was a reading;
without the test it shows under Earlier questions. `IQ16` keeps an exchange
no reading points at that begins with that sentence.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ16 earlier questions leave out bill readings, used or discarded, and another company's, and show a narrower seat only its own  owner sees 4: what the person gave you ; the attached bill, invoic; the clerk asked the old f; the owner asked the old f; clerk sees 1; the reading instruction begins with the shared sentence (source) true
=== 1 CHECK(S) FAILED ===
```

## A narrower seat reads everybody's earlier questions

`marker 793`

`earlierQuestionsFor` treats every viewer as holding every seat. A clerk
reads the owner's old questions and the books text each one sent, which the
clerk's own seats may not open. `IQ16` asks as the clerk.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ16 earlier questions leave out bill readings, used or discarded, and another company's, and show a narrower seat only its own  owner sees 2: the clerk asked the old f; the owner asked the old f; clerk sees 2; the reading instruction begins with the shared sentence (source) true
=== 1 CHECK(S) FAILED ===
```

## The reading spells out the sentence the page looks for

`marker 794`

`readBill`'s instruction writes its first sentence out again instead of
taking it from `READING_QUESTION_STARTS`. Nothing is wrong today; the day one
copy is reworded, discarded readings come back as questions. `IQ16` reads the
source for the shared sentence.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ16 earlier questions leave out bill readings, used or discarded, and another company's, and show a narrower seat only its own  owner sees 2: the clerk asked the old f; the owner asked the old f; clerk sees 1; the reading instruction begins with the shared sentence (source) false
=== 1 CHECK(S) FAILED ===
```

## A lost key is called a missing service

`marker 795`

The form tells a person whose saved key can no longer be read to save a
service, as if none were saved. They type the key again and never learn that
the application's secret changed, which leaves every other person's key
unreadable too. `AI18` changes the secret and asks through the form. (The
first mutant here dropped the form's no-service guard; `inquire` refuses a
missing service with the same sentence, so it changed nothing.)

```
$ db:verify-assistant | npm run db:verify-assistant
FAIL  AI18 a changed secret makes the key unreadable and says so; with no secret nothing saves; forgetting removes it and is trailed without it  changed secret → unreadable; no secret → NO_SECRET: Keys cannot be kept until the; cleared → none, newest trail row clear_ai_service; rows carrying the key: 0
=== 1 CHECK(S) FAILED ===
```

## The question forgets the price it was asked at

`marker 796`

`inquireFromForm` hands `inquire` no prices. The question is answered and
its cost can never be worked out, because the price is kept per question from
the saved service at the time. `IQ13` reads the price back.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ13 the question form carries no secret: the saved service answers it, and without one nothing is sent or kept  no service → Save your service first — its address, y (0 sent, 0 rows); saved → Answered.; price on record none; form fields ledgerId, question, inquiryId
=== 1 CHECK(S) FAILED ===
```

## A failed question says it was answered

`marker 797`

The form's sentence calls any question with a step answered. A declined or
failed question tells the person Answered, and they look for an answer that
is not there. `IQ14` fails one and declines one.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ14 a failed or declined question comes back as a sentence, not a stack  undefined | undefined
FAIL  IQ14b Keep looking from the form asks again on the question it names, and a question not offered it is refused in a sentence  at the limit → Answered.; pressed → Answered.; sent 1; not offered → This question did not stop for want of look-ups, so there is nothing to continue.
FAIL  IQ14c a question that looked up too much is told to ask a narrower one, not to keep looking  last step call_after_limit, capped true; the form said Answered.
=== 3 CHECK(S) FAILED ===
```

## Keep looking presses nothing

`marker 798`

`keepLookingFromForm` reads the company field where the question should be.
Every press names something that is not a question, and the button never
works. `IQ14b` presses from the form.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ14b Keep looking from the form asks again on the question it names, and a question not offered it is refused in a sentence  at the limit → It stopped at the limit before answering. You can let it keep looking.; pressed → There is no such question in this company.; sent 0; not offered → There is no such question in this company.
=== 1 CHECK(S) FAILED ===
```

## A question that looked up too much is told to keep looking

`marker 799`

The form's limit sentence stops asking whether another round is offered. A
question past the character limit tells the person to press Keep looking, and
the page has no button for it. `IQ14c` runs one past the limit through the
form.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ14c a question that looked up too much is told to ask a narrower one, not to keep looking  last step call_after_limit, capped true; the form said It stopped at the limit before answering. You can let it keep looking.
=== 1 CHECK(S) FAILED ===
```

## The question form carries a key field

`marker 800`

The question form grows a field for the key. Nothing sends it today, but the
form is where the key must never travel. `IQ13` renders the real forms and
reads their field names.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ13 the question form carries no secret: the saved service answers it, and without one nothing is sent or kept  no service → Save your service first — its address, y (0 sent, 0 rows); saved → Answered.; price on record 10; form fields ledgerId, aiApiKey, question, inquiryId
=== 1 CHECK(S) FAILED ===
```

## Earlier questions for a person without the seat

`marker 801`

`earlierQuestionsFor` stops asking for the Assistant seat. A person whose
seat was taken away still reads their old questions and the books text each
one sent, from any caller but the page's door. `IQ16b` asks as the outsider.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ16b a person without the Assistant seat is shown no earlier questions, not even their own  the outsider asked 1; shown 1
=== 1 CHECK(S) FAILED ===
```

## A failure after the limit hides behind the narrower line

`marker 802`

`stopLine` says a capped question looked up too much before it looks at how
the question ended. A question that reached the character limit and then
failed on the relay shows only ask a narrower one, and the failure on record
is nowhere on the page. `IQ14d` fails the turn after the limit.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ14d the page's line names a failure even after the character limit, and Keep looking is offered only to the asker on the service it was asked with  after the cap: This question looked up too much to go on. Ask a narrower one.; capped only: This question looked up too much to go on. Ask a narrower one.; offers to owner / owner on another model / clerk / no service: button, elsewhere, null, null
=== 1 CHECK(S) FAILED ===
```

## Keep looking is offered to someone who did not ask

`marker 803`

`keepLookingOffer` stops asking who asked. Every viewer who can see a
question gets its button, and every press but the asker's is refused.
`IQ14d` asks for the clerk.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ14d the page's line names a failure even after the character limit, and Keep looking is offered only to the asker on the service it was asked with  after the cap: The call failed: the relay said 502; capped only: This question looked up too much to go on. Ask a narrower one.; offers to owner / owner on another model / clerk / no service: button, elsewhere, button, null
=== 1 CHECK(S) FAILED ===
```

## The page offers a button the library will refuse

`marker 804`

`keepLookingOffer` stops comparing the saved service with the question's.
After a change of model the button stays, and every press is refused as a
changed service, with no word on the page why. `IQ14d` asks on another model.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ14d the page's line names a failure even after the character limit, and Keep looking is offered only to the asker on the service it was asked with  after the cap: The call failed: the relay said 502; capped only: This question looked up too much to go on. Ask a narrower one.; offers to owner / owner on another model / clerk / no service: button, button, null, null
=== 1 CHECK(S) FAILED ===
```

## Half a file is kept

`marker 805`

0077 no longer ties the four file columns together. A reading can keep a name with no bytes, which the file route answers with nothing and the card links to anyway. `BR22` writes half a file.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR22 the table refuses half a file, a reading of nothing and a blank sentence, and keeps an entered reading's sentence  half: written; nothing: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by) VALUES ; blank: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by, sentenc; newlines: Failed query: INSERT INTO ai_bill_readin; entering it: attached; changed: Failed query: UPDATE ai_bill_reading SET sentence 
=== 1 CHECK(S) FAILED ===
```

## A reading of nothing is kept

`marker 806`

0077 no longer asks for a file or a sentence. A row with neither is a card with nothing to review and two doors to enter it by. `BR22` writes one.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR22 the table refuses half a file, a reading of nothing and a blank sentence, and keeps an entered reading's sentence  half: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by, filenam; nothing: written; blank: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by, sentenc; newlines: Failed query: INSERT INTO ai_bill_readin; entering it: attached; changed: Failed query: UPDATE ai_bill_reading SET sentence 
=== 1 CHECK(S) FAILED ===
```

## A blank sentence is a sentence

`marker 807`

0077 lets a sentence of spaces, or of newlines, stand in for what was read. `BR22` writes both.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR22 the table refuses half a file, a reading of nothing and a blank sentence, and keeps an entered reading's sentence  half: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by, filenam; nothing: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by) VALUES ; blank: written; newlines: written; entering it: attached; changed: Failed query: UPDATE ai_bill_reading SET sentence 
=== 1 CHECK(S) FAILED ===
```

## The sentence behind an entered reading changes

`marker 808`

The trigger guards an entered reading's file but not its sentence. What a person wrote can be rewritten after it became an entry, and the record of what was read no longer matches what was posted. `BR22` rewrites it. (0080 re-issues the trigger, so the block edits 0080's copy: editing 0077's would edit a function nothing runs.)

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR22 the table refuses half a file, a reading of nothing and a blank sentence, and keeps an entered reading's sentence  half: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by, filenam; nothing: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by) VALUES ; blank: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by, sentenc; newlines: Failed query: INSERT INTO ai_bill_readin; entering it: attached; changed: written
=== 1 CHECK(S) FAILED ===
```

## The sentence is read and forgotten

`marker 809`

`readBill` stores no sentence. The reading from a sentence alone keeps nothing of what was written; the card and the form beside it cannot show it. `BR20` reads the row.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR20 a sentence alone is read with today's date and no file and kept without one; nothing, a blank, too long and half a document are refused first; the longest input reads; an empty file box is no file  the sentence was refused: Failed query: INSERT INTO ai_bill_reading (ledger_id, exchan; refusals EMPTY/EMPTY/TOO_LONG/EMPTY, sender reached 0, rows 4 → 4; user text, date sent true; row sentence false, file columns undefined/undefined/undefined/undefined; file not asked; card sentence false; longest → read; line breaks → Failed query: INSERT INTO ai_bill_readin; form → Failed query: 
FAIL  BR21 a sentence and a document leave together in one question and are kept together  text+image_url; file named true, sentence true; row both.png / null
FAIL  BR26 a reading from a sentence alone is entered at both doors with nothing filed, closed, and not said to be filed  expense: not read: Failed query: INSERT INTO ai_bill_reading (ledger_id, exchan; bill: not read: Failed query: INSERT INTO ai_bill_reading (ledger_id, exchan; files 0/0; closed true/true
FAIL  BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type  refused: Failed query: INSERT INTO ai_bill_reading (ledger_; destinations offered 14/14; opened undefined on blank; remembered 4000; unnamed → Income; party blank; a sale's number as income → ∅, a bill's → B-1; the page asks by kind true and offers its own parties true
FAIL  BR26b a reading from a sentence alone is entered as income and as a sales invoice, nothing filed, closed, and not said to be filed  income: not read: Failed query: INSERT INTO ai_bill_reading (ledger_id, exchan; sale: not read: Failed query: INSERT INTO ai_bill_reading (ledger_id, exchan; files -1/-1
=== 5 CHECK(S) FAILED ===
```

## Yesterday with no today

`marker 810`

The chart context stops carrying today's date. A sentence that says yesterday or last month is read against nothing, and the proposal's date is a guess. `BR20` looks for the date in what left.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR20 a sentence alone is read with today's date and no file and kept without one; nothing, a blank, too long and half a document are refused first; the longest input reads; an empty file box is no file  refusals EMPTY/EMPTY/TOO_LONG/EMPTY, sender reached 0, rows 4 → 4; user text, date sent false; row sentence true, file columns null/null/true/null; file none; card sentence true; longest → read; line breaks → read; form → Your sentence read: 1 line. Choose how to enter it below, then review.
=== 1 CHECK(S) FAILED ===
```

## Nothing is read anyway

`marker 811`

`readBill` stops refusing when neither a sentence nor a document arrived. The empty question goes to the service and is paid for before the table refuses the row. `BR20` asks with nothing, against a sender that must not be reached.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR20 a sentence alone is read with today's date and no file and kept without one; nothing, a blank, too long and half a document are refused first; the longest input reads; an empty file box is no file  refusals Faile/Faile/TOO_LONG/EMPTY, sender reached 2, rows 4 → 4; user text, date sent true; row sentence true, file columns null/null/true/null; file none; card sentence true; longest → read; line breaks → read; form → Your sentence read: 1 line. Choose how to enter it below, then review.
=== 1 CHECK(S) FAILED ===
```

## A sentence too long goes out

`marker 812`

`readBill` stops capping the sentence. It is sent and paid for, or refused by the question cap after the reading said nothing. `BR20` sends one character too many.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR20 a sentence alone is read with today's date and no file and kept without one; nothing, a blank, too long and half a document are refused first; the longest input reads; an empty file box is no file  refusals EMPTY/EMPTY/read/EMPTY, sender reached 1, rows 4 → 5; user text, date sent true; row sentence true, file columns null/null/true/null; file none; card sentence true; longest → read; line breaks → read; form → Your sentence read: 1 line. Choose how to enter it below, then review.
=== 1 CHECK(S) FAILED ===
```

## Half a document is read as none

`marker 813`

`readBill` stops asking for the name, the type and the contents together. A document that lost two of them is quietly dropped and the sentence is read alone. `BR20` hands in a name with no file.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR20 a sentence alone is read with today's date and no file and kept without one; nothing, a blank, too long and half a document are refused first; the longest input reads; an empty file box is no file  refusals EMPTY/EMPTY/TOO_LONG/read, sender reached 1, rows 4 → 5; user text, date sent true; row sentence true, file columns null/null/true/null; file none; card sentence true; longest → read; line breaks → read; form → Your sentence read: 1 line. Choose how to enter it below, then review.
=== 1 CHECK(S) FAILED ===
```

## An empty file box is a file

`marker 814`

The form takes the unnamed, empty file a browser sends for a file box left alone as a document. Every sentence typed without a file is refused as an empty file. `BR20` posts the form that way.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR11 the form door reads with the saved service; no file and no service are sentences; discard from the form  till.png read: 2 lines. Choose how to enter it below, then review.; Write what happened, or choose; empty file: The file is empty — nothing ar; Save your service first — its ; till.png discarded. The asking itself stays on record.
FAIL  BR20 a sentence alone is read with today's date and no file and kept without one; nothing, a blank, too long and half a document are refused first; the longest input reads; an empty file box is no file  refusals EMPTY/EMPTY/TOO_LONG/EMPTY, sender reached 0, rows 4 → 4; user text, date sent true; row sentence true, file columns null/null/true/null; file none; card sentence true; longest → read; line breaks → read; form → The file is empty — nothing arrived to read.
=== 2 CHECK(S) FAILED ===
```

## A stored proposal loses its party

`marker 815`

`proposalOf` stops reading the old word. Every reading stored before 2026-09-15 opens its forms with no supplier named. `BR23` stores one in the old words.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR23 a proposal names the other side as party, in four directions; a model's old words and a proposal stored in them read as party  directions expense,bill,income,sale; old answer → Old Words Ltd.; unknown → other; stored →  / listed ; supplier left on it false
=== 1 CHECK(S) FAILED ===
```

## A destination nobody has is kept

`marker 816`

`suggestsOf` passes any word through instead of checking it against the catalogue. A proposal naming a destination this app does not have reaches a card with no door for it. `BR23` reads one; `B32` reads an unknown answer.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  B32 a reading that is not a transaction says so, and is not filed as an expense  "other" kept as "a certificate of incorporation"; an unknown answer -> a contract; a pre-2026-09-16 row -> bill with suggestedKind null
FAIL  BR23 a proposal names the other side as party, in four directions; a model's old words and a proposal stored in them read as party  directions expense,bill,income,sale; old answer → Old Words Ltd.; unknown → refund; stored → Stored Before Ltd. / listed Stored Before Ltd.; supplier left on it false
=== 2 CHECK(S) FAILED ===
```

## A model's old words lose the party

`marker 817`

`parseProposal` reads only party. A model that still answers supplier leaves the other side blank. `BR23` answers in the old words.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR23 a proposal names the other side as party, in four directions; a model's old words and a proposal stored in them read as party  directions expense,bill,income,sale; old answer → ; unknown → other; stored → Stored Before Ltd. / listed Stored Before Ltd.; supplier left on it false
=== 1 CHECK(S) FAILED ===
```

## A sentence is filed as a document

`marker 818`

`attachReadingTo` files whatever it has, and a reading from a sentence alone has no bytes. The filing fails after the entry posted, and the door says the bill could not be filed. `BR26` enters one at both doors.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR22 the table refuses half a file, a reading of nothing and a blank sentence, and keeps an entered reading's sentence  half: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by, filenam; nothing: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by) VALUES ; blank: Failed query: INSERT INTO ai_bill_reading (ledger_id, read_by, sentenc; newlines: Failed query: INSERT INTO ai_bill_readin; entering it: The first argument must be of type string or an in; changed: written
FAIL  BR26 a reading from a sentence alone is entered at both doors with nothing filed, closed, and not said to be filed  expense: Posted as EXP-00006. The document could not be filed against it (The f; bill: Saved to the books. The document could not be filed against it (The fi; files 0/0; closed false/false
FAIL  BR26b a reading from a sentence alone is entered as income and as a sales invoice, nothing filed, closed, and not said to be filed  income: Posted as INC-00001. The document could not be filed against it (The f; sale: Saved to the books. The document could not be filed against it (The fi; files 0/0
=== 3 CHECK(S) FAILED ===
```

## The expense door says a sentence was filed

`marker 819`

`quickEntryFromForm` says the bill is filed against the entry whether or not there was one. The person opens the entry to find nothing attached. `BR26` enters a sentence alone.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR26 a reading from a sentence alone is entered at both doors with nothing filed, closed, and not said to be filed  expense: Posted as EXP-00006. The document is filed against it.; bill: Saved to the books. The reading is marked entered.; files 0/0; closed true/true
FAIL  BR26b a reading from a sentence alone is entered as income and as a sales invoice, nothing filed, closed, and not said to be filed  income: Posted as INC-00001. The document is filed against it.; sale: Saved to the books. The reading is marked entered.; files 0/0
=== 2 CHECK(S) FAILED ===
```

## The bill door says a sentence was filed

`marker 820`

`createInvoiceFromForm` says the bill is filed against its entry whether or not there was one. `BR26` enters a sentence alone at this door too.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR26 a reading from a sentence alone is entered at both doors with nothing filed, closed, and not said to be filed  expense: Posted as EXP-00006. The reading is marked entered.; bill: Saved to the books. The document is filed against its entry.; files 0/0; closed true/true
FAIL  BR26b a reading from a sentence alone is entered as income and as a sales invoice, nothing filed, closed, and not said to be filed  income: Posted as INC-00001. The reading is marked entered.; sale: Saved to the books. The document is filed against its entry.; files 0/0
=== 2 CHECK(S) FAILED ===
```

## The file route reads a reading with no file

`marker 821`

`readingFile` stops leaving out a reading with no bytes, and turning nothing into a file throws. `BR20` asks for the file of a sentence.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR20 a sentence alone is read with today's date and no file and kept without one; nothing, a blank, too long and half a document are refused first; the longest input reads; an empty file box is no file  refusals EMPTY/EMPTY/TOO_LONG/EMPTY, sender reached 0, rows 4 → 4; user text, date sent true; row sentence true, file columns null/null/true/null; file threw: The first argument must; card sentence true; longest → read; line breaks → read; form → Your sentence read: 1 line. Choose how to enter it below, then review.
=== 1 CHECK(S) FAILED ===
```

## A sentence cannot be searched for

`marker 822`

The search looks at file names only. A reading from a sentence alone has none, and nothing typed into the search box finds it. `SR11b` searches for its words.

```
$ db:verify-search | npm run db:verify-search
FAIL  SR11b a reading from a sentence alone is found by its words and titled by them, in its own ledger only  0 reading hit(s): ; the other company sees 0
=== 1 CHECK(S) FAILED ===
```

## A sale remembers a purchase

`marker 823`

`rememberedAccount` takes an expense or a revenue account, whichever is newest. A party on both sides has its last purchase remembered onto money coming in. `BR18c` asks both ways.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR18c a remembered account is of the direction asked for: a party on both sides gives its purchase to money out and its sale to money in  money out → 5300; money in → 5300
FAIL  BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type  destinations offered 14/14; opened Beta Services on 4000; remembered 5300; unnamed → Income; party beta; a sale's number as income → ∅, a bill's → B-1; the page asks by kind true and offers its own parties true
=== 2 CHECK(S) FAILED ===
```

## The old first sentence is replaced, not kept

`marker 824`

`READING_QUESTION_STARTS` loses the sentence every reading before 2026-09-15 began with. Those readings, discarded, come back under Earlier questions with their chart of accounts. `IQ16` writes one out.

```
$ db:verify-inquiry | npm run db:verify-inquiry
FAIL  IQ16 earlier questions leave out bill readings, used or discarded, and another company's, and show a narrower seat only its own  owner sees 3: the attached bill, invoic; the clerk asked the old f; the owner asked the old f; clerk sees 1; the reading instruction begins with the shared sentence (source) true
=== 1 CHECK(S) FAILED ===
```

## A long file name goes out whole

`marker 825`

The file's name is sent unshortened — four hundred characters of somebody's naming, verbatim, to a relay. It used to be caught by the question cap too, when the prompt and the person's sentence shared one 4,000-character limit; splitting those on 2026-09-16 put that ceiling out of reach and left this block biting nothing, which `db:toothless` said out loud. `BR2b` reads what actually leaves.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR2b a long file name is shortened before it leaves                 404 characters named, 400 sent (cap 200), ellipsis false
=== 1 CHECK(S) FAILED ===
```

## The card forgets the sentence

`marker 826`

`readingCards` hands the browser no sentence. A reading from a sentence alone shows as a card with no file and nothing written. `BR20` builds a card from one.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR20 a sentence alone is read with today's date and no file and kept without one; nothing, a blank, too long and half a document are refused first; the longest input reads; an empty file box is no file  refusals EMPTY/EMPTY/TOO_LONG/EMPTY, sender reached 0, rows 4 → 4; user text, date sent true; row sentence true, file columns null/null/true/null; file none; card sentence false; longest → read; line breaks → read; form → Your sentence read: 1 line. Choose how to enter it below, then review.
FAIL  BR27 the page has a box to write in and a file it does not require; a card offers its direction's pair, the model's choice first, and the other direction quietly; a sentence shows and links no file  box true, file required false; income 1131<1758<2337; sale 1152<1790; bill 2175<2788<3966; file link on the sentence false
=== 2 CHECK(S) FAILED ===
```

## A sentence beside a document stays behind

`marker 827`

`readBill` sends the sentence only when there is no document. What the person wrote about the bill in their hand never reaches the model, though it is kept. `BR21` sends both.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR21 a sentence and a document leave together in one question and are kept together  text+image_url; file named true, sentence false; row both.png / Staples again, paid by card
=== 1 CHECK(S) FAILED ===
```

## An empty file is told to write something

`marker 828`

The form answers a chosen file of no bytes with the sentence for a form with
nothing in it, asking the person to write what happened on a page that has
nowhere to write. `BR11` sends an empty file by name.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR11 the form door reads with the saved service; no file and no service are sentences; discard from the form  till.png read: 2 lines. Choose how to enter it below, then review.; Write what happened, or choose; empty file: Write what happened, or choose; Save your service first — its ; till.png discarded. The asking itself stays on record.
=== 1 CHECK(S) FAILED ===
```

## The model is offered half the app

`marker 829`

`destinationMenu` lists only the money destinations. A registration document, a director's consent and a bank statement all meet a menu that cannot hold them, and the model has to force one of four again — which is the defect this catalogue was built to end. `BR24` counts the destinations in the question.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type  destinations offered 11/14; opened Beta Services on 4000; remembered 4000; unnamed → Income; party beta; a sale's number as income → ∅, a bill's → B-1; the page asks by kind true and offers its own parties true
=== 1 CHECK(S) FAILED ===
```

## A sales invoice loses its number

`marker 830`

`invoiceInitialFrom` leaves our number blank on a sales invoice. The document's number goes nowhere and a repeated number is never refused. `BR25` reads the header.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR25 a sales invoice opens on the customer by name, the receivable account and the document's number as ours; a bill keeps it as theirs  customer matched; number ∅ / theirs ∅; stranger → Nobody Known Ltd; as a bill → theirs INV-042, ours ∅; sides sales/revenue/customer,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier; remembered lines 2; the page body uses 4 of 4
=== 1 CHECK(S) FAILED ===
```

## A sales invoice's number is filed as theirs

`marker 831`

`invoiceInitialFrom` puts the document's number in their reference whatever the direction, so a sales invoice carries our own number as the customer's. `BR25` reads the header.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR25 a sales invoice opens on the customer by name, the receivable account and the document's number as ours; a bill keeps it as theirs  customer matched; number INV-042 / theirs INV-042; stranger → Nobody Known Ltd; as a bill → theirs INV-042, ours ∅; sides sales/revenue/customer,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier; remembered lines 2; the page body uses 4 of 4
=== 1 CHECK(S) FAILED ===
```

## The income form remembers an expense account

`marker 832`

The quick form asks the books for an expense account whatever its kind. Income from a party on both sides opens on its last purchase's account, marked as remembered. `BR24` reads what the page asks for.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type  destinations offered 14/14; opened Beta Services on 4000; remembered 4000; unnamed → Income; party beta; a sale's number as income → ∅, a bill's → B-1; the page asks by kind false and offers its own parties true
=== 1 CHECK(S) FAILED ===
```

## The sales invoice remembers an expense account

`marker 833`

The invoice form asks the books for an expense account whatever its direction. `BR25` reads what the page asks for.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR25 a sales invoice opens on the customer by name, the receivable account and the document's number as ours; a bill keeps it as theirs  customer matched; number INV-042 / theirs ∅; stranger → Nobody Known Ltd; as a bill → theirs INV-042, ours ∅; sides sales/revenue/customer,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier; remembered lines 2; the page body uses 3 of 4
=== 1 CHECK(S) FAILED ===
```

## Money in is offered as money out

`marker 834`

The card treats every reading as money going out. A sentence about income offers an expense and a bill, and income only in the quiet line. `BR27` renders a card of each.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR27 the page has a box to write in and a file it does not require; a card offers its direction's pair, the model's choice first, and the other direction quietly; a sentence shows and links no file  box true, file required false; income 3036<3241<1245; sale 3262<3057; bill 2279<2892<4070; file link on the sentence false
=== 1 CHECK(S) FAILED ===
```

## The model's choice is not the main button

`marker 835`

The card always leads with the first of the pair, so a bill or a sales invoice the model recognised opens behind the other button. `BR27` and `BR12` read the order.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR12 the page's cards, from real rows: both doors with the id, likelier first; a missing account said; used and broken ones offer no door  used card → its entry; bill card: expense link true, bill link true; no-account 1; used doors false
FAIL  BR27 the page has a box to write in and a file it does not require; a card offers its direction's pair, the model's choice first, and the other direction quietly; a sentence shows and links no file  box true, file required false; income 1245<1872<2451; sale 1893<1266; bill 2908<2279<4070; file link on the sentence false
=== 2 CHECK(S) FAILED ===
```

## A sales invoice opens as a purchase bill

`marker 836`

The sales link drops its direction, so the invoice form opens a reading of a sale as a purchase bill on the suppliers list. `BR27` reads the link.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR27 the page has a box to write in and a file it does not require; a card offers its direction's pair, the model's choice first, and the other direction quietly; a sentence shows and links no file  box true, file required false; income 1245<1872<2431; sale 1266<1884; bill 2279<2892<4070; file link on the sentence false
=== 1 CHECK(S) FAILED ===
```

## The page has nowhere to write

`marker 837`

The sentence box posts under another field's name, so nothing written reaches the reader and every sentence-only submission is refused. `BR27` looks for the field.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR27 the page has a box to write in and a file it does not require; a card offers its direction's pair, the model's choice first, and the other direction quietly; a sentence shows and links no file  box false, file required false; income 1245<1872<2451; sale 1266<1904; bill 2279<2892<4070; file link on the sentence false
=== 1 CHECK(S) FAILED ===
```

## A file is required again

`marker 838`

The file box is required, so a sentence cannot be sent without choosing a file. `BR27` reads the input.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR27 the page has a box to write in and a file it does not require; a card offers its direction's pair, the model's choice first, and the other direction quietly; a sentence shows and links no file  box true, file required true; income 1245<1872<2451; sale 1266<1904; bill 2279<2892<4070; file link on the sentence false
=== 1 CHECK(S) FAILED ===
```

## Income without a name is called a bill

`marker 839`

`quickInitialFrom` falls back to Bill for any kind, so income the model could not name opens described as a bill. `BR24` opens one.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type  destinations offered 14/14; opened Beta Services on 4000; remembered 4000; unnamed → Bill; party beta; a sale's number as income → ∅, a bill's → B-1; the page asks by kind true and offers its own parties true
=== 1 CHECK(S) FAILED ===
```

## Every reading opens as a purchase bill

`marker 840`

`invoiceInitialFrom` forgets the direction it was given, so the invoice form opens a sale on the purchase side. `BR25` reads the direction.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR25 a sales invoice opens on the customer by name, the receivable account and the document's number as ours; a bill keeps it as theirs  customer matched; number INV-042 / theirs ∅; stranger → Nobody Known Ltd; as a bill → theirs INV-042, ours ∅; sides sales/revenue/customer,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier; remembered lines 2; the page body uses 4 of 4
=== 1 CHECK(S) FAILED ===
```

## A line break counts twice

`marker 841`

`readBill` measures the sentence with the browser's two-character line breaks, so a sentence the box accepted at its limit is refused as too long. `BR20` reads one with three.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR20 a sentence alone is read with today's date and no file and kept without one; nothing, a blank, too long and half a document are refused first; the longest input reads; an empty file box is no file  refusals EMPTY/EMPTY/TOO_LONG/EMPTY, sender reached 0, rows 4 → 4; user text, date sent true; row sentence true, file columns null/null/true/null; file none; card sentence true; longest → read; line breaks → TOO_LONG: That is longer than 2000 chara; form → Your sentence read: 1 line. Choose how to enter it below, then review.
=== 1 CHECK(S) FAILED ===
```

## The invoice form names no remembered line

`marker 842`

`rememberedLines` finds none, so a sales invoice opens with an account taken from the books looking like one a person chose. `BR25` opens one.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR25 a sales invoice opens on the customer by name, the receivable account and the document's number as ours; a bill keeps it as theirs  customer matched; number INV-042 / theirs ∅; stranger → Nobody Known Ltd; as a bill → theirs INV-042, ours ∅; sides sales/revenue/customer,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier; remembered lines none; the page body uses 4 of 4
=== 1 CHECK(S) FAILED ===
```

## A sales invoice opens on the suppliers list

`marker 843`

The invoice body offers the purchase side's parties whatever the direction, so a sale from a reading finds no customer and says so falsely. `BR25` reads what the body offers (source).

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR25 a sales invoice opens on the customer by name, the receivable account and the document's number as ours; a bill keeps it as theirs  customer matched; number INV-042 / theirs ∅; stranger → Nobody Known Ltd; as a bill → theirs INV-042, ours ∅; sides sales/revenue/customer,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier; remembered lines 2; the page body uses 3 of 4
=== 1 CHECK(S) FAILED ===
```

## The income form names no party

`marker 844`

`quickInitialFrom` leaves the Party box empty though the reading names a customer the books have, so income is posted to nobody unless the person notices. `BR24` opens one.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type  destinations offered 14/14; opened Beta Services on 4000; remembered 4000; unnamed → Income; party blank; a sale's number as income → ∅, a bill's → B-1; the page asks by kind true and offers its own parties true
=== 1 CHECK(S) FAILED ===
```

## A sale read as income carries our number as theirs

`marker 845`

`quickInitialFrom` puts a sale's number in the income form's their-reference box, where our own invoice number does not belong. `BR24` opens one.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type  destinations offered 14/14; opened Beta Services on 4000; remembered 4000; unnamed → Income; party beta; a sale's number as income → INV-9, a bill's → B-1; the page asks by kind true and offers its own parties true
=== 1 CHECK(S) FAILED ===
```

## A reading entered twice is not said to be twice

`marker 846`

`attachReadingTo` says only that the bill was entered. A second form that raced the first has posted the same thing again and the person is not told to check. `BR8` attaches a used reading.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR8 a used reading cannot be attached, moved or deleted; a reading is attachable and discardable in its own company only  again: ALREADY_ENTERED: That bill has already b; moved: Failed query: UPDATE ai_bill_r; deleted: Failed query: DELETE FROM ai_b; elsewhere: NO_READING: That reading is not in these; 1/0/0 files
=== 1 CHECK(S) FAILED ===
```

## The invoice form hides its remembered lines

`marker 847`

The invoice body never shows the note naming the lines filled from the books. `BR25` reads the body (source).

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR25 a sales invoice opens on the customer by name, the receivable account and the document's number as ours; a bill keeps it as theirs  customer matched; number INV-042 / theirs ∅; stranger → Nobody Known Ltd; as a bill → theirs INV-042, ours ∅; sides sales/revenue/customer,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier; remembered lines 2; the page body uses 3 of 4
=== 1 CHECK(S) FAILED ===
```

## Every reading opens on the purchase side

`marker 848`

`invoiceSideFor` ignores the direction, so a sale opens as a purchase bill on the suppliers list with the payable account. `BR25` asks it each way.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR25 a sales invoice opens on the customer by name, the receivable account and the document's number as ours; a bill keeps it as theirs  customer matched; number INV-042 / theirs ∅; stranger → Nobody Known Ltd; as a bill → theirs INV-042, ours ∅; sides purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier; remembered lines 2; the page body uses 4 of 4
=== 1 CHECK(S) FAILED ===
```

## The income form looks for a supplier

`marker 849`

The quick body hands the income form the suppliers list to match the reading's party in. `BR24` reads the body (source).

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type  destinations offered 14/14; opened Beta Services on 4000; remembered 4000; unnamed → Income; party beta; a sale's number as income → ∅, a bill's → B-1; the page asks by kind true and offers its own parties false
=== 1 CHECK(S) FAILED ===
```

## A reading's rows go into the same table twice

`marker 850`

The rows door stops asking whether this table was already entered from this reading before it marks it. 0080's trigger still refuses rewriting the mark — so nothing is doubled — but the door never words that refusal, and the person reads a bare database failure instead of being told the rows are already in the register. `CR41` presses Add twice and reads what the second press says.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR41 a reading carries rows the add forms take, and each table enters once  tables kept directors,minute_book; foreign columns dropped; kinds directors_resolution/shareholders_minutes; unreadable date left blank; first Entered 1 director. Added to this company's list: Avery Stone.; again Nothing was entered. Failed query: ; 1 term(s) for Avery; minutes Entered 2 minute-book records.; marked directors,minute_book; discard refused; the prompt names every table and column
=== 1 CHECK(S) FAILED ===
```

## Rows of one day go in in the order they were typed

`marker 851`

`sameDayRank` stops putting an issue before the transfer of what it issued. A minute book's first page is all one date, and a transfer typed above its issue is then refused as an overdrawn holding that never was. `CR39` types them in that order.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR39 a same-day issue and transfer go in in the order they must, whatever order they were typed  Nothing was entered. Row 1: Founder Holdings Ltd. is not on this company's list, and nobody gives up shares they never held.; held nothing; kinds 
FAIL  CR40 a refused row takes the whole form back, and every row's problems are said at once  Nothing was entered. Row 2: Nobody Holds Ltd. is not on this company's list, and nobody gives up shares they never held.; movements 0 → 0; class or holder left behind 0; overdrawn: Nothing was entered. Row 2: Founder Holdings Ltd. is not on , movements then 0; problems: Nothing was entered. Row 1: Director is missing. / Row 2: give Appointed or Ceased — a row with neither says nothing happened.
=== 2 CHECK(S) FAILED ===
```

## A movement the database refuses no longer names its row

`marker 852`

The batch stops asking for the share checks at the end of each statement, so 0035's deferred checks run at the commit, after the row loop has finished — and a form of twenty rows is told something was overdrawn, not which row. `CR40` overdraws in row 2 and reads the row number.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR40 a refused row takes the whole form back, and every row's problems are said at once  Nothing was entered. Row 2: Nobody Holds Ltd. is not on this company's list, and nobody gives up shares they never held.; movements 3 → 3; class or holder left behind 0; overdrawn: Nothing was entered. SHARES_OVERDRAWN: that holder would be , movements then 3; problems: Nothing was entered. Row 1: Director is missing. / Row 2: give Appointed or Ceased — a row with neither says nothing happened.
=== 1 CHECK(S) FAILED ===
```

## Only the first row's problems are said

`marker 853`

`rowProblems` reads row 1 and stops. A form of twenty rows with three missing dates is fixed one refusal at a time, which is the paste box's lesson unlearned. `CR40` sends two bad rows and reads both.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR40 a refused row takes the whole form back, and every row's problems are said at once  Nothing was entered. Row 2: Nobody Holds Ltd. is not on this company's list, and nobody gives up shares they never held.; movements 3 → 3; class or holder left behind 0; overdrawn: Nothing was entered. Row 2: SHARES_OVERDRAWN: that holder wo, movements then 3; problems: Nothing was entered. Row 1: Director is missing.
=== 1 CHECK(S) FAILED ===
```

## Somebody nobody has heard of gives up shares

`marker 854`

The rows door stops refusing a stranger in From and adds them to the list instead, as it does for somebody receiving shares. The holding check still refuses the movement — but by an amount, not by who, so the person is told a number went negative instead of that the name is wrong. `CR40` names a stranger.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR40 a refused row takes the whole form back, and every row's problems are said at once  Nothing was entered. Row 2: SHARES_OVERDRAWN: that holder would be at -5 shares on 2023-02-01; nobody transfers shares they do not hold; movements 3 → 3; class or holder left behind 0; overdrawn: Nothing was entered. Row 2: SHARES_OVERDRAWN: that holder wo, movements then 3; problems: Nothing was entered. Row 1: Director is missing. / Row 2: give Appointed or Ceased — a row with neither says nothing happened.
=== 1 CHECK(S) FAILED ===
```

## The rows door takes the company from the form

`marker 855`

`enterRowsFromForm` reads an entity id off the form before the ledger's own, so a form carrying another company's id enters rows in that company's registers. `CR37` sends their id beside our ledger and counts both registers.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR37 the id doors refuse another company's entity or directorship; the rows door enters only here and says whom it used from elsewhere  profile and cease refused; the rows door said Entered 1 share movement.; movements landed: 0 here, 1 theirs; their director still serving, 1 term(s) of theirs; the use of their party is NOT said
=== 1 CHECK(S) FAILED ===
```

## A model's foreign columns ride along

`marker 856`

`rowsFrom` keeps whatever else the model put in a row beside the columns the form takes. The proposal stored on the reading then carries keys no form reads and no door checks. `CR41` answers with a column that does not exist.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR41 a reading carries rows the add forms take, and each table enters once  tables kept directors,minute_book; foreign columns KEPT; kinds directors_resolution/shareholders_minutes; unreadable date left blank; first Entered 1 director. Added to this company's list: Avery Stone.; again Nothing was entered. The rows of that reading are already in the directors register — entering them again would record everything twice. Add any row still missing by hand.; 1 term(s) for Avery; minutes Entered 2 minute-book records.; marked directors,minute_book; discard refused; the prompt names every table and column
FAIL  CR42 a model's rows are taken the way the form takes them, and nothing is guessed  not so: an empty row is no row
=== 2 CHECK(S) FAILED ===
```

## A date the model could not read is put in the box anyway

`marker 857`

`formRowsFrom` stops blanking a date that is not one, so the date box is handed March 3rd. The note under the row still says what was read, but the box now holds text a date field cannot show, and the form posts it. `CR41` reads the form rows; `CR43` renders the form and finds the unread date in the box's value.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR41 a reading carries rows the add forms take, and each table enters once  tables kept directors,minute_book; foreign columns dropped; kinds directors_resolution/shareholders_minutes; unreadable date GUESSED; first Entered 1 director. Added to this company's list: Avery Stone.; again Nothing was entered. The rows of that reading are already in the directors register — entering them again would record everything twice. Add any row still missing by hand.; 1 term(s) for Avery; minutes Nothing was entered. Row 2: Date "March 3rd" is not a date.; marked directors; discard refused; the prompt names every table and column
FAIL  CR43 the records screen has no boxes at rest, and an add form submits every column of every row  at rest 0 box(es), 5/5 add links, profile link there, 2 Cease button(s); the minute book links its document and links to document management; the shares form names every column of both rows, carries its table and reading, the date it could not read is in the note and PUT IN THE DATE BOX, 1 name(s) marked new, 1 marked as another company's
=== 2 CHECK(S) FAILED ===
```

## The records screen opens a date box on every row again

`marker 858`

Cease starts open, so every director and significant individual carries a date box and a button at rest — the blank-on-the-page the owner asked to be rid of. `CR43` renders the screen and counts named fields.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR43 the records screen has no boxes at rest, and an add form submits every column of every row  at rest 6 box(es), 5/5 add links, profile link there, 0 Cease button(s); the minute book links its document and links to document management; the shares form names every column of both rows, carries its table and reading, the date it could not read is in the note and not put in the date box, 1 name(s) marked new, 1 marked as another company's
FAIL  CR51 a row's Edit opens its own boxes on press, holding what is on file  at rest 6 box(es), 6 Edit button(s); minute book opens with its table, row and values; transfer keeps its kind and balance certificate; significant individual has blank private boxes that say so
=== 2 CHECK(S) FAILED ===
```

## The add form forgets the reading it was filled from

`marker 859`

The rows form stops posting the reading's id, so rows read from a minute book enter as if typed by hand and nothing stops them being entered twice. `CR43` renders the form and reads its hidden fields.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR43 the records screen has no boxes at rest, and an add form submits every column of every row  at rest 0 box(es), 5/5 add links, profile link there, 2 Cease button(s); the minute book links its document and links to document management; the shares form names every column of both rows, does NOT carry its table and reading, the date it could not read is in the note and not put in the date box, 1 name(s) marked new, 1 marked as another company's
=== 1 CHECK(S) FAILED ===
```

## A reading offers only the table the model named

`marker 860`

The card keeps just the table `suggests` points at. A minute book read as a minute book then offers the minute book, and the directors and shares it read have no door. `BR32` renders a reading with rows for two tables.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR32 a reading offers every record table it filled, once, counts what went in, and one entered anywhere is kept  minute book offered; directors NOT offered; NOT counted; discard offered; the entered table not offered again; does NOT say entered; the other table still offered; no discard on a kept reading
=== 1 CHECK(S) FAILED ===
```

## A reading whose rows are in the record offers Discard

`marker 861`

The card offers Discard whatever the reading has become. 0080 refuses the delete, so pressing it only produces a refusal. `BR32` renders a reading already entered into one table.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR32 a reading offers every record table it filled, once, counts what went in, and one entered anywhere is kept  minute book offered; directors offered; counted; discard offered; the entered table not offered again; says 1 entered; the other table still offered; DISCARD OFFERED on a kept reading
=== 1 CHECK(S) FAILED ===
```

## Every hour row opens with its boxes showing

`marker 862`

The Time table renders every row in its edit form, which is the page of blanks the owner called 凌乱. `S38` renders the table at rest and counts named fields.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S38 every SR&ED list reads as text until a row is opened    hours: 3 row(s), 9 box(es); evidence: 3 row(s), 0 box(es); rates: 3 row(s), 0 box(es); the project: 1 row(s), 0 box(es); costs: 5 row(s), 0 box(es); the three answers and filing: 2 row(s), 0 box(es); the year strip: 1 row(s), 0 box(es); opened: hours 9, evidence 4, rates 8, the project 6, costs 3
=== 1 CHECK(S) FAILED ===
```

## The rate table opens on its first row's boxes

`marker 863`

The rates start with a row open. `S38` renders them at rest.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S36 a rate can be put in, corrected and taken away, and each row edits itself  11 rate(s) to start; adding worked and it landed as sent; refusals: a jurisdiction nobody prices BAD_JURISDICTION, a confidence off the list BAD_CONFIDENCE, no name NO_NAME, no authority NO_AUTHORITY, a value that is not a number BAD_VALUE, an end before the start BACKWARDS, no start at all NO_DATE, a delete with no row named NO_ROW; correcting worked to 0.43; deleting worked, back to 11; with a year filed (yes), a rate that year's paper is built from: editing FILED_YEAR, deleting FILED_YEAR, while a new row from a later day went in and un-filing worked; the screen does NOT and MISSES the editing consequences
FAIL  S38 every SR&ED list reads as text until a row is opened    hours: 3 row(s), 0 box(es); evidence: 3 row(s), 0 box(es); rates: 3 row(s), 8 box(es); the project: 1 row(s), 0 box(es); costs: 5 row(s), 0 box(es); the three answers and filing: 2 row(s), 0 box(es); the year strip: 1 row(s), 0 box(es); opened: hours 3, evidence 4, rates 8, the project 6, costs 3
=== 2 CHECK(S) FAILED ===
```

## Somebody from another company's list is used without a word

`marker 864`

The rows door stops saying when a name it matched belongs to a party only another company has. The row still goes in against that party — the owner's call — but silently, which is the one thing the owner said it must not be (2026-09-16: 可以用，但必须写出来). `CR37` and `CR38` read the sentence.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR37 the id doors refuse another company's entity or directorship; the rows door enters only here and says whom it used from elsewhere  profile and cease refused; the rows door said Entered 1 share movement. New share class: Their Class A.; movements landed: 1 here, 0 theirs; their director still serving, 1 term(s) of theirs; the use of their party is NOT said
FAIL  CR38 a form of directors goes in by date, adds the new name, finds the known one and says it came from elsewhere  Entered 3 directors. Added to this company's list: Morgan Lee.; terms Dana Chen 2022-03-01.., Morgan Lee 2022-03-01..2024-06-30; Dana given the role here 1x, 1 Dana Chen on the list
=== 2 CHECK(S) FAILED ===
```

## The card counts what was read as what was entered

`marker 865`

The reading card prints the model's row count beside Entered, not the count the door stored. A person who took a row out before pressing Enter is told every row went in. `BR32` marks 1 entered of 2 read.

```
$ db:verify-bills | npm run db:verify-bills
FAIL  BR32 a reading offers every record table it filled, once, counts what went in, and one entered anywhere is kept  minute book offered; directors offered; counted; discard offered; the entered table not offered again; says what was READ, not entered; the other table still offered; no discard on a kept reading
=== 1 CHECK(S) FAILED ===
```

## The add form stops marking a name from another company

`marker 866`

The rows form no longer tells a person, before they press Enter, that a name will be matched to another company's party. The mark is drawn by `RecordCell`, which a row's Edit draws too (0083). `CR43` renders one of each.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR43 the records screen has no boxes at rest, and an add form submits every column of every row  at rest 0 box(es), 5/5 add links, profile link there, 2 Cease button(s); the minute book links its document and links to document management; the shares form names every column of both rows, carries its table and reading, the date it could not read is in the note and not put in the date box, 1 name(s) marked new, 0 marked as another company's
=== 1 CHECK(S) FAILED ===
```

## The year's three answers open as boxes

`marker 867`

The claim's three questions, the method and the assistance answer start in their edit form, so the Record tab is three textareas and a checkbox before anybody asked to change anything. `S38` renders the claim at rest.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S38 every SR&ED list reads as text until a row is opened    hours: 3 row(s), 0 box(es); evidence: 3 row(s), 0 box(es); rates: 3 row(s), 0 box(es); the project: 1 row(s), 0 box(es); costs: 5 row(s), 0 box(es); the three answers and filing: 2 row(s), 12 box(es); the year strip: 1 row(s), 0 box(es); opened: hours 3, evidence 4, rates 8, the project 6, costs 3
=== 1 CHECK(S) FAILED ===
```

## Mark filed opens with its date box showing

`marker 868`

The filing card's buttons start revealed, so the working paper carries a date box (or a reason box, once filed) at rest. `S38` renders the card drafted and filed.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S38 every SR&ED list reads as text until a row is opened    hours: 3 row(s), 0 box(es); evidence: 3 row(s), 0 box(es); rates: 3 row(s), 0 box(es); the project: 1 row(s), 0 box(es); costs: 5 row(s), 0 box(es); the three answers and filing: 2 row(s), 2 box(es); the year strip: 1 row(s), 0 box(es); opened: hours 3, evidence 4, rates 8, the project 6, costs 3
=== 1 CHECK(S) FAILED ===
```

## A minute-book document is filed against another company's record

`marker 869`

`attachMinuteBookFromForm` stops asking whose record the id names, so a form under this ledger files paper into another company's minute book. `AT16` sends their record's id.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT16 the minute book's paper doors refuse another company's record and document  attach: There is no such minute-book record in these books.; unfile: That is not in this company's books.; their documents 1
=== 1 CHECK(S) FAILED ===
```

## The folder rebuild forgets the minute book

`marker 870`

`rebuildAttachmentTree` wipes every folder but the blobs and relinks only the entries' receipts, so a rebuild — the remedy the screen offers — deletes the Minute book folder and never puts it back. `AT15` removes a link and rebuilds.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT15 a minute-book record's document is one blob, linked in its own folder, provable, and unfiled cleanly  filed on two records; 1 blob file(s); link in Minute book/2026; served as 2026-03-01 directors resolution Approve the stationery budget.pdf; twice ALREADY_ATTACHED; listed 2; sweep before 0 problem(s), after removing the link names it; rebuild did NOT; unfiled ok, link gone, blob kept
FAIL  AT18 a minute-book record corrected moves its documents to the new name, and one deleted takes them out  before: link under the typo; saved: Saved the minute-book record. Its documents are filed under the new name.; old link gone, new there, same bytes; sweep 1 problem(s); deleted: Deleted the minute-book record "Approve the lease". Its document was unfiled; the file stays in the store.; 0 binding(s) left, link gone, blob kept
FAIL  AT19 a company renamed moves its folder of papers, every document still opens; another company's name, or a folder already shared, is refused  before: 3 document(s), the first 35 bytes, sweep 1; renamed: Saved: Minute Paper Holdings Ltd., BC. Its folder of papers was renamed with it.; old folder gone, new there; the document opens: 35 bytes; sweep 1 problem(s) (2026-03-02 shareholders resolution Ratify the budget.pdf is missing from the Minute book folder); another company's name: Another company is called Folderless Ltd.; the two would share one folder of papers. Choose another name.; a folder already shared: minute paper holdings ltd. has the same name, so the two com (nothing moved); trail Minute Paper Ltd. → Minute Paper Holdings Ltd.
=== 3 CHECK(S) FAILED ===
```

## The integrity sweep does not look for the minute book's links

`marker 871`

The sweep checks every minute-book document's blob and hash but never asks whether its link is in the folder, so a Minute book folder emptied by hand reads as clean. `AT15` removes a link and asks.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT15 a minute-book record's document is one blob, linked in its own folder, provable, and unfiled cleanly  filed on two records; 1 blob file(s); link in Minute book/2026; served as 2026-03-01 directors resolution Approve the stationery budget.pdf; twice ALREADY_ATTACHED; listed 2; sweep before 0 problem(s), after removing the link says NOTHING; rebuild put it back; unfiled ok, link gone, blob kept
=== 1 CHECK(S) FAILED ===
```

## A minute book read from a PDF enters its records without the PDF

`marker 872`

The rows door stops filing the reading's document against the records it made. The records are right, and the paper they came from is attached to nothing. `AT17` reads a PDF into two records.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT17 a minute book read from a PDF files that PDF against every record it made  from the PDF: Entered 2 minute-book records.; 0 binding(s) on 0 record(s), 0 blob file; from a sentence: Entered 2 minute-book records.
=== 1 CHECK(S) FAILED ===
```

## A company backup carries the receipts' blobs and not the minute book's

`marker 873`

`exportCompany` collects blob hashes from the entries' attachments only. A minute-book document with bytes of its own leaves without its blob row or its file, and the restored record names a document the store does not have. `BK8` restores one.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK2b the file restores into a company of its own           That backup does not hold everything it points at: 1 minute_book_attachment row(s) break minute_book_attachment_sha256_fkey to attachment_blob. Nothing was restored.
FAIL  BK3 every table comes back holding what it held            136 table(s) differ: party_role 7 → nothing, ledger 1 → nothing, fx_company_currency 0 → nothing, gst_return_adjustment 1 → nothing …
FAIL  BK3a restored cheque still points to its expense, keeps the next number and prints  
FAIL  BK3b a question to the books comes back with its steps on the restored question and its text as it went out  no question in the restored company
FAIL  BK3c a reading from a sentence alone comes back with its sentence and no file  no sentence-only reading in the restored company
FAIL  BK3d audit evidence keeps its source values while its locators are remapped with provenance  the source audit event did not come back
FAIL  BK3e a deleted target keeps its source locator and explanation instead of inventing a restored row  the deleted-target event did not come back
FAIL  BK4 the restored books show the same trial balance         was 1000:0/0/2391255 1066:0/0/19700 1200:0/0/356500 1500:0/0/1200000 1510: | now nothing
FAIL  BK5 a month that was closed is closed again, after its entries are back  0 closed period(s)
FAIL  BK7 the shared party is matched, not copied, and holds its role in the new company  1 party row, 0 role in the restored company
FAIL  BK4b a row pointing at its own table survives, whatever order the rows are in  That backup does not hold everything it points at: 1 minute_book_attachment row(s) break minute_book_attachment_sha256_f
FAIL  BK4c the key that catches a double click stays with the original  ? in the restored company, 1 still on the entry it belongs to
FAIL  BK4d a posted invoice’s entry names the restored invoice, not the original  ? pointing inside its own company, ? pointing at another
FAIL  BK7b a party whose id is not here is found by name, not copied  1 party row(s); the role landed on refused: That backup does not hold everything it points at: 1 minute_
FAIL  BK8 receipts, CRM, minute book, statements and signing paper travel with the books  6 file(s) in the backup, 0 on the restored entry, CRM link MISSING, CRM bytes MISSING, 0 on the restored minute book, whose bytes are NOT in the restored store
FAIL  BK8a restored automation is paused, original target remapped and both private PDFs byte-identical  
FAIL  BK8p Project rows, profit and UUID-scoped independent bytes survive a full company restore  
FAIL  BK11b a composite CRM company reference is checked and refused whole  INCOMPLETE; 0 company left behind
FAIL  BK11d books that do not hold together are refused whole    an entry out of balance: INCOMPLETE, 0 left behind; a balance cache that disagrees with its lines: INCOMPLETE, 0 left behind
FAIL  BK12 a restore adds one fully-attributed arrival event beside the imported history  ? row(s), ?, null
FAIL  BK10b a real pre-CRM v1 file restores without historical audit and gains a usable pipeline  refused; audit included false; 0 new event(s); 0 pipeline / 0 stages
=== 21 CHECK(S) FAILED ===
```

## The minute book's Documents column never shows what is filed

`marker 874`

The records screen stops reading the paper filed against each minute-book record, so a filed document has no link at rest and its floating form has nothing to Unfile. `CR43` renders a record with one document.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR43 the records screen has no boxes at rest, and an add form submits every column of every row  at rest 0 box(es), 5/5 add links, profile link there, 2 Cease button(s); the minute book does NOT link its document and links to document management; the shares form names every column of both rows, carries its table and reading, the date it could not read is in the note and not put in the date box, 1 name(s) marked new, 1 marked as another company's
=== 1 CHECK(S) FAILED ===
```

## The CRA numbers on the payroll screen stop at federal tax

`marker 875`

`EditionFigures` renders the first three groups of figures and not British Columbia's, so the BC brackets, constants and tax reduction payroll computes with are nowhere on the screen. `PR58` renders an edition and reads every figure cell back.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR58 every figure of an edition is on the screen, and the form reads back exactly those numbers  25 cell(s) for 34 figure(s); wrong or missing: bc.thresholds, bc.rates, bc.constants, bc.lowestRate, bc.basicPersonalAmount, bc.taxReduction.maxCredit, bc.taxReduction.thresholdFull, bc.taxReduction.thresholdZero, bc.taxReduction.reductionRate; read back as the same numbers
=== 1 CHECK(S) FAILED ===
```

## An edition added in the app is saved and never read back

`marker 876`

`loadEditions` hands `rates.ts` an empty list instead of the rows, so an edition added on the payroll screen is in the database and payroll still refuses its year. `PR59` adds 2027 and asks for a March 2027 pay date.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR59 a new edition goes in through the form, and a pay date in it resolves to it  a March 2027 pay date before: NO_TABLES; the form said Added 2027-01. Its figures agree with each other and the PDOC example matched to the cent;; after: NO_TABLES; covered to 2027-12-31; the row kept its PDOC case yes; 1 audit row(s); listed as added by alicio@example.test
FAIL  PR60 an edition whose figures disagree, or that PDOC does not confirm, or that is out of order, is refused whole  a K constant off by one: refused; the PDOC federal tax a cent out: NOT REFUSED (The editions would not be usable, so nothing was s); a start not after the last edition: NOT REFUSED (Failed query: ); a figure that is not a number: refused; rows 1 → 1; with no fault: REFUSED (The editions would not be usable, so nothing was saved: 2027-07 is the first edition of 2027 and starts on 2027-07-01, s)
FAIL  PR61 a preview and a T4 year read the editions added in the app themselves, cold  preview of a January 2027 payday: REFUSED (NO_TABLES); the 2027 T4 year: REFUSED (NO_TABLES)
FAIL  PR62 an edition not loaded is refused, not guessed; only an added edition no stub names, and nothing later rests on, can be removed  unloaded: NO_TABLES; loaded: NO_TABLES; removing a built-in: 2026-07 is built into the app and cannot be removed here.; the January under a July: REMOVED (Removed 2027-01. Payroll can now run up to 2026-12-31.); the July: There is no added edition called 2027-07.; removing it while a stub names it: 1 pay stub was computed with 2027-01, so it stays. Its figures are what those stubs were worked out from.; once nothing does: There is no added edition called 2027-01.; covered to 2026-12-31; 0 row(s) left
=== 4 CHECK(S) FAILED ===
```

## An edition PDOC does not confirm is saved anyway

`marker 877`

`addEdition` computes the PDOC example and ignores the lines that disagree, so tables that add up but are not this year's go in. `PR60` sends the federal tax a cent out.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR60 an edition whose figures disagree, or that PDOC does not confirm, or that is out of order, is refused whole  a K constant off by one: refused; the PDOC federal tax a cent out: NOT REFUSED (Added 2027-07. Its figures agree with each other a); a start not after the last edition: refused; a figure that is not a number: refused; rows 1 → 2; with no fault: REFUSED (A new edition starts after the last one on file (2027-07, from 2027-07-01). An edition already on file is corrected by r)
=== 1 CHECK(S) FAILED ===
```

## An edition whose tables do not add up is refused in the engine's words

`marker 878`

`addEdition` stops asking `problemsWith` itself. Nothing wrong is saved even so — computing the PDOC example vets the candidate and throws — but the person at the form is told the tables will not be computed from, and pointed at a design doc, instead of being told nothing was saved. The first version of this block read only whether a refusal came, and stayed green for exactly that reason. `PR60` changes a K constant and reads the sentence.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR60 an edition whose figures disagree, or that PDOC does not confirm, or that is out of order, is refused whole  a K constant off by one: NOT REFUSED (The 2027-07 tables do not add up and nothing will ); the PDOC federal tax a cent out: refused; a start not after the last edition: refused; a figure that is not a number: refused; rows 1 → 1; with no fault: added
=== 1 CHECK(S) FAILED ===
```

## A second edition in a year the app added reads as different CPP and EI

`marker 879`

The list rule compares a year's CPP and EI by key order again. Postgres jsonb hands the keys back in its own order, so a July edition typed on top of a January edition added in the app is refused for numbers that are the same. `PR60` adds July 2027 with no fault.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR60 an edition whose figures disagree, or that PDOC does not confirm, or that is out of order, is refused whole  a K constant off by one: refused; the PDOC federal tax a cent out: NOT REFUSED (The editions would not be usable, so nothing was s); a start not after the last edition: refused; a figure that is not a number: refused; rows 1 → 1; with no fault: REFUSED (The editions would not be usable, so nothing was saved: 2027-01 and 2027-07 are the same year and carry different CPP/EI)
FAIL  PR62 an edition not loaded is refused, not guessed; only an added edition no stub names, and nothing later rests on, can be removed  unloaded: NO_TABLES; loaded: 2027-01; removing a built-in: 2026-07 is built into the app and cannot be removed here.; the January under a July: REMOVED (Removed 2027-01. Payroll can now run up to 2026-12-31.); the July: There is no added edition called 2027-07.; removing it while a stub names it: 1 pay stub was computed with 2027-01, so it stays. Its figures are what those stubs were worked out from.; once nothing does: There is no added edition called 2027-01.; covered to 2026-12-31; 0 row(s) left
=== 2 CHECK(S) FAILED ===
```

## The add form takes a word where a figure goes

`marker 880`

`editionFromFigures` stops asking whether each figure is a number, so a rate typed as words reaches the checker, and the form answers with the arithmetic's own crash — Cannot convert one point six to a BigInt — instead of naming the figure. Nothing is saved; nothing says which box. `PR60` types the EI rate in words.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR60 an edition whose figures disagree, or that PDOC does not confirm, or that is out of order, is refused whole  a K constant off by one: refused; the PDOC federal tax a cent out: refused; a start not after the last edition: refused; a figure that is not a number: NOT REFUSED (Cannot convert one point six to a BigInt); rows 1 → 1; with no fault: added
=== 1 CHECK(S) FAILED ===
```

## A pay-run preview on a fresh server does not know the added editions

`marker 881`

`previewPayRun` stops reading the editions added in the app, so after a restart the first preview — or run — for a year only a row covers is refused until something else happens to load them. `PR61` empties the process's list and previews January 2027.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR61 a preview and a T4 year read the editions added in the app themselves, cold  preview of a January 2027 payday: REFUSED (NO_TABLES); the 2027 T4 year: has its ceilings
=== 1 CHECK(S) FAILED ===
```

## A T4 year on a fresh server does not know the added editions

`marker 882`

`t4Year` stops reading the editions added in the app, so after a restart the slips for a year only a row covers are refused for want of its CPP and EI ceilings. `PR61` empties the process's list and asks for 2027.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR61 a preview and a T4 year read the editions added in the app themselves, cold  preview of a January 2027 payday: computed under 2027-01; the 2027 T4 year: REFUSED (NO_TABLES)
=== 1 CHECK(S) FAILED ===
```

## The SR&ED working paper on a fresh server does not know the added editions

`marker 883`

`workingPaper` stops reading the editions added in the app, so after a restart a claim for a year only a row covers is refused for want of a YMPE. `S39` adds the next year's edition, empties the process's list and opens that claim's paper.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S39 the working paper reads a year's tables added in the app itself, and caps salary at five times that YMPE  the 2027 claim with no 2027 tables: NO_YMPE; with an edition added and the process cold: NO_YMPE; the cap: —
=== 1 CHECK(S) FAILED ===
```

## An edition a pay stub was computed with can be removed

`marker 884`

`removeEdition` stops asking whether any stub names the edition, so the figures a posted payday was worked out from can be deleted from under it. `PR62` files a stub under 2027-01 and removes 2027-01.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR62 an edition not loaded is refused, not guessed; only an added edition no stub names, and nothing later rests on, can be removed  unloaded: NO_TABLES; loaded: 2027-01; removing a built-in: 2026-07 is built into the app and cannot be removed here.; the January under a July: Removing 2027-01 would leave editions payroll cannot use (2027-07 is the first e; the July: Removed 2027-07. Payroll can now run up to 2027-12-31.; removing it while a stub names it: REMOVED (Removed 2027-01. Payroll can now run up to 2026-12-31.); once nothing does: There is no added edition called 2027-01.; covered to 2026-12-31; 0 row(s) left
=== 1 CHECK(S) FAILED ===
```

## Removing a built-in edition is answered as if it did not exist

`marker 885`

`removeEdition` stops recognising the editions built into the code, so Remove on one is answered as if it were an added edition — by the stubs that used it, or, for one no stub has used yet, by the DELETE finding no row — and never by why it stays. `PR62` removes 2026-07.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR62 an edition not loaded is refused, not guessed; only an added edition no stub names, and nothing later rests on, can be removed  unloaded: NO_TABLES; loaded: 2027-01; removing a built-in: 15 pay stubs were computed with 2026-07, so it stays. Its figures are what those stubs were worked out from.; the January under a July: Removing 2027-01 would leave editions payroll cannot use (2027-07 is the first e; the July: Removed 2027-07. Payroll can now run up to 2027-12-31.; removing it while a stub names it: 1 pay stub was computed with 2027-01, so it stays. Its figures are what those stubs were worked out from.; once nothing does: Removed 2027-01. Payroll can now run up to 2026-12-31.; covered to 2026-12-31; 0 row(s) left
FAIL  PR64 an added copy of an edition a release builds in is ignored, shown with Remove, and kept while stubs rest on different figures  an August 2026 pay date with the copy on file: 2026-07; listed 1 time(s), the copy different, Remove offered; 15 stub(s) name 2026-07; removing while different: 15 pay stubs were computed with 2026-07, so it stays. Its figures are ; once the same: 15 pay stubs were computed with 2026-07, so it stays. Its figures are what those stubs were worked out from. (1 row(s) left, trail EMPTY); again: 15 pay stubs were computed with 2026-07, so it stays. Its figures are what those stubs were worked out from.
=== 2 CHECK(S) FAILED ===
```

## The payroll screen lists an added edition as built in

`marker 886`

`editionRecords` drops who added an edition and the PDOC case it was proved against, so the screen shows it as built into the app, with no Remove and no record of what vouched for it. `PR59` reads the list after adding 2027-01.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR59 a new edition goes in through the form, and a pay date in it resolves to it  a March 2027 pay date before: NO_TABLES; the form said Added 2027-01. Its figures agree with each other and the PDOC example matched to the cent;; after: 2027-01; covered to 2027-12-31; the row kept its PDOC case yes; 1 audit row(s); listed as added by nobody
=== 1 CHECK(S) FAILED ===
```

## A corrected minute-book record leaves no trace of what it said

`marker 887`

The correction trigger on `minute_book_entry` watches removals only, so a title put right writes nothing to the audit log and what the minute book used to say is gone. The first version of this block moved the trigger to inserts, which broke every insert and turned the suite red by crashing it before `CR44` ran (independent critic, 2026-09-16). `CR44` corrects a title, then reads the trail.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR44 a minute-book record is corrected or deleted from its row, and the trail keeps what it said  saved: Saved the minute-book record. (every box took); bad boxes: Nothing was saved. Date "soon" is not a date. Title is missing. (nothing changed); deleted: Deleted the minute-book record "Appointment of auditors". (gone); trail: delete_minute_book_entry Appointment of auditors→∅
=== 1 CHECK(S) FAILED ===
```

## Moving an office address earlier collides with the one before it

`marker 888`

The edit moves the row's start before shortening the previous address, so for one statement the office has two addresses on the same days and the database refuses a correction that is right. `CR45` moves the second address a year earlier.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR45 an office's addresses stay a chain when one is moved, refused out of order, or deleted  earlier: 2 Secnd St 2023-05-01→now | 1 First St 2020-01-15→2023-04-30; before the first: Nothing was saved. The address before this one began on 2020-01-15; this one has to begin ; other office: Nothing was saved. This is a registered office address. To file it under the other office,; unchanged; later: 2 Second St 2024-01-01→now | 1 First St 2020-01-15→2023-12-31; deleted: Deleted the office. The address before it is the current one again. → 1 First St 2020-01-15→now
=== 1 CHECK(S) FAILED ===
```

## Deleting an office address leaves the office with none

`marker 889`

The delete stops giving the removed address's days back to the one before it, so deleting the current registered office leaves the company with no current registered office at all. `CR45` deletes the second address and reads the chain.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR45 an office's addresses stay a chain when one is moved, refused out of order, or deleted  earlier: 2 Second St 2022-03-01→now | 1 First St 2020-01-15→2022-02-28; before the first: Nothing was saved. The address before this one began on 2020-01-15; this one has to begin ; other office: Nothing was saved. This is a registered office address. To file it under the other office,; unchanged; later: 2 Second St 2024-01-01→now | 1 First St 2020-01-15→2023-12-31; deleted: Deleted the office. The address before it is the current one again. → 1 First St 2020-01-15→2023-12-31
=== 1 CHECK(S) FAILED ===
```

## An address moved before the one it followed is refused in the database's words

`marker 890`

The edit stops saying that the address before began first, and leaves it to a CHECK constraint, so a person who typed the wrong year reads a constraint name instead of the date to beat. `CR45` moves the second address before the first began.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR45 an office's addresses stay a chain when one is moved, refused out of order, or deleted  earlier: 2 Second St 2022-03-01→now | 1 First St 2020-01-15→2022-02-28; before the first: Nothing was saved. new row for relation "corporate_office" violates check constraint "corp; other office: Nothing was saved. This is a registered office address. To file it under the other office,; unchanged; later: 2 Second St 2024-01-01→now | 1 First St 2020-01-15→2023-12-31; deleted: Deleted the office. The address before it is the current one again. → 1 First St 2020-01-15→now
=== 1 CHECK(S) FAILED ===
```

## A term moved to another person keeps the first person's address

`marker 891`

When a director's row is corrected to a different person and the address box is left blank, the row keeps the frozen address of the person it named before, so the register prints one person at another's address. `CR46` moves a term to a new name with no address.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR46 a director's term is corrected, refused where it would overlap or lack an address, moved to a new name, and deleted  un-ceased into the later term: Nothing was saved. That term would overlap another term of the same person.; fixed: 2021-02-01→2022-06-30 at 7 Typed St; new name, no address: Saved the director. Added to this company's list: Robin Vale. (1 Robin Vale left on the list); with one: Saved the director.; deleted: gone; trail ∅→2022-01-01, 2022-01-01→2022-06-30 under the person
=== 1 CHECK(S) FAILED ===
```

## Correcting a significant individual erases their birth date

`marker 892`

The screen never sends the birth date, so its box arrives blank; the edit writes the blank, and every correction of how somebody controls the company wipes a field the transparency register must keep. `CR47` corrects a row with the private boxes left blank.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR47 a significant individual is corrected with blank private boxes kept, and the trail carries no private field  blank boxes: birth null, address 1 Secret Ln; typed address: 2 New Ln; no start: Nothing was saved. Since is missing.; deleted: Deleted the significant individual.; trail change_significant_individual, change_significant_individual, delete_significant_individual; no private field in it
=== 1 CHECK(S) FAILED ===
```

## A correction's trail carries what the register calls private

`marker 893`

The correction trigger stops taking the private fields out of the row as it was, so every change to a significant individual copies their birth date and address into an audit log nothing filters. The body is 0085's: it re-issued the function, and a mutation of 0083's copy is shadowed. `CR47` reads every trail row for the fields.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR47 a significant individual is corrected with blank private boxes kept, and the trail carries no private field  blank boxes: birth 1980-02-02, address 1 Secret Ln; typed address: 2 New Ln; no start: Nothing was saved. Since is missing.; deleted: Deleted the significant individual.; trail change_significant_individual, change_significant_individual, delete_significant_individual; LEAKED became_on, birth_date, how_control, citizenships, citizen_or_pr, tax_resident_ca, last_known_address
=== 1 CHECK(S) FAILED ===
```

## The securities register cannot be put right even by its own Edit

`marker 894`

The append-only trigger stops reading the flag its doors set, so the owner's answer — editable and deletable, keeping what it said — is refused at the database for every movement. `CR48` corrects an issue and a transfer.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR48 a share movement is corrected or deleted, a transfer as one, and nobody is ever left holding less than nothing  issue to 50: Kim Ng 30, Lee Wong 60; to 30: Nothing was saved. SHARES_APPEND_ONLY: the securities register changes only through its Ed (unchanged); transfer corrected: rows [{"kind":"transfer_in","delta":"40","on_date":"2022-01-01","certificate_no":null,"surrendered_no":null},{"kind":"transfer_out","delta":"-40","on_date":"2022-01-01","certificate_no":null,"surrendered_no":null}], Kim Ng 30, Lee Wong 60; as an issue: Nothing was saved. This is a transfer. To record it as something else, delete it and add t; issue deleted first: Nothing was deleted. SHARES_APPEND_ONLY: the securities register changes only through its  (4 rows); then cancellation, transfer, issue: Nothing was deleted. SHARES_APPEND_ONLY: the securities register changes only through its  / Nothing was deleted. SHARES_APPEND_ONLY: the securities register changes only through its  / Nothing was deleted. SHARES_APPEND_ONLY: the securities register changes only through its , 4 left; trail 0 change row(s), 0 removal row(s)
=== 1 CHECK(S) FAILED ===
```

## A corrected share count may leave a holder negative

`marker 895`

The never-negative trigger judges inserts only, as it did before 0083, so an issue corrected down to fewer shares than its holder later transferred goes in, and the register shows a holder at minus ten. `CR48` corrects the issue to 30 under a transfer of 40.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR48 a share movement is corrected or deleted, a transfer as one, and nobody is ever left holding less than nothing  issue to 50: Kim Ng 30, Lee Wong 10; to 30: Saved the share movement. (NOW Kim Ng 30, Lee Wong -10); transfer corrected: both rows right, Kim Ng 35, Lee Wong -15; as an issue: Nothing was saved. This is a transfer. To record it as something else, delete it and add t; issue deleted first: Deleted the share movement. (3 rows); then cancellation, transfer, issue: gone / gone / That is not in this company's books., 0 left; trail 4 change row(s), 4 removal row(s)
=== 1 CHECK(S) FAILED ===
```

## An issue can be deleted from under the transfer that rests on it

`marker 896`

The never-negative check reads only the row as it is, and a deleted row has none, so removing an issue checks nobody and the holder who later transferred those shares is left negative. `CR48` deletes the issue before the transfer.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR48 a share movement is corrected or deleted, a transfer as one, and nobody is ever left holding less than nothing  issue to 50: Kim Ng 30, Lee Wong 10; to 30: Nothing was saved. SHARES_OVERDRAWN: that holder would be at -10 shares on 2022-01-01; nob (unchanged); transfer corrected: both rows right, Kim Ng 35, Lee Wong 5; as an issue: Nothing was saved. This is a transfer. To record it as something else, delete it and add t; issue deleted first: Deleted the share movement. (3 rows); then cancellation, transfer, issue: gone / gone / That is not in this company's books., 0 left; trail 3 change row(s), 4 removal row(s)
=== 1 CHECK(S) FAILED ===
```

## Deleting a transfer takes only one side of it

`marker 897`

The delete removes the row it was given and not its pair, so a transfer's receiving side goes and its giving side stays, and the group no longer nets to zero. `CR48` deletes the transfer by the row the screen names.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR48 a share movement is corrected or deleted, a transfer as one, and nobody is ever left holding less than nothing  issue to 50: Kim Ng 30, Lee Wong 10; to 30: Nothing was saved. SHARES_OVERDRAWN: that holder would be at -10 shares on 2022-01-01; nob (unchanged); transfer corrected: both rows right, Kim Ng 35, Lee Wong 5; as an issue: Nothing was saved. This is a transfer. To record it as something else, delete it and add t; issue deleted first: Nothing was deleted. SHARES_OVERDRAWN: that holder would be at -45 shares on 2022-02-01; n (4 rows); then cancellation, transfer, issue: gone / Nothing was deleted. TRANSFER_UNBALANCED: the transfer group nets to -45 shares; a transfe / Nothing was deleted. SHARES_OVERDRAWN: that holder would be at -45 shares on 2022-02-01; n, 3 left; trail 3 change row(s), 1 removal row(s)
=== 1 CHECK(S) FAILED ===
```

## A transfer can be saved as if it were an issue

`marker 898`

The edit stops asking whether the boxes' kind is the row's, so a transfer's row is rewritten by the issue path and the refusal, when the database gives one, says nothing about why. `CR48` sends an issue's boxes for a transfer.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR48 a share movement is corrected or deleted, a transfer as one, and nobody is ever left holding less than nothing  issue to 50: Kim Ng 30, Lee Wong 10; to 30: Nothing was saved. SHARES_OVERDRAWN: that holder would be at -10 shares on 2022-01-01; nob (unchanged); transfer corrected: both rows right, Kim Ng 35, Lee Wong 5; as an issue: Nothing was saved.  is not on this company's list, and nobody gives up shares they never h; issue deleted first: Nothing was deleted. SHARES_OVERDRAWN: that holder would be at -45 shares on 2022-02-01; n (4 rows); then cancellation, transfer, issue: gone / gone / gone, 0 left; trail 3 change row(s), 4 removal row(s)
=== 1 CHECK(S) FAILED ===
```

## Deleting a class in use is refused in the database's words

`marker 899`

The class delete stops counting the class's movements, so a person asking to delete a class the register uses reads a foreign-key message instead of how many movements are in it and what to do. `CR49` deletes a class with one movement.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR49 a share class is renamed, refused a name already taken, and deleted only while nothing is in it  in use: update or delete on table "share_class" violates foreign key constraint "share_transaction; renamed: Saved the class as Class A Common — Series 1.; taken: This company already has a class by that name.; empty: Deleted the class Preferred.; left Class A Common — Series 1 (1); trail Common → Class A Common
=== 1 CHECK(S) FAILED ===
```

## An Edit naming another company's row is not asked whose it is

`marker 900`

The row forms stop asking whether the id is this company's before the door runs, and a crafted form is answered as though the row simply did not exist rather than refused as another company's. `CR50` names Records Ltd.'s director under Fixes Ltd.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR50 an Edit or Delete naming another company's row is refused and the row is untouched  edit: Nothing was saved. There is no such director in these books.; delete: Nothing was deleted. There is no such director in these books.; their term still ends 2024-06-30
=== 1 CHECK(S) FAILED ===
```

## No register row offers Edit

`marker 901`

The records screen decides it was not handed the edit doors, so every row is read-only again and the minute book cannot be corrected or deleted — the complaint that started 0083. `CR51` counts the Edit buttons at rest.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR51 a row's Edit opens its own boxes on press, holding what is on file  at rest 0 box(es), 0 Edit button(s); minute book does NOT open right; transfer does NOT; significant individual does NOT
=== 1 CHECK(S) FAILED ===
```

## A significant individual's blank private boxes do not say they keep

`marker 902`

The row editor stops saying that a blank birth date or address keeps what is on file, so a person looking at empty boxes believes the register holds nothing there, or that saving will erase it. `CR51` opens a significant individual.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR51 a row's Edit opens its own boxes on press, holding what is on file  at rest 0 box(es), 6 Edit button(s); minute book opens with its table, row and values; transfer keeps its kind and balance certificate; significant individual does NOT
=== 1 CHECK(S) FAILED ===
```

## A minute-book record corrected leaves its documents under the old name

`marker 903`

The edit stops refiling the record's links, so the Finder tree keeps the document under the typo'd title and the new title has nothing — and the integrity sweep reports the new link missing. `AT18` corrects a title and looks for both links.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT18 a minute-book record corrected moves its documents to the new name, and one deleted takes them out  before: link under the typo; saved: Saved the minute-book record. Its documents are filed under the new name.; old link STILL THERE, new MISSING; sweep 1 problem(s); deleted: Deleted the minute-book record "Approve the lease". Its document was unfiled; the file stays in the store.; 0 binding(s) left, link gone, blob kept
=== 1 CHECK(S) FAILED ===
```

## A minute-book record deleted leaves its documents in the folder

`marker 904`

The delete stops removing the record's links, so the Minute book folder keeps a document filed under a record that no longer exists. `AT18` deletes the record and looks for the link.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT18 a minute-book record corrected moves its documents to the new name, and one deleted takes them out  before: link under the typo; saved: Saved the minute-book record. Its documents are filed under the new name.; old link gone, new there, same bytes; sweep 0 problem(s); deleted: Deleted the minute-book record "Approve the lease". Its document was unfiled; the file stays in the store.; 0 binding(s) left, link STILL THERE, blob kept
=== 1 CHECK(S) FAILED ===
```

## A company holding share movements cannot be removed

`marker 905`

Removing a company stops opening the securities register, so the append-only trigger refuses the delete of its movements and a company that was a mistake cannot be removed once anybody was issued a share. `CO12` removes one.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO12 a company holding only share movements is removed, register and all  refused: Failed query: DELETE FROM share_transaction WHERE share_class_id IN (SELECT id FROM share_
=== 1 CHECK(S) FAILED ===
```

## A registration corrected into another's dates is refused in words nobody can act on

`marker 906`

`correctRegistration` stops looking for the registration its new dates would run into, so the database refuses at its EXCLUDE constraint and the person is told another registration changed at the same moment — not which one, or its dates. `R64` moves a start into the earlier registration.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R64 a registration entered wrong is corrected or deleted, never into another, and the trail keeps it  corrected: Saved: 123456789RT0001, from 2024-02-01, still registered. Documents printed from now on carry the new number, including reprints of ones already sent. → 123456789RT0001 from 2024-02-01; into the earlier one: Another registration for this tax changed while this was being saved. Nothing was saved here. Reload the page to see it.; un-ending the earlier one: Another registration for this tax changed while this was being saved. Nothing was saved here. Reload the page to see it.; its end moved: 2023-11-30; deleted: Deleted the registration 111111111RT0001. Its accounts stay, with anything posted to them. (gone, accounts 9 → 9); trail correct_tax_registration, delete_tax_registration; the page offers both doors for its own registration; with a sale posted under it — delete: 123456789RT0001 has 1 posted tax line, the first dated 2026-; start past the sale: osted tax line now falls outside it — the return will list it as outside the registration.; renumbered: Saved: 123456789RT0002, from 2024-02-01, still registered. D; End before the sale: osted tax line now falls outside it — the return will list it as outside the registration.; after it: Registration 123456789RT0002 ends 2026-12-31. The accounts s; corrected back before it: de it — the return will list it as outside the registration. (ends 2026-03-01); cleared then ended before it: de it — the return will list it as outside the registration. (ends 2026-03-01); a zero-rated invoice: 222222222RT0001 has 1 posted sales invoice, the fi; ended before it: 1 posted sales invoice dated outside it will print without the number.; a supplier's bill alone: deleted
=== 1 CHECK(S) FAILED ===
```

## A registration's corrected number leaves no trace of the old one

`marker 907`

The registration audit trigger stops writing a row when the number or the start date changes, so a number corrected — the one printed on every invoice — is replaced with nothing to say what it was. `R64` corrects WRONG1 and reads the trail.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R64 a registration entered wrong is corrected or deleted, never into another, and the trail keeps it  corrected: Saved: 123456789RT0001, from 2024-02-01, still registered. Documents printed from now on carry the new number, including reprints of ones already sent. → 123456789RT0001 from 2024-02-01; into the earlier one: Registration 111111111RT0001 runs from 2023-01-01 to 2023-12-31; these dates would share days with it.; un-ending the earlier one: Registration 123456789RT0001 runs from 2024-02-01; these dates would share days with it.; its end moved: 2023-11-30; deleted: Deleted the registration 111111111RT0001. Its accounts stay, with anything posted to them. (gone, accounts 9 → 9); trail delete_tax_registration; the page offers both doors for its own registration; with a sale posted under it — delete: 123456789RT0001 has 1 posted tax line, the first dated 2026-; start past the sale: osted tax line now falls outside it — the return will list it as outside the registration.; renumbered: Saved: 123456789RT0002, from 2024-02-01, still registered. D; End before the sale: osted tax line now falls outside it — the return will list it as outside the registration.; after it: Registration 123456789RT0002 ends 2026-12-31. The accounts s; corrected back before it: de it — the return will list it as outside the registration. (ends 2026-03-01); cleared then ended before it: de it — the return will list it as outside the registration. (ends 2026-03-01); a zero-rated invoice: 222222222RT0001 has 1 posted sales invoice, the fi; ended before it: 1 posted sales invoice dated outside it will print without the number.; a supplier's bill alone: deleted
=== 1 CHECK(S) FAILED ===
```

## A deleted registration leaves no trace

`marker 908`

The registration audit trigger fires on inserts and updates only, as before 0084, so a registration deleted is gone with no row saying it existed, what its number was, or who removed it. `R64` deletes one and reads the trail.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R64 a registration entered wrong is corrected or deleted, never into another, and the trail keeps it  corrected: Saved: 123456789RT0001, from 2024-02-01, still registered. Documents printed from now on carry the new number, including reprints of ones already sent. → 123456789RT0001 from 2024-02-01; into the earlier one: Registration 111111111RT0001 runs from 2023-01-01 to 2023-12-31; these dates would share days with it.; un-ending the earlier one: Registration 123456789RT0001 runs from 2024-02-01; these dates would share days with it.; its end moved: 2023-11-30; deleted: Deleted the registration 111111111RT0001. Its accounts stay, with anything posted to them. (gone, accounts 9 → 9); trail correct_tax_registration; the page offers both doors for its own registration; with a sale posted under it — delete: 123456789RT0001 has 1 posted tax line, the first dated 2026-; start past the sale: osted tax line now falls outside it — the return will list it as outside the registration.; renumbered: Saved: 123456789RT0002, from 2024-02-01, still registered. D; End before the sale: osted tax line now falls outside it — the return will list it as outside the registration.; after it: Registration 123456789RT0002 ends 2026-12-31. The accounts s; corrected back before it: de it — the return will list it as outside the registration. (ends 2026-03-01); cleared then ended before it: de it — the return will list it as outside the registration. (ends 2026-03-01); a zero-rated invoice: 222222222RT0001 has 1 posted sales invoice, the fi; ended before it: 1 posted sales invoice dated outside it will print without the number.; a supplier's bill alone: deleted
=== 1 CHECK(S) FAILED ===
```

## An account in use is refused a delete in the database's words

`marker 909`

`deleteAccount` stops counting what holds the account, so a posted-to account is refused by 0008's trigger and a parent by a foreign key — neither saying what holds it, and only one saying to deactivate. `A47` deletes the cash account and a parent.

```
$ db:verify-accounts | npm run db:verify-accounts
FAIL  A47 an account is deactivated and reactivated, and deleted only while nothing uses it  cash: Error: Failed query: DELETE FROM account WHERE id = $1::uuid
=== 1 CHECK(S) FAILED ===
```

## Reactivating an account leaves it inactive

`marker 910`

`setAccountActive` writes inactive whichever way it was asked, so an account retired by mistake cannot be brought back, and the button says it was. `A47` deactivates and reactivates cash.

```
$ db:verify-accounts | npm run db:verify-accounts
FAIL  A47 an account is deactivated and reactivated, and deleted only while nothing uses it  cash: IN_USE: 1000 Cash — Operating is used — 1 journal line — so it stays. Deactivate; parent: IN_USE: 6990 Grouping is used — 1 sub-account — so it stays.; typo: ok (0 left); deactivate ok → active false, reactivate ok → false; theirs: NOT_OURS: That is not in this company's ; trail delete_account, deactivate_account, reactivate_account
=== 1 CHECK(S) FAILED ===
```

## A payroll record somebody was paid from can be deleted

`marker 911`

`deleteEmployee` stops counting the person's stubs, so deleting Dana runs into the stubs' foreign key and fails as a database error instead of saying the stubs are the year's record and to untick Active. `PR63` deletes Dana.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR63 a payroll record never paid from is deleted; one somebody was paid from stays  from another company: That is not in this company's books.; never paid: Mistaken Hire is off the payroll. They stay on the company's list.; Dana: threw: Error: Failed query: DELETE FROM payroll_employee WHERE id = $1::uuid
=== 1 CHECK(S) FAILED ===
```

## Another company's ledger can name a payroll record for deletion

`marker 912`

The employee delete form stops asking whose record the id is, so a form under another company's ledger reaches the door, which refuses it only as not this company's record rather than as not in these books. `PR63` sends the delete from the other company.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR63 a payroll record never paid from is deleted; one somebody was paid from stays  from another company: That payroll record is not this company's.; never paid: Mistaken Hire is off the payroll. They stay on the company's list.; Dana: Dana Whitfield has been paid 7 times, and those stubs are the year's record, so the payrol; rows: mistaken 0, Dana 1, the person 1
=== 1 CHECK(S) FAILED ===
```

## A filed SR&ED year's claim can be deleted

`marker 913`

`deleteSredClaim` stops asking whether the year was filed, so the narratives and allocations of a return that has gone to CRA are deleted with no reason asked and nothing left to show what was claimed. `S40` deletes a filed claim.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S40 a year's claim opened by mistake is deleted once unfiled, and an evidence note is corrected or cleared  filed: DELETED; unfiled: deleted REFUSED SredError: That claim is not on file. (claim 0, project 1, 1 trail row); note changed pages 1-44, without a box pages 1-44, emptied cleared
=== 1 CHECK(S) FAILED ===
```

## Deleting a matched bank row says only half of what to do

`marker 914`

`deleteBankRow` stops saying the row settles an entry, and the database's refusal reaches the person as a bare instruction to undo a match with no word of why the row cannot go. `M79` deletes a matched row.

```
$ db:verify-bank-match | npm run db:verify-bank-match
FAIL  M79 a row imported by mistake is deleted; one matched or set aside is refused and says what to undo  imported twice: Deleted. Import the right file again if the row belongs elsewhere. (gone, trail alicio@example.test: IMPORTED TWICE); matched: Undo the match first.; set aside: That row was set aside on purpose. Put it back first.
=== 1 CHECK(S) FAILED ===
```

## An employee role a payroll record needs can be deleted

`marker 915`

`deleteRole` stops asking whether the person is on the payroll, so their only employee role goes while the payroll record stays — a record the database says must belong to an employee, left with none. `P56` deletes Wren's role.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P56 role endings remain editable and audited, obsolete start inputs are ignored, and required roles remain protected  start past the entry: SAVED; earlier: 2026-02-01; delete the supplier: Kestrel Supply Ltd. is named on JE-00008 dated 202; the mistaken customer role: Role deleted. (0 left); overlap: That role is already recorded here. End it before adding it again.; on the payroll: DELETED; address: Address removed — everywhere this party appears. (0 left)
=== 1 CHECK(S) FAILED ===
```

## A fiscal year in the middle can be deleted

`marker 916`

`deleteFiscalYear` stops asking whether the year sits at either end, so deleting the middle of three leaves twelve months nothing can ever be posted to — the gap `createFiscalYear` refuses to make. `CO13` deletes the middle year.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO13 an empty fiscal year at either end is deleted with its periods; one in the middle or holding an entry stays  middle: deleted FY2026; last: YEAR_IN_USE: FY2027 has 1 entry dated in it, so it stays. On; first: deleted FY2025; 1 years left, 0 of its periods, 1 trail row
=== 1 CHECK(S) FAILED ===
```

## A fiscal year holding an entry is refused only by a foreign key

`marker 917`

`deleteFiscalYear` stops counting the entries dated in the year, so a year with posted books reaches the DELETE and is stopped by the entries' foreign key, in the database's words, with no count and no reason. `CO13` deletes the last year, which holds one entry.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO13 an empty fiscal year at either end is deleted with its periods; one in the middle or holding an entry stays  middle: YEAR_IN_THE_MIDDLE: FY2026 sits between ; last: Error: Failed query: DELETE FROM fiscal_year WHERE id = $1::; first: deleted FY2025; 2 years left, 0 of its periods, 1 trail row
=== 1 CHECK(S) FAILED ===
```

## An owner can rename the superadmin

`marker 918`

`setUserIdentity` stops asking the ladder, so an owner changes the name and the sign-in email of the one account that administers everything. `US37` has an owner rename the superadmin.

```
$ db:verify-users | npm run db:verify-users
FAIL  US37 a name and email are put right by whoever may manage the person, or by the person, and the trail keeps both  fixed: Saved: Typo Fixed, fixed@example.test. (sign-in with the new email ok); taken: namer@example.test already has an account.; the superadmin by an owner: SAVED; own name: Saved: Namer Owner, namer@example.test.; trail tpyo@example.test → fixed@example.test
=== 1 CHECK(S) FAILED ===
```

## A company renamed leaves its papers under the old name

`marker 919`

`renameCompany` changes the name and does not move the folder, and the store finds a company's blobs by its name — so every receipt and minute-book document of the renamed company stops opening. `AT19` renames Minute Paper Ltd. and opens a document.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT19 a company renamed moves its folder of papers, every document still opens; another company's name, or a folder already shared, is refused  before: 3 document(s), the first 35 bytes, sweep 0; renamed: Saved: Minute Paper Holdings Ltd., BC. Its folder of papers was renamed with it.; old folder STILL THERE, new MISSING; the document opens: -1 bytes; sweep 3 problem(s) (2026-03-02 shareholders resolution Ratify the budget.pdf is missing from the store); another company's name: Another company is called Folderless Ltd.; the two would share one folder of papers. Choose another name.; a folder already shared: minute paper holdings ltd. has the same name, so the two com (MOVED); trail Minute Paper Ltd. → Minute Paper Holdings Ltd.
=== 1 CHECK(S) FAILED ===
```

## Two companies can be given one name, and share a folder of papers

`marker 920`

`renameCompany` stops asking whether another company is already called that, so two companies' blobs and Finder trees land in one folder. `AT19` renames Minute Paper Ltd. to Paper Trail Ltd.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT19 a company renamed moves its folder of papers, every document still opens; another company's name, or a folder already shared, is refused  before: 3 document(s), the first 35 bytes, sweep 0; renamed: Saved: Minute Paper Holdings Ltd., BC. Its folder of papers was renamed with it.; old folder gone, new there; the document opens: 35 bytes; sweep 0 problem(s); another company's name: SAVED; a folder already shared: Folderless Ltd. has the same name, so the two companies keep (MOVED); trail Minute Paper Ltd. → Minute Paper Holdings Ltd.
=== 1 CHECK(S) FAILED ===
```

## A company whose folder another company shares can be renamed

`marker 921`

`renameCompany` stops asking whether another company already keeps its papers in the folder being moved, so renaming a restored copy that kept its original's name moves the original's blobs, tree and minute book with it, and the original's receipts stop opening. `AT19` gives two companies one folder and renames one.

```
$ db:verify-attachments | npm run db:verify-attachments
FAIL  AT19 a company renamed moves its folder of papers, every document still opens; another company's name, or a folder already shared, is refused  before: 3 document(s), the first 35 bytes, sweep 0; renamed: Saved: Minute Paper Holdings Ltd., BC. Its folder of papers was renamed with it.; old folder gone, new there; the document opens: 35 bytes; sweep 0 problem(s); another company's name: Another company is called Folderless Ltd.; the two would share one folder of papers. Choose another name.; a folder already shared: SAVED (MOVED); trail Minute Paper Ltd. → Minute Paper Holdings Ltd.
=== 1 CHECK(S) FAILED ===
```

## A new company can be given the name of one already here

`marker 922`

`createCompany` stops asking whose folder of papers the name lands in, so two companies share one folder from their first receipt. `CO14` creates a second Twin Name Ltd.

```
$ db:verify-setup | npm run db:verify-setup
FAIL  CO14 a company cannot be created with the name of one already here, whatever the case  CREATED; 2 company row(s)
=== 1 CHECK(S) FAILED ===
```

## A restored copy keeps its original's name, and its folder

`marker 923`

`restoreCompany` stops asking whose folder the name lands in, so a backup restored beside the company it came from writes into that company's folder, and rebuilding either wipes the other's tree. `BK9` restores with the name left as it was.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK9 every wrong file is refused by name                    the name of a company already here: ACCEPTED
=== 1 CHECK(S) FAILED ===
```

## A director's end date is stripped from the trail

`marker 924`

The directors register is mapped to the transparency register's private fields, so `ceased_on` — public for directors — is taken out of every change row, and a cease or a corrected end date writes a row that says nothing changed. `CR46` reads the end date on both sides.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR46 a director's term is corrected, refused where it would overlap or lack an address, moved to a new name, and deleted  un-ceased into the later term: Nothing was saved. That term would overlap another term of the same person.; fixed: 2021-02-01→2022-06-30 at 7 Typed St; new name, no address: Nothing was saved. A director needs a prescribed address, and Robin Vale has none on file  (0 Robin Vale left on the list); with one: Saved the director. Added to this company's list: Robin Vale.; deleted: gone; trail ∅→∅, ∅→∅ under the person
=== 1 CHECK(S) FAILED ===
```

## A share class renamed leaves no name in the trail

`marker 925`

Share classes are mapped to the securities register, whose `name` is private, so a class rename writes a change row with no name before or after. `CR49` reads the old and new names in the trail.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR49 a share class is renamed, refused a name already taken, and deleted only while nothing is in it  in use: Common has 1 movement on the register. Delete those first, or rename the class instead.; renamed: Saved the class as Class A Common — Series 1.; taken: This company already has a class by that name.; empty: Deleted the class Preferred.; left Class A Common — Series 1 (1); trail ∅ → ∅
=== 1 CHECK(S) FAILED ===
```

## Removing a January edition from under a July leaves payroll unusable

`marker 926`

`removeEdition` stops asking whether the editions left are still a list, so removing an added January under an added July leaves a year that starts in July, and every pay run, T4 and SR&ED paper of every company refuses the whole list with no way to add the January back. `PR62` tries it.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR62 an edition not loaded is refused, not guessed; only an added edition no stub names, and nothing later rests on, can be removed  unloaded: NO_TABLES; loaded: 2027-01; removing a built-in: 2026-07 is built into the app and cannot be removed here.; the January under a July: REMOVED (Removed 2027-01. Payroll can now run up to 2027-12-31.); the July: Removed 2027-07. Payroll can now run up to 2026-12-31.; removing it while a stub names it: 1 pay stub was computed with 2027-01, so it stays. Its figures are what those stubs were worked out from.; once nothing does: There is no added edition called 2027-01.; covered to 2026-12-31; 0 row(s) left
=== 1 CHECK(S) FAILED ===
```

## A party role deleted leaves no trace

`marker 927`

The role audit trigger watches inserts and changes only, as before 0085, so a role given by mistake and deleted leaves no row saying it existed or who removed it. `P56` deletes a role and reads the trail.

```
$ db:verify-parties | npm run db:verify-parties
FAIL  P56 role endings remain editable and audited, obsolete start inputs are ignored, and required roles remain protected  start past the entry: SAVED; earlier: 2026-02-01; delete the supplier: Kestrel Supply Ltd. is named on JE-00008 dated 202; the mistaken customer role: Role deleted. (0 left); overlap: That role is already recorded here. End it before adding it again.; on the payroll: They have a payroll record here, which needs the e; address: Address removed — everywhere this party appears. (0 left)
=== 1 CHECK(S) FAILED ===
```

## A registration with tax posted under it can be deleted

`marker 928`

`deleteRegistration` stops asking what rests on the registration's days, so deleting it makes posted GST read as charged outside any registration and changes the number every document dated then prints. `R64` posts a sale under a registration and deletes it.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R64 a registration entered wrong is corrected or deleted, never into another, and the trail keeps it  corrected: Saved: 123456789RT0001, from 2024-02-01, still registered. Documents printed from now on carry the new number, including reprints of ones already sent. → 123456789RT0001 from 2024-02-01; into the earlier one: Registration 111111111RT0001 runs from 2023-01-01 to 2023-12-31; these dates would share days with it.; un-ending the earlier one: Registration 123456789RT0001 runs from 2024-02-01; these dates would share days with it.; its end moved: 2023-11-30; deleted: Deleted the registration 111111111RT0001. Its accounts stay, with anything posted to them. (gone, accounts 9 → 9); trail correct_tax_registration, delete_tax_registration; the page offers both doors for its own registration; with a sale posted under it — delete: DELETED; start past the sale: That is not in this company's books.; renumbered: That is not in this company's books.; End before the sale: That is not in this company's books.; after it: That is not in this company's books.; corrected back before it: That is not in this company's books. (ends undefined); cleared then ended before it: That is not in this company's books. (ends never); a zero-rated invoice: DELETED; ended before it: That is not in this company's books.; a supplier's bill alone: deleted
=== 1 CHECK(S) FAILED ===
```

## A registration's dates moved past posted tax say nothing about it

`marker 929`

`correctRegistration` stops working out what its new dates leave outside any registration, so moving a start past a posted sale is saved in silence: the return will list that tax as outside the registration, and nobody was told. (Refusing was the first answer; tax after a real change of dates is what the return exists to report, so every date door now saves and says — independent critic, 2026-09-16.) `R64` moves the start past the sale.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R64 a registration entered wrong is corrected or deleted, never into another, and the trail keeps it  corrected: Saved: 123456789RT0001, from 2024-02-01, still registered. Documents printed from now on carry the new number, including reprints of ones already sent. → 123456789RT0001 from 2024-02-01; into the earlier one: Registration 111111111RT0001 runs from 2023-01-01 to 2023-12-31; these dates would share days with it.; un-ending the earlier one: Registration 123456789RT0001 runs from 2024-02-01; these dates would share days with it.; its end moved: 2023-11-30; deleted: Deleted the registration 111111111RT0001. Its accounts stay, with anything posted to them. (gone, accounts 9 → 9); trail correct_tax_registration, delete_tax_registration; the page offers both doors for its own registration; with a sale posted under it — delete: 123456789RT0001 has 1 posted tax line, the first dated 2026-; start past the sale: Saved: 123456789RT0001, from 2026-04-01, still registered.; renumbered: Saved: 123456789RT0002, from 2024-02-01, still registered. D; End before the sale: osted tax line now falls outside it — the return will list it as outside the registration.; after it: Registration 123456789RT0002 ends 2026-12-31. The accounts s; corrected back before it: de it — the return will list it as outside the registration. (ends 2026-03-01); cleared then ended before it: de it — the return will list it as outside the registration. (ends 2026-03-01); a zero-rated invoice: 222222222RT0001 has 1 posted sales invoice, the fi; ended before it: 1 posted sales invoice dated outside it will print without the number.; a supplier's bill alone: deleted
=== 1 CHECK(S) FAILED ===
```

## A register row corrected is written to the trail under the database role

`marker 930`

The record edit doors stop saying who is acting, so every change and removal row the 0083 triggers write names the database role instead of the person. `CR52` reads every audit row the records suite wrote.

```
$ db:verify-records | npm run db:verify-records
FAIL  CR44 a minute-book record is corrected or deleted from its row, and the trail keeps what it said  saved: Saved the minute-book record. (every box took); bad boxes: Nothing was saved. Date "soon" is not a date. Title is missing. (nothing changed); deleted: Deleted the minute-book record "Appointment of auditors". (gone); trail: nothing under the person
FAIL  CR46 a director's term is corrected, refused where it would overlap or lack an address, moved to a new name, and deleted  un-ceased into the later term: Nothing was saved. That term would overlap another term of the same person.; fixed: 2021-02-01→2022-06-30 at 7 Typed St; new name, no address: Nothing was saved. A director needs a prescribed address, and Robin Vale has none on file  (0 Robin Vale left on the list); with one: Saved the director. Added to this company's list: Robin Vale.; deleted: gone; trail ∅→2022-01-01 under the person
FAIL  CR47 a significant individual is corrected with blank private boxes kept, and the trail carries no private field  blank boxes: birth 1980-02-02, address 1 Secret Ln; typed address: 2 New Ln; no start: Nothing was saved. Since is missing.; deleted: Deleted the significant individual.; trail ; no private field in it
FAIL  CR48 a share movement is corrected or deleted, a transfer as one, and nobody is ever left holding less than nothing  issue to 50: Kim Ng 30, Lee Wong 10; to 30: Nothing was saved. SHARES_OVERDRAWN: that holder would be at -10 shares on 2022-01-01; nob (unchanged); transfer corrected: both rows right, Kim Ng 35, Lee Wong 5; as an issue: Nothing was saved. This is a transfer. To record it as something else, delete it and add t; issue deleted first: Nothing was deleted. SHARES_OVERDRAWN: that holder would be at -45 shares on 2022-02-01; n (4 rows); then cancellation, transfer, issue: gone / gone / gone, 0 left; trail 0 change row(s), 0 removal row(s)
FAIL  CR49 a share class is renamed, refused a name already taken, and deleted only while nothing is in it  in use: Common has 1 movement on the register. Delete those first, or rename the class instead.; renamed: Saved the class as Class A Common — Series 1.; taken: This company already has a class by that name.; empty: Deleted the class Preferred.; left Class A Common — Series 1 (1); trail nothing
FAIL  CR52 every audit row this suite wrote names a person, not the database role  change_corporate_office ×5, change_directorship ×1, change_minute_book_entry ×1, change_share_class ×1, change_share_transaction ×3, change_significant_individual ×3, delete_corporate_office ×1, delete_directorship ×1, delete_minute_book_entry ×1, delete_share_class ×1, delete_share_transaction ×4, delete_significant_individual ×1 name the database role
=== 6 CHECK(S) FAILED ===
```

## A registration ended before posted tax says nothing about it

`marker 931`

`ceaseTax` stops working out what the end leaves outside, so ending a registration — or correcting its end, or clearing it through Edit and ending it again — before a posted sale is saved in silence, and the End door says less than the Edit door. `R64` ends it before the sale three ways.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R64 a registration entered wrong is corrected or deleted, never into another, and the trail keeps it  corrected: Saved: 123456789RT0001, from 2024-02-01, still registered. Documents printed from now on carry the new number, including reprints of ones already sent. → 123456789RT0001 from 2024-02-01; into the earlier one: Registration 111111111RT0001 runs from 2023-01-01 to 2023-12-31; these dates would share days with it.; un-ending the earlier one: Registration 123456789RT0001 runs from 2024-02-01; these dates would share days with it.; its end moved: 2023-11-30; deleted: Deleted the registration 111111111RT0001. Its accounts stay, with anything posted to them. (gone, accounts 9 → 9); trail correct_tax_registration, delete_tax_registration; the page offers both doors for its own registration; with a sale posted under it — delete: 123456789RT0001 has 1 posted tax line, the first dated 2026-; start past the sale: osted tax line now falls outside it — the return will list it as outside the registration.; renumbered: Saved: 123456789RT0002, from 2024-02-01, still registered. D; End before the sale: Registration 123456789RT0002 ends 2026-03-01. The accounts stay.; after it: Registration 123456789RT0002 ends 2026-12-31. The accounts s; corrected back before it: stration 123456789RT0002 ends 2026-03-01. The accounts stay. (ends 2026-03-01); cleared then ended before it: stration 123456789RT0002 ends 2026-03-01. The accounts stay. (ends 2026-03-01); a zero-rated invoice: 222222222RT0001 has 1 posted sales invoice, the fi; ended before it: Registration 222222222RT0001 ends 2026-04-30. The accounts stay.; a supplier's bill alone: deleted
=== 1 CHECK(S) FAILED ===
```

## A registration holding only a zero-rated invoice can be deleted

`marker 932`

`restingOn` stops counting posted invoices, so a registration whose only use is an invoice with no tax line — which still prints its number — is deleted and every reprint of that invoice loses the number. `R64` posts a zero-rated invoice and deletes the registration.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R64 a registration entered wrong is corrected or deleted, never into another, and the trail keeps it  corrected: Saved: 123456789RT0001, from 2024-02-01, still registered. Documents printed from now on carry the new number, including reprints of ones already sent. → 123456789RT0001 from 2024-02-01; into the earlier one: Registration 111111111RT0001 runs from 2023-01-01 to 2023-12-31; these dates would share days with it.; un-ending the earlier one: Registration 123456789RT0001 runs from 2024-02-01; these dates would share days with it.; its end moved: 2023-11-30; deleted: Deleted the registration 111111111RT0001. Its accounts stay, with anything posted to them. (gone, accounts 9 → 9); trail correct_tax_registration, delete_tax_registration; the page offers both doors for its own registration; with a sale posted under it — delete: 123456789RT0001 has 1 posted tax line, the first dated 2026-; start past the sale: osted tax line now falls outside it — the return will list it as outside the registration.; renumbered: Saved: 123456789RT0002, from 2024-02-01, still registered. D; End before the sale: osted tax line now falls outside it — the return will list it as outside the registration.; after it: Registration 123456789RT0002 ends 2026-12-31. The accounts s; corrected back before it: de it — the return will list it as outside the registration. (ends 2026-03-01); cleared then ended before it: de it — the return will list it as outside the registration. (ends 2026-03-01); a zero-rated invoice: DELETED; ended before it: That is not in this company's books.; a supplier's bill alone: deleted
=== 1 CHECK(S) FAILED ===
```

## An added copy of a built-in edition puts two of one edition on the list

`marker 933`

`loadEditions` stops leaving out rows a release has since built in, so the list carries two editions of one id and every pay run, T4 and SR&ED paper of every company is refused. `PR64` files a copy of 2026-07 and computes an August pay date.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR64 an added copy of an edition a release builds in is ignored, shown with Remove, and kept while stubs rest on different figures  an August 2026 pay date with the copy on file: BAD_TABLES; listed 2 time(s), the copy different, Remove offered; 15 stub(s) name 2026-07; removing while different: 15 pay stubs were computed with 2026-07 while the copy added here was ; once the same: Removed 2026-07. Payroll can now run up to 2026-12-31. (0 row(s) left, trail keeps its figures and PDOC); again: 2026-07 is built into the app and cannot be removed here.
=== 1 CHECK(S) FAILED ===
```

## An added copy of a built-in edition cannot be removed

`marker 934`

`removeEdition` answers every built-in id as built in without looking for a copy in the database, so a row added before a release shipped the same edition stays for good. `PR64` removes the copy.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR64 an added copy of an edition a release builds in is ignored, shown with Remove, and kept while stubs rest on different figures  an August 2026 pay date with the copy on file: 2026-07; listed 1 time(s), the copy different, Remove offered; 15 stub(s) name 2026-07; removing while different: 15 pay stubs were computed with 2026-07 while the copy added here was ; once the same: Removed 2026-07. Payroll can now run up to 2026-12-31. (1 row(s) left, trail keeps its figures and PDOC); again: Removed 2026-07. Payroll can now run up to 2026-12-31.
=== 1 CHECK(S) FAILED ===
```

## A supplier's bill holds a registration it never printed

`marker 935`

`restingOn` counts purchase bills with sales invoices, so a registration whose only use is a supplier's bill — which carries the supplier's number, not ours — cannot be deleted, and the owner's Acme registration with three posted bills would be held by them. `R64` posts a bill and deletes the registration.

```
$ db:verify-registrations | npm run db:verify-registrations
FAIL  R64 a registration entered wrong is corrected or deleted, never into another, and the trail keeps it  corrected: Saved: 123456789RT0001, from 2024-02-01, still registered. Documents printed from now on carry the new number, including reprints of ones already sent. → 123456789RT0001 from 2024-02-01; into the earlier one: Registration 111111111RT0001 runs from 2023-01-01 to 2023-12-31; these dates would share days with it.; un-ending the earlier one: Registration 123456789RT0001 runs from 2024-02-01; these dates would share days with it.; its end moved: 2023-11-30; deleted: Deleted the registration 111111111RT0001. Its accounts stay, with anything posted to them. (gone, accounts 9 → 9); trail correct_tax_registration, delete_tax_registration; the page offers both doors for its own registration; with a sale posted under it — delete: 123456789RT0001 has 1 posted tax line, the first dated 2026-; start past the sale: osted tax line now falls outside it — the return will list it as outside the registration.; renumbered: Saved: 123456789RT0002, from 2024-02-01, still registered. D; End before the sale: osted tax line now falls outside it — the return will list it as outside the registration.; after it: Registration 123456789RT0002 ends 2026-12-31. The accounts s; corrected back before it: de it — the return will list it as outside the registration. (ends 2026-03-01); cleared then ended before it: de it — the return will list it as outside the registration. (ends 2026-03-01); a zero-rated invoice: 222222222RT0001 has 1 posted sales invoice, the fi; ended before it: 1 posted sales invoice dated outside it will print without the number.; a supplier's bill alone: 333333333RT0001 has 1 posted sales invoice, the first dated 2026-05-10 dated while it was registered. Tax lines are what the return reads, and a sales invoice prints the registration number every time it is printed. So it stays; end it on the right date instead.
=== 1 CHECK(S) FAILED ===
```

## An added copy is removed while stubs rest on its different figures

`marker 936`

`removeEdition` stops asking whether pay was run under a copy whose figures differ from the release's, so removing it destroys the only record of what those stubs were worked out from. `PR64` removes a differing copy with fifteen stubs naming its id.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR64 an added copy of an edition a release builds in is ignored, shown with Remove, and kept while stubs rest on different figures  an August 2026 pay date with the copy on file: 2026-07; listed 1 time(s), the copy different, Remove offered; 15 stub(s) name 2026-07; removing while different: REMOVED (Removed 2026-07. Payroll can now run up to 2026-12-31.); once the same: 2026-07 is built into the app and cannot be removed here. (0 row(s) left, trail keeps its figures and PDOC); again: 2026-07 is built into the app and cannot be removed here.
=== 1 CHECK(S) FAILED ===
```

## The added copy's Remove names no edition

`marker 937`

`EditionCopy` posts an empty edition id, so the payroll screen shows the copy and a Remove that removes nothing. `PR64` renders the note and reads the form.

```
$ db:verify-payroll | npm run db:verify-payroll
FAIL  PR64 an added copy of an edition a release builds in is ignored, shown with Remove, and kept while stubs rest on different figures  an August 2026 pay date with the copy on file: 2026-07; listed 1 time(s), the copy different, Remove NOT offered; 15 stub(s) name 2026-07; removing while different: 15 pay stubs were computed with 2026-07 while the copy added here was ; once the same: Removed 2026-07. Payroll can now run up to 2026-12-31. (0 row(s) left, trail keeps its figures and PDOC); again: 2026-07 is built into the app and cannot be removed here.
=== 1 CHECK(S) FAILED ===
```

## The gate is shown the path before the router decodes it

`marker 938`

The proxy forwards `nextUrl.pathname` as it arrived. `/ledger/%36…/backup/file` names no ledger to the gate, while the router hands the page the decoded id — the whole company, payroll included, to anybody signed in who knows its id (security review, 2026-10-20). `US38` asks the proxy what it forwards.

```
$ db:verify-users | npm run db:verify-users
FAIL  US38 an escaped ledger id or module is judged as the router reads it  proxy forwards /ledger/%30dc91144-d409-420e-86c4-4c85a15fdaf0/backup/file?paper=yes → NO_COMPANY; the raw escaped path → NO_COMPANY; an escaped /payroll → NO_MODULE; an undecodable path → 400
=== 1 CHECK(S) FAILED ===
```

## A ledger path the gate cannot read is admitted as no ledger at all

`marker 939`

`refuseFor` answers a `/ledger/` path with no readable id the way it answers `/companies`: not a ledger question, so yes. That was the second half of the escaped-id leak, and it is what stands if the proxy ever forwards a path the router reads differently. `US38` hands the gate the raw escaped path.

```
$ db:verify-users | npm run db:verify-users
FAIL  US38 an escaped ledger id or module is judged as the router reads it  proxy forwards /ledger/4cfa32b9-1932-41d9-9af8-7fcc8f68ee8f/backup/file?paper=yes → NO_COMPANY; the raw escaped path → opens; an escaped /payroll → NO_MODULE; an undecodable path → 400
=== 1 CHECK(S) FAILED ===
```

## A backup names its own columns

`marker 940`

The restore stops checking a row's keys against the columns that exist. The keys become the column list of an INSERT run with every trigger off, and the checksum is a SHA-256 anybody can recompute, so the file decides what SQL that is (security review, 2026-10-20). `BK11c` hands it a key with a statement in it.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK11c a column the database does not have is refused before anything is written  Failed query: 
=== 1 CHECK(S) FAILED ===
```

## A restore loads books that do not balance

`marker 941`

The restore stops asking the loaded ledger what its triggers would have refused. An entry out of balance, or a balance cache that disagrees with the lines under it, goes in exactly as the file says, and every report reads the cache. `BK11d` nudges one line and one cached balance by a dollar.

```
$ db:verify-backup | npm run db:verify-backup
FAIL  BK11d books that do not hold together are refused whole    an entry out of balance: it was restored, 1 left behind; a balance cache that disagrees with its lines: it was restored, 1 left behind
=== 1 CHECK(S) FAILED ===
```

## Any owner restores with the triggers off

`marker 942`

The restore action goes back to asking only for an owner. The screen, RISKS §1 and the check's own name say the superadmin, and the load it starts runs with every trigger off. `N48` reads the action and the page.

```
$ db:verify-shell | npm run db:verify-shell
FAIL  N23 a resume past the last block is refused, and the tree is left alone  it did not refuse: MUTATION SCRIPT IS NOT READY:
FAIL  N48 superadmin can restore in the app and export the filtered audit trail without widening either door  superadmin-only web restore false; owner filtered CSV true
=== 2 CHECK(S) FAILED ===
```

## A ledger file starts importing payroll

`marker 943`

One import, from the period code into the payroll module. Nothing breaks and every suite stays green — which is how the base bundle came to know thirteen add-ons. `MV2` reads every import in the tree against the record of the crossings that already exist (docs/design/48-module-boundaries.md).

```
$ db:verify-modules | npm run db:verify-modules
FAIL  MV2 no new import from the base bundle into an add-on               1 new: src/lib/periods.ts -> src/lib/payroll/runs.ts
=== 1 CHECK(S) FAILED ===
```

## The record of crossings forgets one

`marker 944`

The cheque-to-pay-stub foreign key drops out of the baseline while the constraint stays. If the record could shrink without the schema changing, it would stop being a record of the schema. `MV3` finds the constraint the record no longer lists.

```
$ db:verify-modules | npm run db:verify-modules
FAIL  MV3 no new foreign key from a base table to an add-on               1 new: cheque -> pay_stub
=== 1 CHECK(S) FAILED ===
```

## A table belongs to no module

`marker 945`

The rule that gives `mcp_credential` to MCP stops matching it. A table nobody owns is one no manifest will install, back up or remove. `MV1` asks every table in the migrated schema for its owner.

```
$ db:verify-modules | npm run db:verify-modules
FAIL  MV1 every table belongs to a module                                 unclaimed: mcp_credential
=== 1 CHECK(S) FAILED ===
```

## The register forgets SR&ED's projects

`marker 946`

`sred_project` drops out of `audit_scope_source`. Nothing refuses: an SR&ED project's trail rows just stop finding their company and sit as unresolved, outside every company's audit screen and backup. `S41` compares the register with the mapping 0086 wrote and writes a row with no company.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S41 an SR&ED row still finds its company in the trail, which names no SR&ED table any more  0086's mapping CHANGED, system tables kept, 0 register row(s) naming a column that is not there; the trigger names no SR&ED table; a project row lands unresolved, a rate row system
=== 1 CHECK(S) FAILED ===
```

## The trail stops asking the register for a company

`marker 947`

The trigger keeps its own lines and no longer reads `audit_scope_source` for an entity column, so every add-on table's row is unresolved while the register is intact. `S41` writes an SR&ED project row with no company.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S41 an SR&ED row still finds its company in the trail, which names no SR&ED table any more  0086's mapping kept, system tables kept, 0 register row(s) naming a column that is not there; the trigger names no SR&ED table; a project row lands unresolved, a rate row system
=== 1 CHECK(S) FAILED ===
```

## The chart of accounts learns SR&ED again

`marker 948`

The account door goes back to reading an SR&ED tag. It reads into nothing — the column it would write is frozen — so every form still saves and every suite about accounts stays green, and the framework knows an add-on once more. `S42` reads every base file for the tag's name.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S42 an account's T661 line is SR&ED's own row: no base file names it, and setting it is on the company's trail  base files naming it: src/lib/master-forms.ts; tagged capital; 1 trail row (company); salary BAD_CATEGORY; cleared leaves 0
=== 1 CHECK(S) FAILED ===
```

## An account's T661 line changes off the trail

`marker 949`

`setSredAccountCategory` stops writing its audit row. The tag still saves and every allocation still reads it; the company's trail simply never says who moved rent into overhead, or when. `S42` looks for the row.

```
$ db:verify-sred | npm run db:verify-sred
FAIL  S42 an account's T661 line is SR&ED's own row: no base file names it, and setting it is on the company's trail  no base file names it; tagged capital; 0 trail row (none); salary BAD_CATEGORY; cleared leaves 0
=== 1 CHECK(S) FAILED ===
```

## Not covered here

No state mutation for migration-check ordering is claimed; the standard battery runs its current normal check.

## What the blocks span

| suite | times run |
|---|---|
| `db:verify-sred` | 104 |
| `db:verify-bills` | 77 |
| `db:verify-inquiry` | 65 |
| `db:verify-payroll` | 65 |
| `db:verify-invoices` | 63 |
| `db:verify-records` | 55 |
| `db:verify-registrations` | 54 |
| `db:verify-shell` | 49 |
| `db:verify-exports` | 37 |
| `db:verify-bank-match` | 32 |
| `db:verify-bank-reconcile` | 31 |
| `db:verify-users` | 29 |
| `db:verify-statements` | 24 |
| `db:verify-backup` | 23 |
| `db:verify-parties` | 23 |
| `db:verify-attachments` | 21 |
| `db:verify-payments` | 18 |
| `db:verify-quick` | 18 |
| `db:verify-bank` | 17 |
| `db:verify-setup` | 17 |
| `db:verify-assistant` | 14 |
| `db:verify-bank-import` | 11 |
| `db:verify-picker` | 11 |
| `db:verify-opening` | 10 |
| `db:verify-periods` | 10 |
| `db:verify-tax` | 10 |
| `db:verify-search` | 9 |
| `backup:states` | 8 |
| `db:verify-accounts` | 8 |
| `db:verify-drafts` | 8 |
| `db:verify-aging` | 7 |
| `db:verify-documents` | 7 |
| `db:verify` | 6 |
| `db:verify-modules` | 3 |
| `db:check-migrations` | 2 |
| `db:verify-reports` | 2 |

**948 suite runs across all blocks.** The independent `npm run db:toothless` validates all945 declarations and three named controls.
