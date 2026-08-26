import { db } from "../db";
import { applyLedger } from "./wallet";
import { sendEmail, topupApprovedEmail } from "./email";

/**
 * Credit a topup's lingotes exactly once (idempotent). Returns true if it
 * credited now. Used by the MP webhook, the PayPal return, and reconciliation.
 */
export interface FeeBreakdown {
  chargeCurrency: string;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
}

export async function creditTopupIfPending(
  topupId: string,
  opts: { providerRef?: string; memoLabel: string; breakdown?: FeeBreakdown },
): Promise<boolean> {
  let credited = false;
  await db.$transaction(async (tx) => {
    const topup = await tx.topUp.findUnique({ where: { id: topupId } });
    if (!topup || topup.status === "PAID") return;
    await applyLedger(tx, {
      userId: topup.userId,
      amount: topup.lingotes,
      type: "TOPUP",
      refType: "topup",
      refId: topup.id,
      memo: `${opts.memoLabel} $${(topup.amountUsd / 100).toFixed(2)}`,
    });
    await tx.topUp.update({
      where: { id: topup.id },
      data: {
        status: "PAID",
        confirmedAt: new Date(),
        providerRef: opts.providerRef ?? topup.providerRef,
        ...(opts.breakdown ?? {}),
      },
    });
    credited = true;
  });
  if (credited) {
    const topup = await db.topUp.findUnique({ where: { id: topupId }, include: { user: { select: { email: true } } } });
    if (topup?.user?.email) {
      const { subject, html } = topupApprovedEmail(topup.lingotes, topup.amountUsd);
      void sendEmail({ to: topup.user.email, subject, html }).catch(() => {});
    }
  }
  return credited;
}
