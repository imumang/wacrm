#!/usr/bin/env bash
# Real-PostgreSQL race test for resumeAwaitingReply's claim UPDATE.
# Targets ONLY a disposable container created by this script.
# Usage: scripts/race-test-awaiting-reply-claim.sh   (needs docker + local image postgres:16)
set -euo pipefail
export MSYS_NO_PATHCONV=1
NAME="wacrm-race-test-$RANDOM$RANDOM"
PORT="${RACE_PORT:-55432}"
PW="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
CLIENTS="${CLIENTS:-32}"
cleanup() { case "$NAME" in wacrm-race-test-*) docker rm -f "$NAME" >/dev/null 2>&1 || true;; esac; }
trap cleanup EXIT
if docker ps -a --format '{{.Ports}}' | grep -q ":$PORT->"; then echo "port $PORT in use"; exit 2; fi
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5432" -e POSTGRES_PASSWORD="$PW" postgres:16 >/dev/null
echo "container=$NAME port=$PORT (no volume)"
for i in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
sleep 2
P() { docker exec -i -e PGPASSWORD="$PW" "$NAME" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
# Minimal DDL: columns the claim touches, plus the 057 CHECK and index.
P <<'SQL'
CREATE TABLE automation_pending_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  contact_id UUID,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','failed','awaiting_reply','expired','superseded')),
  run_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_automation_pending_awaiting_reply
  ON automation_pending_executions(account_id, contact_id) WHERE status = 'awaiting_reply';
CREATE TABLE claim_results (client int, won int);
SQL
ACCT=11111111-1111-1111-1111-111111111111
OTHER=22222222-2222-2222-2222-222222222222
ID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
P -c "INSERT INTO automation_pending_executions(id,account_id,contact_id,status,run_at) VALUES ('$ID','$ACCT',gen_random_uuid(),'awaiting_reply',now()+interval '24 hours')"
# Same shape PostgREST emits for engine.ts:
#   .update({status:'running'}).eq('id',..).eq('account_id',..).eq('status','awaiting_reply').select('id')
docker exec -i "$NAME" sh -c 'cat > /tmp/claim.sql' <<SQL
\set cid random(1,1000000)
WITH c AS (
  UPDATE automation_pending_executions SET status='running'
  WHERE id='$ID' AND account_id='$ACCT' AND status='awaiting_reply'
  RETURNING id
) INSERT INTO claim_results SELECT :cid, count(*) FROM c;
SQL
docker exec -e PGPASSWORD="$PW" "$NAME" pgbench -h 127.0.0.1 -U postgres -n -f /tmp/claim.sql -c "$CLIENTS" -j "$CLIENTS" -t 1 postgres | grep -E "number of clients|transactions actually"
echo "--- round 1: $CLIENTS concurrent claims, same account"
P -c "SELECT 'claims_issued='||count(*)||' winners='||coalesce(sum(won),0) FROM claim_results"
P -c "SELECT 'final_status='||status FROM automation_pending_executions WHERE id='$ID'"
# Tenant scoping: wrong-account claim on a fresh parked row must win 0.
P -c "TRUNCATE claim_results; UPDATE automation_pending_executions SET status='awaiting_reply' WHERE id='$ID'"
docker exec "$NAME" sh -c "sed 's/$ACCT/$OTHER/' /tmp/claim.sql > /tmp/claim_wrong.sql"
docker exec -e PGPASSWORD="$PW" "$NAME" pgbench -h 127.0.0.1 -U postgres -n -f /tmp/claim_wrong.sql -c 8 -j 8 -t 1 postgres >/dev/null
echo "--- round 2: 8 concurrent claims from the WRONG account"
P -c "SELECT 'winners='||coalesce(sum(won),0) FROM claim_results"
P -c "SELECT 'final_status='||status FROM automation_pending_executions WHERE id='$ID'"
# Repeat round 1 several times for confidence.
for r in 1 2 3 4 5; do
  P -c "TRUNCATE claim_results; UPDATE automation_pending_executions SET status='awaiting_reply' WHERE id='$ID'"
  docker exec -e PGPASSWORD="$PW" "$NAME" pgbench -h 127.0.0.1 -U postgres -n -f /tmp/claim.sql -c "$CLIENTS" -j "$CLIENTS" -t 1 postgres >/dev/null
  P -c "SELECT 'repeat $r: winners='||sum(won) FROM claim_results"
done
echo "removing $NAME"
