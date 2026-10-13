import { z } from 'zod';
/** Default merchandise return window, pinned on each request. */
export const commerceReturnPolicy=z.strictObject({enabled:z.boolean().default(true),windowDays:z.number().int().min(1).max(365).default(30)});
