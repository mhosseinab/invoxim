#!/usr/bin/env python3
"""Validate blueprint structure and synthetic oracles, not an application build."""
from __future__ import annotations
import argparse
import calendar
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path
import re
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-schema', action='store_true', help='Fail if optional jsonschema is unavailable.')
    parser.add_argument('--output', type=Path, help='Write a machine-readable report.')
    args = parser.parse_args()
    checks: list[str] = []
    warnings: list[str] = []
    def check(condition: bool, message: str) -> None:
        if not condition:
            raise ValueError(message)
    def load(path: str):
        return json.loads((ROOT / path).read_text(encoding='utf-8'))
    try:
        all_files = [p for p in ROOT.rglob('*') if p.is_file() and '__pycache__' not in p.parts]
        for p in all_files:
            if p.suffix == '.json': json.loads(p.read_text(encoding='utf-8'))
            if p.suffix == '.toml': tomllib.loads(p.read_text(encoding='utf-8'))
        checks.append('All JSON and TOML files parse.')
        registry=load('.agents/skill-registry.json')
        skills={s['name']:s for s in registry['skills']}
        roles={r['name']:r for r in registry['roles']}
        check(len(skills)==len(registry['skills']), 'Duplicate skill name')
        check(len(roles)==len(registry['roles']), 'Duplicate role name')
        for name,s in skills.items():
            p=ROOT/s['path']; check(p.is_file(),f'Missing skill {name}')
            check(re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*',name) is not None,'Invalid skill name')
            content=p.read_text(); check(content.startswith('---\n'),'Missing frontmatter')
            front=content.split('---',2)[1]
            check(f'name: {name}\n' in front and 'description:' in front,f'Bad metadata: {name}')
        for name,r in roles.items():
            check((ROOT/r['path']).is_file(),f'Missing role: {name}')
            check(set(r['skills'])<=set(skills),f'Unknown skills: {name}')
            for kind,ext in [('codex','toml'),('claude','md'),('opencode','md')]:
                p=ROOT/f'.{kind}/agents/ledger-{name}.{ext}'
                check(p.is_file(),f'Missing {kind} role {name}')
                content=p.read_text()
                check(r['path'] in content,f'Adapter missing canonical role: {p}')
                if kind=='codex':
                    cfg=tomllib.loads(content)
                    check(all(k in cfg for k in ['name','description','developer_instructions']),'Invalid Codex role')
                    if r['readOnly']: check(cfg.get('sandbox_mode')=='read-only','Reviewer sandbox missing')
                else:
                    check(content.startswith('---\n') and 'description:' in content.split('---',2)[1],'Invalid Markdown adapter')
        checks.append(f"Skill registry and all three native adapter sets resolve ({len(skills)} skills, {len(roles)} roles).")
        backlog=load('.agents/backlog.json'); tasks={t['id']:t for t in backlog['tasks']}
        cases=load('test-design/acceptance-cases.json')['cases']; case_ids={c['id'] for c in cases}
        check(len(tasks)==len(backlog['tasks']),'Duplicate task ID')
        check(len(case_ids)==len(cases),'Duplicate acceptance case ID')
        visited=set(); visiting=set()
        def visit(tid: str) -> None:
            check(tid in tasks,f'Unknown dependency {tid}')
            check(tid not in visiting,f'Task dependency cycle at {tid}')
            if tid in visited:return
            visiting.add(tid)
            for dep in tasks[tid]['dependsOn']: visit(dep)
            visiting.remove(tid); visited.add(tid)
        for tid,t in tasks.items():
            visit(tid)
            check(t['ownerRole'] in roles and t['reviewerRole'] in roles,f'Unknown task role {tid}')
            check(t['ownerRole']!=t['reviewerRole'],f'Same implementer/reviewer role {tid}')
            check(t['status'] in backlog['statusValues'],f'Invalid task state {tid}')
            check(set(t['acceptanceCaseIds'])<=case_ids,f'Unknown acceptance ID {tid}')
            for doc in t['read']: check((ROOT/doc).is_file(),f'Missing task document {doc}')
        for c in cases:
            check(c['task'] in tasks,f'Orphaned acceptance case {c["id"]}')
            check(c['id'] in tasks[c['task']]['acceptanceCaseIds'],f'Case absent from owner task {c["id"]}')
        checks.append(f'Task DAG and acceptance links are valid ({len(tasks)} tasks, {len(cases)} cases).')
        source_ids={s['id'] for s in load('docs/sources.json')['sources']}
        for p in ROOT.rglob('*.md'):
            content=p.read_text()
            for group in re.findall(r'\[(S\d{2}(?:, S\d{2})*)\]',content):
                for sid in group.split(', '):check(sid in source_ids,f'Unknown source {sid} in {p.name}')
        checks.append(f'All bracketed source references resolve ({len(source_ids)} primary sources).')
        fixtures=load('test-design/fixtures/receipts.json')['fixtures']
        for f in fixtures:
            parts={p['id']:p['text'] for p in f['inputParts']}
            for record in f['expectedExtraction']['records']:
                for evidence in record['evidence']:
                    check(evidence['inputPartId'] in parts, f'Unknown evidence part {f["id"]}')
                    check(evidence['quote'] in parts[evidence['inputPartId']],f'Invented fixture quote {f["id"]}')
        checks.append(f'All evidence quotes occur in their synthetic inputs ({len(fixtures)} fixtures).')
        try:
            from jsonschema import Draft202012Validator, FormatChecker
            extraction=load('contracts/extraction.schema.json'); config=load('contracts/config.schema.json')
            Draft202012Validator.check_schema(extraction); Draft202012Validator.check_schema(config)
            validator=Draft202012Validator(extraction,format_checker=FormatChecker())
            for f in fixtures:validator.validate(f['expectedExtraction'])
            Draft202012Validator(config,format_checker=FormatChecker()).validate(load('config/app.example.json'))
            # Negative schemas: unknown properties and float money must fail.
            bad=json.loads(json.dumps(fixtures[0]['expectedExtraction']))
            bad['records'][0]['total']=24.90
            check(not validator.is_valid(bad),'Extraction schema accepts numeric money')
            bad=json.loads(json.dumps(fixtures[0]['expectedExtraction']));bad['toolCall']='send-secrets'
            check(not validator.is_valid(bad),'Extraction schema accepts extra properties')
            checks.append('Both JSON Schemas validate; example config and all labeled outputs conform; negative shape cases rejected.')
        except ImportError:
            if args.require_schema: raise ValueError('Install jsonschema to run --require-schema; no schemas were validated.')
            warnings.append('jsonschema unavailable: full schema validation was NOT executed.')
        # Independently verify exact numerical fixture expectations with Decimal/int/date.
        financial=load('test-design/financial-cases.json')['cases']
        for c in financial:
            inp,expected,op=c['input'],c['expected'],c['operation']
            if op=='parse-money':
                d=Decimal(inp['amount'])*10**inp['minorDigits']
                if d!=d.to_integral_value():actual={'error':'EXCESS_MINOR_DIGITS'}
                else:actual={'minor':str(int(d))}
            elif op=='sum-minor':actual={'minor':str(sum(int(x) for x in inp['values']))}
            elif op in ['convert','convert-each-then-sum']:
                values=inp['values'] if op.endswith('then-sum') else [inp['sourceMinor']]
                factor=Decimal(inp['targetPerSource'])*Decimal(10)**(inp['targetMinorDigits']-inp['sourceMinorDigits'])
                amount=sum(int((Decimal(v)*factor).quantize(Decimal('1'),rounding=ROUND_HALF_UP)) for v in values)
                actual={'targetMinor':str(amount)}
            elif op=='monthly-net':
                actual={}
                for e in inp['entries']:
                    month=e['date'][:7];actual[month]=str(int(actual.get(month,'0'))+int(e['minor'])*(1 if e['kind']=='payment' else -1))
            elif op=='annual-estimate':actual={'annualMinor':str(int(inp['monthlyMinor'])*12)}
            elif op=='price-change':
                delta=int(inp['nextMinor'])-int(inp['previousMinor'])
                percent=(Decimal(delta)*100/Decimal(inp['previousMinor'])).quantize(Decimal('0.01'),rounding=ROUND_HALF_UP)
                actual={'deltaMinor':str(delta),'percentRounded2':str(percent)}
            elif op=='select-historical-rate':
                target=date.fromisoformat(inp['eventDate'])
                eligible=[d for d in inp['availableDates'] if 0<=(target-date.fromisoformat(d)).days<=inp['maxPriorAgeDays']]
                actual={'rateDate':max(eligible)} if eligible else {'error':'FX_RATE_MISSING'}
            elif op=='monthly-anchor':
                dates=[]
                for month in inp['months']:
                    year,mon=map(int,month.split('-')); day=min(inp['anchorDay'],calendar.monthrange(year,mon)[1])
                    dates.append(date(year,mon,day).isoformat())
                actual={'dates':dates}
            elif op=='financial-inclusion':
                paid=inp.get('paymentEvidence')=='explicitly-paid'
                refunded=inp.get('refundEvidence')=='completed' and inp.get('paymentMethodHint')!='store-credit'
                actual={'ledgerEntries':1 if paid or refunded else 0}
            else:raise ValueError(f'Unknown oracle operation {op}')
            for key,value in actual.items():check(expected[key]==value,f'Financial oracle mismatch {c["id"]}: {actual}')
            if 'display' in expected:check(f'{Decimal(actual["minor"])/100:.2f}'==expected['display'],'Bad display oracle')
        checks.append(f'All {len(financial)} synthetic numerical/state oracles verified independently; this is not application testing.')
        from validate_presentation import validate_presentation
        presentation = validate_presentation(ROOT, require_schema=args.require_schema)
        checks.append(f"Presentation fixture/copy/schema references and exact demo arithmetic checked ({presentation['onboardingFixtures']} views, {presentation['copyKeys']} copy keys).")
        checks.append(f"Concrete packaged path references resolve ({presentation['concretePathsChecked']} unique paths).")
        report={'status':'passed','scope':'blueprint structure and synthetic fixtures only','checks':checks,'warnings':warnings,
                'counts':{'skills':len(skills),'roles':len(roles),'tasks':len(tasks),'acceptanceCases':len(cases),'extractionFixtures':len(fixtures),'financialCases':len(financial),'sources':len(source_ids),'rules':len(list((ROOT/'.agents/rules').glob('*.md'))), **presentation},
                'notExecuted':['Application unit/integration/E2E tests','Native agent discovery/spawning/permission enforcement','OAuth or mailbox API smoke tests','Cloudflare deployment/runtime benchmark','Live AI extraction/evaluation','External security assessment or public-release approval']}
        if args.output:
            args.output.parent.mkdir(parents=True,exist_ok=True)
            args.output.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report,indent=2));return 0
    except (OSError,ValueError,KeyError,TypeError,json.JSONDecodeError) as exc:
        print(f'VALIDATION FAILED: {exc}',file=sys.stderr);return 1

if __name__=='__main__':raise SystemExit(main())
