#!/usr/bin/env python3
"""
Générateur de rapports KPI pour les clients de voicemail.db
Génère des tableaux propres avec les statistiques de la dernière semaine et du mois de janvier
"""

import sqlite3
import json
from datetime import datetime, timedelta
from collections import Counter, defaultdict
import pandas as pd

DB_PATH = "/Users/louisbecker/Desktop/voicemail-assistant/voicemail.db"


def get_connection():
    """Créer une connexion à la base de données"""
    return sqlite3.connect(DB_PATH)


def parse_analysis(analysis_str):
    """Parser le champ analysis JSON"""
    try:
        return json.loads(analysis_str) if analysis_str else {}
    except:
        return {}


def get_kpis_for_period(conn, garage_id, start_date, end_date, period_name):
    """Calculer les KPIs pour une période donnée"""

    # Requête pour les appels
    calls_query = """
    SELECT
        call_sid,
        from_number,
        duration,
        status,
        has_message,
        start_time,
        created_at
    FROM calls
    WHERE garage_id = ?
    AND datetime(created_at) BETWEEN datetime(?) AND datetime(?)
    """

    # Requête pour les messages
    messages_query = """
    SELECT
        call_sid,
        from_number,
        transcript,
        analysis,
        sent_at,
        created_at
    FROM messages
    WHERE garage_id = ?
    AND datetime(created_at) BETWEEN datetime(?) AND datetime(?)
    """

    cursor = conn.cursor()

    # Récupérer les appels
    cursor.execute(calls_query, (garage_id, start_date, end_date))
    calls = cursor.fetchall()

    # Récupérer les messages
    cursor.execute(messages_query, (garage_id, start_date, end_date))
    messages = cursor.fetchall()

    # Calculer les KPIs
    kpis = {}

    # KPIs des appels
    kpis['total_appels'] = len(calls)
    kpis['appels_avec_message'] = sum(1 for c in calls if c[4] == 1)  # has_message
    kpis['appels_manques'] = sum(1 for c in calls if c[3] == 'missed')  # status
    kpis['appels_repondus'] = sum(1 for c in calls if c[3] in ['completed', 'in-progress'])

    # Durée moyenne (en secondes)
    durations = [c[2] for c in calls if c[2] and c[2] > 0]
    kpis['duree_moyenne'] = round(sum(durations) / len(durations), 1) if durations else 0

    # Appelants uniques
    unique_callers = set(c[1] for c in calls if c[1])
    kpis['appelants_uniques'] = len(unique_callers)

    # KPIs des messages
    kpis['total_messages'] = len(messages)
    kpis['messages_envoyes'] = sum(1 for m in messages if m[4])  # sent_at

    # Analyse des motifs
    motives = []
    urgents = 0
    noms_detectes = 0

    for msg in messages:
        analysis = parse_analysis(msg[3])
        if analysis:
            if analysis.get('motive_legend'):
                motives.append(analysis['motive_legend'])
            if analysis.get('is_urgent'):
                urgents += 1
            if analysis.get('name') and analysis['name'].lower() != 'inconnu':
                noms_detectes += 1

    kpis['appels_urgents'] = urgents
    kpis['noms_detectes'] = noms_detectes

    # Top 3 des motifs
    if motives:
        motive_counter = Counter(motives)
        kpis['top_motifs'] = motive_counter.most_common(3)
    else:
        kpis['top_motifs'] = []

    # Taux de conversion
    if kpis['total_appels'] > 0:
        kpis['taux_message'] = round((kpis['appels_avec_message'] / kpis['total_appels']) * 100, 1)
        kpis['taux_reponse'] = round((kpis['appels_repondus'] / kpis['total_appels']) * 100, 1)
    else:
        kpis['taux_message'] = 0
        kpis['taux_reponse'] = 0

    return kpis


