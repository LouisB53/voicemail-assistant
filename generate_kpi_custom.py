#!/usr/bin/env python3
"""
Générateur de rapports KPI avec périodes personnalisables
"""

import sqlite3
import json
from datetime import datetime, timedelta
from collections import Counter
import sys

DB_PATH = "/Users/louisbecker/Desktop/voicemail-assistant/voicemail.db"


def get_connection():
    return sqlite3.connect(DB_PATH)


def parse_analysis(analysis_str):
    try:
        return json.loads(analysis_str) if analysis_str else {}
    except:
        return {}


def get_kpis_for_period(conn, garage_id, start_date, end_date):
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
    kpis['appels_avec_message'] = sum(1 for c in calls if c[4] == 1)
    kpis['appels_manques'] = sum(1 for c in calls if c[3] == 'missed')
    kpis['appels_repondus'] = sum(1 for c in calls if c[3] in ['completed', 'in-progress'])

    # Durée moyenne (en secondes)
    durations = [c[2] for c in calls if c[2] and c[2] > 0]
    kpis['duree_moyenne'] = round(sum(durations) / len(durations), 1) if durations else 0

    # Appelants uniques
    unique_callers = set(c[1] for c in calls if c[1])
    kpis['appelants_uniques'] = len(unique_callers)

    # KPIs des messages
    kpis['total_messages'] = len(messages)
    kpis['messages_envoyes'] = sum(1 for m in messages if m[4])

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


def format_kpi_table_html(kpis, period_name, garage_name):
    """Formater les KPIs en tableau HTML stylé"""

    html = f"""
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rapport KPI - {garage_name}</title>
    <style>
        body {{
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            max-width: 900px;
            margin: 40px auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }}
        .container {{
            background: white;
            border-radius: 15px;
            padding: 40px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }}
        h1 {{
            color: #2d3748;
            text-align: center;
            margin-bottom: 10px;
            font-size: 2.5em;
        }}
        h2 {{
            color: #4a5568;
            text-align: center;
            margin-bottom: 30px;
            font-weight: normal;
        }}
        .period {{
            background: #edf2f7;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
            margin-bottom: 30px;
            font-size: 1.1em;
            color: #2d3748;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
        }}
        .section-title {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px;
            font-size: 1.3em;
            font-weight: bold;
            border-radius: 8px;
            margin-top: 30px;
            margin-bottom: 15px;
        }}
        th {{
            background: #4a5568;
            color: white;
            padding: 15px;
            text-align: left;
            font-weight: 600;
        }}
        td {{
            padding: 12px 15px;
            border-bottom: 1px solid #e2e8f0;
        }}
        tr:hover {{
            background: #f7fafc;
        }}
        .metric {{
            font-weight: 500;
            color: #2d3748;
        }}
        .value {{
            font-weight: bold;
            color: #667eea;
            text-align: right;
        }}
        .highlight {{
            background: #fef5e7;
            font-weight: bold;
        }}
        .footer {{
            text-align: center;
            margin-top: 40px;
            color: #718096;
            font-size: 0.9em;
        }}
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 Rapport KPI</h1>
        <h2>{garage_name}</h2>
        <div class="period">📅 {period_name}</div>

        <div class="section-title">📞 Appels</div>
        <table>
            <tr class="highlight">
                <td class="metric">Total d'appels reçus</td>
                <td class="value">{kpis['total_appels']}</td>
            </tr>
            <tr>
                <td class="metric">Appels répondus</td>
                <td class="value">{kpis['appels_repondus']}</td>
            </tr>
            <tr>
                <td class="metric">Appels manqués</td>
                <td class="value">{kpis['appels_manques']}</td>
            </tr>
            <tr>
                <td class="metric">Appels avec message vocal</td>
                <td class="value">{kpis['appels_avec_message']}</td>
            </tr>
            <tr class="highlight">
                <td class="metric">Taux de réponse</td>
                <td class="value">{kpis['taux_reponse']}%</td>
            </tr>
            <tr class="highlight">
                <td class="metric">Taux de message</td>
                <td class="value">{kpis['taux_message']}%</td>
            </tr>
            <tr>
                <td class="metric">Durée moyenne d'appel</td>
                <td class="value">{kpis['duree_moyenne']}s</td>
            </tr>
            <tr>
                <td class="metric">Appelants uniques</td>
                <td class="value">{kpis['appelants_uniques']}</td>
            </tr>
        </table>

        <div class="section-title">💬 Messages vocaux</div>
        <table>
            <tr class="highlight">
                <td class="metric">Total messages traités</td>
                <td class="value">{kpis['total_messages']}</td>
            </tr>
            <tr>
                <td class="metric">Emails envoyés</td>
                <td class="value">{kpis['messages_envoyes']}</td>
            </tr>
            <tr>
                <td class="metric">Appels urgents</td>
                <td class="value">{kpis['appels_urgents']}</td>
            </tr>
            <tr>
                <td class="metric">Noms détectés</td>
                <td class="value">{kpis['noms_detectes']}</td>
            </tr>
        </table>
"""

    if kpis['top_motifs']:
        html += """
        <div class="section-title">📋 Top 3 des motifs d'appel</div>
        <table>
            <thead>
                <tr>
                    <th>Rang</th>
                    <th>Motif</th>
                    <th style="text-align: right;">Nombre</th>
                </tr>
            </thead>
            <tbody>
"""
        for i, (motif, count) in enumerate(kpis['top_motifs'], 1):
            html += f"""
                <tr>
                    <td>{i}</td>
                    <td>{motif.title()}</td>
                    <td style="text-align: right; font-weight: bold;">{count}</td>
                </tr>
"""
        html += """
            </tbody>
        </table>
"""

    html += f"""
        <div class="footer">
            Rapport généré le {datetime.now().strftime('%d/%m/%Y à %H:%M')}
        </div>
    </div>
</body>
</html>
"""
    return html


