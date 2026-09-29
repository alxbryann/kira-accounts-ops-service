export type Cents = number;
export const toDollars = (c: Cents) => (c / 100).toFixed(2);

// Platform fee is 2.9% of the transfer amount, rounded half-up to the cent — the same rule the
// provider applies on its settlement statement, so our ledger and theirs agree to the cent.
// Rate is in basis points and the math stays in integers: `amount * 0.029` is inexact in floating
// point (88_300 * 0.029 = 2560.7000000000003), which can flip a rounding decision.
export function feeCents(amountCents: Cents, rateBps = 290): Cents {
  return Math.floor((amountCents * rateBps + 5_000) / 10_000);
}
