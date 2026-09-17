# Configuration Reference

---

## Server — `server/config.ts`

```typescript
export const config = {
  PORT:                    3001,
  POLLING_INTERVAL_MS:     5000,
  METRIC_HISTORY_SIZE:     720,
  INGEST_TOKEN:            'mapper-secret-token',
  SOCK_SHOP_BASE_URL:      '',
  SOCK_SHOP_COMPOSE_PATH:  './sock-shop-docker-compose.yml',
  VERTIKAL_BASE_URL:       '',
  VERTIKAL_COMPOSE_PATH:   '../vertikal/docker-compose.yml',
};
```

Override any value with an environment variable:

| Env Var | Default | Effect |
|---|---|---|
| `PORT` | `3001` | HTTP + WebSocket server port |
| `POLLING_INTERVAL_MS` | `5000` | RCA evaluation + graph broadcast interval |
| `METRIC_HISTORY_SIZE` | `720` | Ring buffer depth per node (~1 hour at 5s) |
| `INGEST_TOKEN` | `mapper-secret-token` | Bearer token for `POST /api/ingest` |
| `SOCK_SHOP_BASE_URL` | `''` | Sock Shop HTTP endpoint for health pings |
| `VERTIKAL_BASE_URL` | `''` | Vertikal HTTP endpoint for health pings |

---

## Remote Collector — Environment Variables

Set on the EC2 instance before starting the collector:

| Env Var | Default | Description |
|---|---|---|
| `MAPPER_URL` | `http://127.0.0.1:3001` | Backend ingest URL (via SSH reverse tunnel) |
| `INGEST_TOKEN` | `mapper-secret-token` | Must match server's `INGEST_TOKEN` |
| `TARGET_ID` | `sock-shop-aws` | Sent in every `TelemetryEnvelope.targetId` |
| `ENVIRONMENT` | `aws` | Deployment environment label |
| `REGION` | `ap-south-1` | AWS region label |
| `POLLING_INTERVAL` | `5000` | Collection cycle in milliseconds |

---

## Target SSH Config — `data/remote_config.json`

Written by the UI (`RemoteConfigPanel`) or manually. Loaded by `GraphStore.loadTargetsFromConfig()` at startup.

```json
{
  "sock-shop": {
    "displayName":  "Sock Shop AWS",
    "ec2PublicIp":  "18.206.136.26",
    "sshUsername":  "ubuntu",
    "sshKeyPath":   "~/.ssh/sockshop-key.pem",
    "baseUrl":      "http://18.206.136.26:80"
  },
  "vertikal": {
    "displayName":  "Vertikal AWS",
    "ec2PublicIp":  "54.221.33.11",
    "sshUsername":  "ubuntu",
    "sshKeyPath":   "~/.ssh/vertikal-key.pem",
    "baseUrl":      "http://54.221.33.11:54321"
  }
}
```

**`sshKeyPath` supports `~/`** — expanded via `path.join(os.homedir(), ...)`. No passphrase-protected keys (would require `ssh-agent` integration).

**`baseUrl`** — used for HTTP health pings. Optional but recommended. If absent, `endpointStatus` stays `UNCONFIGURED`.

---

## ML Pipeline — `ml/config.json`

```json
{
  "collector_interval_s":       10,
  "api_base_url":               "http://localhost:3001",
  "min_training_samples":       30,
  "anomaly_threshold":          0.7,
  "persistent_anomaly_windows": 3
}
```

| Key | Default | Description |
|---|---|---|
| `collector_interval_s` | `10` | How often `collector.py` polls `/api/graph` |
| `api_base_url` | `http://localhost:3001` | Backend URL for data collection |
| `min_training_samples` | `30` | Minimum rows per service before training |
| `anomaly_threshold` | `0.7` | Score above which = anomalous |
| `persistent_anomaly_windows` | `3` | Consecutive anomalous windows → `persistent: true` |

---

## Data Files — Auto-Created at Runtime

| File | Created when | Description |
|---|---|---|
| `data/graph_db.json` | First time graph state is saved | Full graph snapshot |
| `data/remote_config.json` | First target registered | SSH configs |
| `data/traces_<targetId>.json` | First TCP events received for a target | 24-hour TCP event log |
| `data/experiments.json` | First experiment started | Experiment history |
| `ml/data/metrics_raw.csv` | `ml/collector.py` first run | Raw metrics time series |
| `ml/data/features.csv` | `ml/preprocess.py` first run | Normalized features |
| `ml/data/normalization_stats.json` | `ml/preprocess.py` | Per-service normalization params |
| `ml/data/latest_scores.json` | `ml/score.py` first run | Current anomaly scores |
| `ml/models/*.joblib` | `ml/train.py` | Serialized IsolationForest per service |

**To reset graph state completely:** `rm data/graph_db.json` — targets will be re-discovered from `remote_config.json` on next startup.

**To reset everything:** `rm -rf data/ ml/data/ ml/models/`

---

## Frontend — `client/vite.config.ts`

The Vite dev server proxies API calls to the backend:

```typescript
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws':  { target: 'ws://localhost:3001', ws: true },
    },
  },
});
```

This means in development, `fetch('/api/graph')` from the React app hits the backend on `:3001`. In production (served by NGINX), the proxy is replaced by NGINX `location` blocks.
