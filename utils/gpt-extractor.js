// utils/gpt-extractor.js (ou gpt-extractor.mjs si tu utilises 'type: module')

import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// Assurez-vous que la clé API est disponible dans l'environnement
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Extrait les informations clés d'une transcription via l'API OpenAI (GPT-3.5-turbo).
 * Utilise le format JSON structuré pour une fiabilité maximale.
 * @param {string} transcript - Le texte transcrit par Whisper.
 * @returns {Promise<object>} Objet contenant les champs extraits.
 */
export async function extractInfoGPT(transcript) {
    if (!transcript) {
        return { name: 'inconnu', motive: 'pas précisé', date_preference: 'pas précisé', is_urgent: false, plate_number: 'inconnu' };
    }

    // Le prompt pour forcer la réponse JSON
    const prompt = `
    Tu es un extracteur de données strict pour les messages vocaux de garages automobiles français. Ton rôle est d'analyser la transcription fournie et d'en extraire les informations clés dans un format JSON strict.

    Instructions:
    1. Réponds UNIQUEMENT avec l'objet JSON valide.
    2. Pour 'name', trouve le nom complet. Si douteux ou absent, utilise 'inconnu'.
    3. Pour 'motive_details', donne un résumé concis (max 5 mots) du besoin exact du client pour l'en-tête de l'email (ex: 'fuite d'huile moteur', 'claquement avant droit', 'devis remplacement pneus').
    4. Pour 'date_preference', si une date est mentionnée, normalise-la au format 'jour de la semaine (JJ-MM-AAAA)'. Si l'année est absente, utilise l'année courante ou l'année suivante si la date est déjà passée. Sinon, mets 'pas précisé'.
    5. Pour 'is_urgent', mets true si l'appel mentionne 'panne', 'bloqué', 'remorquage', ou 'urgent', sinon false.
    6. Pour 'plate_number', recherche le format d'immatriculation française (ex: AA-123-BB). Si absent, mets 'inconnu'.

    Transcription à analyser: """${transcript}"""
    `;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo-1106', // Modèle optimisé pour JSON
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
            motive: result.motive || 'pas précisé',
            date_preference: result.date_preference || 'pas précisé',
            is_urgent: !!result.is_urgent,
            plate_number: result.plate_number || 'inconnu',
        };

    } catch (e) {
        console.error("❌ Erreur d'extraction GPT. Fallback sur les valeurs par défaut.", e.message);
        // En cas d'échec de l'API GPT, on retourne des valeurs sûres.
        return { name: 'inconnu (GPT échec)', motive: 'pas précisé (GPT échec)', date_preference: 'pas précisé (GPT échec)', is_urgent: false, plate_number: 'inconnu' };
    }
}