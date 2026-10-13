# T22 synthetic offline corpus catalog

Contract: 120 cases, 80 development and 40 separately held-out. Exactly one held-out case per family has an immutable case ID and is never used to change production prompt/template code. This is an offline application-conformance corpus with explicit preset candidates, not model output or model accuracy. Expected financial units are literal independent labels; application money/validator code never generates the oracle.

The three variants of a semantic family change representation and evidence placement: plain source, inert HTML, and structured multipart MIME, with independent unsupported binary variants for parser families. Language, source labels, punctuation, source-line context and untrusted payload placement are catalogued per case. Merely changing merchant names or numeric amounts does not constitute a family. Original synthetic input bytes are retained only as test fixtures.

Families:

1. Explicit full-total receipt
2. German paid receipt
3. Decimal-comma receipt
4. Zero-decimal JPY precision
5. Three-decimal KWD precision
6. Separate subtotal/tax/gross total
7. Explicit unpaid invoice
8. Invoice without payment evidence
9. Order confirmation without payment
10. First installment, gross versus cash
11. Card plus redeemed store credit
12. Store-credit-only tender
13. Pending refund, no completed cash
14. Completed refund with previous payment
15. Completed unmatched refund, financial review
16. Credit note without completed refund
17. Cancellation without cash event
18. Explicit unrelated non-purchase
19. Statement without fabricated purchase
20. Recurring evidence suggestion, no forecast cash
21. Exact payment-reference replay
22. Exact document/content replay
23. Duplicate-message business reference
24. Subtotal quoted as gross total
25. Tax quoted as cash payment
26. Tax quoted as completed refund amount
27. Conflicting USD/EUR monetary evidence
28. Unsupported CAD/SEK precision
29. Missing critical fields, bounded review metadata
30. Ambiguous calendar evidence
31. Invoice date substituted for later payment date
32. Source-line payment negation
33. Source-line refund negation
34. Signed/accounting monetary forms
35. Extra confidence/destination/category fields
36. Instructions embedded in purchase content
37. Malformed/fenced/truncated output
38. Inert HTML and multipart resource isolation
39. Image/scanned/textless document requires verified parser
40. Compressed/encrypted/active PDF unsupported

Each case records parser expectations, candidate expectations, exact financial events and replay expectations independently. Unsupported parser cases do not reach extraction. Refusal/truncated-response cases do not pretend to be valid candidates. Metrics must show denominators separately for supported clean cases and challenges; no blanket 120/120 result may be called a live extraction benchmark. Live evaluation, privacy terms/capability probes, actual selected model, approved cost cap and acceptance thresholds remain pending operator tasks.
