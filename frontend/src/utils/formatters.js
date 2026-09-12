export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return 'N/A';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatPercent(value, decimals = 1) {
  if (value === null || value === undefined) return 'N/A';
  return `${value.toFixed(decimals)}%`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return 'N/A';
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTimestamp(ts) {
  if (!ts) return 'N/A';
  const date = new Date(ts);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

export function formatUptime(createdTimestamp) {
  if (!createdTimestamp) return 'N/A';
  const uptimeMs = Date.now() - new Date(createdTimestamp).getTime();
  return formatDuration(uptimeMs);
}

export function formatNumber(n) {
  if (n === null || n === undefined) return 'N/A';
  if (n < 1000) return n.toString();
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  return (n / 1000).toFixed(1) + 'K';
}

export function formatLatency(ms) {
  if (ms === null || ms === undefined) return 'N/A';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
