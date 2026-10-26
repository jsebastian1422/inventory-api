/** One line found by the stock search, with its inventory and product. Decimals as text (ADR-0003). */
export interface StockResult {
  readonly lineId: string;
  readonly inventoryId: string;
  readonly inventoryName: string;
  readonly barcode: string;
  readonly expiresOn: string | null;
  readonly quantityCurrent: string;
  readonly product: {
    readonly id: string;
    readonly sku: string;
    readonly name: string;
    readonly unit: string;
    readonly price: string;
  };
}

/** Exactly one criterion: exact barcode or text in product name/SKU. */
export type StockCriteria = { readonly barcode: string } | { readonly q: string };
