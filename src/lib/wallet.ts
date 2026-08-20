import { Prisma, type LedgerType } from "@prisma/client";
import { db } from "../db";

export class InsufficientFundsError extends Error {
  constructor() {
    super("insufficient_funds");
    this.name = "InsufficientFundsError";
  }
}

interface LedgerInput {
  userId: string;
  amount: number; // + credit, - debit (lingotes)
  type: LedgerType;
  refType?: string;
  refId?: string;
  memo?: string;
}

/**
 * Apply a single balance movement + append its ledger entry, atomically.
 *
 * MUST run inside a transaction (`tx`). The `update ... increment` acquires a
 * row lock, serializing concurrent movements on the same user, so the balance
 * can never go negative from a race. Debits that would overdraw throw and roll
 * back the whole transaction.
 */
export async function applyLedger(tx: Prisma.TransactionClient, input: LedgerInput): Promise<number> {
  const user = await tx.user.update({
    where: { id: input.userId },
    data: { balance: { increment: input.amount } },
    select: { balance: true },
  });
  if (user.balance < 0) {
    throw new InsufficientFundsError();
  }
  await tx.ledgerEntry.create({
    data: {
      userId: input.userId,
      amount: input.amount,
      balanceAfter: user.balance,
      type: input.type,
      refType: input.refType,
      refId: input.refId,
      memo: input.memo,
    },
  });
  return user.balance;
}

/** Convenience wrapper that opens its own transaction for a single movement. */
export function applyLedgerStandalone(input: LedgerInput): Promise<number> {
  return db.$transaction((tx) => applyLedger(tx, input));
}

/** Lingotes for a USD-cents amount at the fixed rate 1 USD = 10 lingotes. */
export function usdCentsToLingotes(usdCents: number): number {
  return Math.round((usdCents / 100) * 10);
}
