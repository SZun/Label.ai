/**
 * Browser admission for the currently focused document. A page never starts
 * capture from an optimistic local setting: the background must confirm it has
 * the native host grant, and an unreadable or stale grant expires quickly.
 */
export class ScanningPermission {
  private validUntil = 0;
  private admitted = false;
  private pending = false;
  private generation = 0;

  constructor(
    private readonly request: () => Promise<unknown>,
    private readonly now = () => performance.now(),
  ) {}

  get allowed(): boolean {
    return this.validUntil > this.now();
  }

  /** Already-submitted work remains under the worker's own permission checks while
   * a renewal is delayed. Only allowed authorizes new capture or badge display. */
  get lastAdmission(): boolean {
    return this.admitted;
  }

  invalidate(): void {
    this.admitted = false;
    this.validUntil = 0;
    this.generation++;
  }

  async refresh(): Promise<void> {
    if (this.pending) return;
    const generation = this.generation;
    this.pending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        this.request(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 8_000);
        }),
      ]);
      if (generation === this.generation) {
        const allowed =
          typeof reply === 'object' &&
          reply !== null &&
          'allowed' in reply &&
          reply.allowed === true;
        if (reply !== undefined) this.admitted = allowed;
        this.validUntil = allowed ? this.now() + 10_000 : 0;
      }
    } catch {
      if (generation === this.generation) this.validUntil = 0;
    } finally {
      clearTimeout(timer);
      this.pending = false;
    }
  }
}
