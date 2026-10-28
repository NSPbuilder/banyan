-- 0079 — how much the screen explains belongs to the person too.
--
-- The owner, one day into using v1.0.1 on real books (2026-09-16):
-- 「网页中有太多细节解释了，我不想要那么多，尤其 new invoice 里，对于熟练使用者
-- 非常冗余」。
--
-- The prose is not padding — it is why somebody who has never kept books can
-- use this one, and it is where a decision that would otherwise live only in a
-- commit message gets said to the person it affects. So it is not deleted; it
-- is made a CHOICE, the same way the palette was in 0067, and for the same
-- reason: it belongs to a person, not to the machine, and a cookie would be
-- forgotten the first time they signed in from somewhere else.
--
-- `brief` hides the paragraphs that are PURE explanation. A paragraph that
-- carries a figure, a count or a name is never hidden, whatever this says —
-- hiding those would take data away, not noise (src/lib/ui.ts, NOTE).
--
-- Default `full`: every row that exists keeps exactly what it saw before this
-- migration ran, and a new person meets the explained version first.

ALTER TABLE app_user
  ADD COLUMN detail text NOT NULL DEFAULT 'full';

ALTER TABLE app_user
  ADD CONSTRAINT app_user_detail_known CHECK (detail IN ('full', 'brief'));

COMMENT ON COLUMN app_user.detail IS
  'full or brief — whether this person is shown the explanatory paragraphs. '
  'Never hides a paragraph carrying data; the stylesheet does the hiding, so '
  'the words stay in the page for anything that reads it (0079).';
