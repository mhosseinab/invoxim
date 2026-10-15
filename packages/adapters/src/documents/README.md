# Transient document parsing and original reads (T10)

## Gmail normalization

`normalizeGmailDocumentInput` normalizes a **supplied** Gmail full payload and attachment map into the provider-neutral `DocumentInput`. It does not fetch mail or attachments; its caller is `pipeline/gmail-content.ts`, which reads content for an authorized processing job with a trusted tenant context. Discovery stays metadata-only. Connection/message/part identifiers are exact provenance, including Gmail's empty root part ID, and are never user authorization or outbound destinations.

The core `createDocumentTextExtractor({ pdf?, limits? })` validates the whole recursive MIME tree before extraction. Defaults and hard maxima (`DOCUMENT_LIMITS`) are 4 MiB aggregate decoded bytes, 64 nodes, depth 8, 20 aggregate PDF pages, and 24,000 aggregate text characters. Gmail headers are separately bounded to 8,192 characters. Declared attachment lengths, canonical padded/unpadded base64url and pad bits are validated. Duplicate part identifiers and missing attachment content fail closed. Raw RFC MIME parsing and content-transfer decoding are outside this adapter: Gmail supplies decoded part bytes through its base64url response representation.

Multipart alternatives select one body, preferring nonempty plain text. Mixed MIME retains each genuine attachment with exact part identity and SHA-256 of original decoded bytes. Inline images with inline/content-ID evidence are ignored; image attachments receive explicit review without invented OCR. No cross-part invoice merging or financial acceptance happens here.

HTML becomes inert plain text. The tokenizer never constructs a DOM, follows links, executes scripts, or fetches CSS/images. It strips scripts/styles, nested hidden/active containers and forms, checks exact closing-tag boundaries, and preserves visible numeric labels and values. Known PDF/image/archive/executable signatures labelled as text fail MIME consistency checks before decoding. Malformed/truncated output and aggregate overflow return incomplete/review without partial receipt text.

## Local PDF text

`createLocalPdfTextExtractor()` (used by the Worker pipeline runtime) uses pinned **unpdf 1.8.1** and its bundled serverless PDF.js build. Its verified support is a narrow **uncompressed text-layer PDF subset**, not general PDF or OCR. A bounded conservative lexical guard (`pdf-preflight.ts`) rejects compressed/filter/object-stream/encrypted/action/embedded-font features and excessive nesting/token volume before PDF.js. It can reject harmless PDFs that mention these feature names; those require review rather than a guessed conversion. The library handles actual parsing; there is no custom PDF parser, decompressor, Node daemon, native canvas, rendering path, or hosted fallback.

The adapter uses original bytes only, disables external worker fetch/auto-fetch/Wasm/image decoding/font face/XFA, sets silent parser logging, checks page count, and streams text sequentially with an output bound. Every page must contain text; a scanned/mixed textless page is review. Reader cancellation and document destruction run after success/failure. Worker tests (`apps/worker/test/documents.test.ts`, `pdf-processing.test.ts`) cover a generated two-page PDF with exact subtotal/tax/total/card-paid evidence, a generated image-only PDF that stays in review, and a compressed 1 MiB text stream that is rejected.

## Original mail reader (`original-mail.ts`)

`createOriginalMailReader({ provider, accessToken, policy }, { fetcher?, archiveByteLimit? })` reads one original message as `message/rfc822` bytes for the Drive archive workflow (`drive/workflow.ts`). That workflow is not wired into the Worker, so this reader has no production caller yet. Endpoints are fixed: Gmail `messages/{id}?format=raw`, and for Outlook a Graph `$select=id` check followed by `/$value` with immutable IDs. The provider message ID is pattern-checked and must match the response ID.

Each read has a 100–10000 ms deadline raced against the caller's abort signal, uses `redirect: "manual"`, accepts only 200 with an allowed content type, rejects a declared or streamed size over the limit, and stops after 4096 chunks or 32 empty chunks. The byte limit is the transient 4 MiB cap, or an archive limit up to 16 MiB. 404 returns `source_unavailable`; 401/403 throws `AUTH_REQUIRED`; 429/503 throws `RATE_LIMITED` with the shared `parseRetryAfter` delay or a 30 s default; any other status throws `UNAVAILABLE`. Invalid encoding, size, type or ID mismatch return a typed `unsupported` result. Responses are cancelled on exit.

## Data handling

All bytes, normalized text and evidence quotes are transient. The modules expose no database, queue, log, or original-storage port. Only identities, hashes and bounded parser status/version metadata are suitable for later persistence. No hosted processor, image/OCR capability, resource, provider request or model charge is enabled by these modules. External parsing requires a separate environment-selected approved adapter, explicit policy/consent and budget integration; absence never silently selects another destination.

This layer preserves numeric evidence; extraction and ledger planning choose and validate actual paid/refund amounts. The synthetic tests are parser/runtime evidence, not extraction-model accuracy or production memory/CPU/Free-plan viability measurements.
