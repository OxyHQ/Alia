/**
 * A Cloudflare DNS write must not index into a list it did not narrow.
 *
 * ## What went wrong, twice, on 2026-08-26
 *
 * `dns_records?name=<host>` filters by NAME and not by type. The apex
 * `alia.onl` held a `CNAME` and a `TXT "v=spf1 -all"`, so that query returned
 * two records and `.result[0]` was whichever Cloudflare listed first.
 *
 *  1. `migrate-pages-to-worker.yml` DELETED `.result[0]`, took the CNAME, and
 *     left the hostname with no address record: fifteen minutes of outage.
 *  2. `bind-pages-domain.yml`, the RECOVERY workflow, then PUT a CNAME body
 *     over `.result[0]`. By then the CNAME was gone, so `.result[0]` was the
 *     SPF record, and a PUT on a record id replaces it whole, type included.
 *     The SPF record was destroyed by a workflow containing no `DELETE` at
 *     all — which is why this asserts a shape and not a verb.
 *
 * Its verification read `.result[0]` too, so the guard that should have caught
 * the wrong record was addressing by index exactly like the write it checked.
 *
 * ## What is asserted
 *
 * NO `.result[0]` IS READ FROM A MIXED-TYPE `dns_records` RESPONSE. The
 * attribution is by file — the path a `dns_records` URL was written to with
 * `-o` — so it follows the data rather than the variable name. That is what
 * separates the two `.result[0]` reads three lines apart in the cutover's
 * inspection: one reads the zone lookup and is fine, one would read the record
 * list and is not.
 *
 * Two exemptions, both because the list cannot hold more than one record:
 *
 *   - a `zones?name=` response: a zone query by name returns one zone.
 *   - a `dns_records` query pinning `type=CNAME`: DNS forbids a second CNAME
 *     at one name, so the server guarantees the singularity indexing assumes.
 *
 * ONLY `CNAME`. Pinning any other type narrows the type without narrowing the
 * count — one name may hold several `A` records — so `&type=A` plus
 * `.result[0]` is the original bug wearing a filter, and is reported.
 *
 * ## Where it looks, and where it deliberately does not
 *
 * Workflows AND the scripts they call. The delete logic moved out of the
 * workflows and into `.github/scripts` in #444, so a gate reading only `*.yml`
 * would be watching the room the code walked out of — it passed a violation
 * planted in `cloudflare-address-records.sh` while I was writing this.
 *
 * `test-*.sh` is EXEMPT, and has to be. `test-cloudflare-cutover.sh` carries
 * the broken step verbatim from `d41a42ac^` as the fixture that proves its
 * checks can still fail. A gate that forbade the historical bug from appearing
 * in the test that reproduces it would forbid the control.
 *
 * ## What is NOT asserted, and why it was removed
 *
 * An earlier version demanded every copy of the address-record type filter be
 * byte-identical. After #444 there is exactly ONE operational definition, in
 * `cloudflare-address-records.sh`. With one copy there is no drift to detect,
 * and the floor that was supposed to stop it passing over nothing was met only
 * by a test ASSERTION that happens to spell the filter the same way — so
 * rewriting that assertion, which is a test author's business, would have
 * turned this red with nothing wrong. It measured a coincidence, so it is gone.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag === -1 ? '.' : process.argv[rootFlag + 1];
const WORKFLOWS = join(ROOT, '.github/workflows');
const SCRIPTS = join(ROOT, '.github/scripts');

const listing = (dir, ext) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => join(dir, f)) : [];

const sources = [
  ...listing(WORKFLOWS, '.yml'),
  ...listing(SCRIPTS, '.sh').filter((f) => !basename(f).startsWith('test-')),
];

/** Shell continuations make one logical command span several lines. */
const logicalLines = (text) => text.replace(/\\\n\s*/g, ' ').split('\n');

const failures = [];

for (const file of sources) {
  const lines = logicalLines(readFileSync(file, 'utf8'));
  const mixed = new Set();
  lines.forEach((line, i) => {
    if (line.includes('dns_records')) {
      const out = line.match(/-o\s+(\S+)/);
      // Only CNAME: see the header. Any other pinned type still permits
      // several records, so indexing the response is still a blind choice.
      if (out && !/[?&]type=CNAME\b/.test(line)) mixed.add(out[1]);
    }
    if (!line.includes('.result[0]')) return;
    for (const path of mixed) {
      if (!line.includes(path)) continue;
      failures.push(
        `${file}:${i + 1} reads .result[0] from ${path}, a dns_records response.\n` +
          `    ${line.trim()}\n` +
          '    A query by name returns every type at that name. Address the record by type,\n' +
          '    or pin type=CNAME on the query and let the server guarantee the singularity.',
      );
    }
  });
}

if (failures.length > 0) {
  console.error('check-dns-record-filters: FAILED\n');
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(
  `check-dns-record-filters: OK — ${sources.length} file(s) scanned, ` +
    'no .result[0] read from a mixed-type dns_records response.',
);
