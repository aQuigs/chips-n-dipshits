import { startDevServer } from '../src/dev/server.ts';
import { clientPage } from './bundle.ts';

const DEFAULT_PORT = 8787;

const server = await startDevServer({
  port: Number(process.env.PORT ?? DEFAULT_PORT),
  page: () => clientPage({}),
});

console.log(`Chips n' Dipshits is running at ${server.url}`);
console.log('Tables live in memory and are gone when this stops. Open the link in several windows to play against yourself.');
