CREATE TABLE "QueueDepthSnapshot" (
    "id" UUID NOT NULL,
    "queueId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedCount" INTEGER NOT NULL,
    "runningCount" INTEGER NOT NULL,
    "scheduledCount" INTEGER NOT NULL,

    CONSTRAINT "QueueDepthSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QueueDepthSnapshot_queueId_capturedAt_key" ON "QueueDepthSnapshot"("queueId", "capturedAt");
CREATE INDEX "QueueDepthSnapshot_projectId_capturedAt_idx" ON "QueueDepthSnapshot"("projectId", "capturedAt");
CREATE INDEX "QueueDepthSnapshot_queueId_capturedAt_idx" ON "QueueDepthSnapshot"("queueId", "capturedAt");

ALTER TABLE "QueueDepthSnapshot" ADD CONSTRAINT "QueueDepthSnapshot_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "Queue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QueueDepthSnapshot" ADD CONSTRAINT "QueueDepthSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
