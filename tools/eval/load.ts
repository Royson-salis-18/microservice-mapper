// File loading for the evaluation harness. The only I/O in tools/eval besides observe.ts and the CLI; scoring itself is pure (score.ts).
import fs from 'node:fs';
import { parseLedger, parseObserved } from './score.ts';

export const loadLedger = (p: string) => parseLedger(fs.readFileSync(p, 'utf8'));
export const loadObserved = (p: string) => parseObserved(fs.readFileSync(p, 'utf8'));
