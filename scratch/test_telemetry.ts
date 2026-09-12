import { GraphStore } from '../server/graph/GraphStore.js';
import { DockerCollector } from '../server/collectors/DockerCollector.js';
import { VertikalAdapter } from '../server/collectors/VertikalAdapter.js';

async function main() {
  const graphStore = new GraphStore();
  const dockerCollector = new DockerCollector();
  const adapters = [new VertikalAdapter()];
  await graphStore.updateFromCollectors(dockerCollector, adapters);
  const nodes = graphStore.getGraph().nodes;
  console.log(`Found ${nodes.length} nodes:`);
  for (const n of nodes) {
    console.log(`- ${n.id} (${n.project}, status: ${n.status}): CPU ${n.metrics?.cpu ?? 'N/A'}%, MEM ${n.metrics?.memoryPercent ?? 'N/A'}%, Net RX ${n.metrics?.networkRx ?? 0} bytes`);
  }
}

main().catch(console.error);
