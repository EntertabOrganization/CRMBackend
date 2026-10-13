import { z } from 'zod';
import { decimal } from '../process-platform/dto';
/** Zero default requires explicit approval for every positive refund. */
export const commerceRefundPolicy=z.strictObject({approvalThreshold:decimal.default('0'),allowSelfApproval:z.boolean().default(false),allowWithoutReturn:z.boolean().default(true)});
