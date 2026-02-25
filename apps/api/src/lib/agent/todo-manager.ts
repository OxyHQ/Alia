/**
 * TodoManager — Structured Task Tracking for Agent Sessions
 *
 * Implements Manus's "todo.md attention trick": the todo list is
 * serialized and injected at the END of the model's context on every
 * iteration. This keeps the agent's objectives in the model's most
 * recent attention window, preventing drift on long tasks.
 *
 * v2: Simplified interface — items are plain strings, status tracked internally.
 * The agent sends string[] items and completed_items indices. No more
 * { text, status } objects that caused schema validation failures across providers.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
}

export interface TodoList {
  objective: string;
  items: TodoItem[];
}

export class TodoManager {
  private objective = '';
  private items: TodoItem[] = [];
  private nextId = 1;

  /**
   * Update the plan from simple string arrays (new v2 interface).
   * Items are strings. completed_items marks items by 1-based index as done.
   * The first non-completed item is automatically marked in_progress.
   */
  update(objective?: string, items?: string[], completedItems?: number[]): void {
    if (objective !== undefined) {
      this.objective = objective;
    }

    if (items && items.length > 0) {
      // Replace entire item list with new strings
      this.items = items.map((text, i) => ({
        id: i + 1,
        text,
        status: 'pending' as TodoStatus,
      }));
      this.nextId = this.items.length + 1;
    }

    // Mark completed items (1-based indices)
    if (completedItems) {
      for (const idx of completedItems) {
        const item = this.items.find(i => i.id === idx);
        if (item) item.status = 'completed';
      }
    }

    // Auto-mark first pending item as in_progress
    const firstPending = this.items.find(i => i.status === 'pending');
    if (firstPending) {
      // Only if no item is already in_progress
      const hasInProgress = this.items.some(i => i.status === 'in_progress');
      if (!hasInProgress) {
        firstPending.status = 'in_progress';
      }
    }
  }

  /** Legacy: Replace the entire todo list with structured items */
  setItems(objective: string, items: Array<{ text: string; status: TodoStatus }>): void {
    this.objective = objective;
    this.items = items.map((item, i) => ({
      id: i + 1,
      text: item.text,
      status: item.status,
    }));
    this.nextId = this.items.length + 1;
  }

  /** Set the overall objective */
  setObjective(objective: string): void {
    this.objective = objective;
  }

  /** Mark an item as completed by id */
  markDone(id: number): boolean {
    const item = this.items.find(i => i.id === id);
    if (!item) return false;
    item.status = 'completed';
    return true;
  }

  /** Get all items */
  getItems(): TodoItem[] {
    return this.items;
  }

  /** Get the todo list as structured data (for session persistence) */
  toJSON(): TodoList {
    return {
      objective: this.objective,
      items: this.items.map(i => ({ ...i })),
    };
  }

  /** Load from persisted data */
  loadFromPersisted(data: TodoList): void {
    this.objective = data.objective || '';
    this.items = (data.items || []).map(i => ({
      id: i.id,
      text: i.text || '',
      status: i.status || 'pending',
    }));
    this.nextId = this.items.length > 0
      ? Math.max(...this.items.map(i => i.id)) + 1
      : 1;
  }

  /** Check if there are any pending items */
  hasPending(): boolean {
    return this.items.some(i => i.status === 'pending' || i.status === 'in_progress');
  }

  /** Progress summary: "3/7 completed" */
  progressSummary(): string {
    const total = this.items.length;
    const completed = this.items.filter(i => i.status === 'completed').length;
    return `${completed}/${total} completed`;
  }

  /**
   * Serialize as markdown — injected into the model's context at the tail.
   */
  serialize(): string {
    if (this.items.length === 0 && !this.objective) return '';

    const lines: string[] = [];

    if (this.objective) {
      lines.push(`**Objective:** ${this.objective}`);
      lines.push('');
    }

    for (const item of this.items) {
      lines.push(`${statusToCheckbox(item.status)} ${item.text}`);
    }

    if (this.items.length > 0) {
      lines.push('');
      lines.push(`Progress: ${this.progressSummary()}`);
    }

    return lines.join('\n');
  }
}

function statusToCheckbox(status: TodoStatus): string {
  switch (status) {
    case 'completed':   return '- [x]';
    case 'in_progress': return '- [~]';
    case 'blocked':     return '- [!]';
    case 'pending':     return '- [ ]';
  }
}
