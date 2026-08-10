import { Router, type Request, type Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { createReport, DuplicateReportError } from '../lib/crowdsource/intake.js';
import { ReportCategory, ReportedType } from '../value-sets/report.js';
import { log } from '../lib/logger.js';

/**
 * `POST /reports` — a user tells Alia something is wrong.
 *
 * A 201 means the report was STORED, and — when its type has a subject provider —
 * that a durable promise to deliver it was stored in the same transaction. It does
 * not mean CrowdSource accepted anything, and the response deliberately does not
 * pretend otherwise: `delivery` says `queued` or `local`, and nothing here reports
 * a case id, because at this point there is none.
 *
 * Every reportable type is accepted, including the ones with no provider. A type
 * without one is stored with the reason recorded and never leaves — see
 * `lib/crowdsource/subjects/registry.ts` for why that is a missing provider rather
 * than a refused report.
 */

const router = Router();

const MAX_CATEGORIES = 3;
const MAX_DETAILS_LENGTH = 2_000;

interface ValidationFailure {
  status: number;
  error: string;
}

type Validated =
  | { ok: true; reportedType: ReportedType; reportedId: string; categories: ReportCategory[]; details?: string }
  | { ok: false; failure: ValidationFailure };

/**
 * Validate the request body without trusting any of it.
 *
 * `reportedId` is checked to be a non-empty STRING here and again in
 * `createReport`. That is not redundant: a truthiness check passes `{$ne: null}`,
 * and an operator reaching a `findOne` filter matches an unrelated row — so the
 * type is asserted at the boundary AND at the query, because the intake service is
 * exported and this route is not its only possible caller.
 */
function validate(body: unknown): Validated {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, failure: { status: 400, error: 'A request body is required.' } };
  }

  const reportedType: unknown = Reflect.get(body, 'reportedType');
  if (
    typeof reportedType !== 'string' ||
    !Object.values(ReportedType).includes(reportedType as ReportedType)
  ) {
    return {
      ok: false,
      failure: {
        status: 400,
        error: `'reportedType' must be one of: ${Object.values(ReportedType).join(', ')}.`,
      },
    };
  }

  const reportedId: unknown = Reflect.get(body, 'reportedId');
  if (typeof reportedId !== 'string' || reportedId.trim() === '') {
    return {
      ok: false,
      failure: { status: 400, error: "'reportedId' must be a non-empty string." },
    };
  }

  const rawCategories: unknown = Reflect.get(body, 'categories');
  if (!Array.isArray(rawCategories) || rawCategories.length === 0) {
    return {
      ok: false,
      failure: { status: 400, error: "'categories' must be a non-empty array." },
    };
  }
  if (rawCategories.length > MAX_CATEGORIES) {
    return {
      ok: false,
      failure: {
        status: 400,
        error: `'categories' must name at most ${MAX_CATEGORIES} categories.`,
      },
    };
  }
  const allowed = Object.values(ReportCategory);
  const categories: ReportCategory[] = [];
  for (const candidate of rawCategories) {
    if (typeof candidate !== 'string' || !allowed.includes(candidate as ReportCategory)) {
      return {
        ok: false,
        failure: {
          status: 400,
          error: `Each category must be one of: ${allowed.join(', ')}.`,
        },
      };
    }
    if (!categories.includes(candidate as ReportCategory)) {
      categories.push(candidate as ReportCategory);
    }
  }

  const rawDetails: unknown = Reflect.get(body, 'details');
  if (rawDetails !== undefined && typeof rawDetails !== 'string') {
    return { ok: false, failure: { status: 400, error: "'details' must be a string." } };
  }
  const details = rawDetails?.trim();

  return {
    ok: true,
    reportedType: reportedType as ReportedType,
    reportedId,
    categories,
    ...(details ? { details: details.slice(0, MAX_DETAILS_LENGTH) } : {}),
  };
}

router.post('/', authenticateToken, async (req: Request, res: Response) => {
  const reporter = req.user?.id;
  if (!reporter) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const validated = validate(req.body);
  if (!validated.ok) {
    return res.status(validated.failure.status).json({ error: validated.failure.error });
  }

  try {
    const result = await createReport({
      reporter,
      reportedType: validated.reportedType,
      reportedId: validated.reportedId,
      categories: validated.categories,
      ...(validated.details === undefined ? {} : { details: validated.details }),
    });

    return res.status(201).json({
      report: {
        id: result.report._id.toHexString(),
        reportedType: result.report.reportedType,
        reportedId: result.report.reportedId,
        categories: result.report.categories,
        status: result.report.status,
        createdAt: result.report.createdAt,
      },
      /**
       * What actually happened, in one word a client can branch on. `local` is not
       * a failure and must not be presented as one — it means Alia recorded the
       * report and has no route to community review for this kind of object.
       */
      delivery: result.outboxEventId === undefined ? 'local' : 'queued',
    });
  } catch (error: unknown) {
    if (error instanceof DuplicateReportError) {
      /**
       * 409 with the original report, not a silent success. A reporter who taps
       * twice should learn that Alia already has it, and a client that treated a
       * duplicate as a new report would show two receipts for one action.
       */
      return res.status(409).json({
        error: error.message,
        report: {
          id: String(error.existing._id),
          reportedType: error.existing.reportedType,
          reportedId: error.existing.reportedId,
          status: error.existing.status,
          createdAt: error.existing.createdAt,
        },
      });
    }
    if (error instanceof TypeError) {
      return res.status(400).json({ error: error.message });
    }
    log.general.error(
      { err: error, reportedType: validated.reportedType },
      'Error creating report',
    );
    return res.status(500).json({ error: 'Failed to create report' });
  }
});

export default router;
