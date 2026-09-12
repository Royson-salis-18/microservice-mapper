I want to build a production-quality LIVE MICROservice architecture
visualization and observability dashboard for my projects.

I have two systems that this dashboard must eventually support:

1. Sock Shop microservices application
2. Vertikal application

The dashboard must NOT be a static architecture diagram and must NOT use
fake/mock telemetry.

The architecture graph should be generated from real service information,
real Docker/container information, real service interactions where available,
and real telemetry.

REFERENCE UI:
Use the attached reference screenshots as visual inspiration.

I want the visual language to be:
- dark/black graphite background
- premium technical observability dashboard
- dense but readable
- thin glowing connections
- red as the primary failure/alert color
- green for healthy
- amber/yellow for degraded
- subtle white/gray for neutral infrastructure
- large interactive network graph
- detailed right-side inspection panel
- minimal rounded panels
- high information density
- professional research/engineering tool rather than a generic admin dashboard

Do NOT copy the screenshots exactly.
Use them only as inspiration for the interaction model and visual density.

==================================================
CORE REQUIREMENT
==================================================

Build a reusable architecture graph system.

The graph must have:

NODES:
- service
- database
- queue/message broker
- API gateway
- frontend
- external dependency
- infrastructure component

EDGES:
- HTTP/API call
- database connection
- message/queue interaction
- dependency relationship

Every node should have a stable ID.

Every edge should have:
- source
- target
- interaction type
- protocol if known
- request count if telemetry is available
- latency if telemetry is available
- error count/rate if telemetry is available
- last seen timestamp
- status

DO NOT invent telemetry values.

If telemetry is unavailable for a field, display:
"Not available"
rather than inventing a number.

==================================================
LIVE DATA ARCHITECTURE
==================================================

Create a clean separation between:

1. DATA COLLECTION
2. NORMALIZATION
3. GRAPH MODEL
4. TELEMETRY STORE
5. UI VISUALIZATION

Use this conceptual pipeline:

REAL SYSTEM
    ↓
Collectors
    ↓
Normalized telemetry
    ↓
Service/Dependency Graph
    ↓
Graph state
    ↓
Interactive UI

Create interfaces/adapters so that Sock Shop and Vertikal can have
different collectors while sharing the same graph visualization engine.

For example:

Collector
  ├── SockShopCollector
  └── VertikalCollector

Both should produce the same normalized structure:

ServiceNode
DependencyEdge
MetricSnapshot
InteractionEvent

Do not tightly couple the UI to Docker or to one project.

==================================================
SOCK SHOP DATA SOURCE
==================================================

For Sock Shop, the system is running as Docker containers.

The collector should discover the running containers dynamically.

Collect at minimum:

- container/service name
- container ID
- image
- running state
- CPU usage
- memory usage
- memory percentage
- network RX
- network TX
- restart count
- uptime
- exposed ports

Use Docker/container information as the infrastructure source of truth.

Also parse the Docker Compose/service configuration where necessary to
determine known service dependencies.

IMPORTANT:

Do not assume that a Compose dependency means an actual runtime
interaction.

Separate:

KNOWN DEPENDENCY

from

OBSERVED RUNTIME INTERACTION

The UI should be able to distinguish these.

==================================================
SOCK SHOP RUNTIME INTERACTIONS
==================================================

Design the collector so that runtime service-to-service interactions can
be captured from real telemetry.

Prefer this hierarchy:

1. OpenTelemetry traces if available
2. HTTP/request telemetry if available
3. network/service observation if available
4. Docker Compose dependency information as fallback architecture metadata

The architecture graph should eventually show actual observed edges such
as:

frontend → catalogue
frontend → carts
frontend → orders
orders → payment
orders → shipping
orders → queue
queue → rabbitmq
catalogue → catalogue-db
carts → carts-db
etc.

DO NOT hard-code these as runtime facts.

They may be represented as known architecture dependencies until actual
telemetry confirms them.

==================================================
VERTIKAL DATA SOURCE
==================================================

Vertikal is a Next.js application with a local Supabase/Docker stack.

