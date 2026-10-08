import { createServer, type Server } from 'node:http';

/** App Service expects the container to listen on PORT; this answers health probes. */
export function startHealthServer(port: number, status: () => Record<string, unknown>): Server {
  const server = createServer((req, res) => {
    const body = JSON.stringify({ status: 'ok', ...status() });
    res.writeHead(req.url === '/health' || req.url === '/' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  server.listen(port, () => console.log(`[worker] health server on :${port}`));
  return server;
}
