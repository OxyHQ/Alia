/*
 * Adapted from OpenMausBot server/repeat-detector.ts at
 * 0a17fa5759e7b77ce4c3a0326109ca342da9c260.
 * Copyright Milind Soni and OpenMausBot contributors. Apache-2.0.
 * Modified for Alia: turn terminology and an explicit hard-stop result.
 */

/** A tool and normalized arguments. Names alone are not repeat signatures. */
export function repeatedToolCallKey(tool: string, args: string | undefined): string | null {
  const normalized = (args ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === tool) return null;
  return `${tool}:${normalized}`;
}

export interface RepeatObservation {
  count: number;
  warning: boolean;
  stop: boolean;
}

/** Bounded per-turn detection for agents spending tokens while going in circles. */
export class RepeatDetector {
  private readonly counts = new Map<string, Map<string, number>>();
  private readonly warningAt: number;
  private readonly stopAt: number;
  private readonly maxKeysPerTurn: number;

  constructor(options: { warningAt?: number; stopAt?: number; maxKeysPerTurn?: number } = {}) {
    this.warningAt = options.warningAt ?? 3;
    this.stopAt = options.stopAt ?? 5;
    this.maxKeysPerTurn = options.maxKeysPerTurn ?? 256;
    if (!Number.isInteger(this.warningAt) || this.warningAt < 2) {
      throw new Error('warningAt must be an integer of at least 2');
    }
    if (!Number.isInteger(this.stopAt) || this.stopAt <= this.warningAt) {
      throw new Error('stopAt must be greater than warningAt');
    }
    if (!Number.isInteger(this.maxKeysPerTurn) || this.maxKeysPerTurn < 1) {
      throw new Error('maxKeysPerTurn must be a positive integer');
    }
  }

  record(turnId: string, key: string): RepeatObservation {
    let perTurn = this.counts.get(turnId);
    if (!perTurn) {
      perTurn = new Map();
      this.counts.set(turnId, perTurn);
    }
    const previous = perTurn.get(key);
    if (previous !== undefined) perTurn.delete(key);
    else if (perTurn.size >= this.maxKeysPerTurn) perTurn.delete(perTurn.keys().next().value!);
    const count = (previous ?? 0) + 1;
    perTurn.set(key, count);
    return { count, warning: count === this.warningAt, stop: count >= this.stopAt };
  }

  settle(turnId: string): void {
    this.counts.delete(turnId);
  }
}
