const WebSocket = require('ws');
function broadcastToClients(payload) {
  const wss = global._wss;
  if (!wss) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
module.exports = { broadcastToClients };
