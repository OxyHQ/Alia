import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import {
  createLibraryFile,
  deleteLibraryFile,
  findLibraryFile,
  listLibraryFiles,
  toLibraryFileResponse,
} from '../db/library/libraryFileRepository.js';
import { FILE_CATEGORIES, type FileCategory } from '../domain/library-file.js';
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

    /**
     * The category tuple comes from `domain/library-file.ts`, the same one the
     * column's CHECK is rendered from — an inline array here could drift from
     * the constraint and silently start filtering on a value no row can hold.
     */
    const narrowed = FILE_CATEGORIES.includes(category as FileCategory)
      ? (category as FileCategory)
      : undefined;

    const rows = await listLibraryFiles(getDb(), userId, narrowed);

    res.json({ files: rows.map(toLibraryFileResponse) });
  } catch (error: unknown) {
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
    const row = await findLibraryFile(getDb(), String(req.params.id), userId);
    if (!row) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.json({ file: toLibraryFileResponse(row) });
  } catch (error: unknown) {
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

    // Create database record. `owner` -> `ownerOxyUserId` is the one column
    // mapping in this domain that cannot be derived from the names.
    const row = await createLibraryFile(getDb(), {
      ownerOxyUserId: userId,
      name: file.originalname,
      url,
      type: file.mimetype,
      size: file.size,
      category,
      thumbnail,
    });

    res.status(201).json({ file: toLibraryFileResponse(row) });
  } catch (error: unknown) {
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
    const db = getDb();
    const file = await findLibraryFile(db, String(req.params.id), userId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Delete from S3
    await deleteFromS3(file.url);
    if (file.thumbnail && file.thumbnail !== file.url) {
      await deleteFromS3(file.thumbnail);
    }

    // Delete database record
    await deleteLibraryFile(db, file.id, userId);

    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error deleting library file');
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

export default router;
