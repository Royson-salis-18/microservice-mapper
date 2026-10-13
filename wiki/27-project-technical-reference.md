
# Microservice Mapper | Technical Spec


The definitive engineering authority for the autonomous topology discovery platform. This manual details the mathematical foundations, architectural constraints, and implementation specifics of the system.






 Internal Technical Reference
 2026-09-15
                

 TypeScript / Node.js / React
 AWS EC2 / Docker
 Bearer Token (INGEST_TOKEN)
                



## 1. Project Vision & Scope


Microservice Mapper is engineered to solve the "Visibility Gap"—the discrepancy between how a system is designed (Declarative Architecture) and how it actually behaves (Runtime Topology).


Traditional observability relies on instrumentation (SDKs) or distributed tracing (OpenTelemetry). While powerful, these require significant developer effort to implement. Mapper takes a Zero-Touch approach, treating the network as the source of truth.


> Core Value Proposition: Move from "I think Service A calls Service B" to "I can prove Service A called Service B 4,500 times in the last 5 minutes with a P95 latency of 120ms."



## 2. Architecture Overview


The system is architected as a decoupled Hub-and-Spoke model, separating the Control Plane from the Data Plane to ensure scalability and security.


```
[ TARGET INFRASTRUCTURE ]                [ MAPPER CONTROL PLANE ]
┌──────────────────────────┐              ┌───────────────────────────────┐
│  Target EC2 Instance     │              │   Express API Server         │
│  ┌────────────────────┐  │              │   ┌───────────────────────┐   │
│  │ Docker Runtime     │  │              │   │ GraphStore (In-Memory) │   │
│  │ ├── Svc A (Node)   │  │              │   │ MetricStore (Buffers)  │   │
│  │ ├── Svc B (Java)   │  │              │   │ RCA Engine (Analysis)  │   │
│  │ └── Collector       │  │              │   └───────────────────────┘   │
│  └──────────┬─────────┘  │              │               ▲               │
│             │            │    HTTPS POST│               │               │
│             └────────────┼─────────────┤               │               │
└──────────────────────────┘  /api/ingest │               │               │
                                          │               ▼               │
                                          │   [ React / Three.js UI ]     │
                                          │   ┌───────────────────────┐   │
                                          │   │ 3D Topology Visualization│   │
                                          │   │ Live Interaction Stream  │   │
                                          │   └───────────────────────┘   │
                                          └───────────────────────────────┘
```



### 2.1 Control Plane Componentry


- GraphStore: The central repository for all nodes and edges. Implements target isolation for multi-tenancy.
- DiscoveryEngine: Manages SSH tunnels to targets, executes Docker inspections, and orchestrates collector deployment.
- RCA Engine: A heuristic-based analysis tool that identifies root causes of failure by correlating anomalies across the graph.
- WebSocket Manager: Handles real-time broadcast of graph updates to UI clients.



### 2.2 Data Plane Componentry


- Remote Collector: A Dockerized TypeScript process that reads /proc/net/tcp and tails container logs.
- Telemetry Envelope: A standardized JSON schema used to transport nodes, metrics, and interaction events.



## 3. Core Design Principles




#### 3.1 Non-Invasiveness


The system must not require modification of the target application code. It achieves this by utilizing "side-channel" telemetry (Logs, TCP tables, Docker Stats) rather than instrumenting code via SDKs.



#### 3.2 Deterministic Identity


To prevent "Node Drift," every entity is assigned a canonical ID based on the pattern targetId:serviceName. This ensures that telemetry from multiple sources (TCP vs. Logs) correlates to the same logical node.



#### 3.3 Eventual Consistency


The system accepts that telemetry may arrive out of order or be delayed. The GraphStore handles this by using lastSeen timestamps and a staleness-based state machine (LIVE $\rightarrow$ STALE $\rightarrow$ OFFLINE).




## 4. System Lifecycle


The lifecycle of a target environment within the Mapper follows a strict state transition flow:


```
[ Unconfigured ] $\rightarrow$ [ Registered ] $\rightarrow$ [ Discovering ] $\rightarrow$ [ Live ] $\rightarrow$ [ Analysis ]
      (via API)           (via Config)      (via SSH Scan)      (via Ingest)     (via RCA Loop)
```


1. Registration: Target IP and SSH keys are added to remote_config.json.
2. Discovery: EndpointDiscoveryEngine connects via SSH, identifies containers, and deploys the collector.
3. Ingestion: The Collector starts POSTing telemetry to /api/ingest.
4. Visualization: The Server broadcasts the discovered graph to the UI.
5. Analysis: The IncidentManager begins monitoring metrics for anomalies.



