import { verifyToken } from '../services/tokenService.js';

/**
 * Extracts requesting user ID from express request object, either from req.user
 * or by parsing Authorization Bearer token header if present.
 *
 * @param {import('express').Request} req
 * @returns {number|string|null} User ID if authenticated/valid token, null otherwise.
 */
export function getUserIdFromReq(req) {
  if (!req) return null;
  if (req.user && req.user.id !== undefined && req.user.id !== null) {
    return req.user.id;
  }
  const authHeader = req.headers?.authorization;
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    if (token) {
      try {
        const decoded = verifyToken(token);
        return decoded?.sub ?? null;
      } catch (_) {
        // invalid token
      }
    }
  }
  return null;
}

/**
 * Formats an auction object for JSON response, handling reserve price visibility.
 *
 * @param {Object} rawAuction - Raw auction object from DB or cache.
 * @param {number|string|null} [userId] - Optional ID of the requesting user.
 * @returns {Object} Formatted auction object.
 */
export function formatAuction(rawAuction, userId = null) {
  if (!rawAuction) return rawAuction;

  const hasReserveField =
    rawAuction.reservePrice !== undefined || rawAuction.reserve_price !== undefined;

  if (!hasReserveField) {
    return rawAuction;
  }

  const sellerId = Number(rawAuction.sellerId ?? rawAuction.seller_id);
  const startPrice =
    typeof rawAuction.startPrice === 'number'
      ? rawAuction.startPrice
      : Number(rawAuction.startPrice ?? rawAuction.start_price);
  const currentPrice =
    typeof rawAuction.currentPrice === 'number'
      ? rawAuction.currentPrice
      : Number(rawAuction.currentPrice ?? rawAuction.current_price);

  const rawReserve = rawAuction.reservePrice ?? rawAuction.reserve_price;
  const reservePrice =
    rawReserve !== null && rawReserve !== undefined ? Number(rawReserve) : null;

  const reserveMet = reservePrice === null || currentPrice >= reservePrice;
  const isSeller =
    userId !== null && userId !== undefined && Number(userId) === sellerId;

  const formatted = {
    id: Number(rawAuction.id),
    title: rawAuction.title,
    description: rawAuction.description !== undefined ? rawAuction.description : null,
    startPrice,
    currentPrice,
    reserveMet,
    status: rawAuction.status,
    sellerId,
    endsAt: rawAuction.endsAt ?? rawAuction.ends_at,
    createdAt: rawAuction.createdAt ?? rawAuction.created_at,
  };

  if (isSeller) {
    formatted.reservePrice = reservePrice;
  }

  return formatted;
}

export default formatAuction;
