export function orientConnection(
  localPort: number,
  remotePort: number,
  scannedListenPorts: Set<number>,
  peerListenPorts: Set<number>,
): { scannedIsCaller: boolean; evidence: 'direction:listen-port' | 'direction:ephemeral-port' | 'direction:unresolved' } {
  const scannedIsServer = scannedListenPorts.has(localPort);
  const peerIsServer = peerListenPorts.has(remotePort);

  if (peerIsServer && !scannedIsServer) return { scannedIsCaller: true, evidence: 'direction:listen-port' };
  if (scannedIsServer && !peerIsServer) return { scannedIsCaller: false, evidence: 'direction:listen-port' };

  const localEphemeral = localPort >= EPHEMERAL_MIN && localPort <= EPHEMERAL_MAX;
  const remoteEphemeral = remotePort >= EPHEMERAL_MIN && remotePort <= EPHEMERAL_MAX;
  if (localEphemeral && !remoteEphemeral) return { scannedIsCaller: true, evidence: 'direction:ephemeral-port' };
  if (remoteEphemeral && !localEphemeral) return { scannedIsCaller: false, evidence: 'direction:ephemeral-port' };

  return { scannedIsCaller: true, evidence: 'direction:unresolved' };
}
