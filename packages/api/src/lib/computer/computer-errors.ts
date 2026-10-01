/** A refusal from the computer host, or from waking it, with a stable code. */
export class ComputerHostError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ComputerHostError';
  }
}
