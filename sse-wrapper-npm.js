const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

const app = express();
const PORT = process.env.PORT || 8000;

// Enable CORS for n8n
app.use(cors());
app.use(express.json());

// Event emitter for MCP messages
const mcpEvents = new EventEmitter();
let mcpProcess = null;
let requestIdCounter = 1;
const pendingRequests = new Map();

// Start MCP server
function startMCPServer() {
  console.log('Starting Asana MCP server...');
  
  // Use npx to run the installed package
  mcpProcess = spawn('npx', ['@roychri/mcp-server-asana'], {
    env: {
      ...process.env,
      ASANA_ACCESS_TOKEN: process.env.ASANA_ACCESS_TOKEN
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Handle stdout (MCP responses)
  const rl = readline.createInterface({
    input: mcpProcess.stdout,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      console.log('MCP Response:', JSON.stringify(message, null, 2));
      
      // Handle response to specific request
      if (message.id && pendingRequests.has(message.id)) {
        const resolve = pendingRequests.get(message.id);
        pendingRequests.delete(message.id);
        resolve(message);
      }
      
      // Emit for SSE
      mcpEvents.emit('message', message);
    } catch (e) {
      console.error('Error parsing MCP output:', e, 'Line:', line);
    }
  });

  // Handle stderr
  mcpProcess.stderr.on('data', (data) => {
    console.error('MCP Error:', data.toString());
  });

  mcpProcess.on('close', (code) => {
    console.log(`MCP process exited with code ${code}`);
    // Restart if it crashes
    setTimeout(startMCPServer, 5000);
  });

  // Send initialization
  setTimeout(() => {
    sendMCPRequest({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'sse-wrapper',
          version: '1.0.0'
        }
      },
      id: 'init-1'
    });
  }, 1000);
}

// Send request to MCP server
function sendMCPRequest(request) {
  return new Promise((resolve) => {
    if (!request.id) {
      request.id = `req-${requestIdCounter++}`;
    }
    
    pendingRequests.set(request.id, resolve);
    
    const message = JSON.stringify(request) + '\n';
    console.log('Sending to MCP:', message);
    mcpProcess.stdin.write(message);
    
    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(request.id)) {
        pendingRequests.delete(request.id);
        resolve({ error: 'Request timeout' });
      }
    }, 30000);
  });
}

// SSE endpoint
app.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  // Listen for MCP messages
  const messageHandler = (message) => {
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  };
  
  mcpEvents.on('message', messageHandler);

  // Keep-alive
  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepAlive);
    mcpEvents.off('message', messageHandler);
  });
});

// List available tools
app.get('/tools', async (req, res) => {
  try {
    const response = await sendMCPRequest({
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {}
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Call a tool
app.post('/tools/:toolName', async (req, res) => {
  try {
    const { toolName } = req.params;
    const response = await sendMCPRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: req.body
      }
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// n8n webhook endpoint
app.post('/webhook/asana/:action', async (req, res) => {
  try {
    const { action } = req.params;
    
    // Map n8n actions to Asana MCP tools
    const toolName = `asana_${action}`;
    
    const response = await sendMCPRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: req.body
      }
    });
    
    if (response.error) {
      res.status(400).json(response.error);
    } else {
      res.json(response.result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    mcp_running: mcpProcess !== null && !mcpProcess.killed,
    asana_token_configured: !!process.env.ASANA_ACCESS_TOKEN
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`SSE wrapper listening on port ${PORT}`);
  startMCPServer();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  if (mcpProcess) {
    mcpProcess.kill();
  }
  process.exit(0);
});
