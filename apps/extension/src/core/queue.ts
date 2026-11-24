export class BoundedQueue {
  #queued = new Map<string, () => Promise<void>>();
  #running = new Set<string>();
  constructor(readonly concurrency: number, readonly capacity: number) {
    if (concurrency < 1 || capacity < concurrency) throw new Error('Invalid queue limits');
  }
  enqueue(id: string, run: () => Promise<void>): boolean {
    if (this.#queued.has(id) || this.#running.has(id) || this.size >= this.capacity) return false;
    this.#queued.set(id, run);
    this.#drain();
    return true;
  }
  cancel(id: string): void { this.#queued.delete(id); }
  clear(): void { this.#queued.clear(); }
  get size(): number { return this.#queued.size + this.#running.size; }
  get active(): number { return this.#running.size; }
  #drain(): void {
    while (this.#running.size < this.concurrency && this.#queued.size > 0) {
      const next = this.#queued.entries().next().value;
      if (!next) return;
      const [id, run] = next;
      this.#queued.delete(id);
      this.#running.add(id);
      void run().catch(() => {}).finally(() => { this.#running.delete(id); this.#drain(); });
    }
  }
}
