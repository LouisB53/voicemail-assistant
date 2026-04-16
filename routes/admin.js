import { Router } from "express";
import { requireAuth } from "./auth.js";
import {
  getAdminCalls,
  getAdminKpis,
  getGaragesSummary,
  getServerErrors,
  countUnresolvedErrors,
  resolveServerError,
  exportContacts,
} from "../db.js";
import { GARAGES } from "../utils/garages.js";

function toCSV(rows, columns) {
  const esc = v => {
    const s = String(v ?? '').replace(/"/g, '""');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s;
  };
  const header = columns.map(c => c.label).join(',');
  const lines = rows.map(row => columns.map(c => esc(c.value(row))).join(','));
  return [header, ...lines].join('\n');
}

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

// GET /api/admin/export/calls?garage=all|name
router.get("/export/calls", (req, res) => {
  const garage = (!req.query.garage || req.query.garage === "all") ? null : req.query.garage;
  const calls = getAdminCalls(garage, 10000);
  const columns = [
    { label: "Date",         value: r => r.created_at },
    { label: "Garage",       value: r => r.garage_id },
    { label: "Numéro",       value: r => r.from_number },
    { label: "Contact",      value: r => r.contact_name || '' },
    { label: "Source",       value: r => r.contact_source || '' },
    { label: "Motif",        value: r => r.analysis?.motive_legend || '' },
    { label: "Détail",       value: r => r.analysis?.motive_details || '' },
    { label: "Immat",        value: r => r.analysis?.plate_number && r.analysis.plate_number !== 'unknown' ? r.analysis.plate_number : '' },
    { label: "Urgent",       value: r => r.analysis?.is_urgent ? 'Oui' : 'Non' },
    { label: "Rappelé",      value: r => r.recalled_at ? 'Oui' : (r.has_message ? 'Non' : '') },
    { label: "Rappelé par",  value: r => r.recalled_by || '' },
    { label: "Rappelé le",   value: r => r.recalled_at || '' },
  ];
  const filename = garage ? `appels_${garage.replace(/\s+/g, '_')}.csv` : 'appels_tous_garages.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + toCSV(calls, columns)); // BOM UTF-8 pour Excel
});

// GET /api/admin/export/contacts?garage=all|name
router.get("/export/contacts", (req, res) => {
  const garage = (!req.query.garage || req.query.garage === "all") ? null : req.query.garage;
  const contacts = exportContacts(garage);
  const columns = [
    { label: "Garage",       value: r => r.garage_id },
    { label: "Nom",          value: r => r.name },
    { label: "Numéro",       value: r => r.phone_number },
    { label: "Source",       value: r => r.source },
    { label: "Dernier appel",value: r => r.last_call_at || '' },
    { label: "Ajouté le",    value: r => r.created_at },
  ];
  const filename = garage ? `contacts_${garage.replace(/\s+/g, '_')}.csv` : 'contacts_tous_garages.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + toCSV(contacts, columns));
});

export default router;
