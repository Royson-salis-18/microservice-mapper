export const config = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3001,
  POLLING_INTERVAL_MS: process.env.POLLING_INTERVAL_MS ? parseInt(process.env.POLLING_INTERVAL_MS, 10) : 5000,
  METRIC_HISTORY_SIZE: process.env.METRIC_HISTORY_SIZE ? parseInt(process.env.METRIC_HISTORY_SIZE, 10) : 720,
  INGEST_TOKEN: process.env.INGEST_TOKEN || 'mapper-secret-token',
  /** The interpreter for the ml/ scripts. `python3` on Linux and macOS; on
   *  Windows the python.org installer provides `python`, and `python3` is at
   *  most a Microsoft Store stub that prints "Python was not found". */
  PYTHON: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
};