def format_kpi_table(kpis, period_name, garage_name):
    """Formater les KPIs en tableau Markdown"""

    lines = []
    lines.append(f"\n## 📊 Rapport KPI - {garage_name}")
    lines.append(f"### Période : {period_name}\n")
    lines.append("---\n")

    # Section Appels
    lines.append("### 📞 Appels")
    lines.append("| Métrique | Valeur |")
    lines.append("|----------|--------|")
    lines.append(f"| **Total d'appels reçus** | {kpis['total_appels']} |")
    lines.append(f"| Appels répondus | {kpis['appels_repondus']} |")
    lines.append(f"| Appels manqués | {kpis['appels_manques']} |")
    lines.append(f"| Appels avec message vocal | {kpis['appels_avec_message']} |")
    lines.append(f"| **Taux de réponse** | {kpis['taux_reponse']}% |")
    lines.append(f"| **Taux de message** | {kpis['taux_message']}% |")
    lines.append(f"| Durée moyenne d'appel | {kpis['duree_moyenne']}s |")
    lines.append(f"| Appelants uniques | {kpis['appelants_uniques']} |")
    lines.append("")

    # Section Messages
    lines.append("### 💬 Messages vocaux")
    lines.append("| Métrique | Valeur |")
    lines.append("|----------|--------|")
    lines.append(f"| **Total messages traités** | {kpis['total_messages']} |")
    lines.append(f"| Emails envoyés | {kpis['messages_envoyes']} |")
    lines.append(f"| Appels urgents | {kpis['appels_urgents']} |")
    lines.append(f"| Noms détectés | {kpis['noms_detectes']} |")
    lines.append("")

    # Section Motifs
    if kpis['top_motifs']:
        lines.append("### 📋 Top 3 des motifs d'appel")
        lines.append("| Rang | Motif | Nombre |")
        lines.append("|------|-------|--------|")
        for i, (motif, count) in enumerate(kpis['top_motifs'], 1):
            lines.append(f"| {i} | {motif.title()} | {count} |")
        lines.append("")

    lines.append("---\n")

    return "\n".join(lines)


def generate_reports():
    """Générer les rapports pour tous les garages"""

    conn = get_connection()
    cursor = conn.cursor()

    # Récupérer tous les garages
    cursor.execute("SELECT DISTINCT garage_id FROM calls WHERE garage_id IS NOT NULL")
    garages = [row[0] for row in cursor.fetchall()]

    print(f"📊 Génération des rapports KPI pour {len(garages)} garage(s)...\n")

    # Date actuelle
    now = datetime.now()

    # Définir les périodes
    # Dernière semaine (7 derniers jours)
    last_week_start = (now - timedelta(days=7)).strftime('%Y-%m-%d 00:00:00')
    last_week_end = now.strftime('%Y-%m-%d 23:59:59')

    # Mois de janvier 2026
    january_start = '2026-01-01 00:00:00'
    january_end = '2026-01-31 23:59:59'

    # Générer les rapports pour chaque garage
    all_reports = []

    for garage_id in garages:
        print(f"\n{'='*60}")
        print(f"🏢 Garage : {garage_id}")
        print(f"{'='*60}")

        # Rapport semaine dernière
        kpis_week = get_kpis_for_period(
            conn,
            garage_id,
            last_week_start,
            last_week_end,
            "Dernière semaine"
        )

        week_report = format_kpi_table(
            kpis_week,
            f"Dernière semaine ({(now - timedelta(days=7)).strftime('%d/%m/%Y')} - {now.strftime('%d/%m/%Y')})",
            garage_id
        )

        print(week_report)
        all_reports.append(week_report)

        # Rapport janvier
        kpis_january = get_kpis_for_period(
            conn,
            garage_id,
            january_start,
            january_end,
            "Janvier 2026"
        )

        january_report = format_kpi_table(
            kpis_january,
            "Janvier 2026",
            garage_id
        )

        print(january_report)
        all_reports.append(january_report)

        # Sauvegarder les rapports individuels
        filename = f"/Users/louisbecker/Desktop/voicemail-assistant/rapport_{garage_id.replace(' ', '_')}.md"
        with open(filename, 'w', encoding='utf-8') as f:
            f.write(f"# Rapport KPI - {garage_id}\n")
            f.write(f"Généré le {now.strftime('%d/%m/%Y à %H:%M')}\n\n")
            f.write(week_report)
            f.write("\n\n")
            f.write(january_report)

        print(f"\n✅ Rapport sauvegardé : {filename}")

    # Sauvegarder un rapport consolidé
    consolidated_filename = "/Users/louisbecker/Desktop/voicemail-assistant/rapport_consolide.md"
    with open(consolidated_filename, 'w', encoding='utf-8') as f:
        f.write(f"# Rapport KPI Consolidé - Tous les Garages\n")
        f.write(f"Généré le {now.strftime('%d/%m/%Y à %H:%M')}\n\n")
        f.write("\n\n".join(all_reports))

    print(f"\n\n{'='*60}")
    print(f"✅ Rapport consolidé sauvegardé : {consolidated_filename}")
    print(f"{'='*60}\n")

    conn.close()


if __name__ == "__main__":
    generate_reports()
