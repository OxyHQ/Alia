import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import { LibraryFile } from '../models/library-file.js';
import { uploadToS3, deleteFromS3 } from '../lib/s3.js';
import { log } from '../lib/logger.js';

const router = Router();

router.use(authenticateToken);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

/**
 * GET /library
 * List the current user's library files
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { category } = req.query;

    const filter: any = { owner: userId };
    if (category && ['documents', 'images', 'other'].includes(category as string)) {
      filter.category = category;
    }

    const files = await LibraryFile.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    res.json({ files });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error listing library files');
    res.status(500).json({ error: 'Failed to list files' });
  }
});

/**
 * GET /library/:id
 * Get a single library file by ID
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const file = await LibraryFile.findOne({ _id: req.params.id, owner: userId }).lean();
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.json({ file });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error getting library file');
    res.status(500).json({ error: 'Failed to get file' });
  }
});

/**
 * POST /library/upload
 * Upload a file to the library
 */
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Determine category from MIME type
    let category: 'documents' | 'images' | 'other' = 'other';
    if (file.mimetype.startsWith('image/')) {
      category = 'images';
    } else if (
      file.mimetype.includes('pdf') ||
      file.mimetype.includes('document') ||
      file.mimetype.includes('text/') ||
      file.mimetype.includes('spreadsheet') ||
      file.mimetype.includes('presentation')
    ) {
      category = 'documents';
    }

    // Upload to S3
    const url = await uploadToS3(
      file.buffer,
      file.originalname,
      `library/${userId}`,
      'file'
    );

    // Upload thumbnail for images
    let thumbnail: string | undefined;
    if (category === 'images') {
      thumbnail = url; // Use the same URL as thumbnail for now
    }

    // Create database record
    const libraryFile = await LibraryFile.create({
      name: file.originalname,
      url,
      type: file.mimetype,
      size: file.size,
      category,
      owner: userId,
      thumbnail,
    });

    res.status(201).json({ file: libraryFile });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error uploading library file');
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

/**
 * DELETE /library/:id
 * Delete a library file
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const file = await LibraryFile.findOne({ _id: req.params.id, owner: userId });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Delete from S3
    await deleteFromS3(file.url);
    if (file.thumbnail && file.thumbnail !== file.url) {
      await deleteFromS3(file.thumbnail);
    }

    // Delete database record
    await file.deleteOne();

    res.json({ success: true });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error deleting library file');
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

export default router;
