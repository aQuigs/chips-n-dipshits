import { buildAll } from './bundle.ts';
import { readDeployment } from './deployment.ts';

const deployment = await readDeployment();

await buildAll(deployment?.url ?? '');
console.log(`Built dist/gas and dist/web${deployment ? ` for ${deployment.url}` : ''}`);
