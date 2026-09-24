import fs from 'fs';

/**
 * Read the last N matching rows of a CSV without loading the file.
 *
 * `/api/ml/features` answers with the most recent 300 rows and was reading
 * the whole 33 MB table to do it. Measured on the real file:
 *
 *     readFileSync(33 MB)                 114.9 ms
 *     .split('\n') -> 152,335 strings      26.1 ms
 *     the actual work (last 300 rows)       0.3 ms
 *
 * 99.8% of the endpoint was reading and splitting data it then discarded,
 * on every poll, and the 152k intermediate strings all had to be collected
 * afterwards. The file only grows, so this got steadily worse.
 *
 * The rows wanted are always at the end, so this seeks backwards from EOF in
 * chunks and stops as soon as it has enough. Cost becomes proportional to
 * the answer rather than to the history — a file ten times larger is not ten
 * times slower.
 *
 * The header is read separately from the front, which is the one part that
 * genuinely does live at the start.
 */

const DEFAULT_CHUNK = 256 * 1024;

/** The header line, read from the front without touching the rest. */
export function readCsvHeader(filePath: string): string[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, read).toString('utf8');
    const nl = text.indexOf('\n');
    return (nl >= 0 ? text.slice(0, nl) : text).trim().split(',');
  } finally {
    fs.closeSync(fd);
  }
}

export interface TailOptions {
  /** Stop once this many matching rows are collected. */
  limit: number;
  /**
   * Optional row filter, applied to the raw line. Kept as a predicate on the
   * unparsed text so a non-matching line is never split — splitting is the
   * expensive part and most lines will not match when filtering by service.
   */
  match?: (line: string) => boolean;
  /**
   * Safety valve. A filter that matches nothing would otherwise walk the
   * entire file backwards, turning the optimisation into the original cost
   * plus overhead. Past this many bytes it gives up and returns what it has.
   */
  maxBytes?: number;
  chunkSize?: number;
}

/**
 * Last `limit` matching lines, in file order, excluding the header.
 *
 * Returns fewer than `limit` when the file (or the scanned budget) runs out,
 * which the caller should treat as "that is all there is" rather than an
 * error.
 */
export function tailCsvLines(filePath: string, opts: TailOptions): string[] {
  const { limit, match, maxBytes = 16 * 1024 * 1024, chunkSize = DEFAULT_CHUNK } = opts;
  if (limit <= 0) return [];

  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return [];

    const collected: string[] = [];
    let position = size;
    let carry = '';        // partial line at the head of the chunk just read
    let scanned = 0;
    let headerReached = false;

    while (position > 0 && collected.length < limit && scanned < maxBytes) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, position);
      scanned += readSize;

      // Prepend, because this chunk sits before what was read last time and
      // its tail may complete a line whose head is in `carry`.
      const text = buf.toString('utf8') + carry;
      const lines = text.split('\n');

      // The first element is only a complete line if we reached the start of
      // the file; otherwise an earlier chunk holds the rest of it.
      carry = position > 0 ? lines.shift()! : '';
      if (position === 0) headerReached = true;

      for (let i = lines.length - 1; i >= 0 && collected.length < limit; i--) {
        const line = lines[i];
        if (!line || line.trim() === '') continue;
        // The very first line of the file is the header, never a row.
        if (headerReached && position === 0 && i === 0) continue;
        if (match && !match(line)) continue;
        collected.push(line);
      }
    }

    // Collected back-to-front; the caller wants chronological order.
    return collected.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Value at `columnIndex` without splitting the whole line.
 *
 * Used by the filter predicate: checking one column on 150k lines via
 * `line.split(',')[i]` allocates a 19-element array per line and throws all
 * of it away. Walking to the Nth comma allocates one small string.
 */
export function fieldAt(line: string, columnIndex: number): string {
  if (columnIndex < 0) return '';
  let start = 0;
  for (let col = 0; col < columnIndex; col++) {
    const next = line.indexOf(',', start);
    if (next === -1) return '';
    start = next + 1;
  }
  const end = line.indexOf(',', start);
  return end === -1 ? line.slice(start) : line.slice(start, end);
}
