import bcrypt from 'bcryptjs';
import { generateToken } from '../services/tokenService.js';
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
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
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
   * Verifies user credentials, generates an HS256 JWT, and returns
   * the token along with the user profile (omitting password hash).
   *
   * @param {import('express').Request<{}, {}, UserLoginPayload>} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const loginUser = async (req, res, next) => {
    const { email, password } = req.body;

    try {
      const result = await db.query(
        'SELECT id, username, email, password, created_at FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = result.rows[0];
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = generateToken(user);
      const { password: _, ...userWithoutPassword } = user;

      return res.status(200).json({
        token,
        user: userWithoutPassword,
      });
    } catch (err) {
      next(err);
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

  return { registerUser, loginUser, getCurrentUser, getUserProfile, updateProfile, changePassword, getMyAuctions };
}

export default createUserController;
