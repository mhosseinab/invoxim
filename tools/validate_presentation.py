#!/usr/bin/env python3
"""Check presentation fixtures and concrete blueprint links, not application behavior."""
from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any


def validate_presentation(root: Path, require_schema: bool = False) -> dict[str, Any]:
    """Validate static expected states, source links and exact demo arithmetic."""
    def load(path: str) -> Any:
        return json.loads((root / path).read_text(encoding='utf-8'))

    def check(condition: bool, message: str) -> None:
        if not condition:
            raise ValueError(message)

    messages = load('contracts/ux-copy.en.json')['messages']
    guards = load('contracts/ux-copy.en.json')['guards']
    check(bool(messages), 'Missing presentation copy')
    check(set(guards) <= set(messages), 'Copy guard references unknown key')
    for key, text in messages.items():
        check(isinstance(text, str) and bool(text.strip()), f'Invalid copy string {key}')
        check(text.count('{') == text.count('}'), f'Unbalanced copy template {key}')

    schema = load('contracts/onboarding-view.schema.json')
    views = load('test-design/fixtures/onboarding-views.json')['fixtures']
    ids = [f['id'] for f in views]
    check(len(ids) == len(set(ids)), 'Duplicate onboarding fixture ID')
    for fixture in views:
        check(fixture['view']['headlineKey'] in messages,
              f'Unknown onboarding copy key in {fixture["id"]}')
    covered = {f['view']['state'] for f in views}
    check(covered == set(schema['properties']['state']['enum']),
          'Onboarding fixture states do not cover the declared projection states')
    schema_validated = False
    try:
        from jsonschema import Draft202012Validator, FormatChecker, ValidationError
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema, format_checker=FormatChecker())
        for fixture in views:
            try:
                validator.validate(fixture['view'])
            except ValidationError as exc:
                raise ValueError(f'Invalid onboarding fixture {fixture["id"]}: {exc.message}') from exc
        schema_validated = True
    except ImportError:
        if require_schema:
            raise ValueError('jsonschema unavailable; onboarding schema was not validated.')

    demo = load('test-design/fixtures/presentation-demo.json')
    check(demo['exampleData'] is True, 'Demo must be labeled synthetic/exampleData=true')
    purchases = {p['id']: p for p in demo['purchases']}
    evidence = {e['id']: e for e in demo['evidence']}
    entries = demo['ledgerEntries']
    check(len(purchases) == len(demo['purchases']), 'Duplicate demo purchase ID')
    check(len(evidence) == len(demo['evidence']), 'Duplicate demo evidence ID')
    check(len({e['id'] for e in entries}) == len(entries), 'Duplicate demo ledger event ID')
    for item in evidence.values():
        check('SYNTHETIC EXAMPLE' in item['text'], 'Unlabeled synthetic evidence')
        check(not re.search(r'https?://|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', item['text']),
              'Demo evidence unexpectedly contains an external URL/address')
    for p in purchases.values():
        check(set(p['evidenceIds']) <= set(evidence), f'Missing demo evidence for {p["id"]}')
    paid_total = refunded_total = 0
    payment_count = refund_count = 0
    for entry in entries:
        check(entry['purchaseId'] in purchases, 'Demo event references missing purchase')
        check(entry['evidenceId'] in evidence, 'Demo event references missing evidence')
        check(entry['evidenceId'] in purchases[entry['purchaseId']]['evidenceIds'],
              'Demo event evidence not linked to its purchase')
        check(entry['kind'] in ('payment', 'refund'), 'Unknown demo financial event kind')
        check(isinstance(entry['amountMinor'], str) and re.fullmatch(r'0|[1-9][0-9]*', entry['amountMinor']) is not None,
              'Demo money must be a nonnegative canonical minor-unit string')
        check(evidence[entry['evidenceId']]['kind'] == entry['kind'],
              'Demo invoice/order incorrectly used as a payment/refund')
        check(demo['range']['start'] <= entry['date'] < demo['range']['endExclusive'],
              'Demo summary event lies outside its declared reporting period')
        if entry['kind'] == 'payment':
            paid_total += int(entry['amountMinor']); payment_count += 1
        else:
            refunded_total += int(entry['amountMinor']); refund_count += 1
    unpaid_total = 0
    for pid, purchase in purchases.items():
        own = [e for e in entries if e['purchaseId'] == pid]
        paid = sum(int(e['amountMinor']) for e in own if e['kind'] == 'payment')
        refunded = sum(int(e['amountMinor']) for e in own if e['kind'] == 'refund')
        for field, amount in [('expectedPaidMinor', paid), ('expectedRefundedMinor', refunded), ('expectedNetMinor', paid-refunded)]:
            check(purchase[field] == str(amount), f'Demo {field} mismatch for {pid}')
        if not own and any(evidence[e]['kind'] == 'unpaid_invoice' for e in purchase['evidenceIds']):
            unpaid_total += int(purchase['documentTotalMinor'])
    expected = {'purchaseCount': len(purchases), 'paymentCount': payment_count, 'refundCount': refund_count,
                'paidMinor': str(paid_total), 'refundedMinor': str(refunded_total),
                'netMinor': str(paid_total-refunded_total), 'unpaidDocumentTotalMinor': str(unpaid_total)}
    check(demo['expectedSummary'] == expected, 'Demo summary arithmetic mismatch')
    check('demo-purchase-a' in purchases and 'demo-purchase-b' in purchases,
          'Same-price distinct-purchase demo is missing')
    check(purchases['demo-purchase-a']['evidenceIds'] != purchases['demo-purchase-b']['evidenceIds'],
          'Same-price demo purchases lost distinct evidence')

    # Only concrete packaged documentation/tool paths, never promised future app code.
    prefixes = ('docs/', 'contracts/', 'config/', 'test-design/', '.agents/', 'tools/')
    checked_paths = set()
    for path in root.rglob('*.md'):
        for code in re.findall(r'`([^`\n]+)`', path.read_text(encoding='utf-8')):
            if not code.startswith(prefixes) or re.search(r'[<>*{}\s]', code):
                continue
            candidate = code.split('#', 1)[0]
            if Path(candidate).suffix not in {'.md', '.json', '.py'}:
                continue
            check((root / candidate).is_file(), f'Missing concrete package reference: {candidate}')
            checked_paths.add(candidate)
    return {'copyKeys': len(messages), 'onboardingFixtures': len(views), 'demoPurchases': len(purchases),
            'demoEvidence': len(evidence), 'concretePathsChecked': len(checked_paths),
            'onboardingSchemaValidated': schema_validated,
            'scope': 'Static fixture/schema/copy-reference checks and exact arithmetic only; no application tests.'}
