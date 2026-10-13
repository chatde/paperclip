import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { goalProgressService } from "../services/goal-progress.js";
import { accessService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function goalProgressRoutes(db: Db) {
  const router = Router();
  const svc = goalProgressService(db);
  const access = accessService(db);

  // A company-wide projection of every task and agent: besides company access,
  // the actor needs company_scope:read, which low-trust and issue-scoped
  // credentials are denied (same gate as the activity feed).
  router.get("/companies/:companyId/goal-progress", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Goal progress is outside this actor's authorization boundary" });
      return;
    }
    res.json(await svc.summary(companyId));
  });

  return router;
}
