#!/usr/bin/env python3
"""
Générateur de rapports KPI pour clients
Génère automatiquement :
- Un rapport pour la dernière semaine
- Un rapport pour le mois de janvier
"""

import sqlite3
import json
from datetime import datetime, timedelta
from collections import Counter
import os

DB_PATH = "/Users/louisbecker/Desktop/voicemail-assistant/voicemail.db"
OUTPUT_DIR = "/Users/louisbecker/Desktop/voicemail-assistant/rapports"


def get_connection():
    return sqlite3.connect(DB_PATH)


def parse_analysis(analysis_str):
    try:
        return json.loads(analysis_str) if analysis_str else {}
    except:
        return {}


def get_kpis_for_period(conn, garage_id, start_date, end_date):
    """Calculer les KPIs pour une période donnée"""

    calls_query = """
    SELECT call_sid, from_number, duration, status, has_message, start_time, created_at
    FROM calls
    WHERE garage_id = ?
    AND datetime(created_at) BETWEEN datetime(?) AND datetime(?)
    """

    messages_query = """
    SELECT call_sid, from_number, transcript, analysis, sent_at, created_at
    FROM messages
    WHERE garage_id = ?
    AND datetime(created_at) BETWEEN datetime(?) AND datetime(?)
    """

    cursor = conn.cursor()
    cursor.execute(calls_query, (garage_id, start_date, end_date))
    calls = cursor.fetchall()
    cursor.execute(messages_query, (garage_id, start_date, end_date))
    messages = cursor.fetchall()

    kpis = {
        'total_appels': len(calls),
        'appels_avec_message': sum(1 for c in calls if c[4] == 1),
        'appels_manques': sum(1 for c in calls if c[3] == 'missed'),
        'appels_repondus': sum(1 for c in calls if c[3] in ['completed', 'in-progress']),
        'appelants_uniques': len(set(c[1] for c in calls if c[1])),
        'total_messages': len(messages),
        'messages_envoyes': sum(1 for m in messages if m[4]),
    }

    # Durée moyenne
    durations = [c[2] for c in calls if c[2] and c[2] > 0]
    kpis['duree_moyenne'] = round(sum(durations) / len(durations), 1) if durations else 0

    # Analyse des messages
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
    kpis['top_motifs'] = Counter(motives).most_common(3) if motives else []

    # Taux
    if kpis['total_appels'] > 0:
        kpis['taux_message'] = round((kpis['appels_avec_message'] / kpis['total_appels']) * 100, 1)
        kpis['taux_reponse'] = round((kpis['appels_repondus'] / kpis['total_appels']) * 100, 1)
    else:
        kpis['taux_message'] = 0
        kpis['taux_reponse'] = 0

    return kpis


