#!/bin/bash
# Kjøres hvert 30. minutt av launchd.
# Starter alle fire tester hvis de ikke allerede er kjørt i dag.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DATO=$(date +%Y-%m-%d)
LOG_FIL="$REPO_DIR/rapporter/kjoring.log"

mkdir -p "$REPO_DIR/rapporter"

# Bare hverdager (1=Man ... 5=Fre)
UKEDAG=$(date +%u)
if [ "$UKEDAG" -gt 5 ]; then
  exit 0
fi

# Allerede kjørt i dag? Sjekk alle fire resultatfiler.
if [ -f "$REPO_DIR/rapporter/$DATO/resultat.json" ] && \
   [ -f "$REPO_DIR/rapporter/$DATO/monkey-resultat.json" ] && \
   [ -f "$REPO_DIR/rapporter/$DATO/sikkerhet-resultat.json" ] && \
   [ -f "$REPO_DIR/rapporter/$DATO/negativ-resultat.json" ]; then
  exit 0
fi

# Er nettstedet tilgjengelig?
STATUS=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "https://tilskudd.fiks.ks.no/" || echo "000")
if [[ ! "$STATUS" =~ ^[23] ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⏳ Nettstedet ikke tilgjengelig (HTTP $STATUS) – prøver igjen om 30 min" >> "$LOG_FIL"
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🚀 Starter tester (ikke kjørt i dag)" >> "$LOG_FIL"
exec "$REPO_DIR/run-rapport-lokalt.sh"
