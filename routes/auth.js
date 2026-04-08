import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getUserByUsername, getUserById } from "../db.js";

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
    { id: user.id, garage_id: user.garage_id, username: user.username },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  res.json({
    token,
    user: { id: user.id, garage_id: user.garage_id, username: user.username, display_name: user.display_name }
  });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
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
