import { z } from 'zod';

/**
 * Zod schema for validating auction creation payloads.
 */
export const createAuctionSchema = z.object({
  title: z
    .string({ required_error: 'Title is required' })
    .min(3, 'Title must be between 3 and 100 characters')
    .max(100, 'Title must be between 3 and 100 characters'),
  description: z.string().optional(),
  startPrice: z
    .number({ required_error: 'Start price is required' })
    .positive('Start price must be greater than 0')
    .refine(
      (val) => {
        const decimalPart = val.toString().split('.')[1];
        return !decimalPart || decimalPart.length <= 2;
      },
      { message: 'Start price can have at most 2 decimal places' }
    ),
  endsAt: z
    .string({ required_error: 'Ends at date is required' }),
}).refine(
  (data) => {
    const endsAtDate = new Date(data.endsAt);
    if (Number.isNaN(endsAtDate.getTime())) {
      return false;
    }
    const oneMinuteFromNow = new Date(Date.now() + 60 * 1000);
    return endsAtDate >= oneMinuteFromNow;
  },
  { 
    message: 'Ends at must be an ISO date at least 1 minute in the future',
    path: ['endsAt'],
  }
);

/**
 * Zod schema for validating auction update payloads.
 */
export const updateAuctionSchema = z
  .object({
    title: z
      .string()
      .min(3, 'Title must be between 3 and 100 characters')
      .max(100, 'Title must be between 3 and 100 characters')
      .optional(),
    description: z.string().nullable().optional(),
    endsAt: z.string().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.title !== undefined ||
      data.description !== undefined ||
      data.endsAt !== undefined,
    {
      message: 'At least one field must be provided',
    }
  )
  .refine(
    (data) => {
      if (data.endsAt === undefined) return true;
      const endsAtDate = new Date(data.endsAt);
      if (Number.isNaN(endsAtDate.getTime())) {
        return false;
      }
      const oneMinuteFromNow = new Date(Date.now() + 60 * 1000);
      return endsAtDate >= oneMinuteFromNow;
    },
    {
      message: 'Ends at must be an ISO date at least 1 minute in the future',
      path: ['endsAt'],
    }
  );

/**
 * Zod schema for validating list auctions query parameters.
 */
export const listAuctionsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'PENDING', 'CLOSED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
  q: z
    .string()
    .min(1, 'Search query must be between 1 and 100 characters')
    .max(100, 'Search query must be between 1 and 100 characters')
    .optional(),
});

/**
 * Zod schema for validating auction id route parameter.
 */
export const auctionIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Zod schema for validating bid placement payloads.
 */
export const placeBidSchema = z.object({
  amount: z
    .number({ required_error: 'Amount is required' })
    .positive('Amount must be greater than 0')
    .refine(
      (val) => {
        const decimalPart = val.toString().split('.')[1];
        return !decimalPart || decimalPart.length <= 2;
      },
      { message: 'Amount can have at most 2 decimal places' }
    ),
});

/**
 * Zod schema for validating bid history query parameters.
 */
export const bidHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
