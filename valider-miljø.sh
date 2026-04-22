#!/bin/bash
# Validerer at PROD-repoet (tilskudd.fiks.ks.no) ikke er kontaminert
# av TEST-miljøreferanser. Kjøres som pre-commit hook og i GitHub Actions.

FEIL=0
GRONN=$'\033[0;32m'
ROD=$'\033[0;31m'
GRA=$'\033[0;90m'
RESET=$'\033[0m'

echo "🔍 Validerer miljøseparasjon (PROD – tilskudd.fiks.ks.no)..."

TESTFILER="uu-tester.js monkey-tester.js sikkerhet-tester.js negativ-tester.js generer-arkiv.js"

for FIL in $TESTFILER; do
  [ -f "$FIL" ] || continue

  # Korrekt URL: tilskudd.fiks.ks.no  –  Feil: fiks.test.ks.no
  if grep -q "fiks\.test\.ks\.no" "$FIL"; then
    echo "${ROD}❌ $FIL inneholder TEST-URL (fiks.test.ks.no)${RESET}"
    FEIL=1
  fi

  # Korrekt badge: PRODUKSJON  –  Feil: TEST-MILJØ
  if grep -q "TEST-MILJØ" "$FIL"; then
    echo "${ROD}❌ $FIL inneholder TEST-badge (TEST-MILJØ)${RESET}"
    FEIL=1
  fi

  # Korrekt sidemeny-farge: #07604f  –  Feil: #0a1355
  if grep -q "\.sidemeny{.*background:#0a1355" "$FIL"; then
    echo "${ROD}❌ $FIL har TEST-sidefarge i .sidemeny (#0a1355 – skal være #07604f)${RESET}"
    FEIL=1
  fi
done

# Sjekk docs/ (publiserte HTML-filer)
if ls docs/*.html &>/dev/null; then
  KONTAMINERT=$(grep -rl "fiks\.test\.ks\.no\|TEST-MILJØ" docs/*.html 2>/dev/null || true)
  if [ -n "$KONTAMINERT" ]; then
    echo "${ROD}❌ docs/ inneholder TEST-referanser:${RESET}"
    echo "$KONTAMINERT" | while read -r linje; do echo "   ${GRA}$linje${RESET}"; done
    FEIL=1
  fi
fi

if [ $FEIL -eq 0 ]; then
  echo "${GRONN}✅ Miljøvalidering OK – ingen TEST-kontaminering i PROD-repo${RESET}"
  exit 0
else
  echo ""
  echo "${ROD}🚨 Commit avbrutt – PROD-repo er kontaminert av TEST-miljøreferanser!${RESET}"
  echo "   Rett opp feilene over og prøv igjen."
  exit 1
fi
