#!/bin/bash
# Kjøres daglig av launchd – tester tilskudd.fiks.test.ks.no og pusher resultater til GitHub

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FIL="$REPO_DIR/rapporter/kjoring.log"
DATO=$(date +%Y-%m-%d)

mkdir -p "$REPO_DIR/rapporter"

echo "=======================================" >> "$LOG_FIL"
echo "[$DATO $(date +%H:%M:%S)] Starter daglig UU-test" >> "$LOG_FIL"

cd "$REPO_DIR"

# Sjekk at nettstedet er tilgjengelig
if ! curl -s --max-time 10 -o /dev/null -w "%{http_code}" "https://tilskudd.fiks.ks.no/" | grep -q "^[23]"; then
  echo "[$DATO $(date +%H:%M:%S)] ❌ Nettstedet ikke tilgjengelig – avbryter" >> "$LOG_FIL"
  exit 1
fi

# Bruk nvm/node fra vanlig sti
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | sort -V | tail -1)/bin:$PATH"

echo "[$DATO $(date +%H:%M:%S)] Node: $(node --version 2>&1)" >> "$LOG_FIL"

# Kjør UU-analyse
echo "[$DATO $(date +%H:%M:%S)] Kjører npm run rapport..." >> "$LOG_FIL"
npm run rapport >> "$LOG_FIL" 2>&1

# Kjør monkey-testing
echo "[$DATO $(date +%H:%M:%S)] Kjører npm run monkey..." >> "$LOG_FIL"
npm run monkey >> "$LOG_FIL" 2>&1

# Kjør sikkerhetstest
echo "[$DATO $(date +%H:%M:%S)] Kjører npm run sikkerhet..." >> "$LOG_FIL"
npm run sikkerhet >> "$LOG_FIL" 2>&1

# Kjør negativ testing
echo "[$DATO $(date +%H:%M:%S)] Kjører npm run negativ..." >> "$LOG_FIL"
npm run negativ >> "$LOG_FIL" 2>&1

# Kjør tastaturnavigasjonstest
echo "[$DATO $(date +%H:%M:%S)] Kjører npm run tastatur..." >> "$LOG_FIL"
npm run tastatur >> "$LOG_FIL" 2>&1

# Generer arkiv
echo "[$DATO $(date +%H:%M:%S)] Kjører npm run arkiv..." >> "$LOG_FIL"
npm run arkiv >> "$LOG_FIL" 2>&1

# Git commit og push
git config user.name "UU-tester bot"
git config user.email "bot@github.com"
git add rapporter/ docs/
git diff --staged --quiet || git commit -m "Daglig UU-rapport $DATO [skip ci]"
git push

echo "[$DATO $(date +%H:%M:%S)] ✅ Ferdig og pushet til GitHub" >> "$LOG_FIL"
