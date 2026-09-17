# 🌐 Microservice Mapper

**Microservice Mapper** is a high-performance, real-time 3D telemetry and architecture mapping platform. It transforms opaque distributed systems into interactive, living maps, allowing engineers to visualize service dependencies, monitor resource health, and trace request flows across complex AWS-deployed environments (specifically optimized for **Sock Shop** and **Vertikal**).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-18+-blue.svg)](https://reactjs.org/)
[![Three.js](https://img.shields.io/badge/Three.js-Fiber-black.svg)](https://threejs.org/)

---

## ✨ Key Features

### 🗺️ Dynamic Architecture Mapping
- **Hybrid Graph Construction**: Combines a **Declared Baseline** (parsed from `docker-compose.yml`) with a **Runtime Overlay** (observed via TCP connections and HTTP logs).
- **Real-time Edge Flow**: Visualizes active communication with "marching ants" animations. Edge colors shift dynamically based on latency and error rates (Cyan $\rightarrow$ Yellow $\rightarrow$ Red).
- **3D Topology View**: A premium WebGL-powered 3D visualization using `@react-three/fiber` for a spatial understanding of your cluster.

### 📊 Deep Telemetry Ingestion
- **Zero-Intrusion Monitoring**: No need to modify your app code. The `remote-collector` agent extracts data directly from the Docker socket and host OS.
- **Resource Tracking**: Live gauges for CPU usage, Memory pressure, and Network I/O per container.
- **Interaction Tracing**: Parses Nginx/Apache and JSON logs to identify exactly which service is calling which endpoint.

### ⚡ Intelligent Traffic Control
- **Automatic Target Resolution**: No manual URL entry. Set your AWS endpoints once in your environment, and the system resolves them automatically.
- **User-Journey Simulation**: Sophisticated traffic engine that mimics real human behavior (Auth $\rightarrow$ Browse $\rightarrow$ Cart $\rightarrow$ Checkout) to trigger realistic internal service cascades.
- **Safety Guardrails**: Prevents accidental traffic execution against localhost or unconfigured targets.

---

## 🏗️ System Architecture

The system is decoupled into five specialized layers:

1. **Mapper Frontend (`/client`)**: Vite + React application. Renders the `ReactFlow` 2D graph and the Three.js 3D architectural view.
2. **Mapper Backend (`/server`)**: Node.js/Express brain. Maintains the global graph state, manages the Target Registry, and broadcasts updates via WebSockets.
3. **Remote Collector (`/remote-collector`)**: Lightweight Docker agent deployed on target EC2 instances. Bridges the gap between the remote Docker API and the central backend via reverse SSH tunnels.
4. **Traffic Generator (`/traffic-generator`)**: A modular engine that exercises target workloads to generate the telemetry that feeds the map.
5. **Target Workloads**: The microservices being mapped (e.g., Sock Shop, Vertikal).

---

## 🚀 Getting Started

### 📦 Installation

First, install dependencies across all sub-projects:

```bash
npm run install:all
```

### ⚙️ Configuration

The Mapper uses a **Single Source of Truth** for target endpoints. Configure your AWS environment variables in your shell or a `.env` file:

```bash
# Target AWS endpoints
export SOCK_SHOP_BASE_URL="http://<YOUR_AWS_SOCK_SHOP_IP>:80"
export VERTIKAL_BASE_URL="http://<YOUR_AWS_VERTIKAL_IP>:54321"
```

### 🛠️ Running the Platform

Start the backend and frontend concurrently:

```bash
npm run dev
```

- **Frontend**: `http://localhost:5173`
- **Backend**: `http://localhost:3000` (API & WebSockets)

---

## 🕹️ Usage Guide

### Generating Telemetry
To see the map come to life, you need to generate traffic. You can do this in two ways:

#### 1. Via the Web UI (Recommended)
1. Navigate to the **⚡ TRAFFIC** tab in the top navigation bar.
2. Select your target (**Sock Shop** or **Vertikal**). The system will automatically resolve the `baseUrl` from your environment variables.
3. Click **▶ START TRAFFIC**.

#### 2. Via the Command Line
```bash
# Start Sock Shop traffic
npm run traffic:sockshop

# Start Vertikal traffic
npm run traffic:vertikal

# Start all configured targets
npm run traffic:all
```

### Analyzing the Map
- **Nodes**: Check the color and gauges. A **Red** node indicates a critical health state or high error rate.
- **Edges**:
  - **Solid Line**: Declared dependency (from Compose file).
  - **Animated Line**: Observed runtime interaction.
  - **Color**: Cyan (Healthy) $\rightarrow$ Yellow (Degraded) $\rightarrow$ Red (Critical/High Latency).
- **Traffic Control**: Use the panel to toggle between different simulation scenarios.

---

## 🧠 How it Works: The "Magic"

### The Graph Merge Strategy
The Mapper doesn't just draw lines; it validates architecture.
1. **Baseline**: The `server` parses `docker-compose.yml`. It says, *"Service A is supposed to talk to Service B."*
2. **Observation**: The `remote-collector` reads `/proc/net/tcp` and Docker logs. It says, *"I just saw a TCP connection from A to B."*
3. **Merge**: The backend merges these. The edge becomes `observed: true`. If the collector sees a connection that **wasn't** in the Compose file, a new "Shadow Edge" is created, alerting you to undocumented dependencies.

### The Telemetry Pipeline
`Remote Collector` $\xrightarrow{\text{Reverse SSH}}$ `Mapper Backend` $\xrightarrow{\text{WebSockets}}$ `React Frontend`

The collector strips Docker's 8-byte binary headers from logs, applies a high-performance regex to extract HTTP metadata, and streams it as a JSON payload to the backend for real-time broadcasting.

---

## 🛠️ Tech Stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | React 18, Vite, ReactFlow, Three.js, `@react-three/fiber`, Tailwind CSS |
| **Backend** | Node.js, Express, Socket.io, TypeScript |
| **Agent** | Node.js, Docker Engine API |
| **Simulation** | Custom User-Journey Engine, Axios |
| **Infrastructure** | AWS EC2, Docker, Reverse SSH Tunnels |
