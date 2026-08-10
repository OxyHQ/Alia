import { ObjectId } from 'mongodb';
import type { Db, Document } from 'mongodb';
import type { AuditCheck, AuditCheckResult, AuditFinding } from '../types';

/**
 * The references batch 9 turned into real foreign keys, and the ids Mongo left
 * dangling behind them.
 *
 * ## Why this is the check with teeth
 *
 * Mongo enforced none of these. Deleting a `Skill` or a `LibraryFile` never
 * touched the agents referencing it, and `routes/agents/crud.ts:323` deletes an
 * agent with a bare `deleteOne` that touches nothing at all — while `populate()`
 * silently dropped every unresolvable entry on read. That silence is why nobody
 * has ever seen one: an agent's skill list simply got shorter, with nothing
 * recording why.
 *
 * The Postgres schema has real foreign keys on all of them, so **the backfill
 * will fail with `23503` on exactly these rows.** That is the designed outcome,
 * not a defect — it is the first time anybody has counted how many of those
 * references are dead.
 *
 * ## The instruction that goes with the number: COUNT and DISCARD
 *
 * Do not drop the constraint. Each dangling id is an entry the agent's owner
 * already watched disappear from their list, so discarding it restores nothing
 * and loses nothing — and keeping the constraint is what makes the same silent
 * shrinkage impossible afterwards. `agent_reviews` is the one to READ rather
 * than skim: a large number there means agents are being deleted with reviews
 * attached, and `lib/agent-rating.ts` has been recomputing ratings against them.
 *
 * ## Collection names are LITERALS
 *
 * None of these models declares a `collection:` option, so Mongoose's default
 * pluralisation applies — but that is a fact about today, and deriving the name
 * from the model would be a check that cannot fail. They are stated, and
 * `openAuditSource` asserts every one EXISTS before this runs, because a query
 * against a misspelled collection counts zero and reads as clean.
 */

interface ReferenceDeclaration {
  readonly key: string;
  /** Human-readable, and what appears in the report. */
  readonly subject: string;
  /** The collection holding the reference. A literal. */
  readonly from: string;
  /**
   * The field holding it. A dotted path is not used: every reference here is
   * either a top-level scalar or a top-level array of ids.
   */
  readonly field: string;
  readonly kind: 'array' | 'scalar';
  /** The collection the reference must resolve into. A literal. */
  readonly to: string;
  /** The Postgres constraint that will refuse it, so the two are tied. */
  readonly constraint: string;
}

/**
 * Every batch-9 reference that gained a foreign key.
 *
 * `agent_session_resources.session_id` is deliberately ABSENT: those rows were
 * an embedded array inside the session document, so they cannot reference a
 * session that does not exist — there is nothing for this check to measure.
 * Stating that here rather than omitting it silently, because a reader
 * comparing this list against the schema will otherwise wonder.
 *
 * `agent_sessions.agent_id`, `containers.session_id` and
 * `rollback_records.session_id` are absent for the opposite reason: they carry
 * NO foreign key by decision, so a dangling id there is expected and permitted
 * rather than a finding.
 */
export const FOREIGN_KEY_REFERENCES: readonly ReferenceDeclaration[] = [
  {
    key: 'agents.skills',
    subject: "an agent's skill referencing a skill that no longer exists",
    from: 'agents',
    field: 'skills',
    kind: 'array',
    to: 'skills',
    constraint: 'agent_skills_skill_id_fk',
  },
  {
    key: 'agents.knowledge',
    subject: "an agent's knowledge referencing a library file that no longer exists",
    from: 'agents',
    field: 'knowledge',
    kind: 'array',
    to: 'libraryfiles',
    constraint: 'agent_knowledge_library_file_id_fk',
  },
  {
    key: 'agentteams.agents',
    subject: 'a team member referencing an agent that no longer exists',
    from: 'agentteams',
    field: 'agents',
    kind: 'array',
    to: 'agents',
    constraint: 'agent_team_agents_agent_id_fk',
  },
  {
    key: 'agentteams.skills',
    subject: "a team's skill referencing a skill that no longer exists",
    from: 'agentteams',
    field: 'skills',
    kind: 'array',
    to: 'skills',
    constraint: 'agent_team_skills_skill_id_fk',
  },
  {
    key: 'agentteams.knowledge',
    subject: "a team's knowledge referencing a library file that no longer exists",
    from: 'agentteams',
    field: 'knowledge',
    kind: 'array',
    to: 'libraryfiles',
    constraint: 'agent_team_knowledge_library_file_id_fk',
  },
  {
    key: 'agentreviews.agentId',
    subject: 'a review of an agent that no longer exists — READ this one, see the module comment',
    from: 'agentreviews',
    field: 'agentId',
    kind: 'scalar',
    to: 'agents',
    constraint: 'agent_reviews_agent_id_fk',
  },
  {
    key: 'eventstreamentries.sessionId',
    subject: 'an event referencing a session that no longer exists',
    from: 'eventstreamentries',
    field: 'sessionId',
    kind: 'scalar',
    to: 'agentsessions',
    constraint: 'event_stream_entries_session_id_fk',
  },
];

