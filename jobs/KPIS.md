# 📊 Liste des KPIs - Rapports Hebdomadaires PitCall

Ce document liste tous les indicateurs de performance (KPIs) calculés et inclus dans les rapports hebdomadaires envoyés aux clients.

---

## ⚠️ Note importante : Périmètre du système

**PitCall capte UNIQUEMENT les appels manqués** (répondeur intelligent). Le système ne gère pas les appels répondus directement par le garage. Les KPIs ci-dessous reflètent cette réalité.

---

## 📈 Les 4 KPIs Principaux

### 1. Nombre d'appels manqués 📞
**Description** : Nombre total d'appels non décrochés par le garage sur la période

**Source** : Table `calls`

**Calcul** : `COUNT(*)`

**Importance** : 🔴 Critique - Volume total d'activité du répondeur

**Objectif cible** : Surveiller les pics d'affluence

**Exemple** : 45 appels manqués sur la semaine

---

### 2. Nombre de messages laissés 💬
**Description** : Appels manqués où le client a laissé un message vocal

**Source** : Table `calls`, champ `has_message`

**Calcul** : `COUNT WHERE has_message = 1`

**Importance** : 🔴 Critique - Leads à traiter en priorité

**Objectif cible** : Maximiser ce nombre (améliorer le message d'accueil)

**Exemple** : 32 messages laissés (sur 45 appels manqués)

---

### 3. Taux d'appels manqués avec message (%) 📊
**Description** : Pourcentage d'appels manqués pour lesquels le client a laissé un message

**Calcul** : `(Messages laissés / Appels manqués) × 100`

**Format** : Pourcentage (1 décimale)

**Importance** : 🔴 Critique - Indicateur de qualité du message d'accueil

**Objectif cible** : > 60%

**Exemple** : 71.1% (32 messages / 45 appels)

**Interprétation** :
- < 50% → Message d'accueil peu engageant, clients raccrochent
- 50-70% → Normal
- > 70% → Excellent, message d'accueil efficace

---

### 4. Nombre d'appelants uniques 👥
**Description** : Nombre de numéros de téléphone différents ayant appelé

**Source** : Table `calls`, champ `from_number`

**Calcul** : `COUNT(DISTINCT from_number)`

**Importance** : 🟡 Important - Portée de l'activité

**Objectif cible** : Surveiller les appelants récurrents

**Exemple** : 38 appelants uniques (certains ont appelé plusieurs fois)

**Interprétation** :
- Si Appelants uniques << Appels manqués → Beaucoup d'appelants récurrents (possiblement urgents)
- Si Appelants uniques ≈ Appels manqués → Chaque personne appelle une seule fois

---

## 📋 Liste des Motifs d'Appels

### Description
Liste complète des motifs d'appels détectés par l'IA, triés par fréquence (du plus fréquent au moins fréquent).

**Source** : Table `messages`, champ `analysis` → `motive_legend`

**Calcul** : `GROUP BY motive_legend ORDER BY COUNT DESC`

**Format** : Liste avec rang + motif + nombre d'occurrences

**Importance** : 🟡 Important - Comprendre les besoins clients

---

### Motifs possibles (selon analyse IA)

| Motif | Description | Exemple |
|-------|-------------|---------|
| **rdv** | Prise de rendez-vous | "Je voudrais un RDV pour un entretien" |
| **panne** | Véhicule en panne | "Ma voiture ne démarre plus" |
| **devis** | Demande de devis | "Combien coûte un changement de pneus ?" |
| **renseignement** | Demande d'information | "Êtes-vous ouverts le samedi ?" |
| **reclamation** | Plainte ou mécontentement | "Mon véhicule n'est toujours pas prêt" |
| **urgent** | Situation urgente | "Je suis en panne sur l'autoroute" |
| **ct** | Contrôle technique | "J'ai besoin d'un CT rapidement" |
| **rappel** | Demande de rappel | "Merci de me rappeler dès que possible" |
| **autre** | Motif non identifié | Message flou ou incompréhensible |

---

### Exemple de liste dans le rapport

```
1. RDV           → 12 appels
2. Panne         → 8 appels
3. Devis         → 5 appels
4. Renseignement → 4 appels
5. CT            → 2 appels
6. Urgent        → 1 appel
```

---

## 📊 Tableau récapitulatif

| # | KPI | Type | Format | Objectif |
|---|-----|------|--------|----------|
| 1 | Appels manqués | Volume | Nombre | Surveiller les pics |
| 2 | Messages laissés | Volume | Nombre | Maximiser |
| 3 | Taux avec message | Qualité | Pourcentage | > 60% |
| 4 | Appelants uniques | Portée | Nombre | Identifier récurrents |
| 5 | Motifs d'appels | Analyse | Liste | Adapter les services |

---

## 🎯 Utilisation des KPIs

### Pour le client (garage)

**Opérationnel** :
- **Messages laissés** → Prioriser les rappels urgents
- **Motifs d'appels** → Préparer le discours de rappel (RDV, panne, devis...)
- **Appelants uniques** → Identifier les clients récurrents (potentiellement insatisfaits ou très urgents)

**Stratégique** :
- **Taux avec message** → Évaluer la qualité du message d'accueil
- **Pics d'appels manqués** → Ajuster les horaires d'ouverture ou embaucher
- **Top motifs** → Adapter les services proposés (ex: beaucoup de pannes → proposer dépannage)

### Pour PitCall (suivi produit)

**Qualité du service** :
- **Taux avec message** → Performance du message d'accueil
- **Nombre de messages** → Volume d'utilisation du produit
- **Qualité des motifs** → Précision de l'IA d'analyse

**Engagement client** :
- Faible taux de message (< 40%) → Revoir le script du message d'accueil
- Beaucoup de motifs "autre" → Améliorer le modèle d'analyse IA

---

## 🔄 KPIs Secondaires (non affichés, mais calculables)

Ces indicateurs peuvent être ajoutés dans une version future :

### Court terme
- ⏱️ **Durée moyenne des messages** : Longueur des messages vocaux
- 📅 **Répartition horaire** : À quelle heure les clients appellent le plus
- 🔁 **Taux d'appelants récurrents** : % d'appelants qui ont appelé 2+ fois

### Moyen terme
- 📈 **Évolution semaine/semaine** : Comparaison avec semaine N-1
- 🌟 **Score de sentiment** : Analyse du ton (positif/négatif/neutre)
- 📍 **Origine géographique** : Localisation des appelants (si disponible)

### Long terme
- 💰 **Valeur estimée par motif** : CA potentiel (RDV = X€, panne = Y€)
- 🎯 **Taux de conversion** : % d'appels transformés en RDV confirmés
- ⏳ **Temps de réponse** : Délai entre l'appel manqué et le rappel du garage

---

## 💾 Sources de Données

### Table `calls`
```sql
SELECT
  call_sid,
  from_number,
  has_message,
  created_at
FROM calls
WHERE garage_id = ?
AND datetime(created_at) BETWEEN ? AND ?
```

**Champs utilisés** :
- `call_sid` : Identifiant unique de l'appel
- `from_number` : Numéro de l'appelant (pour compter les uniques)
- `has_message` : 1 si message laissé, 0 sinon
- `created_at` : Date/heure de l'appel

---

### Table `messages`
```sql
SELECT
  call_sid,
  transcript,
  analysis,
  created_at
FROM messages
WHERE garage_id = ?
AND datetime(created_at) BETWEEN ? AND ?
```

**Champs utilisés** :
- `analysis` : JSON contenant l'analyse IA
  - `analysis.motive_legend` : Motif d'appel détecté
  - `analysis.is_urgent` : Appel urgent (true/false)
  - `analysis.name` : Nom du client (si détecté)

---

## 📧 Format de Rapport PDF

Les KPIs sont présentés dans un PDF stylé avec :

### 1. Entête
- Logo PitCall
- Nom du garage
- Période du rapport

### 2. Cartes statistiques (4 KPIs principaux)
Affichage en grand format avec gradient violet :
- Appels manqués
- Messages laissés
- Taux avec message
- Appelants uniques

### 3. Liste des motifs
Classement visuel avec :
- Numéro de rang
- Nom du motif
- Nombre d'occurrences (badge violet)

### 4. Footer
- Date de génération
- Période analysée
- Logo PitCall

**Design** : Dégradé violet (brand PitCall) + icônes émojis + impression possible

---

## 🛠️ Maintenance

### Comment modifier un KPI existant

1. **Backend** : Modifier `getKPIsForPeriod()` dans `weekly-report.js`
2. **Frontend** : Adapter `generateReportHTML()` pour l'affichage
3. **Documentation** : Mettre à jour ce fichier
4. **Test** : `node jobs/weekly-report.js`

### Comment ajouter un nouveau KPI

1. Identifier la source de données (table, champ)
2. Ajouter le calcul dans `getKPIsForPeriod()`
3. Ajouter l'affichage dans le HTML (carte ou tableau)
4. Documenter dans ce fichier
5. Tester avec données réelles

---

## 📞 Support & Questions

**Période par défaut** : 7 derniers jours (vendredi N-1 → vendredi N)

**Timezone** : Europe/Paris (CET/CEST)

**Envoi automatique** : Tous les vendredis à 17h

---

**Dernière mise à jour** : 2026-02-13
**Version** : 2.0 (KPIs corrigés pour refléter le périmètre réel)
