#!/usr/bin/env python3
"""
Script pour envoyer les rapports KPI par email aux clients
Configure vos paramètres SMTP ci-dessous
"""

import smtplib
import os
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from datetime import datetime

# ==================== CONFIGURATION ====================
# À configurer selon votre fournisseur d'email

SMTP_CONFIG = {
    'server': 'smtp.gmail.com',  # ou smtp.office365.com, smtp.mail.yahoo.com, etc.
    'port': 587,  # 587 pour TLS, 465 pour SSL
    'username': 'votre.email@gmail.com',  # Votre email
    'password': 'votre_mot_de_passe',  # Mot de passe d'application
    'from_email': 'votre.email@gmail.com',
    'from_name': 'Votre Service Voicemail'
}

# Mapping garage -> email client
CLIENT_EMAILS = {
    'Garage Test': 'client@example.com',
    # Ajouter d'autres garages ici :
    # 'Garage Martin': 'martin@example.com',
    # 'Garage Dupont': 'dupont@example.com',
}

RAPPORTS_DIR = "/Users/louisbecker/Desktop/voicemail-assistant/rapports"

# ======================================================


def create_email_body(garage_name, period_name):
    """Créer le corps de l'email"""

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body {{
                font-family: Arial, sans-serif;
                line-height: 1.6;
                color: #333;
            }}
            .container {{
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
            }}
            .header {{
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 30px;
                text-align: center;
                border-radius: 10px;
            }}
            .content {{
                padding: 30px 0;
            }}
            .button {{
                display: inline-block;
                background: #667eea;
                color: white;
                padding: 15px 30px;
                text-decoration: none;
                border-radius: 5px;
                margin: 20px 0;
            }}
            .footer {{
                text-align: center;
                color: #999;
                font-size: 12px;
                margin-top: 30px;
                padding-top: 20px;
                border-top: 1px solid #eee;
            }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>📊 Rapport KPI</h1>
                <p>{period_name}</p>
            </div>

            <div class="content">
                <p>Bonjour,</p>

                <p>Veuillez trouver ci-joint votre rapport KPI pour la période <strong>{period_name}</strong>.</p>

                <p>Ce rapport inclut :</p>
                <ul>
                    <li>📞 Statistiques d'appels (total, taux de réponse, durée moyenne)</li>
                    <li>💬 Analyse des messages vocaux</li>
                    <li>📋 Top des motifs d'appel</li>
                    <li>👥 Nombre d'appelants uniques</li>
                </ul>

                <p>Le rapport est disponible en pièce jointe au format HTML. Vous pouvez l'ouvrir dans votre navigateur ou l'imprimer en PDF.</p>

                <p>Pour toute question concernant ce rapport, n'hésitez pas à nous contacter.</p>

                <p>Cordialement,<br>
                <strong>Votre Service Voicemail</strong></p>
            </div>

            <div class="footer">
                <p>Rapport généré automatiquement le {datetime.now().strftime('%d/%m/%Y à %H:%M')}</p>
                <p>© 2026 Votre Service Voicemail - Tous droits réservés</p>
            </div>
        </div>
    </body>
    </html>
    """

    return html


def send_email_with_attachment(to_email, subject, html_body, attachment_path):
    """Envoyer un email avec pièce jointe"""

    # Créer le message
    msg = MIMEMultipart('alternative')
    msg['From'] = f"{SMTP_CONFIG['from_name']} <{SMTP_CONFIG['from_email']}>"
    msg['To'] = to_email
    msg['Subject'] = subject

    # Corps de l'email en HTML
    msg.attach(MIMEText(html_body, 'html'))

    # Ajouter la pièce jointe
    with open(attachment_path, 'rb') as f:
        part = MIMEBase('application', 'octet-stream')
        part.set_payload(f.read())
        encoders.encode_base64(part)
        part.add_header(
            'Content-Disposition',
            f'attachment; filename={os.path.basename(attachment_path)}'
        )
        msg.attach(part)

    # Envoyer l'email
    try:
        server = smtplib.SMTP(SMTP_CONFIG['server'], SMTP_CONFIG['port'])
        server.starttls()
        server.login(SMTP_CONFIG['username'], SMTP_CONFIG['password'])
        server.send_message(msg)
        server.quit()
        return True, "Email envoyé avec succès"
    except Exception as e:
        return False, f"Erreur : {str(e)}"


def send_reports():
    """Envoyer les rapports à tous les clients"""

    print("\n" + "="*60)
    print("📧 ENVOI DES RAPPORTS PAR EMAIL")
    print("="*60 + "\n")

    if not os.path.exists(RAPPORTS_DIR):
        print(f"❌ Erreur : Le dossier {RAPPORTS_DIR} n'existe pas")
        print("   Veuillez d'abord générer les rapports avec generate_client_reports.py")
        return

    # Vérifier la configuration SMTP
    if 'votre_mot_de_passe' in SMTP_CONFIG['password']:
        print("⚠️  Configuration SMTP non complétée !")
        print("   Veuillez modifier les paramètres dans le script :")
        print("   - SMTP_CONFIG['username']")
        print("   - SMTP_CONFIG['password']")
        print("   - CLIENT_EMAILS")
        print("\n   💡 Pour Gmail, utilisez un 'Mot de passe d'application'")
        print("      https://myaccount.google.com/apppasswords")
        return

    # Compter les envois
    total_sent = 0
    total_failed = 0

    # Pour chaque client
    for garage_id, client_email in CLIENT_EMAILS.items():
        print(f"\n🏢 {garage_id}")
        print("-" * 40)

        # Rapport Semaine
        semaine_file = os.path.join(RAPPORTS_DIR, f"{garage_id.replace(' ', '_')}_Semaine.html")
        if os.path.exists(semaine_file):
            subject = f"📊 Rapport KPI Hebdomadaire - {garage_id}"
            body = create_email_body(garage_id, "Dernière semaine")

            success, message = send_email_with_attachment(
                client_email,
                subject,
                body,
                semaine_file
            )

            if success:
                print(f"✅ Rapport semaine envoyé à {client_email}")
                total_sent += 1
            else:
                print(f"❌ Échec rapport semaine : {message}")
                total_failed += 1
        else:
            print(f"⚠️  Rapport semaine introuvable : {semaine_file}")

        # Rapport Janvier
        janvier_file = os.path.join(RAPPORTS_DIR, f"{garage_id.replace(' ', '_')}_Janvier.html")
        if os.path.exists(janvier_file):
            subject = f"📊 Rapport KPI Janvier 2026 - {garage_id}"
            body = create_email_body(garage_id, "Janvier 2026")

            success, message = send_email_with_attachment(
                client_email,
                subject,
                body,
                janvier_file
            )

            if success:
                print(f"✅ Rapport janvier envoyé à {client_email}")
                total_sent += 1
            else:
                print(f"❌ Échec rapport janvier : {message}")
                total_failed += 1
        else:
            print(f"⚠️  Rapport janvier introuvable : {janvier_file}")

    # Résumé
    print("\n" + "="*60)
    print(f"📊 RÉSUMÉ")
    print(f"✅ Emails envoyés : {total_sent}")
    if total_failed > 0:
        print(f"❌ Échecs : {total_failed}")
    print("="*60 + "\n")


def test_smtp_connection():
    """Tester la connexion SMTP"""
    print("\n🔍 Test de connexion SMTP...")

    try:
        server = smtplib.SMTP(SMTP_CONFIG['server'], SMTP_CONFIG['port'])
        server.starttls()
        server.login(SMTP_CONFIG['username'], SMTP_CONFIG['password'])
        server.quit()
        print("✅ Connexion SMTP réussie !")
        return True
    except Exception as e:
        print(f"❌ Erreur de connexion SMTP : {str(e)}")
        print("\n💡 Conseils :")
        print("   - Vérifiez votre nom d'utilisateur et mot de passe")
        print("   - Pour Gmail, activez l'accès aux applications moins sécurisées")
        print("   - Ou utilisez un mot de passe d'application")
        return False


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        # Mode test : vérifier la connexion SMTP
        test_smtp_connection()
    else:
        # Mode normal : envoyer les rapports
        send_reports()
