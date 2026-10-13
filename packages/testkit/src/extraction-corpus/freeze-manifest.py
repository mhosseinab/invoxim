"""Freeze reviewed authored fixtures BEFORE evaluating held-out cases."""
import hashlib
import json
from pathlib import Path
root=Path(__file__).parent
canonical=lambda value:json.dumps(value,ensure_ascii=False,separators=(",", ":")).encode()
sha=lambda data:hashlib.sha256(data).hexdigest()
manifest={"datasetVersion":"t22-synthetic-v1","canonicalization":"UTF-8 JSON.stringify order, compact JSON, unescaped Unicode","holdoutPolicy":"40 fixed near-template representations; not used to tune production prompts/templates; not model-quality evaluation","partitions":{},"caseHashes":{},"assetHashes":{}}
seen=set()
for partition in ["development","holdout"]:
 dataset=json.loads((root/f"{partition}.json").read_text())
 manifest["partitions"][partition]={"count":len(dataset["cases"]),"sha256":sha(canonical(dataset))}
 for case in dataset["cases"]:
  assert case["id"] not in seen
  seen.add(case["id"])
  manifest["caseHashes"][case["id"]]=sha(canonical(case))
for asset in sorted((root/"assets").iterdir()):
 if asset.is_file():manifest["assetHashes"][asset.name]=sha(asset.read_bytes())
assert manifest["partitions"]["development"]["count"]==80
assert manifest["partitions"]["holdout"]["count"]==40
target=root/"manifest.json"
if target.exists() and json.loads(target.read_text()) != manifest:
 raise RuntimeError("Frozen dataset changed: create a separately reviewed version instead of replacing holdout identities")
target.write_text(json.dumps(manifest,indent=2)+"\n")
print(json.dumps(manifest["partitions"],sort_keys=True))
