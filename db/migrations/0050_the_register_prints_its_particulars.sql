-- 0050 — the register's particulars, and the certificate that changes hands
--
-- Why: s.111(1) asks the central securities register for the name and last
-- known address of each holder, the class and any series, the number of shares
-- held, and the DATE AND PARTICULARS of each issue and of each transfer. This
-- register kept the first three and printed nothing of the fourth: every
-- movement was in the table and on no page (owner, 2026-09-03, asking which of
-- address / par value / allotment-or-transfer / from whom / consideration
-- belong on it).
--
-- Par value is deliberately NOT here, for one reason that can be checked:
-- s.111(1) does not list it among the things this register must contain. And
-- where a class does carry a par value, it is fixed for THE CLASS by the
-- articles — it is not a fact about a holder's row, which is what this table
-- holds.
--
-- "Amount agreed to be considered as paid" and "amount paid per share" are not
-- here either, as a pair: they are the old Companies Act register of members.
-- The BCA asks for the particulars of the issue, and what was given for the
-- shares is one honest column.
--
-- What a movement gains:
--   consideration    what was given for the shares — "$1.00 per share, cash",
--                    "for services rendered", "on the amalgamation".
--   certificate_no   the certificate this movement LEAVES its holder holding.
--                    On a transfer of part of a holding, that is the BALANCE
--                    certificate the transferor gets back.
--   surrendered_no   the certificate this movement takes in and cancels.
--
-- The last two answer the owner's question — should a transfer cancel the old
-- shares and issue new ones? The SHARES are not cancelled and re-issued: they
-- are the same shares, and re-issuing them would inflate the total ever issued
-- and lose the fact that they moved. It is the CERTIFICATE that is surrendered
-- and re-issued, with a balance certificate when only part of a holding goes.
-- Uncertificated shares are ordinary here: all three columns stay NULL.
--
-- Append-only still holds: these are columns on the movement, written when the
-- movement is recorded, and the table's own trigger refuses every UPDATE.

ALTER TABLE share_transaction ADD COLUMN consideration  text;
ALTER TABLE share_transaction ADD COLUMN certificate_no text;
ALTER TABLE share_transaction ADD COLUMN surrendered_no text;

-- Blank is not a particular; it is a NULL that got through a form. The same
-- shape rule party_address puts on line1 and 0049 puts on document_ref.
ALTER TABLE share_transaction ADD CONSTRAINT share_transaction_particulars_shape
  CHECK ((consideration  IS NULL OR length(trim(consideration))  > 0)
     AND (certificate_no IS NULL OR length(trim(certificate_no)) > 0)
     AND (surrendered_no IS NULL OR length(trim(surrendered_no)) > 0));

-- An issue mints shares; there is no certificate to take in.
ALTER TABLE share_transaction ADD CONSTRAINT share_transaction_issue_surrenders_nothing
  CHECK (kind <> 'issue' OR surrendered_no IS NULL);

-- Who may see what stays DATA (0035's rule, and 0048's lesson: a field the
-- visibility table has never heard of defaults to VISIBLE, which is how a
-- public render once showed dates beside a withheld name).
--
-- The holder's address is as private as the holder's name. The particulars
-- are the whole second table, gated by one row: a public inspection copy of
-- this register shows neither who holds what nor how they came to.
INSERT INTO register_field_visibility (register, field, visibility) VALUES
  ('central_securities', 'address',      'private'),
  ('central_securities', 'particulars',  'private');

COMMENT ON COLUMN share_transaction.consideration IS
  'What was given for the shares — the particular s.111(1) asks for.';
COMMENT ON COLUMN share_transaction.certificate_no IS
  'The certificate this movement leaves its holder holding (a balance certificate on a partial transfer out).';
COMMENT ON COLUMN share_transaction.surrendered_no IS
  'The certificate this movement takes in and cancels.';
