/** The call graphs of the two bench systems, as configured in their compose files (caller -> callee; each *_URL / *_HOST
 *  a service is given is a call it makes). Used only to SCORE learned graphs, never read by an engine. */
export const TRUE_CALLS: Record<string, [string, string][]> = {
  shopflow: [['api-gateway', 'catalog'], ['api-gateway', 'cart'], ['api-gateway', 'orders'], ['catalog', 'catalog-db'], ['catalog', 'catalog-cache'], ['cart', 'cart-store'], ['cart', 'catalog'],
    ['orders', 'orders-db'], ['orders', 'cart'], ['orders', 'inventory'], ['orders', 'payments'], ['orders', 'event-bus'], ['inventory', 'catalog-db'], ['payments', 'psp-sandbox'], ['notifier', 'event-bus'], ['notifier', 'orders'], ['notifier', 'catalog']],
  ledgerline: [['edge', 'transfers'], ['edge', 'accounts'], ['transfers', 'accounts'], ['transfers', 'fraud-screening'], ['transfers', 'fx-rates'], ['transfers', 'ledger'], ['transfers', 'event-bus'], ['transfers', 'state-store'],
    ['accounts', 'accounts-db'], ['accounts', 'fraud-screening'], ['fraud-screening', 'accounts'], ['fraud-screening', 'state-store'], ['fx-rates', 'fx-provider'], ['ledger', 'ledger-db'], ['statements-worker', 'event-bus'], ['statements-worker', 'ledger-db'], ['statements-worker', 'accounts']],
};
