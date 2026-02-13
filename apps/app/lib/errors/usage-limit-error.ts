export type UsageLimitType = 'credits' | 'rate_limit';

export interface UsageLimitDetails {
  type: UsageLimitType;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  suggestedAction?: 'upgrade' | 'wait';
  limitType?: string;
  current?: number;
  limit?: number;
  tier?: string;
}

export class UsageLimitError extends Error {
  public details: UsageLimitDetails;

  constructor(details: UsageLimitDetails) {
    super(details.message);
    this.name = 'UsageLimitError';
    this.details = details;
  }

  get isCreditsError(): boolean {
    return this.details.type === 'credits';
  }

  get isRateLimitError(): boolean {
    return this.details.type === 'rate_limit';
  }

  get shouldShowUpgrade(): boolean {
    return this.details.suggestedAction === 'upgrade' || this.details.type === 'credits';
  }
}
