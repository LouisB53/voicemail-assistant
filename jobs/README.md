# WebJob - Rapports Hebdomadaires Automatiques

## 🎯 Objectif

Ce WebJob génère et envoie automatiquement des **rapports PDF** hebdomadaires à vos clients tous les **vendredis à 17h**.

## 📦 Fichiers

- `weekly-report.js` : Script principal de génération et envoi des rapports
- `settings.job` : Configuration du planning (CRON)
- `run.sh` : Script de lancement pour Azure
- `KPIS.md` : Liste complète des 13 KPIs calculés

## 📊 Rapports générés

- **Format** : PDF (généré via Puppeteer)
- **Période** : 7 derniers jours (modifiable)
- **Contenu** : 13 KPIs + graphiques + top motifs
- **Envoi** : Email avec PDF en pièce jointe

## 🚀 Déploiement

### Prérequis

✅ **Dépendances Node.js** : Installer Puppeteer
```bash
npm install puppeteer
```

✅ Variables d'environnement déjà configurées sur Azure App Service :
- `SENDGRID_API_KEY`
- `FROM_EMAIL`
- `FROM_NAME`
- `GARAGE_TEST_EMAIL` (ou autres selon vos garages)
- `DB_PATH` → **À vérifier/configurer** (voir ci-dessous)

⚠️ **Important** : Puppeteer nécessite des dépendances système sur Azure.
Voir la section "Configuration Azure" ci-dessous.

### Vérifier le chemin de la base de données

1. Connectez-vous à votre Azure App Service via SSH ou Kudu
2. Trouvez votre fichier `voicemail.db` :
   ```bash
   find /home -name "voicemail.db" 2>/dev/null
   ```
3. Ajoutez la variable d'environnement `DB_PATH` avec le chemin trouvé

**Chemins typiques** :
- `/home/site/wwwroot/voicemail.db`
- `/home/data/voicemail.db`

### Configuration Azure (pour Puppeteer)

Puppeteer nécessite Chrome/Chromium. Sur Azure App Service :

**Option 1** : Utiliser l'image Docker avec Chrome préinstallé
```bash
# Dans le portail Azure → Configuration → General settings
# Platform : Linux
# Stack : Node 22
```

**Option 2** : Installer les dépendances système
Créer un fichier `.deployment` à la racine :
```
[config]
SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

Et un fichier `deploy.sh` pour installer les dépendances Chrome.

**Option 3** : Utiliser une alternative légère (recommandé)
Remplacer Puppeteer par `chrome-aws-lambda` dans le code (voir documentation).

### Déployer via Git

```bash
# 1. Installer Puppeteer
npm install

# 2. Ajouter les fichiers du WebJob
git add jobs/ package.json package-lock.json

# 3. Commit
git commit -m "Ajout du WebJob de rapports hebdomadaires PDF"

# 4. Push vers Azure
git push azure main
```

Azure détectera automatiquement le dossier `jobs/` et créera le WebJob.

### Vérifier le déploiement

1. **Portail Azure** → votre App Service → **WebJobs**
2. Vous devriez voir : `weekly-report` (Type: Triggered)
3. Cliquez sur **Run** pour tester
4. Cliquez sur **Logs** pour voir le résultat

## ⏰ Planning

- **Tous les vendredis à 17h** (timezone de l'App Service)
- Expression CRON : `0 0 17 * * 5`

### Configurer le fuseau horaire (si nécessaire)

Si le WebJob s'exécute en UTC au lieu de l'heure de Paris, ajoutez cette variable d'environnement :

```
WEBSITE_TIME_ZONE = Romance Standard Time
```

## 🧪 Test manuel

### Via le portail Azure
WebJobs → weekly-report → **Run**

### Via Kudu console
```bash
cd /home/site/wwwroot
node jobs/weekly-report.js
```

## 📊 Configuration des emails clients

### Option 1 : Variables d'environnement (recommandé)

Ajoutez une variable pour chaque garage :
```
GARAGE_TEST_EMAIL = client@garage-test.com
GARAGE_MARTIN_EMAIL = martin@garage-martin.com
```

### Option 2 : Modifier le code

Éditez `weekly-report.js`, ligne 18-22 :
```javascript
const GARAGE_EMAILS = {
  'Garage Test': 'client@example.com',
  'Garage Martin': 'martin@example.com',
  // ...
};
```

⚠️ **Si vous modifiez le code**, les emails seront dans Git. Préférez les variables d'environnement.

## 🐛 Dépannage

### Erreur "Base de données introuvable"
→ Vérifiez la variable `DB_PATH`

### Erreur "Pas d'email configuré"
→ Ajoutez les variables `GARAGE_XXX_EMAIL` ou modifiez `GARAGE_EMAILS`

### Le WebJob ne s'exécute pas automatiquement
→ Vérifiez que `settings.job` est bien déployé dans le même dossier

### Voir les logs
Portail Azure → WebJobs → weekly-report → Logs

## 📝 Personnalisation

### Modifier la période du rapport

Dans `weekly-report.js`, ligne ~340 :
```javascript
// 7 derniers jours (par défaut)
const startDate = now.minus({ days: 7 })

// 30 derniers jours
const startDate = now.minus({ days: 30 })
```

### Modifier le design
La fonction `generateReportHTML()` contient tout le HTML/CSS.

## 💰 Coût

**0€ supplémentaire** - Utilise les ressources de votre App Service existant.

---

**Prêt à déployer ?** → `git add jobs/ && git commit -m "Add weekly reports" && git push`
