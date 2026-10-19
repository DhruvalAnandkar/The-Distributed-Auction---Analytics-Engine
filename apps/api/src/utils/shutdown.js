/**
 * Closes an asynchronous resource via callback or Promise.
 *
 * @param {Object} target - The resource object containing the close method.
 * @param {string} methodName - Name of the method ('close' or 'end').
 * @returns {Promise<void>}
 */
function closeResource(target, methodName) {
  if (!target || typeof target[methodName] !== 'function') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(err);
      } else {
        resolve();
      }
    };

    try {
      const result = target[methodName](done);
      if (result && typeof result.then === 'function') {
        result.then(() => done(), (err) => done(err));
      } else if (result === undefined && target[methodName].length === 0 && !settled) {
        done();
      }
    } catch (err) {
      done(err);
    }
  });
}

/**
 * Creates an idempotent graceful shutdown handler for HTTP server and database pool.
 *
 * @param {Object} [options]
 * @param {{ close: Function }} [options.server] - HTTP server instance with close() method.
 * @param {{ end: Function }} [options.db] - Database pool with end() method.
 * @param {number} [options.timeoutMs=10000] - Maximum duration in milliseconds before timing out.
 * @param {Console | { info?: Function, log?: Function, error?: Function }} [options.logger=console] - Logger interface.
 * @returns {(signal?: string) => Promise<void>} Idempotent async shutdown function.
 */
export function createShutdown({
  server,
  db,
  timeoutMs = 10000,
  logger = console,
} = {}) {
  let shutdownPromise = null;

  const log = (level, ...args) => {
    if (!logger) return;
    if (typeof logger[level] === 'function') {
      logger[level](...args);
    } else if (typeof logger.log === 'function') {
      logger.log(...args);
    }
  };

  return function shutdown(signal) {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = new Promise((resolve, reject) => {
      let timer;

      const timeoutPromise = new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => {
          rejectTimeout(new Error(`Shutdown timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const executeShutdown = async () => {
        log('info', `Graceful shutdown initiated${signal ? ` (${signal})` : ''}`);

        if (server && typeof server.close === 'function') {
          await closeResource(server, 'close');
          log('info', 'HTTP server closed');
        }

        if (db && typeof db.end === 'function') {
          await closeResource(db, 'end');
          log('info', 'Database connections closed');
        }

        log('info', 'Graceful shutdown completed successfully');
      };

      Promise.race([executeShutdown(), timeoutPromise])
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          log('error', `Shutdown failed: ${err.message}`);
          reject(err);
        });
    });

    return shutdownPromise;
  };
}

export default createShutdown;
