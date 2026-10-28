-- Existing records and bindings remain intact. Incorporation packages and
-- internal memos now have their own kind in the document-led minute book.
ALTER TABLE minute_book_entry DROP CONSTRAINT minute_book_entry_record_kind_check;
ALTER TABLE minute_book_entry ADD CONSTRAINT minute_book_entry_record_kind_check CHECK (record_kind IN (
  'certificate', 'court_or_regulator_order', 'directors_consent',
  'resignation', 'shareholders_minutes', 'shareholders_resolution',
  'directors_minutes', 'directors_resolution', 'written_dissent',
  'financial_statements', 'articles', 'other', 'incorporation', 'memo'
));
