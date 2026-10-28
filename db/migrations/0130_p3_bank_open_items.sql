-- Optional outstanding BOOK transactions; bank statements/reconciliation history are not inferred.
ALTER TABLE migration_file DROP CONSTRAINT migration_file_kind_check;
ALTER TABLE migration_file ADD CONSTRAINT migration_file_kind_check CHECK(kind IN
 ('accounts','trial_balance','open_items','starting_trial_balance','starting_open_items','general_ledger','applications','bank_open_items','starting_bank_open_items'));
ALTER TABLE migration_stage DROP CONSTRAINT migration_stage_data_check;
ALTER TABLE migration_stage ADD CONSTRAINT migration_stage_data_check CHECK(jsonb_typeof(data)='object' AND data->>'type' IN
 ('account','balance','item','gl','application','bank_item'));
