CREATE TABLE "Monitor" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "intervalSeconds" INTEGER NOT NULL DEFAULT 300 CHECK ("intervalSeconds" IN (60,300,900)),
  "timeoutMs" INTEGER NOT NULL DEFAULT 10000 CHECK ("timeoutMs" BETWEEN 1000 AND 30000),
  "slowThresholdMs" INTEGER NOT NULL DEFAULT 2000 CHECK ("slowThresholdMs" BETWEEN 100 AND 30000),
  "notificationEmail" TEXT,
  "paused" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "targetChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
  "firstFailureAt" TIMESTAMP(3), "lastCheckAt" TIMESTAMP(3), "lastManualAt" TIMESTAMP(3),
  "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3)
);
CREATE TABLE "Check" (
  "id" TEXT NOT NULL PRIMARY KEY, "monitorId" TEXT NOT NULL,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL CHECK ("source" IN ('AUTOMATIC','MANUAL')),
  "success" BOOLEAN NOT NULL, "httpStatus" INTEGER, "responseTimeMs" INTEGER,
  "elapsedMs" INTEGER NOT NULL, "errorCategory" TEXT, "errorMessage" TEXT,
  CONSTRAINT "Check_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Incident" (
  "id" TEXT NOT NULL PRIMARY KEY, "monitorId" TEXT NOT NULL,
  "firstFailureAt" TIMESTAMP(3) NOT NULL, "confirmedAt" TIMESTAMP(3) NOT NULL,
  "recoveredAt" TIMESTAMP(3), "errorCategory" TEXT,
  CONSTRAINT "Incident_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "CheckRequest" (
  "id" TEXT NOT NULL PRIMARY KEY, "monitorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  CONSTRAINT "CheckRequest_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Notification" (
  "id" TEXT NOT NULL PRIMARY KEY, "incidentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('INCIDENT','RECOVERY')),
  "recipient" TEXT NOT NULL, "subject" TEXT NOT NULL, "body" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0, "nextTryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3), "abandonedAt" TIMESTAMP(3), "lastError" TEXT,
  CONSTRAINT "Notification_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Session" (
  "id" TEXT NOT NULL PRIMARY KEY, "tokenHash" TEXT NOT NULL, "csrfToken" TEXT NOT NULL, "username" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "WorkerHeartbeat" (
  "id" TEXT NOT NULL PRIMARY KEY, "lastSeenAt" TIMESTAMP(3) NOT NULL, "startedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ObservationGap" (
  "id" TEXT NOT NULL PRIMARY KEY, "monitorId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL, "endedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ObservationGap_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Check_monitorId_checkedAt_idx" ON "Check"("monitorId", "checkedAt");
CREATE INDEX "Check_checkedAt_idx" ON "Check"("checkedAt");
CREATE INDEX "Incident_monitorId_confirmedAt_idx" ON "Incident"("monitorId", "confirmedAt");
CREATE UNIQUE INDEX "Incident_one_open_per_monitor" ON "Incident"("monitorId") WHERE "recoveredAt" IS NULL;
CREATE INDEX "CheckRequest_completedAt_createdAt_idx" ON "CheckRequest"("completedAt", "createdAt");
CREATE UNIQUE INDEX "Notification_incidentId_kind_key" ON "Notification"("incidentId", "kind");
CREATE INDEX "Notification_sentAt_abandonedAt_nextTryAt_idx" ON "Notification"("sentAt", "abandonedAt", "nextTryAt");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE INDEX "ObservationGap_monitorId_startedAt_idx" ON "ObservationGap"("monitorId", "startedAt");
