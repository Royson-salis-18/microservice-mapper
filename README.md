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
3. **Remote Collector (`/remote-collector`)**: Lightweight Docker agent deployed on target EC2 instances. It acts as the primary data extraction engine on the remote host.
4. **Traffic Generator (`/traffic-generator`)**: A modular engine that exercises target workloads to generate the telemetry that feeds the map.
5. **Target Workloads**: The microservices being mapped (e.g., Sock Shop, Vertikal), running on AWS EC2 instances specifically optimized for telemetry extraction.

---

## 🛰️ AWS Telemetry Collection via SSH

The Microservice Mapper utilizes a sophisticated SSH-based ingestion pipeline to collect telemetry from remote AWS instances without requiring open inbound ports on the targets, ensuring high security and minimal overhead.

### 🔐 The Reverse SSH Mechanism
Instead of the backend "polling" the remote servers, the `remote-collector` initiates a **Reverse SSH Tunnel**. 

1. **Tunnel Establishment**: The collector on the AWS instance creates an encrypted tunnel back to the Mapper Backend:
   `ssh -R 3001:localhost:3001 backend-server`
2. **Data Streaming**: This tunnel maps the remote collector's local telemetry port (3001) to a port on the backend server.
3. **Secure Ingestion**: The backend can now stream real-time container metrics and log events from the AWS instance as if the collector were running locally.

### 🚀 AWS Instance Optimization
The target AWS EC2 instances are specifically optimized to support this telemetry pipeline:
- **Docker Socket Exposure**: Instances are configured to allow the `remote-collector` secure access to `/var/run/docker.sock` for real-time container stats and log streaming.
- **Log Standardization**: The target applications (Sock Shop/Vertikal) are optimized to output `mapper_json` formatted logs, allowing the collector to extract latency and upstream addresses with near-zero parsing overhead.
- **Resource Tuning**: EC2 instances are tuned to ensure the collector's background telemetry gathering does not impact the primary application's performance.

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
`Remote Collector (AWS)` $\xrightarrow{\text{Reverse SSH Tunnel}}$ `Mapper Backend` $\xrightarrow{\text{WebSockets}}$ `React Frontend`

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
