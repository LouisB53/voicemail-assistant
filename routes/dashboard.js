import { Router } from "express";
import { requireAuth } from "./auth.js";
import {
  getDashboardCalls,
  getDashboardKpis,
  getUrgentCount,
  getMotifBreakdown,
  getReportKpis,
  markRecalled,
  unmarkRecalled,
  getGarageSettings,
  setGarageSettings,
} from "../db.js";

const router = Router();
router.use(requireAuth);

// GET /api/dashboard — données principales
router.get("/dashboard", (req, res) => {
  const garageId = req.user.garage_id;

  const kpisRaw = getDashboardKpis(garageId);
  const urgent = getUrgentCount(garageId);
  const calls = getDashboardCalls(garageId, 150);
  const motifBreakdown = getMotifBreakdown(garageId);

  const total = kpisRaw?.total ?? 0;
  const withMessage = kpisRaw?.with_message ?? 0;
  const toRecall = kpisRaw?.to_recall ?? 0;

  res.json({
    kpis: {
      total,
      withMessage,
      toRecall,
      urgent,
      taux: total > 0 ? Math.round((withMessage / total) * 100) : 0,
    },
    calls,
    motifBreakdown,
  });
});

// GET /api/reports?period=week|month|quarter|year[&garage=id]
router.get("/reports", (req, res) => {
  const period = ["week", "month", "quarter", "year"].includes(req.query.period)
    ? req.query.period
    : "week";
  const garageId = (req.user.role === 'admin' && req.query.garage)
    ? req.query.garage
    : req.user.garage_id;
  const data = getReportKpis(garageId, period);
  res.json({ period, ...data });
});

// POST /api/calls/:id/recalled — marquer comme rappelé
router.post("/calls/:id/recalled", (req, res) => {
  const callId = parseInt(req.params.id, 10);
  if (isNaN(callId)) return res.status(400).json({ error: "ID invalide." });
  markRecalled(callId, req.user.display_name || req.user.username);
  res.json({ ok: true });
});

// DELETE /api/calls/:id/recalled — annuler le statut rappelé
router.delete("/calls/:id/recalled", (req, res) => {
  const callId = parseInt(req.params.id, 10);
  if (isNaN(callId)) return res.status(400).json({ error: "ID invalide." });
  unmarkRecalled(callId);
  res.json({ ok: true });
});

// GET /api/garage/settings
router.get("/garage/settings", (req, res) => {
  const settings = getGarageSettings(req.user.garage_id);
  res.json(settings);
});

// POST /api/garage/settings
router.post("/garage/settings", (req, res) => {
  const { is_closed, closed_message } = req.body;
  if (typeof is_closed === "undefined") {
    return res.status(400).json({ error: "Champ is_closed requis." });
  }
  setGarageSettings(req.user.garage_id, is_closed, closed_message || "");
  res.json({ ok: true });
});

export default router;
