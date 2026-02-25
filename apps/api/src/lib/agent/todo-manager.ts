/**
 * TodoManager — Structured Task Tracking for Agent Sessions
 *
 * Implements Manus's "todo.md attention trick": the todo list is
 * serialized and injected at the END of the model's context on every
 * iteration. This keeps the agent's objectives in the model's most
 * recent attention window, preventing drift on long tasks.
 *
 * Key design:
 *   - Structured items (not a plain string)
 *   - Serializes as markdown checklist
 *   - Placed at context tail for maximum attention weight
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
  subtasks?: TodoItem[];
}

export interface TodoList {
  objective: string;
  items: TodoItem[];
}

export class TodoManager {
  private objective = '';
  private items: TodoItem[] = [];
  private nextId = 1;

  /** Set the overall objective */
  setObjective(objective: string): void {
    this.objective = objective;
  }

  /** Add a new todo item */
  addItem(text: string, status: TodoStatus = 'pending'): TodoItem {
    const item: TodoItem = { id: this.nextId++, text, status };
    this.items.push(item);
    return item;
  }

  /** Update an item's status */
  updateItem(id: number, status: TodoStatus): boolean {
    const item = this.findItem(id);
    if (!item) return false;
    item.status = status;
    return true;
  }

  /** Replace the entire todo list (for the model's updateTodo tool) */
  setItems(objective: string, items: Array<{ text: string; status: TodoStatus }>): void {
    this.objective = objective;
    this.items = items.map((item, i) => ({
      id: i + 1,
      text: item.text,
      status: item.status,
    }));
    this.nextId = this.items.length + 1;
  }

  /** Mark an item as completed */
  markDone(id: number): boolean {
    return this.updateItem(id, 'completed');
  }

  /** Mark an item as in progress */
  markInProgress(id: number): boolean {
    return this.updateItem(id, 'in_progress');
  }

  /** Get all items */
  getItems(): TodoItem[] {
    return this.items;
  }

  /** Get the todo list as structured data */
  toJSON(): TodoList {
    return {
      objective: this.objective,
      items: this.items.map(i => ({ ...i })),
    };
  }

  /** Load from persisted data */
  loadFromPersisted(data: TodoList): void {
    this.objective = data.objective;
    this.items = data.items;
    this.nextId = data.items.length > 0
      ? Math.max(...data.items.map(i => i.id)) + 1
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
   * Serialize as markdown — this is what gets injected into the model's context.
   * Format: markdown checklist with status indicators.
   */
  serialize(): string {
    if (this.items.length === 0 && !this.objective) return '';

    const lines: string[] = [];

    if (this.objective) {
      lines.push(`**Objective:** ${this.objective}`);
      lines.push('');
    }

    for (const item of this.items) {
      const checkbox = statusToCheckbox(item.status);
      lines.push(`${checkbox} ${item.text}`);

      if (item.subtasks) {
        for (const sub of item.subtasks) {
          const subCheckbox = statusToCheckbox(sub.status);
          lines.push(`  ${subCheckbox} ${sub.text}`);
        }
      }
    }

    if (this.items.length > 0) {
      lines.push('');
      lines.push(`Progress: ${this.progressSummary()}`);
    }

    return lines.join('\n');
  }

  private findItem(id: number): TodoItem | undefined {
    for (const item of this.items) {
      if (item.id === id) return item;
      if (item.subtasks) {
        const sub = item.subtasks.find(s => s.id === id);
        if (sub) return sub;
      }
    }
    return undefined;
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
