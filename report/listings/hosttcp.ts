  dockerContainerTcp: (containerId: string): RemoteCommand<string> => ({
    name: "docker.container.tcp",
    // `if` rather than `a && b && c` on purpose: a stopped container reports
    // PID 0, and that should read as "no connections" (exit 0, empty output),
    // which is true, not as a scan failure the caller warns about.
    //
    // The same network namespace's /proc/<pid>/net/dev rides along after a
    // marker line: exact byte counters per interface, read in the same exec.
    // docker stats prints NET I/O rounded to three significant figures
    // ("527MB"), so a rate taken between two of its readings moved in steps
    // of ~200 KB/s at that size; these counters are exact.
    command: `PID=$(docker inspect ${sanitizeContainerId(containerId)} --format '{{.State.Pid}}' 2>/dev/null); if [ -n "$PID" ] && [ "$PID" != "0" ]; then cat /proc/$PID/net/tcp /proc/$PID/net/tcp6 2>&1; echo '${NETDEV_MARKER}'; cat /proc/$PID/net/dev 2>/dev/null; fi`,
    timeoutMs: 10_000,
    maxOutputBytes: 65_536,
  }),
