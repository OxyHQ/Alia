import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  concatenateAudioSegments,
  measureAudioDurationMs,
  parseFinalTimestampMs,
} from '../show-audio';

const run = promisify(execFile);

/**
 * Show audio, against the REAL ffmpeg binary.
 *
 * Not mocked, and the point of the file is that it cannot be: what is under
 * test is whether a duration is MEASURED or inferred, and a mock returning a
 * number proves nothing about which. The fixtures are synthesised by ffmpeg
 * itself so their true length is known exactly rather than asserted against a
 * checked-in file somebody has to trust.
 */

/**
 * What the pipeline used to do: `bytes / (128 * 1024 / 8) * 1000`.
 *
 * Reproduced here rather than described, because it is the thing the fixtures
 * have to be able to catch. A fixture the old formula happens to get right
 * cannot tell a real measurement from the estimate — which is exactly why the
 * central fixture below is 64 kbps and not 128.
 */
const legacyByteEstimateMs = (audio: Buffer): number =>
  Math.round((audio.length / ((128 * 1024) / 8)) * 1000);

let ffmpeg: string;
let workspace: string;

/** A pure sine of a known length at a chosen bitrate. */
async function synthesize(seconds: number, bitrate: string): Promise<Buffer> {
  const path = join(workspace, `tone-${seconds}-${bitrate}.mp3`);
  await run(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${seconds}`,
    '-b:a', bitrate,
    path,
  ]);
  return readFile(path);
}

beforeAll(async () => {
  const module = await import('ffmpeg-static');
  const resolved = module.default;
  if (resolved === null) throw new Error('ffmpeg-static resolved no binary for this platform');
  ffmpeg = resolved;
  workspace = await mkdtemp(join(tmpdir(), 'show-audio-test-'));
});

describe('measuring a show\'s duration', () => {
  it('reads the real length of a file the byte estimate gets badly wrong', async () => {
    // 64 kbps: half the bitrate the old formula assumed, so it under-reports by
    // about half. This is the fixture that discriminates — a 128 kbps one would
    // pass against either implementation.
    const audio = await synthesize(6, '64k');

    const measured = await measureAudioDurationMs(audio);
    expect(measured).not.toBeNull();
    expect(measured).toBeGreaterThanOrEqual(5900);
    expect(measured).toBeLessThanOrEqual(6100);

    // The positive control for the fixture itself: assert the OLD formula is
    // genuinely wrong here. Without this, a fixture that both implementations
    // agree on would look like a passing test of the new one.
    const estimated = legacyByteEstimateMs(audio);
    expect(estimated).toBeLessThan(4000);
    expect(Math.abs(estimated - 6000)).toBeGreaterThan(1500);
  });

  it('and of one it gets right, so the fixture above is not the only shape that works', async () => {
    const audio = await synthesize(2.5, '128k');
    const measured = await measureAudioDurationMs(audio);
    expect(measured).not.toBeNull();
    expect(measured).toBeGreaterThanOrEqual(2400);
    expect(measured).toBeLessThanOrEqual(2600);
  });

  it('answers null for bytes that are not audio, rather than a number', async () => {
    // The honest answer, and the one that matters downstream: Syra writes the
    // duration it is handed and never revisits it, so a fabricated figure is
    // permanent while an absent one is merely blank.
    expect(await measureAudioDurationMs(Buffer.from('this is not an mp3'))).toBeNull();
  });

  it('scales with the input, so it is not returning a constant', async () => {
    const [short, long] = await Promise.all([synthesize(1, '128k'), synthesize(4, '128k')]);
    const [shortMs, longMs] = await Promise.all([
      measureAudioDurationMs(short),
      measureAudioDurationMs(long),
    ]);

    expect(shortMs).not.toBeNull();
    expect(longMs).not.toBeNull();
    expect(longMs ?? 0).toBeGreaterThan((shortMs ?? 0) * 3);
  });
});

describe('reading ffmpeg\'s timestamps', () => {
  /**
   * The rule under test is "take the LAST `time=`", and this module's public
   * entry point cannot reach it: a show-length file decodes in about a
   * millisecond, so ffmpeg emits exactly one stats line and first and last are
   * the same string. A mutation changing `.at(-1)` to `.at(0)` survived the
   * entire suite before this test existed.
   *
   * `-re` makes ffmpeg decode at playback speed, which produces the many
   * ascending lines a long file would. The stderr below is therefore REAL
   * ffmpeg output, captured here rather than written by hand — a hand-written
   * sample would only be testing my own idea of the format.
   */
  it('takes the last of many timestamps, not the first', async () => {
    const audio = await synthesize(3, '128k');
    const path = join(workspace, 'timestamps.mp3');
    await (await import('node:fs/promises')).writeFile(path, audio);

    // A non-zero exit would throw; `-f null -` on a valid file exits 0.
    const { stderr } = await run(ffmpeg, [
      '-stats_period', '0.3',
      '-re',
      '-i', path,
      '-f', 'null', '-',
    ]);

    const stamps = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2})\.(\d{2})/g)];
    // The positive control for the FIXTURE: without several ascending lines
    // this test cannot tell the two rules apart, and would pass vacuously.
    expect(stamps.length).toBeGreaterThan(3);

    const parsed = parseFinalTimestampMs(stderr);
    expect(parsed).toBeGreaterThanOrEqual(2900);
    expect(parsed).toBeLessThanOrEqual(3100);

    // And the first one really is different, which is what makes the assertion
    // above a choice rather than a coincidence.
    const first = stamps[0];
    expect(first).toBeDefined();
    const firstMs =
      Number(first?.[1]) * 3_600_000 +
      Number(first?.[2]) * 60_000 +
      Number(first?.[3]) * 1000 +
      Number(first?.[4]) * 10;
    expect(firstMs).toBeLessThan(2500);
  }, 20_000);

  it('answers null for output carrying no timestamp at all', () => {
    expect(parseFinalTimestampMs('Error opening input: Invalid data found')).toBeNull();
    // `time=N/A` is ffmpeg's own spelling for "produced nothing", and it must
    // read as no measurement rather than as zero.
    expect(parseFinalTimestampMs('size=N/A time=N/A bitrate=N/A')).toBeNull();
  });

  it('reads hours, minutes, seconds and centiseconds', () => {
    expect(parseFinalTimestampMs('time=01:02:03.45')).toBe(3_723_450);
  });
});

describe('joining segments', () => {
  it('produces one file as long as its parts together', async () => {
    const parts = await Promise.all([
      synthesize(2, '128k'),
      synthesize(3, '128k'),
    ]);

    const joined = await concatenateAudioSegments(parts);
    const measured = await measureAudioDurationMs(joined);

    // Five seconds, within an encoder frame either way. The assertion is the
    // SUM rather than "longer than one of them": a join that silently kept only
    // the first segment would pass the weaker form.
    expect(measured).not.toBeNull();
    expect(measured).toBeGreaterThanOrEqual(4800);
    expect(measured).toBeLessThanOrEqual(5300);
  });

  it('hands a single segment straight back', async () => {
    const only = await synthesize(2, '128k');
    expect(await concatenateAudioSegments([only])).toBe(only);
  });

  it('refuses an empty list rather than returning an empty buffer', async () => {
    // An empty MP3 would travel all the way to Syra and become a zero-length
    // episode; throwing keeps the failure where the pipeline can refund it.
    await expect(concatenateAudioSegments([])).rejects.toThrow('No segments to concatenate');
  });

  it('joins segments of DIFFERENT bitrates into one consistent file', async () => {
    // The real shape: TTS and sound effects come from different providers at
    // different bitrates. This is the case where a byte-based duration is
    // wrong no matter which constant it assumes.
    const parts = await Promise.all([
      synthesize(2, '64k'),
      synthesize(2, '128k'),
      synthesize(2, '192k'),
    ]);

    const joined = await concatenateAudioSegments(parts);
    const measured = await measureAudioDurationMs(joined);
    expect(measured).toBeGreaterThanOrEqual(5800);
    expect(measured).toBeLessThanOrEqual(6300);

    // And the estimate the old pipeline would have published for this exact
    // file, which is the number a listener would have seen.
    expect(Math.abs(legacyByteEstimateMs(joined) - 6000)).toBeGreaterThan(0);
  });
});

describe('cleaning up after itself', () => {
  it('leaves no temporary directory behind, on success or on failure', async () => {
    const { readdir } = await import('node:fs/promises');
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('show-'));

    await measureAudioDurationMs(await synthesize(1, '128k'));
    // The failure path too: it takes a different branch out of the function,
    // and a `finally` that only covered the happy one would leak on every
    // failed show — which is the run that happens under load.
    await measureAudioDurationMs(Buffer.from('not audio'));
    await concatenateAudioSegments(await Promise.all([synthesize(1, '128k'), synthesize(1, '128k')]));

    const after = (await readdir(tmpdir())).filter((n) => n.startsWith('show-'));
    expect(after.length).toBe(before.length);
  });
});

// The synthesised fixtures are this file's own; nothing else reads them.
process.on('exit', () => {
  if (workspace !== undefined) void rm(workspace, { recursive: true, force: true });
});
