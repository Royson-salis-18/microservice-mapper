# 🌐 Microservice Mapper

**Microservice Mapper** is an enterprise-grade, real-time 3D telemetry and architecture mapping platform. It transforms opaque distributed systems into interactive, living maps, allowing engineers to visualize service dependencies, monitor resource health, and perform automated Root Cause Analysis (RCA) across complex AWS-deployed environments.

The platform was specifically designed and optimized for high-fidelity observability of distributed microservice workloads, with **Sock Shop** and **Vertikal** as the primary target projects.

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
- **Zero-Intrusion Monitoring**: No need to modify application code. The `remote-collector` agent extracts data directly from the Docker socket and host OS.
- **Resource Tracking**: Live gauges for CPU usage, Memory pressure, and Network I/O per container.
- **Interaction Tracing**: Parses Nginx/Apache and JSON logs to identify exactly which service is calling which endpoint.

### 🕵️ Automated Root Cause Analysis (RCA)
- **Incident Detection**: Automatically identifies "Incidents" when services enter `critical` or `degraded` states.
- **Evidence-Based Scoring**: Uses a multi-factor scoring engine to identify the primary root cause:
    - **Temporal Precedence**: Weights the earliest anomalous node higher (+0.30).
    - **Health Status**: Weights exited/critical containers highest (+0.35).
    - **Runtime Evidence**: Increases confidence when a runtime TCP/HTTP edge is observed (+0.20).
    - **Blast Radius**: Factors in the number of downstream failing services (+0.15).
- **Propagation Pathing**: Maps the "Cascade Effect," showing how a failure in one service propagates through the network to affect others.

### ⚡ Intelligent Traffic Control
- **Automatic Target Resolution**: Set your AWS endpoints once in your environment, and the system resolves them automatically.
- **User-Journey Simulation**: Sophisticated traffic engine that mimics real human behavior (Auth $\rightarrow$ Browse $\rightarrow$ Cart $\rightarrow$ Checkout) to trigger realistic internal service cascades.
- **Safety Guardrails**: Prevents accidental traffic execution against localhost or unconfigured targets.

---

## 🏗️ System Architecture

The system is decoupled into five specialized layers:

1. **Mapper Frontend (`/client`)**: Vite + React application. Renders the `ReactFlow` 2D graph and the Three.js 3D architectural view.
2. **Mapper Backend (`/server`)**: Node.js/Express brain. Maintains the global graph state, manages the Target Registry, and broadcasts updates via WebSockets.
3. **Remote Collector (`/remote-collector`)**: Lightweight Docker agent deployed on target EC2 instances. It acts as the primary data extraction engine on the remote host.
4. **Traffic Generator (`/traffic-generator`)**: A modular engine that exercises target workloads to generate the telemetry that feeds the map.
5. **Target Workloads**: The microservices being mapped (specifically **Sock Shop** and **Vertikal**), running on AWS EC2 instances optimized for telemetry extraction.

---

## 🛰️ AWS Telemetry Collection via SSH

The Microservice Mapper utilizes a sophisticated SSH-based ingestion pipeline to collect telemetry from remote AWS instances without requiring open inbound ports on the targets.

### 🔐 The Reverse SSH Mechanism
Instead of the backend "polling" the remote servers, the `remote-collector` initiates a **Reverse SSH Tunnel**. 

1. **Tunnel Establishment**: The collector on the AWS instance creates an encrypted tunnel back to the Mapper Backend:
   `ssh -R 3001:localhost:3001 backend-server`
2. **Data Streaming**: This tunnel maps the remote collector's local telemetry port (3001) to a port on the backend server.
3. **Secure Ingestion**: The backend can now stream real-time container metrics and log events from the AWS instance as if the collector were running locally.

### 🚀 AWS Instance Optimization
The target AWS EC2 instances are specifically optimized to support this telemetry pipeline:
- **Docker Socket Exposure**: Instances are configured to allow the `remote-collector` secure access to `/var/run/docker.sock` for real-time container stats and log streaming.
- **Log Standardization**: The target applications are optimized to output `mapper_json` formatted logs, allowing the collector to extract latency and upstream addresses with near-zero parsing overhead.
- **Resource Tuning**: EC2 instances are tuned to ensure the collector's background telemetry gathering does not impact the primary application's performance.

---

## 🚀 Getting Started

### 📦 Installation

First, install dependencies across all sub-projects:

```bash
npm run install:all
```

### ⚙️ Configuration

Configure your AWS environment variables in your shell or a `.env` file:

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
To see the map come to life, you need to generate traffic:
- **Via Web UI**: Navigate to **⚡ TRAFFIC** $\rightarrow$ Select Target $\rightarrow$ **START TRAFFIC**.
- **Via CLI**: `npm run traffic:sockshop` or `npm run traffic:vertikal`.

### Analyzing the Map
- **Nodes**: Check the color and gauges. A **Red** node indicates a critical health state.
- **Edges**: 
  - **Solid**: Declared dependency.
  - **Animated**: Observed runtime interaction.
- **RCA Panel**: View the automated root cause analysis to see why a system is failing and how the failure propagated.

---

## 🧠 How it Works: The "Magic"

### The Graph Merge Strategy
1. **Baseline**: The `server` parses `docker-compose.yml` to understand the *intended* architecture.
2. **Observation**: The `remote-collector` reads `/proc/net/tcp` and Docker logs to see the *actual* behavior.
3. **Merge**: The backend merges these. The edge becomes `observed: true`. If a connection is seen that wasn't declared, it's flagged as a "Shadow Edge."

### The Telemetry Pipeline
`Remote Collector (AWS)` $\xrightarrow{\text{Reverse SSH Tunnel}}$ `Mapper Backend` $\xrightarrow{\text{WebSockets}}$ `React Frontend`

---

## 🛠️ Tech Stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | React 18, Vite, ReactFlow, Three.js, `@react-three/fiber`, Tailwind CSS |
| **Backend** | Node.js, Express, Socket.io, TypeScript |
| **Agent** | Node.js, Docker Engine API |
| **Simulation** | Custom User-Journey Engine, Axios |
| **Infrastructure** | AWS EC2, Docker, Reverse SSH Tunnels |