/** How many offending ids to carry back for investigation. Ids only. */
const SAMPLE_LIMIT = 20;

/**
 * A document addressed only by its `_id`, which may be an ObjectId OR a string.
 *
 * The driver's default type declares `_id: ObjectId`; a raw write around
 * Mongoose can leave a 24-hex string in a field the schema declares as an
 * ObjectId, and the whole point of matching both forms is not to trust that
 * declaration.
 */
interface LooselyKeyedDocument {
  _id: string | ObjectId;
}

function idsOf(document: Document, declaration: ReferenceDeclaration): unknown[] {
  const value = document[declaration.field];
  if (declaration.kind === 'array') return Array.isArray(value) ? value : [];
  return value === null || value === undefined ? [] : [value];
}

async function measureReference(
  db: Db,
  declaration: ReferenceDeclaration,
): Promise<{ finding: AuditFinding; scanned: number }> {
  /**
   * Two passes rather than a `$lookup`, because the question is "which ids do
   * not resolve" and a join answers "which documents pair up" — the difference
   * shows on the EMPTY side, where a `$lookup` yields an empty array that is
   * easy to read as a match. Collecting the referenced ids and then asking the
   * target collection which of them exist keeps the residual explicit: whatever
   * is left over is, by construction, the set nothing accounted for.
   */
  const referencing = db
    .collection(declaration.from)
    .find({ [declaration.field]: { $exists: true, $ne: null } }, { projection: { [declaration.field]: 1 } });

  const referencedBy = new Map<string, Set<string>>();
  let scanned = 0;

  for await (const document of referencing) {
    scanned += 1;
    const owner = String(document._id);
    for (const id of idsOf(document, declaration)) {
      if (id === null || id === undefined) continue;
      const key = String(id);
      const owners = referencedBy.get(key);
      if (owners) owners.add(owner);
      else referencedBy.set(key, new Set([owner]));
    }
  }

  const referenced = [...referencedBy.keys()];
  const live = new Set<string>();
  if (referenced.length > 0) {
    /**
     * BOTH forms are offered, and each carries a different half of the work —
     * removing either is not a tightening, it is a break.
     *
     * The map above is keyed by `String(id)` so that an ObjectId and its hex
     * spelling collapse to one entry, which means every key here is a string.
     * So the **ObjectId form is the PRIMARY match**: without it a collection
     * whose `_id` really is an ObjectId resolves nothing and EVERY reference
     * reads as dangling — a false positive across the entire dataset, verified
     * by deleting this line and watching four cases go red, including the two
     * that assert a clean result.
     *
     * The **string form** covers the narrower case: a raw write around Mongoose
     * can leave a 24-hex string in a field the schema declares as an ObjectId,
     * and a query offering only ObjectIds would call such a row dangling while
     * its target is present.
     */
    const candidates: (string | ObjectId)[] = [];
    for (const id of referenced) {
      candidates.push(id);
      if (/^[0-9a-fA-F]{24}$/.test(id)) candidates.push(new ObjectId(id));
    }
    /**
     * Typed with a permissive `_id` on purpose: the driver's default document
     * type declares `_id: ObjectId`, which is exactly the assumption this branch
     * exists to stop relying on.
     */
    const found = db
      .collection<LooselyKeyedDocument>(declaration.to)
      .find({ _id: { $in: candidates } }, { projection: { _id: 1 } });
    for await (const document of found) live.add(String(document._id));
  }

  const dangling = referenced.filter((id) => !live.has(id));
  const affectedDocuments = new Set<string>();
  for (const id of dangling) for (const owner of referencedBy.get(id) ?? []) affectedDocuments.add(owner);

  return {
    scanned,
    finding: {
      key: declaration.key,
      subject:
        `${declaration.subject} — ${dangling.length} dead target id(s) across ` +
        `${affectedDocuments.size} document(s); refused by ${declaration.constraint}`,
      // The number that matters for the backfill is how many ROWS will be
      // refused, which is one per (document, dangling id) pair rather than one
      // per dead target.
      count: dangling.reduce((total, id) => total + (referencedBy.get(id)?.size ?? 0), 0),
      sample: dangling.slice(0, SAMPLE_LIMIT),
    },
  };
}

export const danglingReferencesCheck: AuditCheck = {
  id: 'batch9-dangling-foreign-key-references',
  severity: 'blocking',
  conventionsSection: 'Foreign keys a legacy row will not satisfy — the EXPECTED failure of batch 9b',
  collections: [
    ...new Set(FOREIGN_KEY_REFERENCES.flatMap((r) => [r.from, r.to])),
  ].sort(),
  async run(db: Db): Promise<AuditCheckResult> {
    const findings: AuditFinding[] = [];
    let documentsScanned = 0;

    for (const declaration of FOREIGN_KEY_REFERENCES) {
      const { finding, scanned } = await measureReference(db, declaration);
      findings.push(finding);
      documentsScanned += scanned;
    }

    return {
      checkId: danglingReferencesCheck.id,
      severity: danglingReferencesCheck.severity,
      findings,
      documentsScanned,
    };
  },
};
