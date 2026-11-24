/** Held from the first video frame until its queued inference releases all frame buffers. */
export class CaptureSlots {
  readonly #owners = new Set<string>();
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid capture slot limit');
  }
  acquire(id: string): boolean {
    if (this.#owners.has(id) || this.#owners.size >= this.limit) return false;
    this.#owners.add(id);
    return true;
  }
  release(id: string): void {
    this.#owners.delete(id);
  }
}
