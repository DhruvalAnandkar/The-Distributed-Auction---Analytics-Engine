import bcrypt from 'bcryptjs';
import { generateToken } from '../services/tokenService.js';

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

  return { registerUser, loginUser };
}

export default createUserController;
