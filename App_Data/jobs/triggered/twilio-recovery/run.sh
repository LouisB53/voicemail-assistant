#!/bin/bash
echo "=================================================="
echo "Démarrage du WebJob - Rattrapage via Twilio API"
echo "Date: $(date)"
echo "=================================================="

cd /home/site/wwwroot

echo "✅ Node.js version: $(node --version)"

if [ ! -f "jobs/twilio-recovery.js" ]; then
    echo "❌ Script jobs/twilio-recovery.js introuvable"
    exit 1
fi

node jobs/twilio-recovery.js

EXIT_CODE=$?

echo ""
echo "=================================================="
if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ WebJob terminé avec succès"
else
    echo "❌ WebJob terminé avec des erreurs (code: $EXIT_CODE)"
fi
echo "=================================================="

exit $EXIT_CODE
