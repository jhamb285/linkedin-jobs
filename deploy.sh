#!/usr/bin/env bash
# Deploy the linkedin-jobs CLI to mediaos.
#
#   ./deploy.sh
#
# Steps: ssh mediaos -> git pull on /opt/automations/inbound/linkedin-jobs ->
# bun install. CLI runs from cron, no service to restart.

set -e

ssh mediaos '
  set -e
  cd /opt/automations/inbound/linkedin-jobs
  echo "=== git pull ==="
  git pull
  echo "=== bun install ==="
  /usr/local/bin/bun install --silent
  echo "=== cron status ==="
  crontab -l | grep -E "linkedin-jobs|DISABLED" | head -3
  echo "=== done ==="
'
