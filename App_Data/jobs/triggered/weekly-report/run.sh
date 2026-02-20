#!/bin/bash
# Script d'exécution du WebJob de rapports hebdomadaires
# Exécuté tous les vendredis à 17h (Europe/Paris)

echo "=================================================="
echo "Démarrage du WebJob - Rapports Hebdomadaires"
echo "Date: $(date)"
echo "=================================================="

# Se placer dans le répertoire du projet
cd /home/site/wwwroot

# Vérifier que Node.js est disponible
if ! command -v node &> /dev/null; then
    echo "❌ Node.js n'est pas installé"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"

# Vérifier que le script existe
if [ ! -f "jobs/weekly-report.js" ]; then
    echo "❌ Script jobs/weekly-report.js introuvable"
    exit 1
fi

# Installer Chrome pour Puppeteer si absent (persiste dans /home)
CHROME_CACHE="/home/site/wwwroot/.cache/puppeteer"
if [ ! -d "$CHROME_CACHE" ]; then
    echo "🔽 Chrome non trouvé, installation en cours..."
    export PATH="/node_modules/.bin:$PATH"
    node /node_modules/puppeteer/install.mjs 2>/dev/null || npx puppeteer browsers install chrome
    echo "✅ Chrome installé (ou tentative effectuée)"
else
    echo "✅ Chrome déjà présent dans $CHROME_CACHE"
fi

# Exécuter le script de génération de rapports
echo ""
echo "Exécution du script de génération de rapports..."
node jobs/weekly-report.js

# Capturer le code de sortie
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
