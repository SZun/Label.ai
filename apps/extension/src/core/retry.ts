import type { Binding, LocalDecision } from './protocol';

const RETRY_DELAYS = [1000, 4000] as const;

export class RetryBudget {
  #count = 0;
  #next = 0;

  ready(now = Date.now()): boolean {
    return now >= this.#next;
  }

  defer(now = Date.now()): boolean {
    if (this.#count >= RETRY_DELAYS.length) return false;
    this.#next = now + RETRY_DELAYS[this.#count++];
    return true;
  }

  reset() {
    this.#count = 0;
    this.#next = 0;
  }
}

export function retryableReply(binding: Binding, response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const result = response as Partial<LocalDecision>;
  return (
    result.instanceId === binding.instanceId &&
    result.generation === binding.generation &&
    result.requestId === binding.requestId &&
    result.shouldLabel === false &&
    (result.status === 'BUSY' || result.status === 'CANCELED' || result.status === 'FAILED')
  );
}
