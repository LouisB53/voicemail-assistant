import { Router } from "express";
import { requireAuth } from "./auth.js";
import { getContacts, addContact, updateContact, deleteContact, validateContact } from "../db.js";

const router = Router();
router.use(requireAuth);

// GET /api/contacts
router.get("/contacts", (req, res) => {
  const garageId = (req.user.role === 'admin' && req.query.garage)
    ? req.query.garage
    : req.user.garage_id;
  const contacts = getContacts(garageId);
  res.json(contacts);
});

// POST /api/contacts
router.post("/contacts", (req, res) => {
  const { name, phone_number } = req.body;
  if (!name?.trim() || !phone_number?.trim()) {
    return res.status(400).json({ error: "Nom et numéro requis." });
  }
  try {
    addContact(req.user.garage_id, phone_number.trim(), name.trim());
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "Ce numéro existe déjà dans vos contacts." });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/contacts/:id
router.put("/contacts/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, phone_number } = req.body;
  if (!name?.trim() || !phone_number?.trim()) {
    return res.status(400).json({ error: "Nom et numéro requis." });
  }
  updateContact(id, req.user.garage_id, name.trim(), phone_number.trim());
  res.json({ ok: true });
});

// POST /api/contacts/:id/validate — passe un contact auto en manuel
router.post("/contacts/:id/validate", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "ID invalide." });
  validateContact(id, req.user.garage_id);
  res.json({ ok: true });
});

// DELETE /api/contacts/:id
router.delete("/contacts/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  deleteContact(id, req.user.garage_id);
  res.json({ ok: true });
});

export default router;
