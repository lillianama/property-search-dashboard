/** A shared user setting, independent of source prices and listing history. */
export interface PurchasePriceSetting {
  purchasePriceOverride?: number | null;
  latestPrice: number | null;
}
export function effectivePurchasePrice(property: PurchasePriceSetting): number | null {
  return property.purchasePriceOverride ?? property.latestPrice;
}
export const MAX_PURCHASE_PRICE = 1_000_000_000;
export function validPurchasePrice(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PURCHASE_PRICE && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001);
}