## 5. GraphStore Specification


The GraphStore.ts class is the most critical component of the server. It manages the in-memory representation of the entire microservice landscape.



### 5.1 Internal State Maps


| Property | Type | Responsibility |
| --- | --- | --- |
| targets | Map<string, Target> | Stores environment-level metadata (Host IP, Display Name, Status). |
| nodesByTarget | Map<string, Map<string, ServiceNode>> | Nested map allowing O(1) lookup of a service within a specific project. |
| edgesByTarget | Map<string, Map<string, DependencyEdge>> | Tracks dependencies. Keys are formatted as source->target. |



### 5.2 The Ingestion Algorithm


When a TelemetryEnvelope arrives, the following sequence is executed in ingestRemote():


```
function ingestRemote(payload, clientIp) {
  1. Normalize target identity and update target.lastSeen = now.
  2. For each node in payload.events.nodes:
     - Normalize ID to "target:service".
     - Update node.status and metadata (containerId, image).
  3. For each edge in payload.events.edges:
     - Normalize source/target IDs.
     - If edge.observed is true, update edge.lastSeen.
  4. For each metric in payload.events.metrics:
     - Push raw snapshot to MetricStore.
     - Update current node.metrics (cpu, mem, network).
  5. For each interaction in payload.events.interactions:
     - Create/Update DependencyEdge.
     - Mark edge.observed = true.
     - Map route to EndpointRegistry and update request counts.
  6. Broadcast 'graph-update' via WebSockets.
}
```



## 6. MetricStore & Aggregation


The MetricStore.ts provides the temporal depth required for anomaly detection. It doesn't just store the current state, but a sliding window of history.



### 6.1 Time-Series Buffering


The store maintains a Map<string, MetricSnapshot[]>. To prevent memory exhaustion, it implements a fixed-size buffer (maxSize). When the buffer is full, the oldest sample is shifted out.



### 6.2 Edge Metric Aggregation


The getAggregatedEdgeMetrics() method transforms raw interaction events into a statistical summary for a specific edge over a time window (default 5m):


```math
Error Rate = $\frac{\text{Requests with StatusCode } \ge 400}{\text{Total Requests}}$ 
Avg Latency = $\frac{\sum \text{LatencyMs}}{\text{Total Requests}}$ 
Throughput = $\frac{\sum \text{BytesSent}}{\text{WindowSeconds}}$
```



## 7. Endpoint Registry


The EndpointRegistry.ts manages the catalog of "reachable" interfaces. It separates the physical identity (IP/Port) from the logical identity (Service Name).


- Service IDs: Deterministic names stripped of Docker Compose prefixes.
- Endpoint IDs: Unique identifiers for a specific protocol/port pair on a service.
- Route IDs: Unique identifiers for a specific HTTP Method + Path combination.



## 8. API & Routing Layer


The API is built using Express.js and organized in routes.ts. It provides both synchronous REST endpoints for the UI and an asynchronous Ingestion endpoint for the collectors.


> Security Note: The /api/ingest endpoint is protected by a Bearer token (INGEST_TOKEN) to prevent unauthorized telemetry injection.



## 9. Anomaly Detection Logic


The AnomalyDetector.ts uses a combination of static thresholds and dynamic statistical analysis to identify problematic nodes.



### 9.1 Dynamic Z-Score Analysis


Instead of relying on a hard-coded "CPU > 80%" rule, the system calculates a Z-Score based on the last 15 minutes of history.


```math
$Z = \frac{x - \mu}{\sigma}$ 
            Where $x$ is current value, $\mu$ is the moving average, and $\sigma$ is the standard deviation.
```


| |Z| Value | Severity | Interpretation |
| --- | --- | --- |
| $2.5 \le Z < 3.0$ | MEDIUM | Statistically significant deviation. Monitor closely. |
| $3.0 \le Z < 4.0$ | HIGH | Strong anomaly. Likely impacting performance. |
| $Z \ge 4.0$ | CRITICAL | Extreme outlier. High probability of failure. |



## 10. RCA Engine Scoring


The RCAEngine.ts calculates a Root Cause Score for every failing node using a weighted evidence model.



### 10.1 The Scoring Weights



| Factor | Weight | Condition |
| --- | --- | --- |
| Temporal Precedence | +0.30 | Node was the first in the cluster to show an anomaly. |
| Critical Status | +0.35 | Container process exited or is in 'critical' state. |
| Observed Dependency | +0.20 | Runtime TCP traffic is confirmed between this node and others. |
| Downstream Impact | +0.15 | Multiple downstream dependencies are also failing. |
| Anomaly Presence | +0.10 | General metric anomaly (Z-score) detected. |




