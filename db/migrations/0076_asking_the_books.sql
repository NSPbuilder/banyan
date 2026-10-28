-- 0076 · Asking the books (docs/design/38-a-sentence-to-the-books.md).
--
-- A question the assistant answers by looking things up with read-only tools.
-- The question and the exact system text go in BEFORE the first request
-- leaves; each step — a reply and what was sent back, or a person pressing
-- Keep looking — goes in BEFORE the next request. So everything a request
-- carries is already on record when it leaves, and a process killed while
-- waiting loses only the reply that never came.
--
-- Both tables are append-only, like ai_exchange (0061). Totals, the answer,
-- why it stopped and whether Keep looking is offered are derived from the
-- steps, never stored.

CREATE TABLE ai_inquiry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id     uuid NOT NULL REFERENCES ledger(id),
  asked_at      timestamptz NOT NULL DEFAULT now(),
  asked_by      text NOT NULL,
  question      text NOT NULL CHECK (length(btrim(question)) > 0),
  -- Verbatim, with the tool list as filtered by the asker's seats at the time.
  system        text NOT NULL,
  model         text NOT NULL,
  service       text,
  price_input   numeric CHECK (price_input  IS NULL OR price_input  >= 0),
  price_output  numeric CHECK (price_output IS NULL OR price_output >= 0),
  price_cached  numeric CHECK (price_cached IS NULL OR price_cached >= 0),
  price_unit    text
);
CREATE INDEX ai_inquiry_ledger_idx ON ai_inquiry (ledger_id, asked_at DESC);

CREATE TABLE ai_inquiry_step (
  inquiry_id         uuid NOT NULL REFERENCES ai_inquiry(id),
  n                  integer NOT NULL CHECK (n >= 1),
  -- When the reply came back, or when the person pressed Keep looking.
  at                 timestamptz NOT NULL DEFAULT now(),
  outcome            text NOT NULL CHECK (outcome IN (
                       'call', 'unreadable', 'too_much', 'answer', 'answer_unformatted',
                       'refusal', 'error', 'cut_off', 'call_after_limit', 'too_slow', 'more')),
  model_text         text,
  stop_reason        text,
  input_tokens       integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens  integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  error              text,
  tool               text,
  args               jsonb,
  -- Exactly what went back to the model; NULL when nothing did.
  result             text,
  -- This step reached the question's character limit.
  capped             boolean NOT NULL DEFAULT false,
  -- Only on a Keep looking press: who pressed.
  asked_by           text,
  -- Two presses at once both aim at the same n; the second is refused here.
  PRIMARY KEY (inquiry_id, n),
  CONSTRAINT ai_inquiry_step_more_is_a_press CHECK ((outcome = 'more') = (asked_by IS NOT NULL)),
  CONSTRAINT ai_inquiry_step_a_press_carries_no_reply CHECK (
    outcome <> 'more' OR (
      model_text IS NULL AND stop_reason IS NULL AND error IS NULL AND tool IS NULL
      AND args IS NULL AND result IS NULL AND input_tokens = 0 AND output_tokens = 0
      AND cache_read_tokens = 0 AND NOT capped))
);

CREATE OR REPLACE FUNCTION ai_inquiry_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AI_INQUIRY_IMMUTABLE: a question to the books and its steps are a record; they are not edited or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ai_inquiry_immutable
  BEFORE UPDATE OR DELETE ON ai_inquiry
  FOR EACH ROW EXECUTE FUNCTION ai_inquiry_is_immutable();

CREATE TRIGGER trg_ai_inquiry_step_immutable
  BEFORE UPDATE OR DELETE ON ai_inquiry_step
  FOR EACH ROW EXECUTE FUNCTION ai_inquiry_is_immutable();
