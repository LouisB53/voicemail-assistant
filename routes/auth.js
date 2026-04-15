import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";
import { getUserByUsername, getUserById, updateUsername, updatePassword } from "../db.js";
import { getGarageByName } from "../utils/garages.js";

sgMail.setApiKey(process.env.SENDGRID_API_SECRET);

// Tokens de réinitialisation en mémoire : token → { userId, expires }
const resetTokens = new Map();

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "changeme-jwt-secret";
const TOKEN_EXPIRY = "7d";

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Identifiant et mot de passe requis." });
  }

  const user = getUserByUsername(username.trim());
  if (!user) {
    return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
  }

  const token = jwt.sign(
    { id: user.id, garage_id: user.garage_id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  res.json({
    token,
    user: { id: user.id, garage_id: user.garage_id, username: user.username, display_name: user.display_name, role: user.role }
  });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/forgot-password — envoyer un lien de réinitialisation
router.post("/forgot-password", async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Identifiant requis." });

  const user = getUserByUsername(username.trim());
  // Toujours répondre OK pour ne pas révéler si un compte existe
  if (!user) return res.json({ ok: true });

  const garage = getGarageByName(user.garage_id);
  if (!garage?.to_email) return res.json({ ok: true });

  const token = crypto.randomBytes(32).toString("hex");
  resetTokens.set(token, { userId: user.id, expires: Date.now() + 30 * 60 * 1000 });

  const resetUrl = `${process.env.PUBLIC_SERVER_URL || "http://localhost:3000"}/reset-password.html?token=${token}`;

  try {
    await sgMail.send({
      to: garage.to_email,
      from: garage.from_email,
      subject: "PitCall — Réinitialisation de votre mot de passe",
      html: `
        <p>Bonjour,</p>
        <p>Une demande de réinitialisation de mot de passe a été effectuée pour votre compte <strong>${user.username}</strong>.</p>
        <p><a href="${resetUrl}" style="background:#1d4ed8;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin:12px 0;">Réinitialiser mon mot de passe</a></p>
        <p style="color:#737373;font-size:13px;">Ce lien est valable 30 minutes. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
        <p style="color:#737373;font-size:13px;">— L'équipe PitCall</p>
      `,
    });
  } catch (err) {
    console.error("Erreur envoi email reset:", err.message);
  }

  res.json({ ok: true });
});

// POST /api/auth/reset-password — réinitialiser le mot de passe avec le token
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: "Données manquantes." });
  if (newPassword.length < 8) return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères." });

  const entry = resetTokens.get(token);
  if (!entry) return res.status(400).json({ error: "Lien invalide ou déjà utilisé." });
  if (Date.now() > entry.expires) {
    resetTokens.delete(token);
    return res.status(400).json({ error: "Lien expiré. Faites une nouvelle demande." });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  updatePassword(entry.userId, hash);
  resetTokens.delete(token);

  res.json({ ok: true });
});

// POST /api/auth/credentials — modifier identifiant et/ou mot de passe
router.post("/credentials", requireAuth, async (req, res) => {
  const { newUsername, newPassword } = req.body;
  if (!newUsername && !newPassword) {
    return res.status(400).json({ error: "Aucune modification fournie." });
  }
  if (newUsername && newUsername.trim().length < 3) {
    return res.status(400).json({ error: "L'identifiant doit faire au moins 3 caractères." });
  }
  if (newPassword && newPassword.length < 8) {
    return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères." });
  }
  try {
    if (newUsername && newUsername.trim() !== req.user.username) {
      const existing = getUserByUsername(newUsername.trim());
      if (existing) return res.status(409).json({ error: "Cet identifiant est déjà utilisé." });
      updateUsername(req.user.id, newUsername.trim());
    }
    if (newPassword) {
      const hash = await bcrypt.hash(newPassword, 12);
      updatePassword(req.user.id, hash);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la mise à jour." });
  }
});

// Middleware exporté pour les autres routes
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Non authentifié." });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getUserById(payload.id);
    if (!user) return res.status(401).json({ error: "Utilisateur introuvable." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Token invalide ou expiré." });
  }
}

export default router;
