/**
 * Azure App Service entry point for Playwright MCP Server
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server } from './server.js';
import { resolveCLIConfig } from './config.js';
import { ElevenLabsHandler } from './elevenLabsIntegration.js';
import { contextFactory } from './browserContextFactory.js';
import { snapshotTools } from './tools.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

// Security middleware - configured for ElevenLabs integration
app.use(helmet({
  contentSecurityPolicy: false, // Disable for browser automation
  referrerPolicy: { policy: "no-referrer-when-downgrade" }, // Allow cross-origin requests
  crossOriginEmbedderPolicy: false, // Allow embedding
  crossOriginOpenerPolicy: false, // Allow cross-origin opening
  crossOriginResourcePolicy: { policy: "cross-origin" } // Allow cross-origin resource sharing
}));

// CORS configuration for ElevenLabs and MCP clients
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman, etc.)
    if (!origin) return callback(null, true);
    
    // Allow ElevenLabs domains
    if (origin.includes('elevenlabs.io') || 
        origin.includes('elevenlabs.com') ||
        origin === 'https://api.elevenlabs.io' ||
        origin === 'https://elevenlabs.io') {
      return callback(null, true);
    }
    
    // Allow localhost for development
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return callback(null, true);
    }
    
    // Allow custom origins from environment
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // For SSE/MCP connections, be more permissive
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Cache-Control',
    'Last-Event-ID',
    'mcp-session-id'
  ]
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Additional headers for ElevenLabs backend integration
app.use((req, res, next) => {
  // Log incoming requests for debugging
  console.log(`📥 ${req.method} ${req.url} - Origin: ${req.get('origin')} - Referer: ${req.get('referer')}`);
  
  // Set additional CORS headers
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Last-Event-ID, mcp-session-id');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Referrer-Policy', 'no-referrer-when-downgrade');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Tools endpoint for ElevenLabs direct integration
app.get('/tools', async (req, res) => {
  try {
    console.log('🛠️ ElevenLabs requesting tools via GET /tools');
    console.log('📊 Request headers:', JSON.stringify(req.headers, null, 2));
    console.log('📊 Query params:', JSON.stringify(req.query, null, 2));
    
    if (!mcpServer) {
      return res.status(503).json({
        error: 'MCP Server not initialized',
        message: 'Server is starting up, please try again'
      });
    }
    
    const toolsResult = await mcpServer.listTools();

    if (!toolsResult || !toolsResult.tools || !Array.isArray(toolsResult.tools)) {
      console.error('❌ Invalid tools result structure:', toolsResult);
      return res.status(500).json({
        error: 'Invalid tools result',
        message: 'MCP server returned invalid tools structure'
      });
    }
    
    // Format tools exactly as ElevenLabs expects - simple array format
    const formattedTools = toolsResult.tools.map(tool => {
      let parameters = {
        type: "object",
        properties: {},
        required: []
      };
      
      try {
        // Convert tool inputSchema to JSON Schema format
        if (tool.inputSchema && typeof tool.inputSchema === 'object') {
          const schema = tool.inputSchema as any;
          if (schema.properties) {
            parameters = {
              type: "object",
              properties: schema.properties,
              required: schema.required || []
            };
          }
        }
      } catch (e) {
        console.warn(`⚠️ Schema conversion failed for tool ${tool.name}:`, e);
      }
      
      return {
        id: tool.name,
        name: tool.name,
        description: tool.description,
        parameters: parameters
      };
    });

    console.log(`✅ Returning ${formattedTools.length} tools to ElevenLabs`);
    
    // IMPORTANT: Return a raw array (not wrapped in an object)
    res.json(formattedTools);
    
  } catch (error) {
    console.error('❌ Error serving tools:', error);
    res.status(500).json({
      error: 'Failed to retrieve tools',
      message: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

// Tool execution endpoint for ElevenLabs direct integration
app.post('/tools/:toolName', async (req, res) => {
  try {
    const { toolName } = req.params;
    const { arguments: toolArgs } = req.body;
    
    console.log(`🔧 ElevenLabs executing tool: ${toolName}`, toolArgs);
    
    if (!mcpServer) {
      return res.status(503).json({
        error: 'MCP Server not initialized',
        message: 'Server is starting up, please try again'
      });
    }
    
    const result = await mcpServer.callTool(toolName, toolArgs || {});
    
    console.log(`✅ Tool ${toolName} executed successfully`);
    
    res.json({
      success: true,
      tool: toolName,
      result: result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`❌ Error executing tool ${req.params.toolName}:`, error);
    res.status(500).json({
      success: false,
      error: 'Tool execution failed',
      message: error instanceof Error ? error.message : 'Internal server error',
      tool: req.params.toolName
    });
  }
});

// Initialize MCP Server and ElevenLabs handler
let mcpServer: Server;
let elevenLabsHandler: ElevenLabsHandler;

async function initializeServices() {
  try {
    // Configure for Azure App Service
    const config = await resolveCLIConfig({
      browser: 'chromium',
      headless: true,
      isolated: true,
      blockServiceWorkers: true,
      caps: 'core,tabs,wait,vision',
      imageResponses: 'allow',
      vision: true,
      sandbox: false
    });

    console.log('🔧 Creating MCP Server with config:', {
      browser: config.browser,
      capabilities: config.capabilities,
      vision: config.vision
    });
    
    mcpServer = new Server(config);
    
    // Test if tools are loaded immediately after creation
    try {
      const testTools = await mcpServer.listTools();
      console.log(`🛠️ MCP Server loaded with ${testTools.tools.length} tools`);
      console.log('📋 Tool names:', testTools.tools.map(t => t.name).slice(0, 5));
    } catch (error) {
      console.error('❌ Error testing MCP server tools:', error);
    }
    
    elevenLabsHandler = new ElevenLabsHandler(config);
    
    console.log('✅ Services initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize services:', error);
    throw error;
  }
}

// ElevenLabs AI Agent endpoint
app.post('/api/browser-action', async (req, res) => {
  try {
    const { action, parameters, sessionId } = req.body;
    
    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Action is required'
      });
    }

    console.log(`🤖 ElevenLabs request: ${action}`, parameters);
    
    const result = await elevenLabsHandler.handleRequest({
      action,
      parameters: parameters || {},
      sessionId: sessionId || req.ip
    });

    res.json(result);
  } catch (error) {
    console.error('❌ Error handling ElevenLabs request:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

// MCP Protocol endpoint (for direct MCP clients)
app.post('/api/mcp', async (req, res) => {
  try {
    const { method, params } = req.body;
    
    // Handle MCP protocol messages
    let result;
    switch (method) {
      case 'tools/list':
        result = await mcpServer.listTools();
        break;
      case 'tools/call':
        result = await mcpServer.callTool(params.name, params.arguments);
        break;
      default:
        throw new Error(`Unknown MCP method: ${method}`);
    }

    res.json({
      jsonrpc: '2.0',
      id: req.body.id,
      result
    });
  } catch (error) {
    console.error('❌ Error handling MCP request:', error);
    res.json({
      jsonrpc: '2.0',
      id: req.body.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error'
      }
    });
  }
});

// MCP SSE endpoint for ElevenLabs integration  
const sessions = new Map();

async function handleSSE(req: express.Request, res: express.Response, url: URL) {
  if (req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.statusCode = 400;
      return res.end('Missing sessionId');
    }

    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      return res.end('Session not found');
    }

    return await transport.handlePostMessage(req, res);
  } else if (req.method === 'GET') {
    console.log('🔌 New MCP SSE connection');
    
    const transport = new SSEServerTransport('/sse', res);
    sessions.set(transport.sessionId, transport);
    
    console.log(`📡 Created SSE session: ${transport.sessionId}`);
    
    const connection = await mcpServer.createConnection(transport);
    res.on('close', () => {
      console.log(`🔌 SSE session closed: ${transport.sessionId}`);
      sessions.delete(transport.sessionId);
      void connection.close().catch(e => console.error('Error closing connection:', e));
    });
    return;
  }

  res.statusCode = 405;
  res.end('Method not allowed');
}

// Handle SSE requests
app.use('/sse', async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    await handleSSE(req, res, url);
  } catch (error) {
    console.error('❌ Error handling SSE request:', error);
    res.status(500).end('SSE request failed');
  }
});

// Session management
app.delete('/api/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    await elevenLabsHandler.closeSession(sessionId);
    res.json({ success: true, message: 'Session closed' });
  } catch (error) {
    console.error('❌ Error closing session:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to close session'
    });
  }
});

// Get available actions for ElevenLabs
app.get('/api/actions', (req, res) => {
  res.json({
    actions: [
      {
        name: 'navigate',
        description: 'Navigate to a URL',
        parameters: {
          url: { type: 'string', required: true, description: 'URL to navigate to' }
        }
      },
      {
        name: 'click',
        description: 'Click an element on the page',
        parameters: {
          element: { type: 'string', required: true, description: 'Element description' },
          ref: { type: 'string', required: false, description: 'Element reference' }
        }
      },
      {
        name: 'type',
        description: 'Type text into an input field',
        parameters: {
          text: { type: 'string', required: true, description: 'Text to type' },
          element: { type: 'string', required: false, description: 'Input field description' }
        }
      },
      {
        name: 'screenshot',
        description: 'Take a screenshot of the current page',
        parameters: {}
      },
      {
        name: 'extract_text',
        description: 'Extract text content from the page',
        parameters: {}
      },
      {
        name: 'wait',
        description: 'Wait for text to appear or time to pass',
        parameters: {
          text: { type: 'string', required: false, description: 'Text to wait for' },
          time: { type: 'number', required: false, description: 'Time to wait in seconds' }
        }
      }
    ]
  });
});

// Error handling middleware
app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🔄 SIGTERM received, shutting down gracefully...');
  await elevenLabsHandler.cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🔄 SIGINT received, shutting down gracefully...');
  await elevenLabsHandler.cleanup();
  process.exit(0);
});

// Start server
async function startServer() {
  try {
    await initializeServices();
    
    app.listen(port, '0.0.0.0', () => {
      console.log(`🚀 Playwright MCP Server running on port ${port}`);
      console.log(`📍 Health check: http://localhost:${port}/health`);
      console.log(`🤖 ElevenLabs endpoint: http://localhost:${port}/api/browser-action`);
      console.log(`🔧 MCP endpoint: http://localhost:${port}/api/mcp`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

export { app };