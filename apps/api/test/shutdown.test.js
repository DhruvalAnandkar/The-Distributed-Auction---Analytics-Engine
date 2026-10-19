import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createShutdown } from '../src/utils/shutdown.js';
import { createFakeDb } from './helpers/fakeDb.js';

test('shutdown calls server.close then db.end in order and resolves', async () => {
  const events = [];
  const server = {
    close(cb) {
      events.push('server.close:start');
      setTimeout(() => {
        events.push('server.close:end');
        cb();
      }, 10);
    },
  };
  const db = {
    end() {
      events.push('db.end:start');
      return new Promise((resolve) => {
        setTimeout(() => {
          events.push('db.end:end');
          resolve();
        }, 10);
      });
    },
  };

  const shutdown = createShutdown({ server, db, logger: false });
  await shutdown('SIGTERM');

  assert.deepEqual(events, [
    'server.close:start',
    'server.close:end',
    'db.end:start',
    'db.end:end',
  ]);
});

test('shutdown is idempotent and calls server.close then db.end exactly once when invoked concurrently', async () => {
  let serverCloseCalls = 0;
  let dbEndCalls = 0;

  const server = {
    close(cb) {
      serverCloseCalls += 1;
      setTimeout(cb, 10);
    },
  };
  const db = {
    async end() {
      dbEndCalls += 1;
    },
  };

  const shutdown = createShutdown({ server, db, logger: false });

  const [res1, res2, res3] = await Promise.all([
    shutdown('SIGTERM'),
    shutdown('SIGINT'),
    shutdown(),
  ]);

  assert.equal(serverCloseCalls, 1);
  assert.equal(dbEndCalls, 1);
  assert.equal(res1, undefined);
  assert.equal(res2, undefined);
  assert.equal(res3, undefined);
});

test('shutdown is idempotent and calls server.close then db.end exactly once when invoked sequentially', async () => {
  let serverCloseCalls = 0;
  let dbEndCalls = 0;

  const server = {
    close(cb) {
      serverCloseCalls += 1;
      cb();
    },
  };
  const db = {
    async end() {
      dbEndCalls += 1;
    },
  };

  const shutdown = createShutdown({ server, db, logger: false });

  await shutdown('SIGTERM');
  await shutdown('SIGINT');
  await shutdown();

  assert.equal(serverCloseCalls, 1);
  assert.equal(dbEndCalls, 1);
});

test('shutdown times out with a clear error if server.close hangs', async () => {
  let dbEndCalled = false;
  const server = {
    close(_cb) {
      // hangs, never invokes callback
    },
  };
  const db = {
    async end() {
      dbEndCalled = true;
    },
  };

  const shutdown = createShutdown({ server, db, timeoutMs: 50, logger: false });

  await assert.rejects(
    async () => {
      await shutdown('SIGTERM');
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out/i);
      assert.match(err.message, /50ms/);
      return true;
    }
  );

  assert.equal(dbEndCalled, false);
});

test('shutdown times out with a clear error if db.end hangs', async () => {
  let serverCloseCalled = false;
  const server = {
    close(cb) {
      serverCloseCalled = true;
      cb();
    },
  };
  const db = {
    end() {
      // hangs, returns pending promise
      return new Promise(() => {});
    },
  };

  const shutdown = createShutdown({ server, db, timeoutMs: 50, logger: false });

  await assert.rejects(
    async () => {
      await shutdown('SIGTERM');
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out/i);
      assert.match(err.message, /50ms/);
      return true;
    }
  );

  assert.equal(serverCloseCalled, true);
});

test('shutdown rejects if server.close yields an error', async () => {
  const server = {
    close(cb) {
      cb(new Error('server close failure'));
    },
  };
  const db = {
    async end() {},
  };

  const shutdown = createShutdown({ server, db, logger: false });

  await assert.rejects(
    async () => {
      await shutdown('SIGTERM');
    },
    { message: 'server close failure' }
  );
});

test('shutdown rejects if db.end yields an error', async () => {
  const server = {
    close(cb) {
      cb();
    },
  };
  const db = {
    async end() {
      throw new Error('db end failure');
    },
  };

  const shutdown = createShutdown({ server, db, logger: false });

  await assert.rejects(
    async () => {
      await shutdown('SIGTERM');
    },
    { message: 'db end failure' }
  );
});

test('shutdown works with Node http.Server and fakeDb', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, resolve));
  assert.equal(server.listening, true);

  const db = createFakeDb([]);
  let dbEndCalled = false;
  const originalEnd = db.end;
  db.end = async () => {
    dbEndCalled = true;
    return originalEnd.call(db);
  };

  const shutdown = createShutdown({ server, db, timeoutMs: 1000, logger: false });
  await shutdown('SIGTERM');

  assert.equal(server.listening, false);
  assert.equal(dbEndCalled, true);
});

test('shutdown logs lifecycle events through provided logger', async () => {
  const logs = [];
  const mockLogger = {
    info: (msg) => logs.push({ level: 'info', msg }),
    error: (msg) => logs.push({ level: 'error', msg }),
  };

  const server = { close: (cb) => cb() };
  const db = { end: async () => {} };

  const shutdown = createShutdown({ server, db, logger: mockLogger });
  await shutdown('SIGTERM');

  assert.ok(logs.some((l) => l.msg.includes('SIGTERM')));
  assert.ok(logs.some((l) => l.msg.includes('HTTP server closed')));
  assert.ok(logs.some((l) => l.msg.includes('Database connections closed')));
});

test('shutdown succeeds even if server or db is omitted', async () => {
  const shutdownOnlyDb = createShutdown({ db: { async end() {} }, logger: false });
  await shutdownOnlyDb();

  const shutdownOnlyServer = createShutdown({ server: { close: (cb) => cb() }, logger: false });
  await shutdownOnlyServer();

  const shutdownEmpty = createShutdown({ logger: false });
  await shutdownEmpty();
});

test('server.js registers SIGTERM and SIGINT signal handlers', () => {
  const serverFilePath = fileURLToPath(new URL('../src/server.js', import.meta.url));
  const serverContent = fs.readFileSync(serverFilePath, 'utf8');

  assert.match(serverContent, /createShutdown/);
  assert.match(serverContent, /process\.on\(\s*['"]SIGTERM['"]/);
  assert.match(serverContent, /process\.on\(\s*['"]SIGINT['"]/);
});