## 11. Incident Lifecycle


An Incident is a first-class object that encapsulates a failure event. The IncidentManager` manages the following states:


1. Detection: AnomalyDetector flags one or more nodes.
2. Analysis: RCAEngine calculates scores and identifies the primary root cause.
3. Propagation: The system traces the "Blast Radius" by following edges from the root cause downwards.
4. Remediation: The system generates a suggested command (e.g., docker start ...) based on the root cause.
5. Resolution: When anomalies disappear, the incident is marked as RESOLVED.



## 12. Graph Analytics


The GraphAnalytics.ts provides higher-order insights into the system topology.


- Node Degree: Sum of upstream and downstream connections. High degree nodes are "Critical Hubs."
- Top Consumers: Identifies services with the highest relative CPU/Memory usage.
- Connectivity Analysis: Finds the most connected nodes to identify single points of failure (SPOFs).



## 13. Discovery Engine Flow


The EndpointDiscoveryEngine` implements an automation flow to map remote target environments.


```
Discovery Flow:
1. Connect via SSH using .pem key.
2. Run 'docker ps' to identify all containers.
3. Run 'docker inspect' on each container:
   - Extract image name, ports, and environment variables.
   - Parse NetworkSettings to find internal IP addresses.
4. Parse 'docker-compose.yml' (if available):
   - Extract 'depends_on' blocks to build Declared Topology.
5. Register discovered services and endpoints in EndpointRegistry.
6. Deploy the 'remote-collector' container using 'docker run'.
7. Establish continuous polling loop for runtime metrics.
```



## 14. TargetAgent Lifecycle


The TargetAgent` manages the state of a single remote target, implementing auto-recovery for SSH drops.


> Recovery Logic: If a polling cycle fails, the agent enters recovering = true, closes the current connection, and schedules a reconnect attempt in 10 seconds.



## 15. Telemetry Platform (Lib)


The telemetry-platform is a shared library used by both the server and collector.


- ConnectionManager: Handles the complexity of SSH PTYs and tunnel persistence.
- DiscoveryEngine: The logic for parsing Docker-specific metadata into a generic architecture model.
- MetricCollector: Low-level primitives for reading system stats.



## 16. Collector Runtime


The remote-collector` is a high-performance TypeScript process optimized for low overhead.




#### Performance Characteristics:


- Polling Interval: Default 5 seconds.
- Log Tailing: Uses a sliding window to avoid reading the entire log file on every cycle.
- Ingestion: Batches telemetry events into a single TelemetryEnvelope.




## 17. TCP Inference Logic


The collector reads /proc/net/tcp on the host to identify established connections.


```
Algorithm:
1. Read /proc/net/tcp.
2. Filter for rows where state == '01' (TCP_ESTABLISHED).
3. Parse the local and remote hex-encoded IP addresses.
4. Use the local Docker network map to correlate these IPs to container names.
5. If SourceIP=SvcA and TargetIP=SvcB, mark Edge(SvcA $\rightarrow$ SvcB) as 'observed'.
```



## 18. HTTP Log Demuxing


The collector implements a Demuxer to handle multiple log formats.


1. JSON Parser: Parses structured logs and looks for upstream_addr.
2. Regex Parser: Applies a standard access log regex to infer target services via path analysis.
3. Upstream Mapping: Resolves upstream_addr back to a service name via internal IP map.



## 19. Traffic Controller


