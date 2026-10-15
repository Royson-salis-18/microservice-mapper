/**
 * One colour per kind of service, shared by every view so a database is the
 * same green in 3D, on the 2D canvas and in every table.
 *
 * Red and amber are deliberately absent: those two mean "degraded" and
 * "critical" and nothing else, so trouble is never mistaken for a category.
 */
export const TYPE_COLORS: Record<string, string> = {
  gateway: '#6f8dff',
  frontend: '#b98cff',
  service: '#3fb8f0',
  database: '#38c793',
  cache: '#f27bbd',
  queue: '#a6d84a',
  infrastructure: '#8fa0b8',
  external: '#d5dbe4',
};

export const typeColor = (type: string | undefined): string =>
  TYPE_COLORS[type ?? ''] ?? TYPE_COLORS.service;

/** `rgba()` of a hex colour, for tinted backgrounds and borders. */
export function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Health, the one thing the map and graphs colour by. */
export const STATE_HEX: Record<string, string> = {
  healthy: '#3ecf8e',
  degraded: '#e8a33d',
  critical: '#ef5f67',
  unknown: '#6b7079',
};
