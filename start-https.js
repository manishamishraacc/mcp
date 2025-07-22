import { HttpServer } from './lib/httpServer.js';
const server = new HttpServer();
const port = 8123; // Change this if you want a different port

server.routePath('/status', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
});

server.start({ port }).then(() => {
  console.log(`MCP HTTPS server running at https://localhost:${port}`);
}).catch(err => {
  console.error('Failed to start MCP HTTPS server:', err);
}); 