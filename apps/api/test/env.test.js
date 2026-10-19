import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/env.js';

const validSecret = '01234567890123456789012345678901';

const validEnv = {
  DB_HOST: 'localhost',
  DB_USER: 'postgres',
  DB_PASSWORD: 'secretpassword',
  DB_NAME: 'auction_db',
  JWT_SECRET: validSecret,
};

test('Valid env returns a frozen config with defaults applied', () => {
  const config = loadConfig(validEnv);

  assert.equal(Object.isFrozen(config), true);
  assert.equal(config.PORT, 5001);
  assert.equal(config.DB_PORT, 5432);
  assert.equal(config.DB_HOST, 'localhost');
  assert.equal(config.DB_USER, 'postgres');
  assert.equal(config.DB_PASSWORD, 'secretpassword');
  assert.equal(config.DB_NAME, 'auction_db');
  assert.equal(config.JWT_SECRET, validSecret);
  assert.equal(config.NODE_ENV, 'development');
  assert.equal(config.CORS_ORIGINS, undefined);
  assert.equal(config.ADMIN_TOKEN, undefined);

  // Object is deeply read-only
  assert.throws(() => {
    config.PORT = 8080;
  }, TypeError);
});

test('Explicit optional and override values are correctly populated and coerced', () => {
  const config = loadConfig({
    ...validEnv,
    PORT: '3000',
    DB_PORT: '5433',
    CORS_ORIGINS: 'https://example.com, https://app.example.com',
    ADMIN_TOKEN: 'admin-secret-token',
    NODE_ENV: 'staging',
  });

  assert.equal(config.PORT, 3000);
  assert.equal(config.DB_PORT, 5433);
  assert.equal(config.CORS_ORIGINS, 'https://example.com, https://app.example.com');
  assert.equal(config.ADMIN_TOKEN, 'admin-secret-token');
  assert.equal(config.NODE_ENV, 'staging');
});

test('Invalid env throws a single error naming every bad variable', () => {
  assert.throws(
    () => loadConfig({}),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Invalid environment configuration/);
      assert.match(err.message, /DB_HOST/);
      assert.match(err.message, /DB_USER/);
      assert.match(err.message, /DB_PASSWORD/);
      assert.match(err.message, /DB_NAME/);
      assert.match(err.message, /JWT_SECRET/);
      return true;
    }
  );
});

test('Multiple invalid fields are all reported in the single error message', () => {
  assert.throws(
    () =>
      loadConfig({
        PORT: 'not-a-number',
        DB_PORT: '999999',
        DB_HOST: '',
        DB_USER: '',
        DB_PASSWORD: '',
        DB_NAME: '',
        JWT_SECRET: 'short',
        ADMIN_TOKEN: 12345,
      }),
    (err) => {
      assert.match(err.message, /PORT/);
      assert.match(err.message, /DB_PORT/);
      assert.match(err.message, /DB_HOST/);
      assert.match(err.message, /DB_USER/);
      assert.match(err.message, /DB_PASSWORD/);
      assert.match(err.message, /DB_NAME/);
      assert.match(err.message, /JWT_SECRET/);
      assert.match(err.message, /ADMIN_TOKEN/);
      return true;
    }
  );
});

test('Short JWT_SECRET is rejected unless NODE_ENV=test', () => {
  // In development (default): short secret is rejected
  assert.throws(
    () => loadConfig({ ...validEnv, JWT_SECRET: 'too-short-secret' }),
    (err) => {
      assert.match(err.message, /JWT_SECRET/);
      assert.match(err.message, /at least 32 characters/);
      return true;
    }
  );

  // In production: short secret is rejected
  assert.throws(
    () => loadConfig({ ...validEnv, NODE_ENV: 'production', JWT_SECRET: 'too-short-secret' }),
    (err) => {
      assert.match(err.message, /JWT_SECRET/);
      assert.match(err.message, /at least 32 characters/);
      return true;
    }
  );

  // In NODE_ENV=test: short secret is accepted
  const testConfig = loadConfig({
    ...validEnv,
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret',
  });
  assert.equal(testConfig.JWT_SECRET, 'test-secret');
});

test('Missing JWT_SECRET is rejected even in NODE_ENV=test', () => {
  assert.throws(
    () => loadConfig({ ...validEnv, NODE_ENV: 'test', JWT_SECRET: '' }),
    /JWT_SECRET/
  );
  const withoutSecret = { ...validEnv, NODE_ENV: 'test' };
  delete withoutSecret.JWT_SECRET;
  assert.throws(() => loadConfig(withoutSecret), /JWT_SECRET/);
});

test('Secrets never appear in the error message', () => {
  const sensitiveJwtSecret = 'my-super-private-short-secret';
  assert.throws(
    () =>
      loadConfig({
        ...validEnv,
        NODE_ENV: 'production',
        JWT_SECRET: sensitiveJwtSecret,
      }),
    (err) => {
      assert.ok(!err.message.includes(sensitiveJwtSecret), 'Secret must not leak into error message');
      return true;
    }
  );
});

test('Port boundaries and coercion are enforced', () => {
  assert.throws(() => loadConfig({ ...validEnv, PORT: 0 }), /PORT/);
  assert.throws(() => loadConfig({ ...validEnv, PORT: -1 }), /PORT/);
  assert.throws(() => loadConfig({ ...validEnv, PORT: 65536 }), /PORT/);
  assert.throws(() => loadConfig({ ...validEnv, PORT: 3.14 }), /PORT/);
  assert.throws(() => loadConfig({ ...validEnv, DB_PORT: 0 }), /DB_PORT/);
  assert.throws(() => loadConfig({ ...validEnv, DB_PORT: 70000 }), /DB_PORT/);
});

test('Defaults to process.env when no argument is supplied', () => {
  const originalEnv = { ...process.env };
  try {
    process.env.DB_HOST = 'db.internal';
    process.env.DB_USER = 'dbuser';
    process.env.DB_PASSWORD = 'strongpassword';
    process.env.DB_NAME = 'production_db';
    process.env.JWT_SECRET = validSecret;
    process.env.NODE_ENV = 'production';
    delete process.env.PORT;
    delete process.env.DB_PORT;

    const config = loadConfig();
    assert.equal(config.DB_HOST, 'db.internal');
    assert.equal(config.PORT, 5001);
    assert.equal(config.DB_PORT, 5432);
  } finally {
    process.env = originalEnv;
  }
});

test('loadConfig handles null or undefined argument gracefully', () => {
  assert.throws(() => loadConfig(null), /Invalid environment configuration/);
});
