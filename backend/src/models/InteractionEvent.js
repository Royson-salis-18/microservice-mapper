export function createInteractionEvent({ timestamp = Date.now(), source = null, target = null, protocol = null, route = null, method = null, statusCode = null, latency = null } = {}) {
  return {
    timestamp,
    source,
    target,
    protocol,
    route,
    method,
    statusCode,
    latency
  };
}
