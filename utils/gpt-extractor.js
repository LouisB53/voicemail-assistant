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
    Tu es un extracteur de données strict pour les messages vocaux de garages automobiles français. Ton seul rôle est d'analyser la transcription fournie et d'en extraire les informations clés dans un format JSON strict.

    Instructions:
    1. Réponds UNIQUEMENT avec l'objet JSON valide.
    2. Pour 'name', essaie d'identifier le nom et prénom. Si douteux ou absent, mets 'inconnu'.
    3. Pour 'motive', donne un résumé concis (max 5 mots). Utilise des termes comme 'révision', 'panne', 'carrosserie', 'pneus'.
    4. Pour 'date_preference', normalise en 'AAAA-MM-JJ' si possible (année par défaut à l'année courante ou suivante), sinon utilise 'jour de la semaine (ex: lundi prochain)', sinon 'pas précisé'.
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