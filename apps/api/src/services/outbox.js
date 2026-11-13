/**
 * Writes a domain event into the outbox table.
 *
 * @param {Object} client - Node-postgres client or query interface.
 * @param {string} eventType - The domain event type (e.g. 'BidPlaced', 'AuctionClosed').
 * @param {Object} payload - Event payload object.
 * @returns {Promise<Object>} The inserted domain event row.
 */
export async function writeEvent(client, eventType, payload) {
  const result = await client.query(
    `INSERT INTO domain_events (event_type, payload)
     VALUES ($1, $2)
     RETURNING 
       id,
       event_type as "eventType",
       payload,
       created_at as "createdAt"`,
    [eventType, JSON.stringify(payload)]
  );
  return result.rows[0];
}

/**
 * Claims a batch of unpublished outbox domain events using FOR UPDATE SKIP LOCKED.
 *
 * @param {Object|{ query: Function, connect?: Function }} dbOrOptions - Database pool/client or options object.
 * @param {number} [batchSize=10] - Number of events to claim.
 * @returns {Promise<Array<{ id: number, eventType: string, payload: any, createdAt: Date, claimedAt: Date }>>}
 */
export async function claimBatch(dbOrOptions, batchSize = 10) {
  let db = dbOrOptions;
  let size = batchSize;

  if (dbOrOptions && typeof dbOrOptions === 'object' && !('query' in dbOrOptions) && !('connect' in dbOrOptions)) {
    db = dbOrOptions.db;
    size = dbOrOptions.batchSize ?? 10;
  }

  const client = typeof db?.connect === 'function' ? await db.connect() : db;
  const isDedicatedClient = client !== db;

  try {
    if (isDedicatedClient) {
      await client.query('BEGIN');
    }

    const selectResult = await client.query(
      `SELECT 
        id,
        event_type as "eventType",
        payload,
        created_at as "createdAt",
        claimed_at as "claimedAt"
      FROM domain_events
      WHERE published_at IS NULL AND claimed_at IS NULL
      ORDER BY id ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
      [size]
    );

    if (selectResult.rows.length === 0) {
      if (isDedicatedClient) {
        await client.query('COMMIT');
      }
      return [];
    }

    const ids = selectResult.rows.map((row) => Number(row.id));
    const now = new Date();

    const updateResult = await client.query(
      `UPDATE domain_events
       SET claimed_at = $1
       WHERE id = ANY($2)
       RETURNING 
         id,
         event_type as "eventType",
         payload,
         created_at as "createdAt",
         claimed_at as "claimedAt"`,
      [now, ids]
    );

    if (isDedicatedClient) {
      await client.query('COMMIT');
    }

    const rows = updateResult.rows.length > 0 ? updateResult.rows : selectResult.rows;

    return rows.map((row) => {
      let payload = row.payload;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (_) {}
      }
      return {
        id: Number(row.id),
        eventType: row.eventType ?? row.event_type,
        payload,
        createdAt: row.createdAt ?? row.created_at,
        claimedAt: row.claimedAt ?? row.claimed_at ?? now,
      };
    });
  } catch (err) {
    if (isDedicatedClient) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    throw err;
  }
  finally {
    if (isDedicatedClient && typeof client.release === 'function') {
      client.release();
    }
  }
}

/**
 * Marks domain events as published.
 *
 * @param {Object|{ query: Function, connect?: Function }} dbOrOptions - Database pool/client or options object.
 * @param {number[]} [eventIds] - Array of claimed event IDs to mark as published.
 * @returns {Promise<number>} Number of marked events.
 */
export async function markPublished(dbOrOptions, eventIds) {
  let db = dbOrOptions;
  let ids = eventIds;

  if (dbOrOptions && typeof dbOrOptions === 'object' && !('query' in dbOrOptions) && !('connect' in dbOrOptions)) {
    db = dbOrOptions.db;
    ids = dbOrOptions.eventIds;
  }

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return 0;
  }

  const numericIds = ids.map((id) => Number(id));
  const now = new Date();

  const result = await db.query(
    `UPDATE domain_events
     SET published_at = $1
     WHERE id = ANY($2)
     RETURNING id`,
    [now, numericIds]
  );

  return result.rowCount ?? result.rows?.length ?? 0;
}

export default {
  writeEvent,
  claimBatch,
  markPublished,
};
