// Test rapide de la clé API SendGrid
import sgMail from "@sendgrid/mail";
import dotenv from "dotenv";

dotenv.config();

// Configuration SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_SECRET);

async function testSendGrid() {
    console.log("🔍 Test de la clé API SendGrid...\n");

    // Vérifier que la clé existe
    if (!process.env.SENDGRID_API_SECRET) {
        console.error("❌ ERREUR: La variable SENDGRID_API_SECRET n'est pas définie dans .env");
        process.exit(1);
    }

    console.log(`✅ Clé API trouvée: ${process.env.SENDGRID_API_SECRET.substring(0, 20)}...`);

    // Test d'envoi d'email
    try {
        console.log("\n📧 Tentative d'envoi d'un email de test...");

        const msg = {
            to: 'louis.becker0503@gmail.com', // Email de test (BCC_MONITOR)
            from: 'louis.becker0503@gmail.com', // Doit être vérifié dans SendGrid
            subject: '🧪 Test SendGrid - Voicemail Assistant',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2>✅ Test réussi!</h2>
                    <p>Ce message confirme que votre nouvelle clé API SendGrid fonctionne correctement.</p>
                    <p><strong>Date:</strong> ${new Date().toLocaleString('fr-FR')}</p>
                    <hr>
                    <p style="color: #666; font-size: 12px;">
                        Envoyé depuis votre serveur Voicemail Assistant
                    </p>
                </div>
            `
        };

        await sgMail.send(msg);

        console.log("✅ Email de test envoyé avec succès!");
        console.log(`   → Destinataire: ${msg.to}`);
        console.log(`   → Sujet: ${msg.subject}`);
        console.log("\n💡 Vérifiez votre boîte de réception (et le dossier spam si besoin)");
        console.log("\n⚠️  Rappel: Compte gratuit SendGrid = 100 emails/jour");

    } catch (error) {
        console.error("\n❌ ERREUR lors de l'envoi:", error.message);

        if (error.response) {
            console.error("\nDétails de l'erreur:");
            console.error(error.response.body);
        }

        console.log("\n💡 Solutions possibles:");
        console.log("   1. Vérifier que l'email 'from' est vérifié dans SendGrid");
        console.log("   2. Vérifier que la clé API a les permissions d'envoi");
        console.log("   3. Attendre quelques minutes si la clé vient d'être créée");

        process.exit(1);
    }
}

testSendGrid();
