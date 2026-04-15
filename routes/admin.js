import { Router } from "express";
import { requireAuth } from "./auth.js";
import {
  getAdminCalls,
  getAdminKpis,
  getGaragesSummary,
  getServerErrors,
  countUnresolvedErrors,
  resolveServerError,
} from "../db.js";
import { GARAGES } from "../utils/garages.js";

const router = Router();

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Accès refusé." });
  }
  next();
}

router.use(requireAuth);
router.use(requireAdmin);

// GET /api/admin/garages
router.get("/garages", (req, res) => {
  const garages = Object.values(GARAGES).map(g => ({ id: g.name, name: g.name }));
  res.json(garages);
});

// GET /api/admin/dashboard?garage=all|garageName
router.get("/dashboard", (req, res) => {
  const garage = (!req.query.garage || req.query.garage === "all") ? null : req.query.garage;

  if (!garage) {
    const summary  = getGaragesSummary();
    const calls    = getAdminCalls(null, 300);
    const kpis     = getAdminKpis(null);
    res.json({ mode: "all", summary, calls, kpis });
  } else {
    const kpis  = getAdminKpis(garage);
    const calls = getAdminCalls(garage, 150);
    res.json({ mode: "single", garage, kpis, calls });
  }
});

// GET /api/admin/errors?filter=unresolved|all
router.get("/errors", (req, res) => {
  const onlyUnresolved = req.query.filter !== "all";
  res.json({
    errors: getServerErrors(onlyUnresolved),
    unresolved: countUnresolvedErrors(),
  });
});

// POST /api/admin/errors/:id/resolve
router.post("/errors/:id/resolve", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "ID invalide." });
  resolveServerError(id, req.user.display_name || req.user.username);
  res.json({ ok: true });
});

export default router;
