/**
 * Escapes PostgreSQL LIKE/ILIKE pattern special characters (%, _, \).
 *
 * @param {string} str - Search query string.
 * @returns {string} Pattern-escaped string safe for LIKE/ILIKE queries.
 */
export function escapeLike(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

export default escapeLike;
