# Clef classifier evaluation

This tool evaluates **synthetic documents only** through the same request builder, response validator and receipt routing used in production. It does not discover or read email, use D1, mutate jobs, or run financial extraction. It has no runtime tools and always sends to the fixed Cloudflare Clef REST endpoint. It does not evaluate Perplexity pplx-decider; that calibration is an open follow-up (AI-CLASSIFIER-PROVIDER-01), and the 0.1/0.9 thresholds are unverified for pplx-decider.

A dry run is the default and needs no credentials:

```sh
node tools/implementation/clef-eval.mjs
node --test tools/implementation/clef-eval.test.mjs
```

The fixed corpus has 80 development and 40 held-out cases, balanced English/German. Six unsupported/scanned PDF documents remain reviewable without a model call. Invoice cover emails and their decoded invoice attachments are separate document cases. Positive cases include unpaid/paid invoices, sparse invoices, receipts, credit notes, completed refund confirmations and mixed notification-plus-document content. Negative cases include orders, delivery/tracking, reminders, pending refunds, cancellations, quotes, subscription notices, marketing and injection attempts. These synthetic labels are not measured model accuracy.

The dry-run report checks immutable partition hashes and complete request bytes, predicts request count and conservative reserved cost, and reports `metrics: null`. Do not tune against held-out model results. Choose prompt/threshold changes on development, freeze the candidate, then evaluate held-out once. Live runs require an explicit partition; `all` is dry-run only. A held-out run requires `--frozen-development /tmp/clef-development.json`, whose complete/error-free development result must match the current protocol and corpus hashes. Routing must match the original thresholds or an exact recorded development sweep row whose metrics recompute from the saved development scores; the negative boundary must remain unchanged. Label each additional inspection explicitly if reusing the held-out set.

## Opt-in live run

A live run requires explicit operator permission **and an agreed total cost cap** before running this command. Never paste a token into the command or chat. Wrangler supplies its existing OAuth/API token in memory using its supported `auth token --json` command. This also supports an API token already supplied through Wrangler's normal environment. The tool never prints or writes it. Global API-key/email authentication is intentionally unsupported.

```sh
node tools/implementation/clef-eval.mjs --live --wrangler-auth \
  --account-id ACCOUNT_ID --partition development \
  --max-calls 80 --max-cost-usd 0.10 --out /tmp/clef-development.json
```

After the candidate is frozen, a separately approved held-out phase can use:

```sh
node tools/implementation/clef-eval.mjs --live --wrangler-auth \
  --account-id ACCOUNT_ID --partition holdout --frozen-development /tmp/clef-development.json \
  --max-calls 40 --max-cost-usd 0.05 --out /tmp/clef-holdout.json
```

The development report includes a development-only post-hoc threshold table. These are alternate routes over recorded scores, not extra model measurements or calibration. Held-out rows are excluded from that analysis.

Read current Cloudflare documentation for the required Workers AI permissions. Saved Wrangler authorization may lack them; an authorization failure stops the run without widening permissions or creating another token. Do not read credential files or invent an alternate endpoint.

Calls are sequential with no retries, no more than 240 per invocation, 8 KiB complete JSON request limit, 16 KiB response limit, 30 seconds per call and a 20-minute run deadline. SIGINT/SIGTERM abort the active request. Any provider error stops further calls. The tariff and thresholds come from the versioned Clef configuration `config/ai.classification.clef.json` (production now selects `perplexity-decider`, so this tool no longer reads the production file); reports record its version/date. Each call reserves a conservative text-only input estimate using complete request bytes plus 1,024 tokens before sending. Reported usage settles that reservation; missing/error/timeout usage retains it. A reported overrun stops the run. This reservation bound is not a guarantee about a provider's changed tariff or unreported billing. Cost limits are per invocation; divide the separately authorized **total** cap across phases and do not launch concurrent runs against one approval.

Metrics show true/false positives, true/false negatives, positive/negative abstentions, unsupported reviews, errors, precision, recall and decision coverage with explicit numerators/denominators. Recall includes positive abstentions in its denominator; “review everything” cannot achieve good recall or coverage. Case-level scores are synthetic evaluation data, not financial evidence. Transport mocks test the harness, not Clef quality. No population-accuracy claim follows from this small synthetic corpus.
