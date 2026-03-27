#!/usr/bin/env node
/**
 * Script de génération et envoi automatique des rapports hebdomadaires
 * Exécuté tous les vendredis à 17h via Azure WebJob
 *
 * Utilise l'infrastructure existante :
 * - BDD SQLite (voicemail.db)
 * - SendGrid pour l'envoi des emails
 * - Structure HTML similaire aux rapports actuels
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import sgMail from '@sendgrid/mail';
import { DateTime } from 'luxon';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import PDFDocument from 'pdfkit';
import { readFileSync, unlinkSync, mkdirSync, createWriteStream } from 'fs';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'voicemail.db');
const SENDGRID_API_SECRET = process.env.SENDGRID_API_SECRET;
const BCC_MONITOR = 'louis.becker0503@gmail.com';

// Charger la configuration des garages (même logique que server.js)
let GARAGES;
const configString = process.env.GARAGES_CONFIG;

if (configString) {
  try {
    GARAGES = JSON.parse(configString);
    console.log('✅ Configuration des garages chargée depuis GARAGES_CONFIG');
  } catch (error) {
    console.error('❌ Erreur parsing GARAGES_CONFIG, fallback sur garages.json');
    GARAGES = JSON.parse(fs.readFileSync(join(__dirname, '..', 'garages.json'), 'utf-8'));
  }
} else {
  console.warn('⚠️  GARAGES_CONFIG non trouvée, utilisation de garages.json');
  GARAGES = JSON.parse(fs.readFileSync(join(__dirname, '..', 'garages.json'), 'utf-8'));
}

// Créer un mapping garage_name → to_email / from_email depuis la config
const GARAGE_EMAILS = {};
const GARAGE_FROM_EMAILS = {};
Object.values(GARAGES).forEach(garage => {
  GARAGE_EMAILS[garage.name] = garage.to_email;
  GARAGE_FROM_EMAILS[garage.name] = garage.from_email;
});

console.log('📧 Emails configurés pour:', Object.keys(GARAGE_EMAILS).join(', '));

// Initialiser SendGrid
if (SENDGRID_API_SECRET) {
  sgMail.setApiKey(SENDGRID_API_SECRET);
} else {
  console.error('❌ SENDGRID_API_SECRET non défini');
  process.exit(1);
}

/**
 * Parser le champ analysis JSON
 */
function parseAnalysis(analysisStr) {
  try {
    return analysisStr ? JSON.parse(analysisStr) : {};
  } catch (error) {
    return {};
  }
}

/**
 * Calculer les KPIs pour un garage sur une période
 * Note: Le système capte UNIQUEMENT les appels manqués (répondeur intelligent)
 */
function getKPIsForPeriod(db, garageId, startDate, endDate) {
  // Récupérer les appels manqués
  const calls = db.prepare(`
    SELECT call_sid, from_number, has_message, created_at
    FROM calls
    WHERE garage_id = ?
    AND datetime(created_at) BETWEEN datetime(?) AND datetime(?)
  `).all(garageId, startDate, endDate);

  // Récupérer les messages avec analyse
  const messages = db.prepare(`
    SELECT call_sid, from_number, transcript, analysis, created_at
    FROM messages
    WHERE garage_id = ?
    AND datetime(created_at) BETWEEN datetime(?) AND datetime(?)
  `).all(garageId, startDate, endDate);

  // KPI 1: Nombre d'appels manqués
  const appels_manques = calls.length;

  // KPI 2: Nombre de messages laissés
  const messages_laisses = calls.filter(c => c.has_message === 1).length;

  // KPI 3: Taux d'appels manqués avec message
  const taux_message = appels_manques > 0
    ? Math.round((messages_laisses / appels_manques) * 1000) / 10
    : 0;

  // KPI 4: Appelants uniques
  const appelants_uniques = new Set(calls.map(c => c.from_number).filter(Boolean)).size;

  // KPI 5: Liste des motifs d'appels avec comptage
  const motiveCounter = {};
  messages.forEach(msg => {
    const analysis = parseAnalysis(msg.analysis);
    if (analysis && analysis.motive_legend) {
      const motif = analysis.motive_legend;
      motiveCounter[motif] = (motiveCounter[motif] || 0) + 1;
    }
  });

  // Trier les motifs par nombre d'occurrences (du plus fréquent au moins fréquent)
  const motifs_liste = Object.entries(motiveCounter)
    .sort((a, b) => b[1] - a[1])
    .map(([motif, count]) => ({ motif, count }));

  return {
    appels_manques,
    messages_laisses,
    taux_message,
    appelants_uniques,
    motifs_liste,
  };
}

