import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { money, ZERO, type Tx } from './support';

const policySchema = z.strictObject({ version: z.string().min(1).max(80),
  countries: z.record(z.string().regex(/^[A-Z]{2}$/), z.strictObject({ rateBasisPoints: z.number().int().min(0).max(10000), taxCode: z.string().min(1).max(100) })) });

/** Operator-supplied exclusive tax policy. No inferred legal rate or implicit production exemption. */
export async function quoteTax(tx: Tx, accountId: string, workspaceId: string, taxable: Prisma.Decimal, currency: string) {
  const account = await tx.billingAccount.findFirst({ where: { id: accountId, workspaceId, status: 'ACTIVE' } });
  if (!account) throw new AppError('NOT_FOUND', 'Billing account was not found.', 404);
  const raw = process.env.BILLING_TAX_POLICY_JSON;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') throw new AppError('DEPENDENCY_UNAVAILABLE', 'Billing tax policy must be configured.', 503);
    return { amount: ZERO, snapshot: { version: 'UNCONFIGURED_NON_PRODUCTION', rateBasisPoints: 0 } };
  }
  let policy: z.infer<typeof policySchema>;
  try { policy = policySchema.parse(JSON.parse(raw)); }
  catch { throw new AppError('DEPENDENCY_UNAVAILABLE', 'Billing tax policy configuration is invalid.', 503); }
  const country = (account.legalIdentity as { country?: string }).country;
  const rule = country ? policy.countries[country] : undefined;
  if (!rule) throw new AppError('DEPENDENCY_UNAVAILABLE', 'No billing tax policy is configured for this payer jurisdiction.', 503);
  return { amount: money(taxable.mul(rule.rateBasisPoints).div(10000), currency), snapshot: { version: policy.version, country, ...rule, behavior: 'EXCLUSIVE' } };
}
