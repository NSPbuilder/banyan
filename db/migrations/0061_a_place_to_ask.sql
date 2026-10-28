-- 0061 — a place to ask, and a record of every asking.
--
-- The owner wants an assistant in the application before deciding what it is
-- for (2026-09-06: 「我还没想好具体要ai做什么，把模块做出来先」). What can be
-- decided now is the part that does not depend on the purpose: every question
-- and every answer is a row, with who asked, what the books contributed, what
-- the model said, and what it cost in tokens. Cost in dollars is derived at
-- display from the token counts and a price table in code — a stored dollar
-- figure would be wrong the day the price changed.
--
-- `books_sent` is the exact text the books contributed to the request, or
-- NULL when nothing did. Sending a company's figures to a service outside
-- this machine is the one thing here a reader will want to be sure about, so
-- it is not a flag; it is the text.
--
-- Append-only, like the audit log: a trail that can be edited is not one.

CREATE TABLE ai_exchange (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id          uuid NOT NULL REFERENCES ledger(id),
  asked_at           timestamptz NOT NULL DEFAULT now(),
  asked_by           text NOT NULL,
  model              text NOT NULL,
  question           text NOT NULL CHECK (length(btrim(question)) > 0),
  books_sent         text,
  answer             text,
  stop_reason        text,
  input_tokens       integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens  integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  error              text
);
CREATE INDEX ai_exchange_ledger_idx ON ai_exchange (ledger_id, asked_at DESC);

CREATE OR REPLACE FUNCTION ai_exchange_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AI_EXCHANGE_IMMUTABLE: an exchange with the assistant is a record; it is not edited or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ai_exchange_immutable
  BEFORE UPDATE OR DELETE ON ai_exchange
  FOR EACH ROW EXECUTE FUNCTION ai_exchange_is_immutable();
