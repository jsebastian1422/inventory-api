import { describe, expect, it } from 'vitest';
import type { Cart } from '../../domain/cart/cart.js';
import type { CartRepository } from '../../domain/cart/cart-repository.js';
import type { Sale } from '../../domain/sale/sale.js';
import type {
  CheckoutInput,
  CheckoutOutcome,
  SaleFilter,
  SaleRepository,
} from '../../domain/sale/sale-repository.js';
import { DomainError } from '../../domain/shared/errors.js';
import { encodeCursor } from '../../domain/sync/change-cursor.js';
import { RecordingAuditLog } from '../../testing/in-memory.js';
import type { ScopeUseCases } from '../scope/scope.use-cases.js';
import { SaleUseCases } from './sale.use-cases.js';

const SELLER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EST = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CART = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-01-01T00:00:00.000Z');

const cart: Cart = {
  id: CART,
  establishmentId: EST,
  createdBy: SELLER,
  status: 'open',
  cancelledBy: null,
  cancelledAt: null,
  soldBy: null,
  soldAt: null,
  saleId: null,
  version: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

const sale: Sale = {
  id: 'ssssssss-ssss-4sss-8sss-ssssssssssss',
  number: 1,
  establishmentId: EST,
  cartId: CART,
  sellerId: SELLER,
  customer: { docType: 'CC', docNumber: '123', name: 'Ana Pérez', email: 'ana@x.co', phone: null },
  items: [
    {
      id: 'i1',
      cartItemId: 'ci1',
      inventoryLineId: 'l1',
      productId: 'p1',
      sku: 'SKU',
      productName: 'Prod',
      unit: 'unit',
      barcode: 'BC',
      expiresOn: null,
      unitPrice: '10.00',
      quantity: '2.000',
      subtotal: '20.00',
    },
  ],
  total: '20.00',
  createdAt: NOW,
  version: 1,
};

const actor = (userId: string, ...permissions: string[]) => ({ userId, permissions });

function setup(
  options: {
    cart?: Cart | null;
    outcome?: CheckoutOutcome;
    scopeIds?: string[];
    readIds?: string[];
  } = {},
) {
  const calls: { checkout: CheckoutInput[]; list: SaleFilter[] } = { checkout: [], list: [] };
  const sales: SaleRepository = {
    async checkout(input) {
      calls.checkout.push(input);
      return options.outcome ?? { status: 'sold', sale };
    },
    async findById(id) {
      return id === sale.id ? sale : null;
    },
    async list(filter) {
      calls.list.push(filter);
      return { items: [sale], total: 1 };
    },
    async listChanges() {
      return { items: [sale], hasMore: false, last: { xid: '5', id: sale.id } };
    },
  };
  const carts = {
    async findById() {
      return options.cart === undefined ? cart : options.cart;
    },
  } as unknown as CartRepository;
  const inScope: string[] = options.scopeIds ?? [EST];
  const scope = {
    async assertInScope(_actor: unknown, id: string) {
      if (!inScope.includes(id))
        throw new DomainError('forbidden', 'x', 'ESTABLISHMENT_NOT_IN_SCOPE');
    },
    async resolve() {
      return { access: 'assigned', ids: inScope };
    },
    async resolveForSalesRead() {
      return options.readIds ?? inScope;
    },
  } as unknown as ScopeUseCases;
  const log = new RecordingAuditLog();
  return { uc: new SaleUseCases(sales, carts, scope, log, () => NOW), calls, log };
}

async function code(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return error instanceof DomainError ? `${error.kind}:${error.code}` : 'other';
  }
  return undefined;
}

