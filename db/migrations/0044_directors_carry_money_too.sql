-- 0044 — directors and shareholders carry money too
--
-- Why: the owner (2026-09-02) — a director advances money for the company and
-- the entry cannot name them; the loan account says "due to director" while
-- the line says nobody. 0025 seeded `transacts = false` for director and
-- shareholder on the theory that those roles exist for the corporate records
-- (P4) and money would reach a person through some other role. That theory is
-- wrong for an owner-managed company: director loans, expense advances,
-- shareholder loans, dividends — these ARE money moving, and the person the
-- money moves against IS the director or shareholder, in that capacity.
--
-- Safe by the rule's own machinery: 0027's guard refuses transacts true→false
-- while journal lines rely on the role; false→true relies on nothing and
-- orphans nothing. `party_may_transact` reads this table live, so every door
-- (typed journals, corrections, the entry screens' party list) opens at once.
-- The remaining rule still holds and still matters: a line may only name a
-- party holding SOME role at that company covering the entry date.
--
-- P01/P15 in verify-parties pin the vocabulary and were re-pinned with this
-- migration: P15 now proves a director CAN be named on a journal line.

UPDATE party_role_definition SET transacts = true
 WHERE code IN ('director', 'shareholder');
