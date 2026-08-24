/**
 * The ffmpeg seam for generated shows: joining segments, and measuring what
 * came out.
 *
 * Both operations live here because both need the SAME binary, resolved the
 * same way, and splitting them across two modules would mean two copies of that
 * resolution free to disagree about whether ffmpeg is available.
 *
 * ## `execFile`, not `fluent-ffmpeg`
 *
 * `fluent-ffmpeg` builds filter graphs through a chained API and is unmaintained
 * upstream. Neither operation here needs a graph — each is one invocation with a
 * fixed argument list — and using it cost three things this does not: an `any`
 * for the untyped module, a hand-rolled `settled` flag and `setTimeout` to
 * bound a run that `execFile` bounds itself, and a wrapper between this code and
 * the stderr that measuring a duration has to read verbatim.
 *
 * ## Why the duration is MEASURED rather than computed from the file size
 *
 * The previous pipeline divided the byte length by 128 kbps. That is only right
 * when the file really is 128 kbps constant, and a show's is routinely not: TTS
 * and sound-effect segments arrive from different providers at different
 * bitrates, and when ffmpeg is unavailable they are concatenated verbatim rather
 * than re-encoded. Measured on a 6-second 64 kbps file, the estimate answers
 * 2961 ms — less than half.
 *
 * That number is not cosmetic. Syra's ingest writes the duration it is handed
 * and its transcode never revisits it, so a wrong figure is what every listener
 * sees in the episode list and in the RSS feed, permanently.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { log } from '../logger.js';

const run = promisify(execFile);

/** Long enough for a half-hour show on a busy container, short enough to fail. */
const FFMPEG_TIMEOUT_MS = 120_000;

/**
 * ffmpeg writes its progress and its final statistics to stderr, and a long
 * show produces a lot of it. The default 1 MB `maxBuffer` would kill the
 * process mid-encode with a message about the buffer rather than about the
 * audio.
 */
const STDERR_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * The bundled ffmpeg binary, or `null` when there is none.
 *
 * A dynamic import because `ffmpeg-static` resolves a platform binary at
 * require time: importing it statically would make this module — and everything
 * that reaches it — fail to load on a platform it has no binary for, rather
 * than degrade.
 */
async function ffmpegPath(): Promise<string | null> {
  try {
    const module = await import('ffmpeg-static');
    return module.default ?? null;
  } catch (err: unknown) {
    log.general.warn({ err }, 'ffmpeg-static could not be loaded');
    return null;
  }
}

/**
 * ffmpeg's own final timestamp, as milliseconds. Exported because it is the one
 * part of this module a fixture can drive directly — see below.
 *
 * The LAST `time=` in the output, never the first. ffmpeg emits one stats line
 * per `-stats_period`, and only the final one is the end of the stream.
 *
 * **What was actually measured, because the distinction is invisible at show
 * scale.** A three-second file decodes in about a millisecond, so ffmpeg emits
 * exactly ONE stats line and first and last are the same string — a mutation
 * changing `.at(-1)` to `.at(0)` survived the whole suite. Forced to decode in
 * real time with `-re`, the same file emits nine ascending lines beginning at
 * `time=00:00:00.81` and ending at `time=00:00:03.00`, and the two rules then
 * differ by nearly four times. So the last-match rule is right for the general
 * case and unreachable through this module's own public entry point, which is
 * why the test drives this function with real captured output instead.
 *
 * `time=N/A` appears when ffmpeg produced nothing at all; it does not match the
 * pattern, so such a run answers `null` rather than 0 — the difference between
 * "no audio" and "no measurement", which are not the same thing to report.
 */
export function parseFinalTimestampMs(stderr: string): number | null {
  const matches = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2})\.(\d{2})/g)];
  const last = matches.at(-1);
  if (last === undefined) return null;

  const [, hours, minutes, seconds, centiseconds] = last;
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    Number(centiseconds) * 10
  );
}

/**
 * How long this audio actually plays for, in milliseconds, or `null`.
 *
 * `-f null -` decodes the whole stream and discards it, so the timestamp it
 * ends on is the real playing time rather than anything inferred from the
 * container. That costs one decode pass — well under a second for a show — and
 * it is the only way to be right about a file whose bitrate varies.
 *
 * `null` when ffmpeg is unavailable or its output cannot be read. A caller
 * passes that absence on rather than substituting an estimate: Syra shows no
 * duration for an episode that reports none, and shows a WRONG one for an
 * episode that reports a guess.
 */
export async function measureAudioDurationMs(audio: Buffer): Promise<number | null> {
  const binary = await ffmpegPath();
  if (binary === null) {
    log.general.warn('ffmpeg not available — a show is published without a duration');
    return null;
  }

  const directory = await mkdtemp(join(tmpdir(), 'show-duration-'));
  const file = join(directory, 'audio.mp3');
  try {
    await writeFile(file, audio);
    // A non-zero exit throws, which is what should happen: a file ffmpeg cannot
    // decode has no duration to report and saying so is the honest answer.
    const { stderr } = await run(binary, ['-i', file, '-f', 'null', '-'], {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: STDERR_BUFFER_BYTES,
    });
    return parseFinalTimestampMs(stderr);
  } catch (err: unknown) {
    log.general.warn({ err }, 'Could not measure show audio duration');
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Join audio segments into one MP3.
 *
 * ## The fallback concatenates BYTES, and that is worse than it looks
 *
 * Without ffmpeg this returns `Buffer.concat(segments)`. Two MP3 streams glued
 * end to end do play in most decoders, but the result carries every input's own
 * bitrate and sample rate, which is precisely the file the size-based duration
 * estimate is wrong about. The fallback is kept because a show with slightly
 * odd audio beats no show at all — and {@link measureAudioDurationMs} is what
 * stops that path also producing a wrong duration, since it decodes whatever it
 * is given rather than assuming a bitrate.
 */
export async function concatenateAudioSegments(segments: Buffer[]): Promise<Buffer> {
  if (segments.length === 0) throw new Error('No segments to concatenate');
  const [only] = segments;
  if (segments.length === 1 && only !== undefined) return only;

  const binary = await ffmpegPath();
  if (binary === null) {
    log.general.warn('ffmpeg not available — joining show segments byte-wise');
    return Buffer.concat(segments);
  }

  const directory = await mkdtemp(join(tmpdir(), 'show-concat-'));
  try {
    const paths: string[] = [];
    for (const [index, segment] of segments.entries()) {
      const path = join(directory, `segment-${String(index).padStart(3, '0')}.mp3`);
      await writeFile(path, segment);
      paths.push(path);
    }

    /**
     * The concat demuxer's list file. Each path is quoted and the directory is
     * one this process just created with `mkdtemp`, so no name in it came from
     * a model, a provider or a user — which is what makes `-safe 0` acceptable
     * here and would not make it acceptable over an arbitrary path.
     */
    const listPath = join(directory, 'concat.txt');
    await writeFile(listPath, paths.map((path) => `file '${path}'`).join('\n'));

    const outputPath = join(directory, 'output.mp3');
    await run(
      binary,
      [
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '1',
        // One loudness across segments that came from different providers at
        // different levels, which is otherwise the most audible defect.
        '-filter:a', 'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-y', outputPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: STDERR_BUFFER_BYTES },
    );

    return await readFile(outputPath);
  } finally {
    // One `rm` of the directory, not a loop over the files it holds: a name the
    // loop did not know about — ffmpeg's own temporary output, a file added
    // later — would survive a per-file cleanup and leak on every run.
    await rm(directory, { recursive: true, force: true });
  }
}
