ALTER TABLE profiles ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0 AND version <= 2147483646);
CREATE UNIQUE INDEX account_provider_identity ON "account"(providerId, accountId);
