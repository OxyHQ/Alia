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
import { newLegacyKey, storePrivateContent } from '../lib/files/oxy-files.js';
import { storedMediaUrl } from '../lib/stored-media.js';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * A library file, with its stored object addressable.
 *
 * `url` and `thumbnail` hold stored LOCATORS (an Oxy file, a legacy key, or
 * both while it moves — `storedLocator`). A locator is not an address, and this
 * is the one place a library file gets one — a file whose object cannot be
 * addressed drops the field rather than carrying a string the browser cannot
 * fetch.
 */
function withAddressableFile(
  req: Request,
  userId: string,
  file: ReturnType<typeof toLibraryFileResponse>,
): Record<string, unknown> {
  const render = (key: string | undefined): string | undefined =>
    key === undefined || key === '' ? undefined : (storedMediaUrl(req, key, userId) ?? undefined);
  const url = render(file.url);
  const thumbnail = render(file.thumbnail);
  const { url: _storedUrl, thumbnail: _storedThumb, ...rest } = file;
  return {
    ...rest,
    ...(url === undefined ? {} : { url }),
    ...(thumbnail === undefined ? {} : { thumbnail }),
  };
}

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

    res.json({
      files: rows.map((row) => withAddressableFile(req, userId, toLibraryFileResponse(row))),
    });
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
    res.json({ file: withAddressableFile(req, userId, toLibraryFileResponse(row)) });
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

    // The person's own file (`lib/files/oxy-files.ts` says where it goes and
    // why). Nothing names it until the row below commits; the row's own
    // transaction records Alia's use of it.
    const stored = await storePrivateContent({
      kind: 'library_file',
      owner: { kind: 'person', oxyUserId: userId },
      bytes: file.buffer,
      mime: file.mimetype,
      name: file.originalname,
      legacyKey: newLegacyKey(`library/${userId}`, 'file', file.originalname),
    });

    // Create database record. `owner` -> `ownerOxyUserId` is the one column
    // mapping in this domain that cannot be derived from the names. An image is
    // its own thumbnail.
    const row = await createLibraryFile(getDb(), {
      ownerOxyUserId: userId,
      name: file.originalname,
      url: stored.objectKey,
      oxyFileId: stored.oxyFileId,
      type: file.mimetype,
      size: file.size,
      category,
      ...(category === 'images' && stored.objectKey !== null
        ? { thumbnail: stored.objectKey }
        : {}),
    });

    // Addressable, like every other read of this resource: the stored locator
    // is not something a client can fetch.
    res.status(201).json({ file: withAddressableFile(req, userId, toLibraryFileResponse(row)) });
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
    // One transaction removes the row and records what it named as released:
    // the person's Oxy file loses Alia's reference and a legacy object becomes
    // garbage for the collector (`lib/files/oxy-file-sync.ts`).
    const removed = await deleteLibraryFile(getDb(), String(req.params.id), userId);
    if (removed === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error deleting library file');
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

export default router;
