import bcrypt from 'bcryptjs';

/**
 * @typedef {Object} UserRegistrationPayload
 * @property {string} username - Desired unique username.
 * @property {string} email - Unique email address of the user.
 * @property {string} password - Raw, unhashed user password.
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

  return { registerUser };
}

export default createUserController;
