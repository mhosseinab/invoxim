#!/usr/bin/env bash
# Idempotent setup of the standard issue labels for gh-issue-reporting.
# Usage: bash .agents/skills/gh-issue-reporting/scripts/setup-labels.sh
set -euo pipefail

create_label() {
  local name="$1" color="$2" desc="$3"
  if gh label list --limit 200 --json name --jq '.[].name' | grep -Fxq "$name"; then
    echo "exists: $name"
  else
    gh label create "$name" --color "$color" --description "$desc"
    echo "created: $name"
  fi
}

create_label "priority:high" "B60205" "Must fix before task close"
create_label "priority:medium" "D93F0B" "Real defect or contract gap"
create_label "priority:low" "FBCA04" "Hardening or polish"

create_label "category:security" "0E8A16" "Security / injection / authz"
create_label "category:money" "1D76DB" "Financial correctness"
create_label "category:data-integrity" "5319E7" "Schema / durability / identity"
create_label "category:api-contract" "0052CC" "Contract or schema drift"
create_label "category:correctness" "0052CC" "Behavioral bug"
create_label "category:race" "0052CC" "Concurrency / CAS / double-apply"
create_label "category:test-gap" "FBEC7D" "Missing or misleading tests"
create_label "category:ops" "C2E0C6" "CI, cleanup, operational"
create_label "category:privacy" "7A0099" "Deletion / retention / secrets"
create_label "category:privacy-secrets" "7A0099" "Secret exposure / redaction"
create_label "category:ux-truthfulness" "E99695" "Copy vs capability honesty"
create_label "category:a11y" "F9D0C4" "Accessibility"
create_label "category:resource-limits" "E4E669" "Quotas, bounds, resource use"

echo "done"
