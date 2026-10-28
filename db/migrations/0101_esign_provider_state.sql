-- This is authoritative-provider signing state, not a cached accounting age.
ALTER TABLE esign_request RENAME COLUMN snapshot TO provider_state;