The TrafficController` manages external load generation via the traffic-generator CLI.


```
Traffic Execution:
- Spawns 'node --import tsx src/cli.ts' as a child process.
- Passes parameters: --target, --profile, --url, --mode.
- Listens to stdout for '__STATS__' markers to update real-time experiment metrics.
- Sends SIGTERM to the child process on stop.
```



## 20. Experiment Logic


Experiments are formal test runs that define a workload and "success limits" (e.g., P95 latency < 200ms).


> Experiment Lifecycle: START $\rightarrow$ MONITOR $\rightarrow$ EVALUATE $\rightarrow$ STOP.



## 21. Data Model: ServiceNode


| Field | Type | Description |
| --- | --- | --- |
| id | string | Canonical ID (target:service). |
| status | healthy | degraded | critical | unknown | Current health state based on metrics/z-score. |
| type | gateway | service | database | queue | frontend | Logical role of the service. |
| metrics | NodeMetrics | null | Current snapshot of CPU/Mem/Net. |



## 22. Data Model: DependencyEdge


| Field | Type | Description |
| --- | --- | --- |
| source | string | Source Node ID. |
| target | string | Target Node ID. |
| declared | boolean | True if found in Compose/Config. |
| observed | boolean | True if seen in TCP/Logs. |
| evidenceSources | string[] | List of sources (network-tcp, http-log, compose-config). |



## 23. Data Model: Telemetry Envelope


The envelope is the transport unit for all data from Collector $\rightarrow$ Server.


```
interface TelemetryEnvelope {
  schemaVersion: string;
  targetId: string;
  timestamp: string;
  events: {
    nodes: ServiceNode[];
    metrics: { nodeId: string; snapshot: MetricSnapshot }[];
    edges: DependencyEdge[];
    interactions: InteractionEvent[];
  }
}
```



## 24. Data Model: Incident


| Field | Type | Description |
| --- | --- | --- |
| rootCauseServiceId | string | null | The ID of the node determined to be the origin of failure. |
| confidence | LOW | MEDIUM | HIGH | UNKNOWN | Certainty of the RCA result. |
| propagation | PropagationStep[] | The sequence of failures cascading from the root. |
| evidence | EvidenceItem[] | The specific metrics/events that justify the incident. |



## 25. API Spec: Graph


| Endpoint | Method | Params | Response |
| --- | --- | --- | --- |
| /api/graph | GET | None | { nodes: [], edges: [], targets: [] } |
| /api/nodes/:id | GET | id (path) | ServiceNode object. |
| /api/nodes/:id/metrics | GET | range (query: '5m', '15m') | MetricSnapshot[] history. |



## 26. API Spec: Discovery


| Endpoint | Method | Params | Response |
| --- | --- | --- | --- |
| /api/targets | GET | None | Target[] |
| /api/targets/:id/discovery | GET | id (path) | TargetDiscoverySummary |
| /api/discovery/refresh | POST | { targetId: string } | { success: boolean } |



## 27. API Spec: Incidents


| Endpoint | Method | Params | Response |
| --- | --- | --- | --- |
| /api/incidents | GET | targetId (query) | Incident[] |
| /api/incidents/:id | GET | id (path) | Incident object. |
| /api/incidents/:id/propagation | GET | id (path) | PropagationStep[] |



## 28. API Spec: Traffic


| Endpoint | Method | Params | Response |
| --- | --- | --- | --- |
| /api/traffic/start | POST | { targetId, profile, mode } | TargetTrafficStatus[] |
| /api/traffic/stop | POST | { targetId } | TargetTrafficStatus |
| /api/experiments/start | POST | { targetId, profile, config } | { experimentId, trafficStatus } |



## 29. API Spec: Ingestion




### POST /api/ingest


The primary entry point for all remote telemetry.



#### Required Headers:


```
Authorization: Bearer <INGEST_TOKEN>
```



#### Payload Specification:


```
{
  "schemaVersion": "1.0",
  "targetId": "sock-shop",
  "timestamp": "2026-09-15T12:00:00Z",
  "events": {
    "nodes": [...],
    "metrics": [...],
    "edges": [...],
    "interactions": [...]
  }
}
```




## 30. Installation Guide


Follow these steps to set up a local development environment.



1. Clone Repository: git clone https://github.com/royson/microservice-mapper.git
2. Full Dependency Install: npm run install:all
3. Environment Setup: Create a .env file in the root: PORT=3001\nMAPPER_PUBLIC_URL=http://localhost:3001\nINGEST_TOKEN=mapper-secret-token
4. Launch: npm run dev




## 31. Deployment Guide


For deploying to an AWS environment:


- Server Instance: Deploy to an EC2 instance with port 3001 open.
- Public URL: Set MAPPER_PUBLIC_URL to the public IP of the server instance.
- Target Config: Add targets to data/remote_config.json with the correct .pem key path.



## 32. Troubleshooting Matrix


| Symptom | Root Cause | Resolution |
| --- | --- | --- |
| Nodes show "NO DATA" | Collector $\rightarrow$ Server Connectivity | Check Security Group for port 3001; verify MAPPER_PUBLIC_URL. |
| SSH Auth Failure | Incorrect PEM key or User | Check sshUsername and sshKeyPath in remote_config.json. |
| Graph is static/no edges | No runtime traffic observed | Run npm run traffic:sockshop to stimulate the system. |
| RCA reports "UNKNOWN" | Insufficient history for Z-Score | Wait 15 minutes for the MetricStore to build a baseline. |
| Collector not starting | Docker daemon inaccessible on target | Ensure SSH user has permissions to run docker without sudo. |



