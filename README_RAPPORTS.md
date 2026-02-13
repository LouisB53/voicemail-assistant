# 📊 Générateur de Rapports KPI - Guide d'utilisation

## 📁 Fichiers disponibles

### 1. `generate_client_reports.py` ⭐ (RECOMMANDÉ)
**Script principal pour générer les rapports clients**

Ce script génère automatiquement **2 rapports HTML par client** :
- Un rapport pour la **dernière semaine** (7 derniers jours)
- Un rapport pour le **mois de janvier 2026**

#### Utilisation :
```bash
python3 generate_client_reports.py
```

#### Sortie :
- Les rapports sont sauvegardés dans le dossier `rapports/`
- Format : `{NomGarage}_Semaine.html` et `{NomGarage}_Janvier.html`
- Design moderne et professionnel, prêt à envoyer aux clients

---

### 2. `generate_kpi_custom.py`
**Script pour périodes personnalisées**

Permet de spécifier manuellement les dates de début et fin pour chaque période.

#### Configuration :
Modifier les variables dans le script :
```python
# Période 1
period1_start = '2026-01-01 00:00:00'
period1_end = '2026-01-31 23:59:59'
period1_name = "Janvier 2026"

# Période 2
period2_start = '2026-02-01 00:00:00'
period2_end = '2026-02-07 23:59:59'
period2_name = "Première semaine de février"
```

---

### 3. `generate_kpi_report.py`
**Script de base (format Markdown)**

Génère des rapports au format Markdown (moins visuel).

---

## 📊 KPIs inclus dans les rapports

### Section Appels 📞
- **Total d'appels reçus**
- Appels répondus
- Appels manqués
- Appels avec message vocal
- **Taux de réponse** (%)
- **Taux de message** (%)
- Durée moyenne d'appel (secondes)
- Nombre d'appelants uniques

### Section Messages Vocaux 💬
- **Total messages traités**
- Emails envoyés
- Appels urgents
- Noms détectés

### Section Motifs d'Appel 📋
- Top 3 des motifs les plus fréquents
- Nombre d'occurrences par motif

---

## 🎨 Aperçu des rapports

Les rapports HTML sont optimisés pour :
- ✅ Affichage web moderne
- ✅ Impression (fonction Imprimer du navigateur)
- ✅ Envoi par email
- ✅ Responsive design (mobile friendly)

### Thème visuel :
- Design gradient violet/bleu
- Cartes statistiques en haut
- Tableaux détaillés
- Section motifs avec badges colorés

---

## 🚀 Workflow recommandé

1. **Chaque semaine** : Exécuter `generate_client_reports.py`
2. Ouvrir les fichiers HTML dans le dossier `rapports/`
3. Vérifier les données
4. Envoyer par email aux clients ou imprimer en PDF

---

## 💡 Astuces

### Convertir HTML en PDF
**Option 1 : Via navigateur**
```
1. Ouvrir le fichier HTML dans Chrome/Firefox
2. Cmd+P (Mac) ou Ctrl+P (Windows)
3. "Enregistrer au format PDF"
```

**Option 2 : Via ligne de commande (si wkhtmltopdf installé)**
```bash
wkhtmltopdf rapport.html rapport.pdf
```

### Automatiser l'envoi par email
Vous pouvez créer un script Python avec `smtplib` pour envoyer automatiquement les rapports :

```python
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

def send_report(to_email, html_content, garage_name):
    msg = MIMEMultipart('alternative')
    msg['Subject'] = f"Rapport KPI - {garage_name}"
    msg['From'] = "votre@email.com"
    msg['To'] = to_email

    html_part = MIMEText(html_content, 'html')
    msg.attach(html_part)

    # Envoyer via SMTP
    # ... configuration SMTP ...
```

---

## 📊 Structure de la base de données

### Table `calls`
- `call_sid` : ID unique de l'appel (Twilio)
- `from_number` : Numéro de l'appelant
- `to_number` : Numéro appelé
- `duration` : Durée en secondes
- `status` : completed, missed, in-progress
- `has_message` : 0 ou 1
- `garage_id` : Identifiant du garage/client
- `created_at` : Date de l'appel

### Table `messages`
- `call_sid` : Référence à l'appel
- `garage_id` : Identifiant du garage/client
- `from_number` : Numéro de l'appelant
- `transcript` : Transcription du message vocal
- `analysis` : JSON avec analyse GPT (motif, urgence, nom, etc.)
- `sent_at` : Date d'envoi de l'email
- `created_at` : Date du message

---

## 🔧 Dépannage

### Erreur : "no such table"
→ Vérifier le chemin vers `voicemail.db` dans les scripts

### Rapports vides
→ Vérifier qu'il y a des données pour les périodes demandées :
```bash
sqlite3 voicemail.db "SELECT MIN(created_at), MAX(created_at) FROM calls"
```

### Erreur d'encodage
→ Les scripts utilisent UTF-8, assurez-vous que votre terminal supporte l'UTF-8

---

## 📧 Contact

Pour toute question ou amélioration, contactez l'équipe de développement.

---

**Dernière mise à jour** : Février 2026
