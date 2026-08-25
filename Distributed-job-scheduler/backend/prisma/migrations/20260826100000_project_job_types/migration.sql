CREATE TABLE "ProjectJobType" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "jobType" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectJobType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectJobType_projectId_jobType_key" ON "ProjectJobType"("projectId", "jobType");
CREATE INDEX "ProjectJobType_projectId_idx" ON "ProjectJobType"("projectId");
ALTER TABLE "ProjectJobType" ADD CONSTRAINT "ProjectJobType_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;