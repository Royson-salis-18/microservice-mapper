export const config = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3001,
  POLLING_INTERVAL_MS: process.env.POLLING_INTERVAL_MS ? parseInt(process.env.POLLING_INTERVAL_MS, 10) : 5000,
  METRIC_HISTORY_SIZE: process.env.METRIC_HISTORY_SIZE ? parseInt(process.env.METRIC_HISTORY_SIZE, 10) : 720,
  VERTIKAL_COMPOSE_PATH: process.env.VERTIKAL_COMPOSE_PATH || '/home/royson/Documents/projects/vertikal/docker-compose.yml',
  SOCK_SHOP_COMPOSE_PATH: process.env.SOCK_SHOP_COMPOSE_PATH || '/home/royson/Documents/projects/microservice-mapper/sock-shop-docker-compose.yml',
  INGEST_TOKEN: process.env.INGEST_TOKEN || 'mapper-secret-token',
  SOCK_SHOP_BASE_URL: process.env.SOCK_SHOP_BASE_URL || '',
  VERTIKAL_BASE_URL: process.env.VERTIKAL_BASE_URL || '',
};