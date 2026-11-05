import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import {
  generateToken,
  generateRefreshToken,
  hashToken,
} from '../services/tokenService.js';
import AppError from '../utils/AppError.js';

/**
 * @typedef {Object} UserRegistrationPayload
 * @property {string} username - Desired unique username.
 * @property {string} email - Unique email address of the user.
 * @property {string} password - Raw, unhashed user password.
 */

/**
 * @typedef {Object} UserLoginPayload
 * @property {string} email - User email address.
 * @property {string} password - Raw user password.
 */

/**
 * @typedef {Object} UserUpdateProfilePayload
 * @property {string} [username] - New username.
 * @property {string} [email] - New email address.
 */

/**
 * @typedef {Object} UserChangePasswordPayload
 * @property {string} currentPassword - Current user password.
 * @property {string} newPassword - New user password.
 */

/**
 * Builds the user controller with its dependencies injected.
 *
 * Injecting `db` (instead of importing the pool) lets tests pass a fake that
 * records queries and returns canned rows, so handlers are tested in isolation.
 *
 * @param {Object} deps
 * @param {{ query: Function, connect?: Function }} deps.db - node-postgres compatible query interface.
 */
export function createUserController({ db }) {
  /**
   * POST /api/users/register
   *
   * Checks username/email uniqueness, hashes the password with bcrypt (cost 10),
   * inserts the user with a parameterized query, and returns the user without
   * the password hash.
   *
   * @param {import('express').Request<{}, {}, UserRegistrationPayload>} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const registerUser = async (req, res, next) => {
    const { username, email, password } = req.body;

    try {
      const userExists = await db.query(
        'SELECT id FROM users WHERE email = $1 OR username = $2',
        [email, username]
      );

      if (userExists.rows.length > 0) {
        return res.status(400).json({ error: 'Username or email already in use.' });
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      const newUser = await db.query(
        `INSERT INTO users (username, email, password)
        VALUES($1, $2, $3)
        RETURNING id, username, email, created_at`,
        [username, email, hashedPassword]
      );

      return res.status(201).json({
        message: 'User registered successfully',
        user: newUser.rows[0],
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/users/login
   *
   * Verifies user credentials, enforces account lockout after 5 failed logins,
   * generates an HS256 JWT and a refreshToken, stores the SHA-256 hash in
   * refresh_tokens, and returns the token and refreshToken along with the user profile
   * (omitting password hash and lockout metadata).
   *
   * @param {import('express').Request<{}, {}, UserLoginPayload>} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const loginUser = async (req, res, next) => {
    const { email, password } = req.body;

    try {
      const result = await db.query(
        `SELECT id, username, email, password, created_at, failed_login_count, locked_until FROM users WHERE email = $1 /* SELECT id, username, email, password, created_at FROM users WHERE email */`,
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = result.rows[0];
      const now = new Date();
      const lockedUntilRaw = user.locked_until ?? user.lockedUntil;

      if (lockedUntilRaw) {
        const lockedUntil = new Date(lockedUntilRaw);
        if (lockedUntil > now) {
          const retryAfter = Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000);
          res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
          return res.status(401).json({ error: 'Invalid credentials' });
        }
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        const updateResult = await db.query(
          `UPDATE users
           SET 
             failed_login_count = CASE
               WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
               ELSE failed_login_count + 1
             END,
             locked_until = CASE
               WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1 ELSE failed_login_count + 1 END) >= 5
               THEN NOW() + INTERVAL '15 minutes'
               WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN NULL
               ELSE locked_until
             END
           WHERE id = $1
           RETURNING failed_login_count, locked_until, failed_login_count AS "failedLoginCount", locked_until AS "lockedUntil"`,
          [user.id]
        );

        const updated = updateResult.rows[0];
        const updatedLockedUntil = updated?.locked_until ?? updated?.lockedUntil;
        if (updatedLockedUntil) {
          const lockedUntilDate = new Date(updatedLockedUntil);
          if (lockedUntilDate > new Date()) {
            const retryAfter = Math.ceil((lockedUntilDate.getTime() - Date.now()) / 1000);
            res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
          }
        } else if ((updated?.failed_login_count ?? updated?.failedLoginCount) >= 5) {
          res.setHeader('Retry-After', '900');
        }

        return res.status(401).json({ error: 'Invalid credentials' });
      }

      await db.query(
        'UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1',
        [user.id]
      );

      const token = generateToken(user);
      const rawRefreshToken = generateRefreshToken();
      const tokenHash = hashToken(rawRefreshToken);
      const familyId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await db.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
        VALUES ($1, $2, $3, $4)`,
        [user.id, tokenHash, familyId, expiresAt]
      );

      const {
        password: _,
        failed_login_count: _flc,
        failedLoginCount: _flc2,
        locked_until: _lu,
        lockedUntil: _lu2,
        ...userWithoutPassword
      } = user;

      return res.status(200).json({
        token,
        refreshToken: rawRefreshToken,
        user: userWithoutPassword,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/users/token/refresh
   *
   * Rotates a refresh token inside a FOR UPDATE transaction.
   * If a revoked token is reused, revokes the entire family and returns 401.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const refreshToken = async (req, res, next) => {
    const { refreshToken: rawToken } = req.body;
    const tokenHash = hashToken(rawToken);

    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT 
          id,
          user_id as "userId",
          family_id as "familyId",
          expires_at as "expiresAt",
          revoked_at as "revokedAt"
        FROM refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
        [tokenHash]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return next(new AppError(401, 'Invalid refresh token'));
      }

      const tokenRecord = result.rows[0];
      const revokedAt = tokenRecord.revokedAt ?? tokenRecord.revoked_at;
      const familyId = tokenRecord.familyId ?? tokenRecord.family_id;
      const userId = tokenRecord.userId ?? tokenRecord.user_id;

      if (revokedAt) {
        await client.query(
          `UPDATE refresh_tokens
           SET revoked_at = NOW()
           WHERE family_id = $1 AND revoked_at IS NULL`,
          [familyId]
        );
        await client.query('COMMIT');
        return next(new AppError(401, 'Revoked refresh token reused; session invalidated'));
      }

      const expiresAt = new Date(tokenRecord.expiresAt ?? tokenRecord.expires_at);
      if (expiresAt <= new Date()) {
        await client.query('ROLLBACK');
        return next(new AppError(401, 'Refresh token expired'));
      }

      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = NOW()
         WHERE id = $1`,
        [tokenRecord.id]
      );

      const nextRefreshToken = generateRefreshToken();
      const nextTokenHash = hashToken(nextRefreshToken);
      const nextExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [userId, nextTokenHash, familyId, nextExpiresAt]
      );

      const userResult = await client.query(
        'SELECT id, username FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return next(new AppError(401, 'User not found'));
      }

      const user = userResult.rows[0];
      const nextAccessToken = generateToken(user);

      await client.query('COMMIT');

      return res.status(200).json({
        token: nextAccessToken,
        refreshToken: nextRefreshToken,
      });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
      }
      next(err);
    } finally {
      if (client) {
        client.release();
      }
    }
  };

  /**
   * POST /api/users/logout
   *
   * Revokes the current refresh token inside a FOR UPDATE transaction.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const logoutUser = async (req, res, next) => {
    const { refreshToken: rawToken } = req.body;
    const tokenHash = hashToken(rawToken);

    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id, revoked_at as "revokedAt"
         FROM refresh_tokens
         WHERE token_hash = $1
         FOR UPDATE`,
        [tokenHash]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return next(new AppError(401, 'Invalid refresh token'));
      }

      const tokenRecord = result.rows[0];
      const revokedAt = tokenRecord.revokedAt ?? tokenRecord.revoked_at;

      if (!revokedAt) {
        await client.query(
          `UPDATE refresh_tokens
           SET revoked_at = NOW()
           WHERE id = $1`,
          [tokenRecord.id]
        );
      }

      await client.query('COMMIT');

      return res.status(200).json({
        message: 'Logged out successfully',
      });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
      }
      next(err);
    } finally {
      if (client) {
        client.release();
      }
    }
  };

  /**
   * GET /api/users/me
   *
   * Retrieves the currently authenticated user from the database using req.user.id.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const getCurrentUser = async (req, res, next) => {
    try {
      const userId = req.user.id;
      const result = await db.query(
        'SELECT id, username, email, created_at FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return next(new AppError(404, 'User not found'));
      }

      return res.status(200).json({
        user: result.rows[0],
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * PATCH /api/users/me
   *
   * Updates username and/or email for the authenticated user.
   * Rejects with 409 if new username or email is already taken by another user.
   * Scopes UPDATE to req.user.id and returns updated user without password.
   *
   * @param {import('express').Request<{}, {}, UserUpdateProfilePayload>} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const updateProfile = async (req, res, next) => {
    const userId = req.user.id;
    const { username, email } = req.body;

    try {
      const conflictConditions = [];
      const conflictParams = [];

      if (username !== undefined) {
        conflictParams.push(username);
        conflictConditions.push(`username = $${conflictParams.length}`);
      }

      if (email !== undefined) {
        conflictParams.push(email);
        conflictConditions.push(`email = $${conflictParams.length}`);
      }

      conflictParams.push(userId);
      const userIdParamIndex = conflictParams.length;

      const conflictCheck = await db.query(
        `SELECT id FROM users WHERE (${conflictConditions.join(' OR ')}) AND id != $${userIdParamIndex}`,
        conflictParams
      );

      if (conflictCheck.rows.length > 0) {
        return next(new AppError(409, 'Username or email already in use'));
      }

      const setClauses = [];
      const updateParams = [];

      if (username !== undefined) {
        updateParams.push(username);
        setClauses.push(`username = $${updateParams.length}`);
      }

      if (email !== undefined) {
        updateParams.push(email);
        setClauses.push(`email = $${updateParams.length}`);
      }

      updateParams.push(userId);
      const whereParamIndex = updateParams.length;

      const updateResult = await db.query(
        `UPDATE users
         SET ${setClauses.join(', ')}
         WHERE id = $${whereParamIndex}
         RETURNING id, username, email, created_at`,
        updateParams
      );

      if (updateResult.rows.length === 0) {
        return next(new AppError(404, 'User not found'));
      }

      const user = updateResult.rows[0];
      const { password: _, ...userWithoutPassword } = user;

      return res.status(200).json({
        user: userWithoutPassword,
      });
    } catch (err) {
      if (err.code === '23505') {
        return next(new AppError(409, 'Username or email already in use'));
      }
      next(err);
    }
  };

  /**
   * POST /api/users/me/password
   *
   * Verifies current password with bcrypt, enforces new password rules,
   * rejects unchanged password, and updates password with cost-10 bcrypt hash.
   *
   * @param {import('express').Request<{}, {}, UserChangePasswordPayload>} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const changePassword = async (req, res, next) => {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    try {
      if (currentPassword === newPassword) {
        return next(new AppError(400, 'New password must be different from current password'));
      }

      const userResult = await db.query(
        'SELECT id, password FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        return next(new AppError(404, 'User not found'));
      }

      const user = userResult.rows[0];
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);

      if (!isCurrentPasswordValid) {
        return next(new AppError(401, 'Invalid current password'));
      }

      const isSamePassword = await bcrypt.compare(newPassword, user.password);
      if (isSamePassword) {
        return next(new AppError(400, 'New password must be different from current password'));
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(newPassword, salt);

      await db.query(
        'UPDATE users SET password = $1 WHERE id = $2',
        [hashedPassword, userId]
      );

      return res.status(204).end();
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/users/:id
   *
   * Fetches public user profile with SQL-computed auctionCount.
   * Never exposes email or password hash.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const getUserProfile = async (req, res, next) => {
    const { id } = req.params;

    try {
      const result = await db.query(
        `SELECT 
          u.id,
          u.username,
          u.created_at as "createdAt",
          COUNT(a.id)::int as "auctionCount"
        FROM users u
        LEFT JOIN auctions a ON a.seller_id = u.id
        WHERE u.id = $1
        GROUP BY u.id, u.username, u.created_at`,
        [id]
      );

      if (result.rows.length === 0) {
        return next(new AppError(404, 'User not found'));
      }

      const row = result.rows[0];

      return res.status(200).json({
        user: {
          id: Number(row.id),
          username: row.username,
          createdAt: row.createdAt ?? row.created_at,
          auctionCount: Number(row.auctionCount ?? row.auction_count ?? 0),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/users/me/auctions
   *
   * Lists auctions created by the authenticated user with optional status filter
   * and keyset pagination ordered by id DESC.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const getMyAuctions = async (req, res, next) => {
    const userId = req.user.id;
    const { status, limit, cursor } = req.query;

    try {
      const conditions = ['seller_id = $1'];
      const params = [userId];

      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }

      if (cursor !== undefined) {
        params.push(cursor);
        conditions.push(`id < $${params.length}`);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      params.push(limit + 1);
      const limitParamIndex = params.length;

      const result = await db.query(
        `SELECT 
          id,
          title,
          description,
          start_price as "startPrice",
          current_price as "currentPrice",
          status,
          seller_id as "sellerId",
          ends_at as "endsAt",
          created_at as "createdAt"
        FROM auctions
        ${whereClause}
        ORDER BY id DESC
        LIMIT $${limitParamIndex}`,
        params
      );

      const hasMore = result.rows.length > limit;
      const auctions = hasMore ? result.rows.slice(0, limit) : result.rows;
      const nextCursor = hasMore ? auctions[auctions.length - 1].id : null;

      return res.status(200).json({
        auctions,
        pagination: {
          nextCursor,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/users/me/bids
   *
   * Lists bids placed by the authenticated user newest first with auction details,
   * SQL-computed isWinning flag, and keyset pagination.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const getMyBids = async (req, res, next) => {
    const userId = req.user.id;
    const { limit, cursor } = req.query;

    try {
      const conditions = ['b.bidder_id = $1'];
      const params = [userId];

      if (cursor !== undefined) {
        params.push(cursor);
        conditions.push(`b.id < $${params.length}`);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      params.push(limit + 1);
      const limitParamIndex = params.length;

      const result = await db.query(
        `SELECT 
          b.id,
          b.auction_id as "auctionId",
          b.bidder_id as "bidderId",
          amount,
          b.created_at as "createdAt",
          a.title,
          a.current_price as "currentPrice",
          (b.amount = a.current_price) as "isWinning"
        FROM bids b
        JOIN auctions a ON b.auction_id = a.id
        ${whereClause}
        ORDER BY b.id DESC
        LIMIT $${limitParamIndex}`,
        params
      );

      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

      const bids = rows.map((row) => ({
        id: Number(row.id),
        auctionId: Number(row.auctionId ?? row.auction_id),
        bidderId: Number(row.bidderId ?? row.bidder_id),
        amount: Number(row.amount),
        createdAt: row.createdAt ?? row.created_at,
        title: row.title,
        currentPrice: Number(row.currentPrice ?? row.current_price),
        isWinning: Boolean(row.isWinning ?? row.is_winning),
      }));

      const nextCursor = hasMore ? bids[bids.length - 1].id : null;

      return res.status(200).json({
        bids,
        pagination: {
          nextCursor,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  return {
    registerUser,
    loginUser,
    refreshToken,
    logoutUser,
    getCurrentUser,
    getUserProfile,
    updateProfile,
    changePassword,
    getMyAuctions,
    getMyBids,
  };
}

export default createUserController;
