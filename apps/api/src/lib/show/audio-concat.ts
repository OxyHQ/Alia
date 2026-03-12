/**
 * Audio Concatenation — Merges multiple audio buffers into a single MP3.
 *
 * Uses ffmpeg-static (pre-built binary, no system install) + fluent-ffmpeg.
 */

import { mkdtempSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { log } from '../logger.js';

/**
 * Concatenate multiple audio buffers into a single MP3 buffer.
 *
 * Writes segments to temp files, uses ffmpeg concat demuxer to merge them,
 * and returns the result as a Buffer.
 */
export async function concatenateAudioSegments(
  segmentBuffers: Buffer[],
): Promise<Buffer> {
  if (segmentBuffers.length === 0) throw new Error('No segments to concatenate');
  if (segmentBuffers.length === 1) return segmentBuffers[0];

  // Dynamic imports for ffmpeg
  const ffmpegStaticModule = await import('ffmpeg-static');
  const ffmpegPath = ffmpegStaticModule.default;
  const ffmpegModule = await import('fluent-ffmpeg');
  const ffmpeg = ffmpegModule.default;

  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'show-'));
  const segmentFiles: string[] = [];

  try {
    // Write each segment buffer to a temp file
    for (let i = 0; i < segmentBuffers.length; i++) {
      const filePath = join(tempDir, `segment-${i.toString().padStart(3, '0')}.mp3`);
      writeFileSync(filePath, segmentBuffers[i]);
      segmentFiles.push(filePath);
    }

    // Create ffmpeg concat demuxer file list
    const listPath = join(tempDir, 'concat.txt');
    const listContent = segmentFiles.map(f => `file '${f}'`).join('\n');
    writeFileSync(listPath, listContent);

    // Output path
    const outputPath = join(tempDir, 'output.mp3');

    // Run ffmpeg concatenation
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-c:a', 'libmp3lame',
          '-b:a', '128k',
          '-ar', '44100',
          '-ac', '1',
          // Apply volume normalization
          '-filter:a', 'loudnorm=I=-16:TP=-1.5:LRA=11',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => {
          log.general.error({ err }, 'ffmpeg concatenation failed');
          reject(err);
        })
        .run();
    });

    // Read result into buffer
    const { readFile } = await import('fs/promises');
    return await readFile(outputPath);
  } finally {
    // Clean up temp files
    for (const f of [...segmentFiles, join(tempDir, 'concat.txt'), join(tempDir, 'output.mp3')]) {
      try { unlinkSync(f); } catch {}
    }
    try {
      const { rmdir } = await import('fs/promises');
      await rmdir(tempDir).catch(() => {});
    } catch {}
  }
}
