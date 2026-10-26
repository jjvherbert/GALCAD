// Desfazer/refazer por instantâneos imutáveis do documento (documentos pequenos: JSON).
export interface HistoryEntry<T> {
  state: T;
  label: string;
}

export class History<T> {
  private past: HistoryEntry<T>[] = [];
  private future: HistoryEntry<T>[] = [];

  private current: HistoryEntry<T>;
  private readonly limit: number;

  constructor(initial: HistoryEntry<T>, limit = 200) {
    this.current = initial;
    this.limit = limit;
  }

  get state(): T { return this.current.state; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  get undoLabel() { return this.current.label; }
  get redoLabel() { return this.future.at(-1)?.label; }

  /** Regista um novo estado. `merge` junta alterações contínuas (ex.: arrastar) numa só entrada. */
  push(state: T, label: string, merge = false) {
    if (merge && this.past.length && this.current.label === label) {
      this.current = { state, label };
    } else {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
      this.current = { state, label };
    }
    this.future = [];
  }

  undo(): T | undefined {
    const prev = this.past.pop();
    if (!prev) return undefined;
    this.future.push(this.current);
    this.current = prev;
    return prev.state;
  }

  redo(): T | undefined {
    const next = this.future.pop();
    if (!next) return undefined;
    this.past.push(this.current);
    this.current = next;
    return next.state;
  }

  reset(state: T, label = "Abrir") {
    this.past = [];
    this.future = [];
    this.current = { state, label };
  }
}
