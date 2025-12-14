const express = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const { authenticateApiKey } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// Storage limits by plan (in bytes)
const STORAGE_LIMITS = {
  FREE: 1 * 1024 * 1024 * 1024,      // 1 GB
  PRO: 50 * 1024 * 1024 * 1024,      // 50 GB
  TEAM: 500 * 1024 * 1024 * 1024     // 500 GB
};

// Get presigned URL for upload
router.post('/presigned-url', authenticateApiKey, async (req, res, next) => {
  try {
    const { fileName, fileType, fileSize, recordingId } = req.body;

    // Check storage limit
    const storageLimit = STORAGE_LIMITS[req.user.plan];
    const newStorageUsed = BigInt(req.user.storageUsed) + BigInt(fileSize);
    
    if (newStorageUsed > BigInt(storageLimit)) {
      return res.status(403).json({ 
        error: 'Storage limit exceeded',
        limit: storageLimit,
        used: req.user.storageUsed
      });
    }

    const fileKey = `recordings/${req.user.id}/${recordingId}/${uuidv4()}-${fileName}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
      ContentType: fileType
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    res.json({ 
      uploadUrl, 
      fileKey,
      expiresIn: 3600
    });
  } catch (error) {
    next(error);
  }
});

// Confirm upload completed
router.post('/confirm', authenticateApiKey, async (req, res, next) => {
  try {
    const { recordingId, fileKey, fileSize, duration } = req.body;

    const videoUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;

    const recording = await prisma.recording.update({
      where: { id: recordingId },
      data: {
        videoUrl,
        fileSize: BigInt(fileSize),
        duration: duration || 0,
        status: 'READY'
      }
    });

    // Update user storage
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        storageUsed: { increment: BigInt(fileSize) }
      }
    });

    res.json({ recording });
  } catch (error) {
    next(error);
  }
});

// Get presigned URL for viewing
router.get('/view/:recordingId', async (req, res, next) => {
  try {
    const recording = await prisma.recording.findUnique({
      where: { id: req.params.recordingId }
    });

    if (!recording || !recording.videoUrl) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    // Extract key from URL
    const url = new URL(recording.videoUrl);
    const fileKey = url.pathname.substring(1);

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey
    });

    const viewUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    res.json({ viewUrl, expiresIn: 3600 });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
