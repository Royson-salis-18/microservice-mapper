'use strict';

/**
 * LedgerLine (retail-banking transfers) journeys, from the bench's own loadgen (ledgerline/loadgen/journeys.js).
 * Entry point: the edge gateway on :8081. Account ids are acct-00001..acct-20000; payers come from the low range, which the bench
 * seeds with healthy balances, payees from the whole population.
 *
 * Every transfer carries a fresh idempotency key (${uuid}): reusing one makes the service replay the first answer and do no work,
 * which would put almost no load on the ledger.
 */

const PAYERS = ['acct-00003', 'acct-00017', 'acct-00042', 'acct-00088', 'acct-00120', 'acct-00256', 'acct-00301', 'acct-00477', 'acct-00512', 'acct-00640', 'acct-00733', 'acct-00801', 'acct-00950', 'acct-01100', 'acct-01234', 'acct-01500', 'acct-01777', 'acct-01999'];
const PAYEES = ['acct-02100', 'acct-03300', 'acct-04500', 'acct-05700', 'acct-06900', 'acct-08100', 'acct-09300', 'acct-10500', 'acct-11700', 'acct-12900', 'acct-14100', 'acct-15300', 'acct-16500', 'acct-17700', 'acct-18900'];

const transfer = {
  id: 'transfer', name: 'Transfer money', vars: { from: PAYERS, to: PAYEES }, steps: [
    { id: 'transfer', method: 'POST', path: '/api/transfers', headers: { 'idempotency-key': '${uuid}' },
      body: { from: '${from}', to: '${to}', amountCents: 2500, currency: 'USD' }, thinkTimeMs: [300, 1500] },
  ],
};
const profile = {
  id: 'profile', name: 'Risk profile lookup', vars: { acct: PAYEES }, steps: [
    { id: 'risk_profile', method: 'GET', path: '/api/accounts/${acct}/risk-profile', thinkTimeMs: [300, 1500] },
  ],
};
const statement = {
  id: 'statement', name: 'Account statement', vars: { acct: PAYERS }, steps: [
    { id: 'statement', method: 'GET', path: '/api/statements/${acct}', thinkTimeMs: [500, 2000] },
  ],
};

const workflows = { transfer, profile, statement };
const defaultWorkflowWeights = [
  { key: 'transfer', weight: 60 },
  { key: 'profile', weight: 30 },
  { key: 'statement', weight: 10 },
];
const profiles = {
  BASELINE: { users: 4, spawnRatePerSec: 1, defaultThinkTimeMs: [800, 2500] },
  MODERATE: { users: 15, spawnRatePerSec: 2, defaultThinkTimeMs: [500, 1500] },
  HEAVY: { users: 40, spawnRatePerSec: 5, defaultThinkTimeMs: [200, 1000] },
  STRESS: { users: 80, spawnRatePerSec: 10, defaultThinkTimeMs: [100, 500] },
  RAMP: { users: 20, spawnRatePerSec: 2, defaultThinkTimeMs: [500, 1500] },
};

module.exports = { workflows, defaultWorkflowWeights, profiles };
