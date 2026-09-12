import { Suspense, useMemo, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { PerspectiveCamera, OrbitControls, Sparkles, DragControls } from '@react-three/drei';
import type { Node, Edge } from '@xyflow/react';
import * as THREE from 'three';
import { Node3D } from './Node3D';
import { Edge3D } from './Edge3D';

interface Scene3DProps {
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  onNodeClick: (id: string) => void;
  onPaneClick: () => void;
}

export function Scene3D({ nodes, edges, selectedNodeId, onNodeClick, onPaneClick }: Scene3DProps) {
  // Increased scale to place nodes much further apart
  const scale = 0.08; 
  
  // Local state for 3D positions to support dragging
  const [positions, setPositions] = useState<Record<string, [number, number, number]>>({});

  useEffect(() => {
    if (nodes.length === 0) return;
    
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      if (n.position.x < minX) minX = n.position.x;
      if (n.position.x > maxX) maxX = n.position.x;
      if (n.position.y < minY) minY = n.position.y;
      if (n.position.y > maxY) maxY = n.position.y;
    });

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    setPositions(prev => {
      const next = { ...prev };
      nodes.forEach(n => {
        if (!next[n.id]) {
          const x = (n.position.x - centerX) * scale;
          const z = (n.position.y - centerY) * scale;
          next[n.id] = [x, 0, z];
        }
      });
      return next;
    });
  }, [nodes, scale]);

  const mappedEdges = useMemo(() => {
    return edges.map(e => {
      return {
        ...e,
        startPos: positions[e.source] || [0,0,0],
        endPos: positions[e.target] || [0,0,0]
      };
    });
  }, [edges, positions]);

  return (
    <div style={{ 
      width: '100%', 
      height: '100%', 
      background: '#070a14',
      position: 'relative'
    }} onClick={(e) => {
      if (e.target === e.currentTarget) onPaneClick();
    }}>
      <Canvas shadows>
        <Suspense fallback={null}>
          <color attach="background" args={['#070a14']} />
          <fog attach="fog" args={['#070a14', 20, 100]} />
          
          <PerspectiveCamera 
            makeDefault 
            position={[0, 40, 50]} 
            fov={40}
            near={0.1} 
            far={1000} 
          />
          <OrbitControls 
            makeDefault
            enableRotate={true}
            enablePan={true}
            enableZoom={true}
            minDistance={10}
            maxDistance={120}
            maxPolarAngle={Math.PI / 2 - 0.1} 
            dampingFactor={0.05}
            mouseButtons={{
              LEFT: THREE.MOUSE.PAN,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.ROTATE
            }}
          />
          
          {/* High-contrast Neon Lighting */}
          <ambientLight intensity={0.2} />
          <directionalLight position={[10, 20, 10]} intensity={1.5} color="#00d4ff" />
          <directionalLight position={[-10, 15, -10]} intensity={0.5} color="#ff1744" />

          {/* Very faint background data particles */}
          <Sparkles count={50} scale={60} size={1} speed={0.2} opacity={0.2} color="#00d4ff" />

          {/* 3D Flowing Edges (Data Streams) */}
          {mappedEdges.map(edge => (
            <Edge3D 
              key={edge.id} 
              edge={edge as any} 
              startPos={edge.startPos as [number,number,number]} 
              endPos={edge.endPos as [number,number,number]} 
            />
          ))}

          {/* 3D Stylized Nodes */}
          {nodes.map(node => {
            const pos = positions[node.id] || [0,0,0];
            return (
              <DragControls 
                key={node.id} 
                axisLock="y" 
                onDragStart={() => {
                  // Select node immediately when interacting/clicking
                  onNodeClick(node.id);
                }}
                onDrag={(localMatrix, deltaLocalMatrix, worldMatrix, deltaWorldMatrix) => {
                  const newPos = new THREE.Vector3().setFromMatrixPosition(worldMatrix);
                  setPositions(prev => ({
                    ...prev,
                    [node.id]: [newPos.x, pos[1], newPos.z]
                  }));
                }}
              >
                <Node3D 
                  node={node as any} 
                  position={pos} 
                  isSelected={node.id === selectedNodeId}
                  onClick={() => {}} // Handled by DragControls onDragStart
                />
              </DragControls>
            );
          })}
        </Suspense>
      </Canvas>
    </div>
  );
}

