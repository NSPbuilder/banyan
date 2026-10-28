-- 0063 — the key is kept after all: per person, encrypted, under a secret
-- that lives only in .env.local.
--
-- 0062 (this morning) kept nothing: each person's key travelled with every
-- question and was forgotten with the tab. The owner used it and revised the
-- ruling the same day: 「用户填好之后就一直可用吧，关掉后不要忘掉，但保持加密」 —
-- keep it once filled in, but keep it encrypted.
--
-- Encrypted in the one way that means something on a self-hosted system: the
-- key is AES-256-GCM under AI_KEY_SECRET, a secret the owner puts in
-- .env.local and nowhere else. A database backup carries the ciphertext and
-- not the secret; the environment file carries the secret and no ciphertext.
-- Either alone reveals nothing. A restore on a machine without the secret
-- makes every saved key unreadable, and the page then asks for it again —
-- which is the intended failure, and RESTORE.md says so.
--
-- One row per person: the assistant's service is theirs, not the company's.
-- `key_hint` is the last four characters, so the page can say which key is
-- saved without showing it. The prices are the ones they want their askings
-- costed at; each asking still copies them into its own row (0062).

CREATE TABLE user_ai_service (
  user_id      uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  base_url     text NOT NULL,
  model        text NOT NULL,
  key_enc      bytea NOT NULL,     -- iv (12 bytes) || auth tag (16) || ciphertext
  key_hint     text NOT NULL,
  price_input  numeric CHECK (price_input  IS NULL OR price_input  >= 0),
  price_output numeric CHECK (price_output IS NULL OR price_output >= 0),
  price_cached numeric CHECK (price_cached IS NULL OR price_cached >= 0),
  price_unit   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