describe('checkout', () => {
  it('sells for the owner, normalizes the buyer and audits ids without buyer data', async () => {
    const { uc, calls, log } = setup();
    const result = await uc.checkout(actor(SELLER, 'sales.create'), CART, {
      customer: { docType: 'CC', docNumber: '123', name: ' Ana Pérez ' },
    });
    expect(result).toBe(sale);
    expect(calls.checkout[0]).toMatchObject({
      cartId: CART,
      actorId: SELLER,
      now: NOW,
      customer: { name: 'Ana Pérez' },
    });
    expect(log.events.map((e) => e.event)).toEqual([
      'sale.created',
      'inventory_line.quantity_sold',
    ]);
    expect(log.events[0]!.data).toMatchObject({ saleId: sale.id, number: 1, total: '20.00' });
    expect(JSON.stringify(log.events)).not.toMatch(/Ana|123|ana@/);
  });

  it('order: 400 buyer, 403 permission, 404 not the owner, 403 scope, VERSION_CONFLICT', async () => {
    const seller = actor(SELLER, 'sales.create');
    expect(
      await code(() => setup().uc.checkout(seller, CART, { customer: { docType: 'CC' } })),
    ).toBe('validation:VALIDATION_ERROR');
    expect(await code(() => setup().uc.checkout(actor(SELLER), CART, {}))).toBe(
      'forbidden:FORBIDDEN',
    );
    expect(await code(() => setup().uc.checkout(actor(OTHER, 'sales.create'), CART, {}))).toBe(
      'not_found:CART_NOT_FOUND',
    );
    expect(await code(() => setup({ cart: null }).uc.checkout(seller, CART, {}))).toBe(
      'not_found:CART_NOT_FOUND',
    );
    expect(await code(() => setup({ scopeIds: [] }).uc.checkout(seller, CART, {}))).toBe(
      'forbidden:ESTABLISHMENT_NOT_IN_SCOPE',
    );
    const stale = setup();
    expect(await code(() => stale.uc.checkout(seller, CART, {}, 2))).toBe(
      'conflict:VERSION_CONFLICT',
    );
    expect(stale.calls.checkout).toHaveLength(0);
  });

  it('a version conflict found inside the transaction is VERSION_CONFLICT with the current cart', async () => {
    const { uc, log } = setup({
      outcome: { status: 'conflict', current: { ...cart, version: 4 } },
    });
    let error: unknown;
    try {
      await uc.checkout(actor(SELLER, 'sales.create'), CART, {}, 3);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('VERSION_CONFLICT');
    expect((error as DomainError).extra?.current).toMatchObject({ version: 4 });
    expect(log.events.some((e) => e.event === 'sale.created')).toBe(false);
  });

  it('authorizeCheckout applies the same checks without executing', async () => {
    const { uc, calls } = setup();
    await expect(
      uc.authorizeCheckout(actor(SELLER, 'sales.create'), CART),
    ).resolves.toBeUndefined();
    expect(await code(() => uc.authorizeCheckout(actor(SELLER), CART))).toBe('forbidden:FORBIDDEN');
    expect(await code(() => uc.authorizeCheckout(actor(OTHER, 'sales.create'), CART))).toBe(
      'not_found:CART_NOT_FOUND',
    );
    expect(calls.checkout).toHaveLength(0);
  });
});

describe('queries (R-1)', () => {
  it('get: the seller, a reader in scope or with establishments.all; otherwise 404', async () => {
    const { uc } = setup();
    await expect(uc.get(actor(SELLER, 'sales.create'), sale.id)).resolves.toBe(sale);
    await expect(uc.get(actor(OTHER, 'sales.read'), sale.id)).resolves.toBe(sale);
    await expect(
      setup({ scopeIds: [] }).uc.get(actor(OTHER, 'sales.read', 'establishments.all'), sale.id),
    ).resolves.toBe(sale);
    expect(await code(() => uc.get(actor(OTHER, 'sales.create'), sale.id))).toBe(
      'not_found:SALE_NOT_FOUND',
    );
    expect(
      await code(() => setup({ scopeIds: [] }).uc.get(actor(OTHER, 'sales.read'), sale.id)),
    ).toBe('not_found:SALE_NOT_FOUND');
    expect(await code(() => uc.get(actor(SELLER), sale.id))).toBe('not_found:SALE_NOT_FOUND');
    expect(await code(() => uc.get(actor(SELLER, 'sales.create'), 'zzz'))).toBe(
      'not_found:SALE_NOT_FOUND',
    );
  });

  it('read scope includes assigned establishments even when the operate scope excludes them (RE-3)', async () => {
    const page = { limit: 10, offset: 0 };
    const inactive = setup({ scopeIds: [], readIds: [EST] });
    await inactive.uc.list(actor(OTHER, 'sales.read'), page);
    expect(inactive.calls.list[0]!.visibility).toEqual({
      sellerId: undefined,
      establishmentIds: [EST],
    });
    await expect(
      setup({ scopeIds: [], readIds: [EST] }).uc.get(actor(OTHER, 'sales.read'), sale.id),
    ).resolves.toBeDefined();
    expect(
      await code(() =>
        setup({ scopeIds: [EST], readIds: [] }).uc.get(actor(OTHER, 'sales.read'), sale.id),
      ),
    ).toBe('not_found:SALE_NOT_FOUND');
  });

  it('list: visibility by permission and scope; 403 with neither or a foreign sellerId', async () => {
    const page = { limit: 10, offset: 0 };
    const own = setup();
    await own.uc.list(actor(SELLER, 'sales.create'), page);
    expect(own.calls.list[0]!.visibility).toEqual({ sellerId: SELLER });
    const read = setup();
    await read.uc.list(actor(OTHER, 'sales.read'), page);
    expect(read.calls.list[0]!.visibility).toEqual({
      sellerId: undefined,
      establishmentIds: [EST],
    });
    const all = setup();
    await all.uc.list(actor(OTHER, 'sales.read', 'establishments.all'), page);
    expect(all.calls.list[0]!.visibility).toEqual({ sellerId: undefined, establishmentIds: 'all' });
    const both = setup();
    await both.uc.list(actor(SELLER, 'sales.create', 'sales.read'), page);
    expect(both.calls.list[0]!.visibility).toEqual({ sellerId: SELLER, establishmentIds: [EST] });
    expect(await code(() => own.uc.list(actor(OTHER), page))).toBe('forbidden:FORBIDDEN');
    expect(
      await code(() => own.uc.list(actor(SELLER, 'sales.create'), { ...page, sellerId: OTHER })),
    ).toBe('forbidden:FORBIDDEN');
    await expect(
      own.uc.list(actor(SELLER, 'sales.create'), { ...page, sellerId: SELLER.toUpperCase() }),
    ).resolves.toBeDefined();
    expect(
      await code(() =>
        own.uc.list(actor(SELLER, 'sales.create'), {
          ...page,
          from: '2026-02-01',
          to: '2026-01-01',
        }),
      ),
    ).toBe('validation:VALIDATION_ERROR');
  });

  it('changes: needs sales.create; opaque cursor, 400 when malformed', async () => {
    const { uc } = setup();
    const page = await uc.changes(actor(SELLER, 'sales.create'), undefined, 10);
    expect(page).toMatchObject({ items: [sale], hasMore: false });
    expect(page.nextCursor).toBe(encodeCursor({ xid: '5', id: sale.id }));
    expect(await code(() => uc.changes(actor(SELLER), undefined, 10))).toBe('forbidden:FORBIDDEN');
    expect(await code(() => uc.changes(actor(SELLER, 'sales.create'), '***', 10))).toBe(
      'validation:VALIDATION_ERROR',
    );
  });
});
