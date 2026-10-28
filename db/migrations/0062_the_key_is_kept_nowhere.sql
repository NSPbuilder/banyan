-- 0062 — the key is kept nowhere; what answered, and at what price, is.
--
-- The owner's ruling (2026-09-06): 「key哪里都不留，用户不填自己的key就没有ai功能」.
-- Each person brings their own service — address, key, model — typed on the
-- assistant's page and remembered by their browser; the server uses the key
-- for that one request and writes it nowhere: no column, no setting, no log,
-- and `ask` strikes it out of any error text before recording. The first two
-- versions read the service from the environment (0061's day); that is gone.
--
-- What the trail CAN keep is what is not secret and is a fact about the
-- asking: which service answered (the host of the address), under which model
-- name, and the prices the person typed at the time — so money is still
-- derived per row, from that row's own tokens and that row's own prices, and
-- a later price never rewrites an earlier asking.

ALTER TABLE ai_exchange
  ADD COLUMN service      text,
  ADD COLUMN price_input  numeric CHECK (price_input  IS NULL OR price_input  >= 0),
  ADD COLUMN price_output numeric CHECK (price_output IS NULL OR price_output >= 0),
  ADD COLUMN price_cached numeric CHECK (price_cached IS NULL OR price_cached >= 0),
  ADD COLUMN price_unit   text;
