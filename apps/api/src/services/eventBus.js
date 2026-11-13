import { EventEmitter } from 'node:events';

/**
 * Creates a new EventEmitter instance for real-time event broadcasting.
 *
 * @returns {import('node:events').EventEmitter}
 */
export function createEventBus() {
  return new EventEmitter();
}

/**
 * Shared default EventBus instance.
 */
export const eventBus = createEventBus();

export default eventBus;
