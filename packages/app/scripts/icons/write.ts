/**
 * Writes the generated icon components. `bun run generate:icons`.
 *
 * The directory is rebuilt whole rather than patched, so a component dropped
 * from the manifest goes with it instead of lingering as an import that still
 * resolves.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR, generate } from './generate';

const files = generate();
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
for (const [file, source] of files) writeFileSync(join(OUT_DIR, file), source, 'utf8');
process.stdout.write(`${files.size} icons -> ${OUT_DIR}\n`);
