CREATE INDEX "auditEvent_recent" ON "auditEvent" ("organizationId","createdAt" DESC,"id" DESC);
