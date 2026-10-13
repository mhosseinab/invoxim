CREATE TABLE fx_rates (
 id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'),
 source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 80),
 from_currency TEXT NOT NULL CHECK(length(from_currency)=3 AND from_currency NOT GLOB '*[^A-Z]*'),
 to_currency TEXT NOT NULL CHECK(length(to_currency)=3 AND to_currency NOT GLOB '*[^A-Z]*'),
 requested_date TEXT NOT NULL CHECK(length(requested_date)=10),
 effective_date TEXT NOT NULL CHECK(length(effective_date)=10),
 rate TEXT NOT NULL CHECK(length(rate) BETWEEN 1 AND 31 AND rate NOT GLOB '*[^0-9.]*' AND substr(rate,1,1) BETWEEN '0' AND '9' AND substr(rate,-1,1) BETWEEN '0' AND '9' AND length(rate)-length(replace(rate,'.',''))<=1 AND replace(rate,'.','') GLOB '*[1-9]*' AND (substr(rate,1,1)<>'0' OR substr(rate,2,1)='.') AND CASE WHEN instr(rate,'.')=0 THEN length(rate)<=12 ELSE instr(rate,'.')<=13 AND length(rate)-instr(rate,'.') BETWEEN 1 AND 18 END),
 retrieved_at INTEGER NOT NULL CHECK(typeof(retrieved_at)='integer' AND retrieved_at BETWEEN 0 AND 9007199254740991),
 source_version TEXT NOT NULL CHECK(length(source_version) BETWEEN 1 AND 80),
 UNIQUE(source,from_currency,to_currency,requested_date,effective_date,source_version)
);
CREATE TABLE entry_valuations (
 user_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 reporting_currency TEXT NOT NULL CHECK(length(reporting_currency)=3 AND reporting_currency NOT GLOB '*[^A-Z]*'),
 profile_version INTEGER NOT NULL CHECK(typeof(profile_version)='integer' AND profile_version BETWEEN 1 AND 2147483646),
 entry_version INTEGER NOT NULL CHECK(typeof(entry_version)='integer' AND entry_version BETWEEN 1 AND 2147483646),
 calculation_version TEXT NOT NULL CHECK(calculation_version='fx-v1'),
 policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),
 policy_source TEXT NOT NULL CHECK(length(policy_source) BETWEEN 1 AND 80),
 max_prior_age_days INTEGER NOT NULL CHECK(typeof(max_prior_age_days)='integer' AND max_prior_age_days BETWEEN 0 AND 31),
 original_kind TEXT NOT NULL CHECK(original_kind IN ('payment','refund')),
 original_minor INTEGER NOT NULL CHECK(typeof(original_minor)='integer' AND original_minor BETWEEN 0 AND 9000000000000),
 original_currency TEXT NOT NULL,
 original_event_date TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('converted','unconverted')),
 signed_minor TEXT CHECK(signed_minor IS NULL OR (typeof(signed_minor)='text' AND (signed_minor='0' OR (signed_minor NOT GLOB '*[^0-9]*' AND substr(signed_minor,1,1) BETWEEN '1' AND '9' AND length(signed_minor)<=19 AND (length(signed_minor)<19 OR signed_minor<='9223372036854775807')) OR (substr(signed_minor,1,1)='-' AND substr(signed_minor,2) NOT GLOB '*[^0-9]*' AND substr(signed_minor,2,1) BETWEEN '1' AND '9' AND length(signed_minor)<=20 AND (length(signed_minor)<20 OR substr(signed_minor,2)<='9223372036854775807'))))),
 basis TEXT CHECK(basis IN ('identity','reference')),
 reason TEXT CHECK(reason IN ('rate_missing','currency_unsupported','rate_future','rate_stale','quote_mismatch','source_mismatch','invalid_quote','magnitude_overflow')),
 rate_id TEXT REFERENCES fx_rates(id),
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483646),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(user_id,entry_id,reporting_currency,profile_version,entry_version,calculation_version,policy_hash),
 FOREIGN KEY(user_id,entry_id) REFERENCES ledger_entries(user_id,id) ON DELETE CASCADE,
 CHECK((status='converted' AND signed_minor IS NOT NULL AND basis IS NOT NULL AND reason IS NULL AND ((basis='identity' AND rate_id IS NULL AND original_currency=reporting_currency) OR (basis='reference' AND rate_id IS NOT NULL AND original_currency<>reporting_currency))) OR (status='unconverted' AND signed_minor IS NULL AND basis IS NULL AND reason IS NOT NULL)),
 CHECK(status='unconverted' OR (original_kind='payment' AND substr(signed_minor,1,1)<>'-') OR (original_kind='refund' AND (signed_minor='0' OR substr(signed_minor,1,1)='-')))
);
CREATE INDEX fx_rates_public_lookup ON fx_rates(source,from_currency,to_currency,effective_date DESC);
CREATE INDEX entry_valuations_current ON entry_valuations(user_id,entry_id,profile_version,entry_version,reporting_currency,calculation_version,policy_hash);