/**
 * @deprecated Remplacé par generatePDF via PDFKit
 * Générer le HTML du rapport
 */
function generateReportHTML(kpis, garageName, periodName, startDate, endDate) {
  const now = DateTime.now().setZone('Europe/Paris');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rapport Hebdomadaire - ${garageName}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 40px 20px;
            min-height: 100vh;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        .header h2 {
            font-size: 1.5em;
            font-weight: 300;
            opacity: 0.9;
        }
        .period-badge {
            background: rgba(255,255,255,0.2);
            padding: 12px 24px;
            border-radius: 25px;
            display: inline-block;
            margin-top: 20px;
            font-size: 1.1em;
        }
        .content {
            padding: 40px;
        }
        .stat-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .stat-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 25px;
            border-radius: 15px;
            text-align: center;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }
        .stat-card .value {
            font-size: 2.5em;
            font-weight: bold;
            margin: 10px 0;
        }
        .stat-card .label {
            font-size: 0.9em;
            opacity: 0.9;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .section {
            margin-bottom: 40px;
        }
        .section-title {
            font-size: 1.5em;
            color: #2d3748;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 3px solid #667eea;
            display: flex;
            align-items: center;
        }
        .section-title .icon {
            font-size: 1.2em;
            margin-right: 10px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background: white;
        }
        tr {
            border-bottom: 1px solid #e2e8f0;
            transition: background 0.2s;
        }
        tr:hover {
            background: #f7fafc;
        }
        td {
            padding: 16px;
            font-size: 1em;
        }
        td:first-child {
            color: #4a5568;
            font-weight: 500;
        }
        td:last-child {
            text-align: right;
            font-weight: bold;
            color: #667eea;
            font-size: 1.1em;
        }
        .highlight {
            background: linear-gradient(to right, #fef5e7, transparent);
        }
        .highlight td:last-child {
            color: #764ba2;
            font-size: 1.3em;
        }
        .motif-list {
            list-style: none;
        }
        .motif-item {
            background: #f7fafc;
            padding: 15px 20px;
            margin: 10px 0;
            border-radius: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-left: 4px solid #667eea;
        }
        .motif-rank {
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
        }
        .motif-name {
            flex: 1;
            color: #2d3748;
            font-weight: 500;
        }
        .motif-count {
            background: #764ba2;
            color: white;
            padding: 5px 15px;
            border-radius: 20px;
            font-weight: bold;
        }
        .footer {
            text-align: center;
            padding: 30px;
            color: #718096;
            background: #f7fafc;
            font-size: 0.9em;
        }
        @media print {
            body { background: white; padding: 0; }
            .container { box-shadow: none; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 Rapport Hebdomadaire</h1>
            <h2>${garageName}</h2>
            <div class="period-badge">📅 ${periodName}</div>
        </div>

        <div class="content">
            <!-- Statistiques principales - 4 KPIs -->
            <div class="stat-grid">
                <div class="stat-card">
                    <div class="label">Appels Manqués</div>
                    <div class="value">${kpis.appels_manques}</div>
                </div>
                <div class="stat-card">
                    <div class="label">Messages Laissés</div>
                    <div class="value">${kpis.messages_laisses}</div>
                </div>
                <div class="stat-card">
                    <div class="label">Taux avec Message</div>
                    <div class="value">${kpis.taux_message}%</div>
                </div>
                <div class="stat-card">
                    <div class="label">Appelants Uniques</div>
                    <div class="value">${kpis.appelants_uniques}</div>
                </div>
            </div>

            ${kpis.motifs_liste.length > 0 ? `
            <!-- Section Motifs d'appels -->
            <div class="section">
                <div class="section-title">
                    <span class="icon">📋</span>
                    Motifs d'Appels
                </div>
                <ul class="motif-list">
                    ${kpis.motifs_liste.map((item, i) => `
                    <li class="motif-item">
                        <div class="motif-rank">${i + 1}</div>
                        <div class="motif-name">${item.motif.charAt(0).toUpperCase() + item.motif.slice(1)}</div>
                        <div class="motif-count">${item.count}</div>
                    </li>
                    `).join('')}
                </ul>
            </div>
            ` : `
            <!-- Aucun message -->
            <div class="section">
                <div class="section-title">
                    <span class="icon">📋</span>
                    Motifs d'Appels
                </div>
                <p style="color: #718096; text-align: center; padding: 40px;">
                    Aucun message vocal analysé sur cette période.
                </p>
            </div>
            `}
        </div>

        <div class="footer">
            Rapport généré le ${now.toFormat('dd/MM/yyyy à HH:mm')}<br>
            Période analysée : ${startDate} au ${endDate}<br>
            <strong>PitCall</strong> - Système de gestion des messages vocaux
        </div>
    </div>
</body>
</html>`;
}

/**
 * Générer un PDF avec PDFKit (pur Node.js, sans Chrome)
 */
async function generatePDF(kpis, garageName, periodName, startDate, endDate, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const stream = createWriteStream(outputPath);

      doc.on('error', reject);
      stream.on('error', reject);
      stream.on('finish', () => resolve({ success: true }));

      doc.pipe(stream);

      const PURPLE      = '#667eea';
      const PURPLE_DARK = '#764ba2';
      const PURPLE_SOFT = '#8b9ff4';
      const WHITE       = '#ffffff';
      const DARK        = '#2d3748';
      const GRAY        = '#718096';
      const LIGHT_BG    = '#f7fafc';

      const W  = doc.page.width;   // 595.28
      const M  = 40;               // marge
      const CW = W - M * 2;        // largeur contenu

      // HEADER
      doc.rect(0, 0, W, 170).fill(PURPLE);

      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(26)
         .text('Rapport Hebdomadaire', M, 40, { width: CW, align: 'center' });

      doc.font('Helvetica').fontSize(16)
         .text(garageName, M, 80, { width: CW, align: 'center' });

      const bW = 220, bH = 26, bX = (W - 220) / 2;
      doc.rect(bX, 117, bW, bH).fill(PURPLE_SOFT);
      doc.fillColor(WHITE).font('Helvetica').fontSize(10)
         .text(`Periode : ${periodName}`, bX, 124, { width: bW, align: 'center' });

      // KPI CARDS
      const cardTop = 195;
      const cardH   = 90;
      const gap     = 10;
      const cardW   = (CW - gap * 3) / 4;

      const kpiItems = [
        { label: 'APPELS MANQUES',    value: kpis.appels_manques },
        { label: 'MESSAGES LAISSES',  value: kpis.messages_laisses },
        { label: 'TAUX AVEC MESSAGE', value: `${kpis.taux_message}%` },
        { label: 'APPELANTS UNIQUES', value: kpis.appelants_uniques },
      ];

      kpiItems.forEach((item, i) => {
        const x = M + i * (cardW + gap);
        doc.rect(x, cardTop, cardW, cardH).fill(PURPLE);
        doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(28)
           .text(String(item.value), x, cardTop + 16, { width: cardW, align: 'center' });
        doc.font('Helvetica').fontSize(7)
           .text(item.label, x, cardTop + 58, { width: cardW, align: 'center' });
      });

      // MOTIFS SECTION
      let y = cardTop + cardH + 30;

      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(14)
         .text("Motifs d'Appels", M, y);
      y += 22;

      doc.rect(M, y, CW, 2).fill(PURPLE);
      y += 14;

      if (kpis.motifs_liste.length > 0) {
        kpis.motifs_liste.forEach((item, i) => {
          const rowH = 36;
          doc.rect(M, y, CW, rowH).fill(i % 2 === 0 ? LIGHT_BG : WHITE);

          // Cercle rang
          doc.circle(M + 20, y + rowH / 2, 13).fill(PURPLE);
          doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(10)
             .text(String(i + 1), M + 14, y + rowH / 2 - 6, { width: 12, align: 'center' });

          // Nom du motif
          const motifName = item.motif.charAt(0).toUpperCase() + item.motif.slice(1);
          doc.fillColor(DARK).font('Helvetica').fontSize(11)
             .text(motifName, M + 42, y + rowH / 2 - 6, { width: CW - 90 });

          // Badge count
          const cW = 40;
          doc.rect(M + CW - cW, y + 8, cW, 20).fill(PURPLE_DARK);
          doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(10)
             .text(String(item.count), M + CW - cW, y + 13, { width: cW, align: 'center' });

          y += rowH;
        });
      } else {
        doc.rect(M, y, CW, 50).fill(LIGHT_BG);
        doc.fillColor(GRAY).font('Helvetica').fontSize(11)
           .text('Aucun message vocal analyse sur cette periode.', M, y + 18, { width: CW, align: 'center' });
        y += 50;
      }

      // FOOTER
      y += 30;
      doc.rect(0, y, W, 80).fill(LIGHT_BG);

      const now = DateTime.now().setZone('Europe/Paris');
      doc.fillColor(GRAY).font('Helvetica').fontSize(9)
         .text(`Rapport genere le ${now.toFormat('dd/MM/yyyy a HH:mm')}`, M, y + 14, { width: CW, align: 'center' });
      doc.text(`Periode analysee : ${startDate} au ${endDate}`, M, y + 28, { width: CW, align: 'center' });
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(9)
         .text('PitCall - Systeme de gestion des messages vocaux', M, y + 42, { width: CW, align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Envoyer le rapport par email avec PDF en pièce jointe
 */
async function sendReport(garageName, clientEmail, fromEmail, pdfPath, periodName, kpis) {
  // Lire le PDF
  const pdfContent = readFileSync(pdfPath);
  const pdfBase64 = pdfContent.toString('base64');

  // Construire la liste des top 3 motifs pour le texte
  const topMotifsText = kpis.motifs_liste.slice(0, 3).map((item, i) =>
    `${i + 1}. ${item.motif.charAt(0).toUpperCase() + item.motif.slice(1)} : ${item.count}`
  ).join('\n');

  const msg = {
    to: clientEmail,
    from: fromEmail,
    bcc: BCC_MONITOR,
    subject: `📊 Rapport Hebdomadaire - ${garageName} - ${periodName}`,
    text: `Bonsoir,

Voici le récapitulatif de nos appels manqués cette semaine qui ont pu être récupérés grâce à PitCall.

- ${kpis.appels_manques} appels manqués
- ${kpis.messages_laisses} messages retranscrits et qualifiés par email

${kpis.motifs_liste.length > 0 ? `Principaux motifs :\n${topMotifsText}` : 'Aucun motif détecté cette semaine.'}

Bonne fin de semaine !

Bien à vous,
Louis Becker
Fondateur de PitCall`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#222; font-size:15px; max-width:600px;">
        <p>Bonsoir,</p>
        <p>Voici le récapitulatif de nos appels manqués cette semaine qui ont pu être récupérés grâce à <strong>PitCall</strong>.</p>

        <p style="margin:0 0 4px 0;"><strong>Appels manqués :</strong> ${kpis.appels_manques}</p>
        <p style="margin:0 0 4px 0;"><strong>Messages retranscrits et qualifiés :</strong> ${kpis.messages_laisses}</p>

        ${kpis.motifs_liste.length > 0 ? `
        <p style="margin:14px 0 4px 0;"><strong>Principaux motifs :</strong></p>
        ${kpis.motifs_liste.slice(0, 3).map((item, i) =>
          `<p style="margin:0 0 4px 0;">${i + 1}. <strong>${item.motif.charAt(0).toUpperCase() + item.motif.slice(1)}</strong> : ${item.count}</p>`
        ).join('')}
        ` : ''}

        <p style="margin-top:20px;">Bonne fin de semaine !</p>
        <p style="margin-top:20px;">Bien à vous,<br><strong>Louis Becker</strong><br>Fondateur de PitCall</p>
      </div>
    `,
    attachments: [
      {
        content: pdfBase64,
        filename: `Rapport_${garageName.replace(/\s+/g, '_')}_${periodName.replace(/\s+/g, '_')}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment',
      },
    ],
  };

  try {
    await sgMail.send(msg);
    return { success: true, messageId: msg.messageId };
  } catch (error) {
    console.error('Erreur SendGrid:', error);
    if (error.response) {
      console.error('Détails:', error.response.body);
    }
    return { success: false, error: error.message };
  }
}

/**
 * Fonction principale
 */
async function generateAndSendWeeklyReports() {
  console.log('='.repeat(60));
  console.log('📊 GÉNÉRATION DES RAPPORTS HEBDOMADAIRES');
  console.log('='.repeat(60));
  console.log(`Date/heure: ${DateTime.now().setZone('Europe/Paris').toFormat('dd/MM/yyyy HH:mm')}`);
  console.log(`Base de données: ${DB_PATH}`);
  console.log('='.repeat(60) + '\n');

  // Connexion à la base de données
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    console.log('✅ Connexion à la base de données réussie\n');
  } catch (error) {
    console.error('❌ Erreur de connexion à la base de données:', error.message);
    process.exit(1);
  }

  // Calculer la période (7 derniers jours)
  const now = DateTime.now().setZone('Europe/Paris');
  const endDate = now.toFormat('yyyy-MM-dd HH:mm:ss');
  const startDate = now.minus({ days: 7 }).toFormat('yyyy-MM-dd HH:mm:ss');
  const periodName = `${now.minus({ days: 7 }).toFormat('dd/MM')} - ${now.toFormat('dd/MM/yyyy')}`;

  console.log(`📅 Période: ${periodName}`);
  console.log(`   Du: ${startDate}`);
  console.log(`   Au: ${endDate}\n`);

  // Récupérer la liste des garages
  const garages = db.prepare(`
    SELECT DISTINCT garage_id
    FROM calls
    WHERE garage_id IS NOT NULL
  `).all().map(row => row.garage_id);

  console.log(`🏢 Garages trouvés: ${garages.length}`);
  garages.forEach(g => console.log(`   - ${g}`));
  console.log('');

  // Créer un dossier temporaire pour les PDFs
  const tempDir = join(__dirname, '..', 'temp_reports');
  try {
    mkdirSync(tempDir, { recursive: true });
  } catch (error) {
    // Le dossier existe déjà, pas de problème
  }

  // Traiter chaque garage
  let totalSent = 0;
  let totalFailed = 0;

  for (const garageId of garages) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🏢 ${garageId}`);
    console.log('='.repeat(60));

    // Vérifier si on a un email configuré pour ce garage
    const clientEmail = GARAGE_EMAILS[garageId];
    const fromEmail = GARAGE_FROM_EMAILS[garageId];
    if (!clientEmail || !fromEmail) {
      console.log(`⚠️  Pas d'email configuré pour ${garageId}`);
      totalFailed++;
      continue;
    }

    // Calculer les KPIs
    console.log('📊 Calcul des KPIs...');
    const kpis = getKPIsForPeriod(db, garageId, startDate, endDate);
    console.log(`   Appels manqués: ${kpis.appels_manques}`);
    console.log(`   Messages laissés: ${kpis.messages_laisses}`);
    console.log(`   Taux avec message: ${kpis.taux_message}%`);
    console.log(`   Appelants uniques: ${kpis.appelants_uniques}`);

    // Vérifier s'il y a des données
    if (kpis.appels_manques === 0) {
      console.log('⚠️  Aucun appel manqué sur cette période, rapport non envoyé');
      continue;
    }

    // Générer le PDF
    console.log('📄 Génération du PDF...');
    const pdfFilename = `Rapport_${garageId.replace(/\s+/g, '_')}_${now.toFormat('yyyy-MM-dd')}.pdf`;
    const pdfPath = join(tempDir, pdfFilename);

    const pdfResult = await generatePDF(kpis, garageId, periodName, startDate, endDate, pdfPath);
    if (!pdfResult.success) {
      console.log(`❌ Échec de génération PDF: ${pdfResult.error}`);
      totalFailed++;
      continue;
    }

    // Envoyer l'email avec le PDF
    console.log(`📧 Envoi du rapport à ${clientEmail}...`);
    const result = await sendReport(garageId, clientEmail, fromEmail, pdfPath, periodName, kpis);

    if (result.success) {
      console.log(`✅ Rapport envoyé avec succès`);
      totalSent++;
    } else {
      console.log(`❌ Échec de l'envoi: ${result.error}`);
      totalFailed++;
    }

    // Nettoyer le fichier PDF temporaire
    try {
      unlinkSync(pdfPath);
      console.log('   🗑️  Fichier temporaire supprimé');
    } catch (error) {
      console.log('   ⚠️  Impossible de supprimer le fichier temporaire');
    }
  }

  // Fermer la connexion
  db.close();

  // Résumé
  console.log('\n' + '='.repeat(60));
  console.log('📊 RÉSUMÉ');
  console.log('='.repeat(60));
  console.log(`✅ Rapports envoyés: ${totalSent}`);
  console.log(`❌ Échecs: ${totalFailed}`);
  console.log(`📧 Total garages traités: ${garages.length}`);
  console.log('='.repeat(60) + '\n');

  process.exit(totalFailed > 0 ? 1 : 0);
}

// Exécuter
generateAndSendWeeklyReports().catch(error => {
  console.error('❌ Erreur fatale:', error);
  process.exit(1);
});
