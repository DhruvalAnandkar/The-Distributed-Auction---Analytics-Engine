import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

/**
 * Computes SHA-256 hash of a string in hex format.
 *
 * @param {string} token
 * @returns {string} 64-character hex hash.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generates an opaque cryptographically secure refresh token string.
 *
 * @returns {string}
 */
export function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generates an HS256 JWT for the given user.
 *
 * @param {{ id: number | string, username: string }} user - User object containing id and username.
 * @returns {string} Signed JWT.
 * @throws {Error} If JWT_SECRET environment variable is missing.
 */
export function generateToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: '1h',
    }
  );
}

/**
 * Verifies an HS256 JWT using JWT_SECRET.
 *
 * @param {string} token - JWT token string.
 * @returns {import('jsonwebtoken').JwtPayload | string} Decoded payload.
 * @throws {Error} If JWT_SECRET is missing or token is invalid.
 */
export function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  return jwt.verify(token, secret, { algorithms: ['HS256'] });
}

export default {
  generateToken,
  verifyToken,
  hashToken,
  generateRefreshToken,
};
