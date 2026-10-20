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

  return { registerUser, loginUser, getCurrentUser, getUserProfile, updateProfile };
}

export default createUserController;
