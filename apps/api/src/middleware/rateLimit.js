/**
 * @fileoverview In-memory token-bucket rate limiter middleware.
 */

import AppError from '../utils/AppError.js';

/**
 * Creates an Express rate limiting middleware using a token-bucket algorithm.
 *
 * @param {Object} options
 * @param {number} options.capacity - Maximum tokens the bucket can hold.
 * @param {number} options.refillPerSecond - Number of tokens added per second.
 * @param {(req: import('express').Request) => string} options.key - Function to extract bucket key from request.
 * @param {() => number} [options.now=Date.now] - Optional function returning current timestamp in milliseconds.
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter({ capacity, refillPerSecond, key, now = Date.now }) {
  const buckets = new Map();

  // Periodic cleanup of stale buckets every 60 seconds to prevent unbounded memory growth
  const cleanupInterval = setInterval(() => {
    const currentTime = now();
    const staleThresholdMs = 15 * 60 * 1000; // 15 minutes of inactivity

    for (const [bucketKey, bucket] of buckets.entries()) {
      if (currentTime - bucket.lastRefill > staleThresholdMs) {
        buckets.delete(bucketKey);
      }
    }
  }, 60000);

  // Unref so the interval doesn't prevent test runner or node process exit
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return (req, res, next) => {
    const bucketKey = key(req);
    const currentTime = now();

    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        tokens: capacity,
        lastRefill: currentTime,
      };
      buckets.set(bucketKey, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsedSeconds = (currentTime - bucket.lastRefill) / 1000;
    if (elapsedSeconds > 0) {
      const tokensToAdd = elapsedSeconds * refillPerSecond;
      bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = currentTime;
    }

    if (bucket.tokens < 1) {
      // Calculate exact seconds needed to accumulate at least 1 token
      const deficit = 1 - bucket.tokens;
      const secondsNeeded = Math.ceil(deficit / refillPerSecond);
      res.setHeader('Retry-After', String(secondsNeeded));
      return next(new AppError(429, 'Too many requests, please try again later'));
    }

    bucket.tokens -= 1;
    next();
  };
}

export default createRateLimiter;
