// utils/gpt-extractor.js (Finalisé)

import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// Assurez-vous que la clé API est disponible dans l'environnement
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Extrait les informations clés d'une transcription via l'API OpenAI (GPT-3.5-turbo).
 * @param {string} transcript - Le texte transcrit par Whisper.
 * @returns {Promise<object>} Objet contenant les champs extraits.
 */
export async function extractInfoGPT(transcript) {
    // Liste stricte des légendes (pour le prompt et le fallback)
    const MOTIVE_LEGENDS = [
        'panne', 'carrosserie / accident', 'entretien / révision', 'contrôle technique', 
        'freins', 'pneus / crevaison', 'pare-brise', 'bruit / vibration', 
        'récupération véhicule', 'suivi / état des réparations', 
        'demande de devis / facturation', 'prise de rendez-vous', 
        'modification / annulation de RDV', 'demande d’information', 
        'réservation parking'
    ];

    // Le Fallback par défaut à utiliser en cas d'échec
    const DEFAULT_FALLBACK = { 
        name: 'inconnu (échec analyse)', 
        motive_legend: 'demande d’information', 
        motive_details: 'transcription vide ou invalide', 
        date_preference: 'pas précisé', 
        is_urgent: false, 
        plate_number: 'inconnu' 
    };

    // 💡 VÉRIFICATION DE ROBUSTESSE :
    // Si la transcription est vide ou non significative (suite à un échec Whisper par exemple),
    // on saute l'appel GPT pour économiser des jetons et éviter une analyse inutile.
    if (!transcript || transcript.trim() === "" || transcript.includes("(transcription indisponible)")) {
        console.warn("⚠️ GPT-Extractor : Transcription invalide reçue. Utilisation du fallback.");
        return DEFAULT_FALLBACK;
    }

    // Le prompt mis à jour pour forcer la réponse JSON
    const prompt = `
    Tu es un extracteur de données strict pour les messages vocaux de garages automobiles français. Ton rôle est d'analyser la transcription fournie et d'en extraire les informations clés dans un format JSON strict.

    Instructions:
    1. Réponds UNIQUEMENT avec l'objet JSON valide.
    2. Pour 'name', trouve le nom complet. Si douteux ou absent, utilise 'inconnu'.
    3. Pour 'motive_legend', choisis **strictement** un seul motif dans la liste suivante, sans ajout ni modification : [${MOTIVE_LEGENDS.join(', ')}].
    4. Pour 'motive_details', donne un résumé concis (max 5 mots) du besoin exact du client pour l'en-tête de l'email (ex: 'fuite d'huile moteur', 'claquement avant droit', 'devis remplacement pneus').
    5. Pour 'date_preference', si une date est mentionnée, normalise-la au format 'jour de la semaine (JJ-MM-AAAA)'. Si l'année est absente, utilise l'année courante ou l'année suivante si la date est déjà passée. Sinon, mets 'pas précisé'.
    6. Pour 'is_urgent', mets true si l'appel mentionne 'panne', 'bloqué', 'remorquage', ou 'urgent', sinon false.
    7. Pour 'plate_number', recherche le format d'immatriculation française (ex: AA-123-BB). Si absent, mets 'inconnu'.

    Transcription à analyser: """${transcript}"""
    `;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo-1106',
            messages: [
                { role: "system", content: prompt },
            ],
            response_format: { type: "json_object" },
            temperature: 0.1, 
        });

        const jsonText = response.choices[0].message.content;
        const result = JSON.parse(jsonText);

        // Mappage des résultats pour garantir le format de sortie
        return {
            name: result.name || 'inconnu',
            motive_legend: result.motive_legend || 'demande d’information',
            motive_details: result.motive_details || 'pas précisé', 
            date_preference: result.date_preference || 'pas précisé',
            is_urgent: !!result.is_urgent,
            plate_number: result.plate_number || 'inconnu',
        };

    } catch (e) {
        console.error("❌ Erreur d'extraction GPT (API, parsing JSON, etc.):", e.message);
        // Retourne le fallback complet en cas d'échec de l'API
        return { ...DEFAULT_FALLBACK, motive_details: `Échec API GPT: ${e.message.substring(0, 30)}...` };
    }
}