def format_html_report(kpis, period_name, garage_name):
    """Générer un rapport HTML stylé"""

    html = f"""<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rapport KPI - {garage_name}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 40px 20px;
            min-height: 100vh;
        }}
        .container {{
            max-width: 900px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }}
        .header {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }}
        .header h1 {{
            font-size: 2.5em;
            margin-bottom: 10px;
        }}
        .header h2 {{
            font-size: 1.5em;
            font-weight: 300;
            opacity: 0.9;
        }}
        .period-badge {{
            background: rgba(255,255,255,0.2);
            padding: 12px 24px;
            border-radius: 25px;
            display: inline-block;
            margin-top: 20px;
            font-size: 1.1em;
        }}
        .content {{
            padding: 40px;
        }}
        .section {{
            margin-bottom: 40px;
        }}
        .section-title {{
            font-size: 1.5em;
            color: #2d3748;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 3px solid #667eea;
            display: flex;
            align-items: center;
        }}
        .section-title .icon {{
            font-size: 1.2em;
            margin-right: 10px;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            background: white;
        }}
        tr {{
            border-bottom: 1px solid #e2e8f0;
            transition: background 0.2s;
        }}
        tr:hover {{
            background: #f7fafc;
        }}
        td {{
            padding: 16px;
            font-size: 1em;
        }}
        td:first-child {{
            color: #4a5568;
            font-weight: 500;
        }}
        td:last-child {{
            text-align: right;
            font-weight: bold;
            color: #667eea;
            font-size: 1.1em;
        }}
        .highlight {{
            background: linear-gradient(to right, #fef5e7, transparent);
        }}
        .highlight td:last-child {{
            color: #764ba2;
            font-size: 1.3em;
        }}
        .stat-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }}
        .stat-card {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 25px;
            border-radius: 15px;
            text-align: center;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }}
        .stat-card .value {{
            font-size: 2.5em;
            font-weight: bold;
            margin: 10px 0;
        }}
        .stat-card .label {{
            font-size: 0.9em;
            opacity: 0.9;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        .motif-list {{
            list-style: none;
        }}
        .motif-item {{
            background: #f7fafc;
            padding: 15px 20px;
            margin: 10px 0;
            border-radius: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-left: 4px solid #667eea;
        }}
        .motif-rank {{
            background: #667eea;
            color: white;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            margin-right: 15px;
        }}
        .motif-name {{
            flex: 1;
            color: #2d3748;
            font-weight: 500;
        }}
        .motif-count {{
            background: #764ba2;
            color: white;
            padding: 5px 15px;
            border-radius: 20px;
            font-weight: bold;
        }}
        .footer {{
            text-align: center;
            padding: 30px;
            color: #718096;
            background: #f7fafc;
            font-size: 0.9em;
        }}
        @media print {{
            body {{ background: white; padding: 0; }}
            .container {{ box-shadow: none; }}
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 Rapport KPI</h1>
            <h2>{garage_name}</h2>
            <div class="period-badge">📅 {period_name}</div>
        </div>

        <div class="content">
            <!-- Statistiques principales -->
            <div class="stat-grid">
                <div class="stat-card">
                    <div class="label">Total Appels</div>
                    <div class="value">{kpis['total_appels']}</div>
                </div>
                <div class="stat-card">
                    <div class="label">Taux de Réponse</div>
                    <div class="value">{kpis['taux_reponse']}%</div>
                </div>
                <div class="stat-card">
                    <div class="label">Messages Vocaux</div>
                    <div class="value">{kpis['total_messages']}</div>
                </div>
                <div class="stat-card">
                    <div class="label">Appelants Uniques</div>
                    <div class="value">{kpis['appelants_uniques']}</div>
                </div>
            </div>

            <!-- Section Appels -->
            <div class="section">
                <div class="section-title">
                    <span class="icon">📞</span>
                    Détails des Appels
                </div>
                <table>
                    <tr class="highlight">
                        <td>Total d'appels reçus</td>
                        <td>{kpis['total_appels']}</td>
                    </tr>
                    <tr>
                        <td>Appels répondus</td>
                        <td>{kpis['appels_repondus']}</td>
                    </tr>
                    <tr>
                        <td>Appels manqués</td>
                        <td>{kpis['appels_manques']}</td>
                    </tr>
                    <tr>
                        <td>Appels avec message vocal</td>
                        <td>{kpis['appels_avec_message']}</td>
                    </tr>
                    <tr class="highlight">
                        <td>Taux de message</td>
                        <td>{kpis['taux_message']}%</td>
                    </tr>
                    <tr>
                        <td>Durée moyenne d'appel</td>
                        <td>{kpis['duree_moyenne']}s</td>
                    </tr>
                </table>
            </div>

            <!-- Section Messages -->
            <div class="section">
                <div class="section-title">
                    <span class="icon">💬</span>
                    Messages Vocaux
                </div>
                <table>
                    <tr class="highlight">
                        <td>Total messages traités</td>
                        <td>{kpis['total_messages']}</td>
                    </tr>
                    <tr>
                        <td>Emails envoyés</td>
                        <td>{kpis['messages_envoyes']}</td>
                    </tr>
                    <tr>
                        <td>Appels urgents</td>
                        <td>{kpis['appels_urgents']}</td>
                    </tr>
                    <tr>
                        <td>Noms détectés</td>
                        <td>{kpis['noms_detectes']}</td>
                    </tr>
                </table>
            </div>
"""

    # Section motifs
    if kpis['top_motifs']:
        html += """
            <div class="section">
                <div class="section-title">
                    <span class="icon">📋</span>
                    Top 3 des Motifs d'Appel
                </div>
                <ul class="motif-list">
"""
        for i, (motif, count) in enumerate(kpis['top_motifs'], 1):
            html += f"""
                    <li class="motif-item">
                        <div class="motif-rank">{i}</div>
                        <div class="motif-name">{motif.title()}</div>
                        <div class="motif-count">{count}</div>
                    </li>
"""
        html += """
                </ul>
            </div>
"""

    html += f"""
        </div>

        <div class="footer">
            Rapport généré le {datetime.now().strftime('%d/%m/%Y à %H:%M')}<br>
            Système de gestion des messages vocaux
        </div>
    </div>
</body>
</html>
"""
    return html