def generate_report_for_garage(garage_id, period1_start, period1_end, period1_name,
                                period2_start, period2_end, period2_name):
    """Générer le rapport pour un garage avec deux périodes"""

    conn = get_connection()

    print(f"\n{'='*60}")
    print(f"🏢 Génération du rapport pour : {garage_id}")
    print(f"{'='*60}\n")

    # Période 1
    print(f"📊 Période 1 : {period1_name}")
    kpis1 = get_kpis_for_period(conn, garage_id, period1_start, period1_end)
    html1 = format_kpi_table_html(kpis1, period1_name, garage_id)

    filename1 = f"/Users/louisbecker/Desktop/voicemail-assistant/rapport_{garage_id.replace(' ', '_')}_periode1.html"
    with open(filename1, 'w', encoding='utf-8') as f:
        f.write(html1)

    print(f"✅ Rapport sauvegardé : {filename1}")
    print(f"   - Total appels : {kpis1['total_appels']}")
    print(f"   - Messages traités : {kpis1['total_messages']}")

    # Période 2
    print(f"\n📊 Période 2 : {period2_name}")
    kpis2 = get_kpis_for_period(conn, garage_id, period2_start, period2_end)
    html2 = format_kpi_table_html(kpis2, period2_name, garage_id)

    filename2 = f"/Users/louisbecker/Desktop/voicemail-assistant/rapport_{garage_id.replace(' ', '_')}_periode2.html"
    with open(filename2, 'w', encoding='utf-8') as f:
        f.write(html2)

    print(f"✅ Rapport sauvegardé : {filename2}")
    print(f"   - Total appels : {kpis2['total_appels']}")
    print(f"   - Messages traités : {kpis2['total_messages']}")

    conn.close()

    return filename1, filename2


if __name__ == "__main__":
    conn = get_connection()
    cursor = conn.cursor()

    # Récupérer tous les garages
    cursor.execute("SELECT DISTINCT garage_id FROM calls WHERE garage_id IS NOT NULL")
    garages = [row[0] for row in cursor.fetchall()]

    print(f"\n🏢 Garages trouvés : {', '.join(garages)}")

    # Vérifier les dates disponibles
    cursor.execute("SELECT MIN(created_at), MAX(created_at) FROM calls")
    min_date, max_date = cursor.fetchone()
    print(f"📅 Période de données disponibles : {min_date} à {max_date}")

    conn.close()

    # Configuration des périodes
    # Pour l'exemple, utilisons les données de novembre disponibles
    # Semaine 1 : 25 novembre (10h-15h)
    period1_start = '2025-11-25 10:00:00'
    period1_end = '2025-11-25 15:00:00'
    period1_name = "Semaine du 25 novembre (matin)"

    # Semaine 2 : 25 novembre (15h-18h)
    period2_start = '2025-11-25 15:00:00'
    period2_end = '2025-11-25 18:00:00'
    period2_name = "Semaine du 25 novembre (après-midi)"

    print(f"\n📊 Génération des rapports avec les périodes suivantes :")
    print(f"   Période 1 : {period1_name}")
    print(f"   Période 2 : {period2_name}")

    for garage in garages:
        generate_report_for_garage(
            garage,
            period1_start, period1_end, period1_name,
            period2_start, period2_end, period2_name
        )

    print(f"\n{'='*60}")
    print("✅ Tous les rapports ont été générés !")
    print(f"{'='*60}\n")
