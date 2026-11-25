export class BoundedQueue {
  #queued = new Map<string, () => Promise<void>>();
  #playback = new Map<string, () => Promise<void>>();
  #running = new Set<string>();
  constructor(
    readonly concurrency: number,
    readonly capacity: number,
    readonly reservedPlayback = 0,
  ) {
    if (
      concurrency < 1 ||
      capacity < concurrency ||
      reservedPlayback < 0 ||
      reservedPlayback >= capacity
    )
      throw new Error('Invalid queue limits');
  }
  enqueue(id: string, run: () => Promise<void>, priority?: 'playback'): boolean {
    const limit = priority ? this.capacity : this.capacity - this.reservedPlayback;
    if (this.has(id) || this.size >= limit) return false;
    (priority ? this.#playback : this.#queued).set(id, run);
    this.#drain();
    return true;
  }
  cancel(id: string): void {
    this.#queued.delete(id);
    this.#playback.delete(id);
  }
  clear(): void {
    this.#queued.clear();
    this.#playback.clear();
  }
  has(id: string): boolean {
    return this.#playback.has(id) || this.#queued.has(id) || this.#running.has(id);
  }
  get size(): number {
    return this.#playback.size + this.#queued.size + this.#running.size;
  }
  get active(): number {
    return this.#running.size;
  }
  #drain(): void {
    while (this.#running.size < this.concurrency) {
      const pending = this.#playback.size ? this.#playback : this.#queued;
      const next = pending.entries().next().value;
      if (!next) return;
      const [id, run] = next;
      pending.delete(id);
      this.#running.add(id);
      void run()
        .catch(() => {})
        .finally(() => {
          this.#running.delete(id);
          this.#drain();
        });
    }
  }
}