def generate_reports():
    """Générer les rapports pour tous les garages"""

    # Créer le dossier de sortie
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    conn = get_connection()
    cursor = conn.cursor()

    # Récupérer tous les garages
    cursor.execute("SELECT DISTINCT garage_id FROM calls WHERE garage_id IS NOT NULL")
    garages = [row[0] for row in cursor.fetchall()]

    print("\n" + "="*60)
    print(f"📊 GÉNÉRATION DES RAPPORTS KPI")
    print("="*60)
    print(f"🏢 Garages : {', '.join(garages)}")

    # Vérifier les dates disponibles
    cursor.execute("SELECT MIN(created_at), MAX(created_at) FROM calls")
    min_date, max_date = cursor.fetchone()
    print(f"📅 Données disponibles : {min_date} à {max_date}")
    print("="*60 + "\n")

    now = datetime.now()

    # Définir les périodes
    # Dernière semaine (7 derniers jours)
    last_week_start = (now - timedelta(days=7)).strftime('%Y-%m-%d 00:00:00')
    last_week_end = now.strftime('%Y-%m-%d 23:59:59')
    last_week_name = f"Dernière semaine ({(now - timedelta(days=7)).strftime('%d/%m')} - {now.strftime('%d/%m/%Y')})"

    # Mois de janvier
    january_start = '2026-01-01 00:00:00'
    january_end = '2026-01-31 23:59:59'
    january_name = "Janvier 2026"

    # Générer pour chaque garage
    for garage_id in garages:
        print(f"\n🏢 {garage_id}")
        print("-" * 40)

        # Rapport semaine
        kpis_week = get_kpis_for_period(conn, garage_id, last_week_start, last_week_end)
        html_week = format_html_report(kpis_week, last_week_name, garage_id)

        filename_week = os.path.join(
            OUTPUT_DIR,
            f"{garage_id.replace(' ', '_')}_Semaine.html"
        )
        with open(filename_week, 'w', encoding='utf-8') as f:
            f.write(html_week)

        print(f"✅ Semaine : {kpis_week['total_appels']} appels, {kpis_week['total_messages']} messages")
        print(f"   → {filename_week}")

        # Rapport janvier
        kpis_jan = get_kpis_for_period(conn, garage_id, january_start, january_end)
        html_jan = format_html_report(kpis_jan, january_name, garage_id)

        filename_jan = os.path.join(
            OUTPUT_DIR,
            f"{garage_id.replace(' ', '_')}_Janvier.html"
        )
        with open(filename_jan, 'w', encoding='utf-8') as f:
            f.write(html_jan)

        print(f"✅ Janvier : {kpis_jan['total_appels']} appels, {kpis_jan['total_messages']} messages")
        print(f"   → {filename_jan}")

    conn.close()

    print("\n" + "="*60)
    print("✅ TOUS LES RAPPORTS ONT ÉTÉ GÉNÉRÉS !")
    print(f"📁 Dossier : {OUTPUT_DIR}")
    print("="*60 + "\n")


if __name__ == "__main__":
    generate_reports()
