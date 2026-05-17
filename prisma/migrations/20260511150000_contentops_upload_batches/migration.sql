-- CreateTable
CREATE TABLE "UploadBatch" (
    "id" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedBy" TEXT,
    "machineFamily" TEXT NOT NULL DEFAULT 'Unknown',
    "machineModel" TEXT NOT NULL DEFAULT 'Unknown',
    "topic" TEXT NOT NULL DEFAULT 'Uncategorized',
    "location" TEXT NOT NULL DEFAULT 'Unknown',
    "metadataSource" TEXT NOT NULL DEFAULT 'DEFAULT',
    "reviewStatus" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    "aiConfidence" DOUBLE PRECISION,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "driveFolderId" TEXT,
    "driveFolderUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingAsset" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" BIGINT,
    "webViewLink" TEXT,
    "thumbnailLink" TEXT,
    "uploadStatus" TEXT NOT NULL DEFAULT 'UPLOADED',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomingAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadBatch_batchCode_key" ON "UploadBatch"("batchCode");

-- AddForeignKey
ALTER TABLE "IncomingAsset" ADD CONSTRAINT "IncomingAsset_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "UploadBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
