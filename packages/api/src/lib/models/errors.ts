import { AliaError, AliaErrorCode } from '../errors/error-codes.js';
import { redactUnsafeDetail } from '../errors/sanitize.js';

/**
 * A request named a model the catalogue does not offer for chat.
 *
 * Answered as HTTP 400 with the wire code `model_not_found` and `param:
 * 'model'`. The echo is the caller's own string, so only credential redaction
 * applies (`redactUnsafeDetail`), never route concealment.
 */
export class ModelNotFoundError extends AliaError {
  /** The OpenAI-style `error.code` this refusal is serialized with. */
  static readonly WIRE_CODE = 'model_not_found';

  constructor(readonly requested: string) {
    super({
      code: AliaErrorCode.INVALID_REQUEST,
      message: `Model not in the catalogue: ${requested}`,
      userMessage: redactUnsafeDetail(
        `"${requested}" is not an available model. List the models you can use at GET /catalogue.`,
      ),
      retryable: false,
      reason: 'model_not_found',
      httpStatus: 400,
    });
    this.name = 'ModelNotFoundError';
  }
}
