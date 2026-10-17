/**
 * @typedef {Object} ClosedAuctionResult
 * @property {number} auctionId - The unique identifier of the closed auction.
 * @property {number | null} winnerId - The user ID of the highest bidder, or null if no bids.
 * @property {number | null} winningAmount - The highest bid amount, or null if no bids.
 */

/**
 * Marks active auctions with ends_at <= now as CLOSED and identifies
 * the highest bidder as the winner within a database transaction.
 *
 * @param {Object} deps
 * @param {{ connect: Function }} deps.db - Node-postgres Pool or fakeDb instance.
 * @param {Date | string} [deps.now] - Cutoff timestamp (defaults to current date).
 * @returns {Promise<ClosedAuctionResult[]>}
 */
export async function closeExpiredAuctions({ db, now } = {}) {
  const cutoff = now !== undefined ? now : new Date();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const updateResult = await client.query(
      `UPDATE auctions
       SET status = 'CLOSED'
       WHERE status = $1 AND ends_at <= $2
       RETURNING id`,
      ['ACTIVE', cutoff]
    );

    if (updateResult.rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    const closedAuctionIds = updateResult.rows.map((row) => Number(row.id));

    const bidsResult = await client.query(
      `SELECT DISTINCT ON (auction_id)
         auction_id as "auctionId",
         bidder_id as "winnerId",
         amount as "winningAmount"
       FROM bids
       WHERE auction_id = ANY($1)
       ORDER BY auction_id, amount DESC, id DESC`,
      [closedAuctionIds]
    );

    const winningBidsByAuction = new Map();
    for (const row of bidsResult.rows) {
      const auctionId = Number(row.auctionId ?? row.auction_id);
      const rawWinnerId = row.winnerId ?? row.winner_id ?? row.bidderId ?? row.bidder_id;
      const rawAmount = row.winningAmount ?? row.winning_amount ?? row.amount;

      const winnerId = rawWinnerId !== null && rawWinnerId !== undefined ? Number(rawWinnerId) : null;
      const winningAmount = rawAmount !== null && rawAmount !== undefined ? Number(rawAmount) : null;

      if (!winningBidsByAuction.has(auctionId)) {
        winningBidsByAuction.set(auctionId, { winnerId, winningAmount });
      } else {
        const existing = winningBidsByAuction.get(auctionId);
        if (winningAmount !== null && (existing.winningAmount === null || winningAmount > existing.winningAmount)) {
          winningBidsByAuction.set(auctionId, { winnerId, winningAmount });
        }
      }
    }

    const results = closedAuctionIds.map((auctionId) => {
      const winningBid = winningBidsByAuction.get(auctionId);
      return {
        auctionId,
        winnerId: winningBid ? winningBid.winnerId : null,
        winningAmount: winningBid ? winningBid.winningAmount : null,
      };
    });

    await client.query('COMMIT');

    return results;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

export default closeExpiredAuctions;
