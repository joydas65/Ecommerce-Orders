import { createServer } from 'node:http';
import { runtimeHandler } from './runtime.js';

const port = Number(process.env.PORT || 4100);
const server = createServer(runtimeHandler);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, '127.0.0.1', () => console.info(`Orders service listening on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
