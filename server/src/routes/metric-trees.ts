import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { metricTreeService } from "../services/metric-tree.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

/**
 * Metric-tree API (POS-168). Exposes the VAT companion metric tree for a company/week.
 *
 * GET /api/companies/:companyId/metric-trees[?weekStart=<ISO>]
 *   Returns the current week's metric tree, the previous-week baseline, and any
 *   week-over-week band-breach alerts. `weekStart` (any timestamp inside the target
 *   ISO week) defaults to the current week.
 */
export function metricTreeRoutes(db: Db) {
  const router = Router();
  const svc = metricTreeService(db);

  router.get("/companies/:companyId/metric-trees", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    let weekStart: Date | undefined;
    const raw = req.query.weekStart;
    if (typeof raw === "string" && raw.length > 0) {
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) throw badRequest("weekStart must be a valid ISO timestamp");
      weekStart = parsed;
    }

    res.json(await svc.computeWithAlerts(companyId, { weekStart }));
  });

  return router;
}