The collector must be designed to discover:

- Next.js application
- Supabase gateway
- Supabase Auth / GoTrue
- PostgREST
- PostgreSQL
- Supabase Studio
- postgres-meta
- Mailpit
- other running Vertikal infrastructure

Inspect the actual Vertikal repository and Docker configuration before
creating the dependency graph.

Inspect:
- docker-compose.yml
- package.json
- app/
- API routes
- Supabase configuration
- server-side data access
- authentication code
- database access
- storage access

Determine actual relationships from the code/configuration.

Again:

CODE/CONFIG DEPENDENCY
and
OBSERVED RUNTIME INTERACTION

must remain separate concepts.

==================================================
NORMALIZED DATA MODEL
==================================================

Create a normalized graph model similar to:

ServiceNode:
{
  id,
  name,
  type,
  project,
  status,
  metadata,
  metrics
}

DependencyEdge:
{
  id,
  source,
  target,
  type,
  protocol,
  sourceOfTruth,
  status,
  metrics,
  lastSeen
}

MetricSnapshot:
{
  timestamp,
  cpu,
  memory,
  networkRx,
  networkTx,
  latency,
  requestRate,
  errorRate,
  restartCount
}

InteractionEvent:
{
  timestamp,
  source,
  target,
  protocol,
  route,
  method,
  statusCode,
  latency
}

Use timestamps everywhere.

==================================================
IMPORTANT RESOURCE CONSTRAINT
==================================================

The Sock Shop environment may run on a small AWS EC2 instance.

Do NOT build an unnecessarily heavy telemetry system.

Avoid:
- huge databases
- high-frequency polling
- memory-heavy agents
- unnecessary Kubernetes
- unnecessary cloud services

Start with lightweight collection.

Make the sampling interval configurable.

Default to approximately 5 seconds for infrastructure metrics.

Runtime interaction collection should be event/trace based where possible
rather than aggressively polling every service.

==================================================
GRAPH ENGINE
==================================================

Build an interactive graph visualization.

Users must be able to:

- zoom
- pan
- drag nodes
- click nodes
- click edges
- search services
- focus a service
- hide/show infrastructure nodes
- filter by project
- filter by node type
- filter by status
- reset layout
- fit graph to screen

Use a proper graph visualization library rather than manually positioning
HTML elements.

Prefer React Flow if appropriate for the existing application.
If another graph library is already installed and suitable, reuse it.

The graph layout must automatically organize the architecture.

Avoid a giant tangled ball of nodes.

Use intelligent hierarchical/force-directed layout.

==================================================
NODE VISUALIZATION
==================================================

Every node should visually communicate health.

Healthy:
- subtle green indicator

Degraded:
- amber indicator

Critical:
- red indicator

Unknown:
- gray indicator

Node should display:

SERVICE NAME

small secondary information such as:

CPU 23%
MEM 41%
LAT 18ms

Do not overcrowd the node.

Use subtle animation only for live state changes.

Critical nodes can have a restrained red glow/pulse.

==================================================
EDGE VISUALIZATION
==================================================

Edges should visually communicate traffic and health.

Normal:
thin neutral connection

Active:
subtle animated flow

High latency:
amber

High error rate:
red

Failed dependency:
strong red

Edge thickness may represent request rate when real request-rate
telemetry exists.

Never invent traffic volume.

Clicking an edge must open its interaction details.

==================================================
RIGHT-SIDE INSPECTION PANEL
==================================================

When a service is clicked, open a detailed inspection panel.

The panel should contain:

SERVICE

Service name
Service type
Project
Container ID
Image
Status
Uptime

LIVE HEALTH

CPU
Memory
Network RX
Network TX
Restart count

REQUEST TELEMETRY

Request rate
Error rate
Average latency
P95 latency if available
P99 latency if available

DEPENDENCIES

Upstream services
Downstream services

RECENT INTERACTIONS

Timestamp
Source
Target
Route
HTTP method
Status
Latency

RECENT EVENTS

Failures
Restarts
Latency spikes
Health changes

Do not display fake values.

