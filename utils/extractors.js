// utils/extractors.js

// ---------- Utils ----------
export function normalizePhone(num) {
  if (!num) return "inconnu";
  const n = String(num).replace(/[^\d+]/g, "");
  if (n.startsWith("+33")) return n;
  if (n.startsWith("0")) return "+33" + n.slice(1);
  return n || "inconnu";
}

export function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- Extraction ----------
export function extractInfoFr(transcript) {
  if (!transcript) return { cause: "pas précisé", date: "pas précisé" };
  const t = transcript.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

  const rules = [
    { k: ["panne", "ne demarre", "ne démarre", "bloqué", "voyant rouge", "probleme moteur"], v: "panne" },
    { k: ["accident", "choc", "endommagée", "sinistre"], v: "carrosserie / accident" },
    { k: ["vidange", "huile", "revision", "révision", "filtre", "entretien"], v: "entretien / révision" },
    { k: ["controle technique", "contrôle technique", "ct"], v: "contrôle technique" },
    { k: ["frein", "plaquette", "disque"], v: "freins" },
    { k: ["pneu", "pneus", "crevaison", "roue"], v: "pneus / crevaison" },
    { k: ["pare-brise", "vitre"], v: "pare-brise" },
    { k: ["bruit", "vibration", "claquement"], v: "bruit / vibration" },
    { k: ["recuperer", "récupérer", "voiture prête", "je passe la chercher"], v: "récupération véhicule" },
    { k: ["suivi", "statut", "fini", "réparée"], v: "suivi / état des réparations" },
    { k: ["devis", "prix", "facture"], v: "demande de devis / facturation" },
    { k: ["rendez-vous", "rdv", "prendre rdv", "venir au garage"], v: "prise de rendez-vous" },
    { k: ["annuler", "deplacer", "reporter"], v: "modification / annulation de RDV" },
    { k: ["information", "renseignement", "question", "je voulais savoir"], v: "demande d’information" },
  ];

  let cause = "pas précisé";
  for (const r of rules) {
    if (r.k.some(k => t.includes(k))) {
      cause = r.v;
      break;
    }
  }

  const now = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  const parts = [];

  if (/\baujourd.?hui\b/.test(t)) parts.push(`${iso(now)} (aujourd’hui)`);
  else if (/\bdemain\b/.test(t)) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() + 1);
    parts.push(`${iso(d)} (demain)`);
  }

  const date = parts[0] || "pas précisé";
  return { cause, date };
}

export function extractNameFr(transcript) {
  if (!transcript) return "pas précisé";
  const text = transcript.trim();
  const patterns = [
    /je m[' ’]?appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,50})/gi,
    /mon nom est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,50})/gi,
    /moi c['’]?est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,50})/gi,
    /je suis\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,50})/gi,
  ];

  const invalidStarts = /^(Merci|Bonjour|Bonsoir|Oui|Non|Je|Le|La)\b/i;

  for (const re of patterns) {
    const match = re.exec(text);
    if (match) {
      let name = match[1].split(/[,.!?\n]/)[0].trim();
      name = name.split(/\s+/).slice(0, 2).join(" ");
      name = name.replace(/\b([A-Za-zÀ-ÖØ-öø-ÿ])/g, c => c.toUpperCase());
      if (!invalidStarts.test(name)) return name;
    }
  }
  return "pas précisé";
}

export function detectPriority(t = "") {
  const L = t.toLowerCase();
  const urgent = /panne|urgent|bloqué|dépanneuse/.test(L);
  const rentable = /pare[-\s]?brise|carrosserie|vitre/.test(L);
  const pickup = /récupérer|venir.*chercher|prête/.test(L);
  const plate = (L.match(/\b([a-z]{2}-\d{3}-[a-z]{2})\b/i) || [null, null])[1];
  return { urgent, rentable, pickup, plate: plate ? plate.toUpperCase() : null };
}
