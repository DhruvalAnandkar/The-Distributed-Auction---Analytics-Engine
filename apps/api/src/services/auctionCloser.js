/**
 * @typedef {Object} ClosedAuctionResult
 * @property {number} auctionId - The unique identifier of the closed auction.
 * @property {number | null} winnerId - The user ID of the highest bidder, or null if no bids or reserve not met.
 * @property {number | null} winningAmount - The highest bid amount, or null if no bids or reserve not met.
 */

/**
 * Marks active auctions with ends_at <= now as CLOSED and identifies
 * the highest bidder as the winner within a database transaction.
 * Writes AuctionClosed domain events to the outbox inside the same transaction.
 *
 * @param {Object} deps
 * @param {{ connect: Function }} deps.db - Node-postgres Pool or fakeDb instance.
 * @param {Date | string} [deps.now] - Cutoff timestamp (defaults to current date).
 * @param {Object} [deps.cache] - LRU cache instance to invalidate closed auctions.
 * @returns {Promise<ClosedAuctionResult[]>}
 */
export async function closeExpiredAuctions({ db, now, cache } = {}) {
  const cutoff = now !== undefined ? now : new Date();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const updateResult = await client.query(
      `UPDATE auctions
       SET status = 'CLOSED'
       WHERE status = $1 AND ends_at <= $2
       RETURNING id, reserve_price as "reservePrice"`,
      ['ACTIVE', cutoff]
    );

    if (updateResult.rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    const closedAuctionsMap = new Map();
    const closedAuctionIds = updateResult.rows.map((row) => {
      const id = Number(row.id);
      closedAuctionsMap.set(id, {
        reservePrice: row.reservePrice ?? row.reserve_price,
      });
      return id;
    });

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
      const auctionMeta = closedAuctionsMap.get(auctionId);
      const rawReserve = auctionMeta?.reservePrice;
      const reservePrice = rawReserve !== null && rawReserve !== undefined ? Number(rawReserve) : null;

      if (!winningBid || winningBid.winnerId === null || winningBid.winningAmount === null) {
        return {
          auctionId,
          winnerId: null,
          winningAmount: null,
        };
      }

      if (reservePrice !== null && winningBid.winningAmount < reservePrice) {
        return {
          auctionId,
          winnerId: null,
          winningAmount: null,
        };
      }

      return {
        auctionId,
        winnerId: winningBid.winnerId,
        winningAmount: winningBid.winningAmount,
      };
    });

    for (const res of results) {
      await client.query(
        `INSERT INTO domain_events (event_type, payload) VALUES ($1, $2)`,
        [
          'AuctionClosed',
          JSON.stringify({
            auctionId: res.auctionId,
            winnerId: res.winnerId,
            winningAmount: res.winningAmount,
          }),
        ]
      );
    }

    await client.query('COMMIT');

    if (cache) {
      for (const auctionId of closedAuctionIds) {
        cache.delete(auctionId);
      }
    }

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
