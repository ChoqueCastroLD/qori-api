// Manual crypto (Binance) top-ups. No merchant API: we show the user our USDT
// deposit address / Binance Pay ID, they pay and submit proof (TxID or
// screenshot), and an admin confirms it, crediting lingotes. 1 USDT ~= 1 USD.
const ADDRESS = process.env.BINANCE_USDT_ADDRESS ?? "";
const NETWORK = process.env.BINANCE_USDT_NETWORK ?? "BSC (BEP20)";
const PAY_ID = process.env.BINANCE_PAY_ID ?? "";

export function binanceConfigured(): boolean {
  return !!(ADDRESS || PAY_ID);
}

export function binanceInstructions(amountUsdCents: number) {
  return {
    asset: "USDT",
    network: NETWORK,
    address: ADDRESS || null,
    payId: PAY_ID || null,
    amountUsd: amountUsdCents / 100,
    amountUsdt: amountUsdCents / 100, // 1 USDT ~= 1 USD
  };
}
