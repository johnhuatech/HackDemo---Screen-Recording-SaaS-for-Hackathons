const express = require('express');
const { z } = require('zod');
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const { authenticate, authenticateApiKey } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

const createRecordingSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  projectId: z.string().uuid().optional(),
  duration: z.number().optional(),
  fileSize: z.number().optional()
});

const updateRecordingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  isPublic: z.boolean().optional(),
  projectId: z.string().uuid().nullable().optional()
});

// Get all recordings for user
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { projectId, search, page = 1, limit = 20 } = req.query;
    
    const where = {
      userId: req.user.id,
      ...(projectId && { projectId }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ]
      })
    };

    const [recordings, total] = await Promise.all([
      prisma.recording.findMany({
        where,
        include: {
          project: { select: { id: true, name: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: parseInt(limit)
      }),
      prisma.recording.count({ where })
    ]);

    res.json({
      recordings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

// Get single recording
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const recording = await prisma.recording.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      include: {
        project: true,
        annotations: { orderBy: { timestamp: 'asc' } }
      }
    });

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    res.json({ recording });
  } catch (error) {
    next(error);
  }
});

// Get public recording by share token
router.get('/share/:shareToken', async (req, res, next) => {
  try {
    const recording = await prisma.recording.findUnique({
      where: { shareToken: req.params.shareToken },
      include: {
        user: { select: { name: true, avatar: true } },
        project: { select: { name: true, hackathon: true } },
        annotations: { orderBy: { timestamp: 'asc' } }
      }
    });

    if (!recording || !recording.isPublic) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    // Increment views
    await prisma.recording.update({
      where: { id: recording.id },
      data: { views: { increment: 1 } }
    });

    res.json({ recording });
  } catch (error) {
    next(error);
  }
});

// Create recording metadata
router.post('/', authenticateApiKey, async (req, res, next) => {
  try {
    const data = createRecordingSchema.parse(req.body);
    
    const recording = await prisma.recording.create({
      data: {
        ...data,
        userId: req.user.id,
        shareToken: uuidv4()
      }
    });

    res.status(201).json({ recording });
  } catch (error) {
    next(error);
  }
});

// Update recording
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const data = updateRecordingSchema.parse(req.body);
    
    const recording = await prisma.recording.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      data
    });

    if (recording.count === 0) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    const updated = await prisma.recording.findUnique({
      where: { id: req.params.id }
    });

    res.json({ recording: updated });
  } catch (error) {
    next(error);
  }
});

// Delete recording
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const recording = await prisma.recording.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    // TODO: Delete from S3

    await prisma.recording.delete({
      where: { id: req.params.id }
    });

    // Update user storage
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        storageUsed: { decrement: recording.fileSize }
      }
    });

    res.json({ message: 'Recording deleted' });
  } catch (error) {
    next(error);
  }
});

// Add annotation
router.post('/:id/annotations', authenticate, async (req, res, next) => {
  try {
    const { timestamp, text, type } = req.body;
    
    const recording = await prisma.recording.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    const annotation = await prisma.annotation.create({
      data: {
        timestamp,
        text,
        type: type || 'note',
        recordingId: req.params.id
      }
    });

    res.status(201).json({ annotation });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