==================================================
SERVICE DETAIL UX
==================================================

The right panel should feel like a professional observability tool.

Include small charts for:

CPU over time
Memory over time
Latency over time
Request rate
Error rate

Use real historical telemetry collected by the backend.

Keep the charts compact.

Allow:

5 min
15 min
30 min
1 hour

where enough historical data exists.

If insufficient data exists, clearly state that.

==================================================
TOP BAR
==================================================

Create a top navigation/header with:

Architecture
Telemetry
Dependencies
Analytics

Project selector:

ALL
SOCK SHOP
VERTIKAL

Global status:

Healthy
Degraded
Critical

Search box:

Search services, containers, routes...

Live indicator:

● LIVE

and the last telemetry update timestamp.

==================================================
LEFT SIDE
==================================================

Provide compact graph controls:

Fit graph
Reset layout
Zoom +
Zoom -
Dependency mode
Telemetry mode
Failure mode

Filters:

All
Services
Databases
Queues
Gateways

==================================================
ANALYTICS
==================================================

The dashboard should eventually support:

Top CPU consumers
Top memory consumers
Highest latency services
Highest error-rate services
Most connected services
Most depended-on services
Recent failures
Dependency hotspots

Also calculate graph-level properties when enough data exists:

- node degree
- upstream dependency count
- downstream dependency count
- centrality
- dependency depth

These analytics should be derived from the actual graph.

==================================================
FAILURE VISUALIZATION
==================================================

This is important because this dashboard will eventually be used by my
cascading failure prediction/RCA research.

Design the graph so that a failure can later propagate visually.

For example:

Service A 🔴
     ↓
Service B 🟠
     ↓
Service C 🟡

The UI should be capable of showing:

SOURCE FAILURE
      ↓
AFFECTED DEPENDENCY
      ↓
DOWNSTREAM RISK

Do NOT implement fake failure propagation yet.

Prepare the architecture so my future probabilistic cascading-failure
model can provide:

riskScore
failureProbability
affectedProbability
propagationPath

to the graph.

==================================================
NO MOCK DATA
==================================================

This is a strict requirement.

Do NOT create fake services.

Do NOT create fake CPU values.

Do NOT create fake latency.

Do NOT create fake request counts.

Do NOT use random values to make the UI look alive.

If the collector has no data:

show:

"No telemetry available"

instead.

The graph itself may use architecture/configuration data where appropriate,
but clearly label its source.

==================================================
PROJECT STRUCTURE
==================================================

Before modifying anything:

1. Inspect the existing repository.
2. Identify the existing frontend framework.
3. Identify existing dependencies.
4. Identify existing API/backend architecture.
5. Identify whether a graph library already exists.
6. Identify existing telemetry collection.
7. Identify existing Docker integration.
8. Do not overwrite existing functionality.

Then propose the smallest clean architecture needed.

Do not blindly rewrite the project.

==================================================
FIRST IMPLEMENTATION
==================================================

For this first stage, DO NOT attempt to finish everything.

Implement only:

1. Reusable graph data model
2. Docker/service discovery layer
3. Sock Shop adapter
4. Vertikal adapter structure
5. Live infrastructure metrics collection
6. Graph API/state layer
7. Interactive graph UI
8. Clickable service nodes
9. Basic right-side service detail panel
10. Real-time refresh

Once this foundation works, stop and report:

- files created
- files modified
- commands required to run it
- how real telemetry flows through the system
- what data is currently live
- what telemetry is still missing
- how to test the graph

Do not continue to advanced analytics until this foundation is verified.

==================================================
QUALITY BAR
==================================================

The result should look like a serious observability/research platform.

Think:

"microservice command center"

rather than:

"dashboard template".

The graph should be the hero element.

The UI should feel similar in information density and sophistication to
the attached references while remaining original.

Prioritize:
- real data
- correctness
- clean architecture
- performance
- excellent interaction design
- readable graph
- detailed service inspection
- dark technical aesthetic
- red/green health visualization

Start by inspecting the existing project and report your findings before
making destructive architectural changes.