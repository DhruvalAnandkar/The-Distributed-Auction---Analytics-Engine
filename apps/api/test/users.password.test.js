import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const validToken = jwt.sign({ sub: 42, username: 'alice' }, process.env.JWT_SECRET);
const currentPasswordPlain = 'CurrentPass123!';
const currentPasswordHash = bcrypt.hashSync(currentPasswordPlain, 10);

const mockUserWithPassword = {
  id: 42,
  password: currentPasswordHash,
};

test('POST /api/users/me/password returns 401 without authorization header', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/me/password')
    .send({
      currentPassword: currentPasswordPlain,
      newPassword: 'NewValidPass123!',
    });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});

test('POST /api/users/me/password returns 401 with invalid token', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', 'Bearer malformed.or.invalid.token')
    .send({
      currentPassword: currentPasswordPlain,
      newPassword: 'NewValidPass123!',
    });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid or expired token' });
  assert.equal(db.calls.length, 0);
});

test('POST /api/users/me/password returns 401 when currentPassword is wrong', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE id/,
      rows: [mockUserWithPassword],
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      currentPassword: 'WrongPassword999!',
      newPassword: 'NewValidPass123!',
    });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid current password' });
  assert.equal(db.callsMatching(/UPDATE users/).length, 0);
});

test('POST /api/users/me/password returns 400 for weak newPassword (too short, too long, or no number/letter)', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  // Too short (< 8 chars)
  const resShort = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      currentPassword: currentPasswordPlain,
      newPassword: 'Short1',
    });
  assert.equal(resShort.status, 400);
  assert.equal(resShort.body.error, 'Validation failed');
  assert.ok(resShort.body.details.some((d) => d.field === 'newPassword'));

  // No number (only letters)
  const resNoNum = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      currentPassword: currentPasswordPlain,
      newPassword: 'onlylettersinpassword',
    });
  assert.equal(resNoNum.status, 400);
  assert.ok(resNoNum.body.details.some((d) => d.field === 'newPassword'));

  // No letter (only digits)
  const resNoLetter = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      currentPassword: currentPasswordPlain,
      newPassword: '1234567890',
    });
  assert.equal(resNoLetter.status, 400);
  assert.ok(resNoLetter.body.details.some((d) => d.field === 'newPassword'));

  // Too long (> 128 chars)
  const resLong = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      currentPassword: currentPasswordPlain,
      newPassword: `${'A'.repeat(125)}1234`,
    });
  assert.equal(resLong.status, 400);
  assert.ok(resLong.body.details.some((d) => d.field === 'newPassword'));

  assert.equal(db.calls.length, 0);
});

test('POST /api/users/me/password returns 400 when newPassword equals currentPassword in request body', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      currentPassword: currentPasswordPlain,
      newPassword: currentPasswordPlain,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.some((d) => d.field === 'newPassword'));
  assert.equal(db.calls.length, 0);
});

test('POST /api/users/me/password returns 400 when newPassword matches current password via bcrypt in database', async () => {
  const longBase = 'A'.repeat(70) + '1a';
  const currentPass = longBase + 'X';
  const newPass = longBase + 'Y';
  const hash = bcrypt.hashSync(currentPass, 10);

  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE id/,
      rows: [{ id: 42, password: hash }],
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      currentPassword: currentPass,
      newPassword: newPass,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'New password must be different from current password');
  assert.equal(db.callsMatching(/UPDATE users/).length, 0);
});

test('POST /api/users/me/password returns 400 when missing required fields', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const resMissingCurrent = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ newPassword: 'NewValidPass123!' });
  assert.equal(resMissingCurrent.status, 400);

  const resMissingNew = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ currentPassword: currentPasswordPlain });
  assert.equal(resMissingNew.status, 400);

  assert.equal(db.calls.length, 0);
});

test('POST /api/users/me/password returns 404 when user is not found in database', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE id/,
      rows: [],
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      currentPassword: currentPasswordPlain,
      newPassword: 'NewValidPass123!',
    });

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'User not found' });
});

test('POST /api/users/me/password succeeds with 204 and stores bcrypt hash of newPassword (cost 10)', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE id/,
      rows: [mockUserWithPassword],
    },
    {
      match: /UPDATE users SET password/,
      rows: [],
    },
  ]);
  const app = createApp({ db });

  const newPasswordPlain = 'BrandNewPassword2026!';

  const res = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      currentPassword: currentPasswordPlain,
      newPassword: newPasswordPlain,
    });

  assert.equal(res.status, 204);
  assert.equal(res.text, '');
  assert.deepEqual(res.body, {});

  const selectCalls = db.callsMatching(/SELECT .* FROM users WHERE id/);
  assert.equal(selectCalls.length, 1);
  assert.deepEqual(selectCalls[0].params, [42]);

  const updateCalls = db.callsMatching(/UPDATE users SET password/);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].params[1], 42);

  const storedHash = updateCalls[0].params[0];
  assert.notEqual(storedHash, newPasswordPlain);
  assert.match(storedHash, /^\$2[ab]\$10\$/);
  assert.ok(await bcrypt.compare(newPasswordPlain, storedHash));
});

test('POST /api/users/me/password returns 500 when database fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE id/,
      error: new Error('DB connection reset'),
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/me/password')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      currentPassword: currentPasswordPlain,
      newPassword: 'NewValidPass123!',
    });

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
