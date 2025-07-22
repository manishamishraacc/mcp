/**
 * Azure App Service entry point for Playwright MCP Server
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { Server } from './server.js';
import { resolveCLIConfig } from './config.js';
import { ElevenLabsHandler } from './elevenLabsIntegration.js';
import { contextFactory } from './browserContextFactory.js';
import { snapshotTools } from './tools.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);
interface JSONSchemaObject {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
}
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
        name: tool.name,
        description: tool.description,
        parameters: parameters
      };
    });

    console.log(`✅ Returning ${formattedTools.length} tools to ElevenLabs`);
    
    // Check if ElevenLabs expects Server-Sent Events format
    const acceptHeader = req.get('Accept');
    if (acceptHeader && acceptHeader.includes('text/event-stream')) {
      console.log('📡 ElevenLabs expects SSE format - implementing MCP SSE protocol');
      
      try {
        // Create SSE transport for proper MCP protocol
        const transport = new SSEServerTransport('/tools', res);
        sseSessions.set(transport.sessionId, transport);
        
        console.log(`📡 Created SSE session for tools: ${transport.sessionId}`);
        
        // Create MCP connection
        const connection = await mcpServer.createConnection(transport);
        
        // Handle connection cleanup
        res.on('close', () => {
          console.log(`🔌 Tools SSE session closed: ${transport.sessionId}`);
          sseSessions.delete(transport.sessionId);
          void connection.close().catch(e => console.error('Error closing tools connection:', e));
        });
        
        return; // Don't send additional response
      } catch (error) {
        console.error('❌ Error setting up tools SSE connection:', error);
        return res.status(500).end('Tools SSE setup failed');
      }
    } else {
      // Check if this is an ElevenLabs MCP server configuration request
      const userAgent = req.get('User-Agent');
      const referer = req.get('Referer');
      const origin = req.get('Origin');
      
      console.log('🔍 Request analysis:', {
        userAgent: userAgent?.substring(0, 100),
        referer: referer?.substring(0, 100),
        origin: origin?.substring(0, 100),
        accept: req.get('Accept')?.substring(0, 100)
      });
      
      // ElevenLabs makes requests from api.us.elevenlabs.io
      if (origin?.includes('elevenlabs.io') || referer?.includes('elevenlabs.io') || userAgent?.includes('python-httpx')) {
        console.log('🔧 ElevenLabs requesting tools - returning wrapped format');
        
        const response = {
          tools: formattedTools
        };
        
        console.log('📤 /tools Response being sent to ElevenLabs:');
        console.log(JSON.stringify(response, null, 2));
        
        // Return tools in the exact format ElevenLabs expects
        res.json(response);
      } else {
        console.log('📄 Browser request - sending tools as JSON array');
        
        console.log('📤 /tools Response being sent to browser:');
        console.log(JSON.stringify(formattedTools, null, 2));
        
        // IMPORTANT: Return a raw array (not wrapped in an object) for browser
        res.json(formattedTools);
      }
    }
    
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
    
    const response = {
      success: true,
      tool: toolName,
      result: result,
      timestamp: new Date().toISOString()
    };
    
    console.log('📤 Tool execution response being sent:');
    console.log(JSON.stringify(response, null, 2));
    
    res.json(response);
    
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

// ElevenLabs ClientTools configuration endpoint
app.get('/api/elevenlabs-tools', async (req, res) => {
  try {
    console.log('🛠️ ElevenLabs requesting clientTools configuration (GET)');
    
    if (!elevenLabsHandler) {
      return res.status(503).json({
        error: 'ElevenLabs handler not initialized',
        message: 'Server is starting up, please try again'
      });
    }
    
    const clientToolsConfig = elevenLabsHandler.getClientToolsConfig();
    const toolDefinitions = elevenLabsHandler.getToolDefinitions();
    
    console.log(`✅ Returning ${Object.keys(clientToolsConfig.clientTools).length} clientTools to ElevenLabs`);
    
    res.json({
      success: true,
      clientTools: clientToolsConfig.clientTools,
      toolDefinitions: toolDefinitions,
      message: 'Use these clientTools in your ElevenLabs Conversation.startSession() configuration'
    });
    
  } catch (error) {
    console.error('❌ Error serving ElevenLabs clientTools:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve clientTools configuration',
      message: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

// ElevenLabs ClientTools configuration endpoint (POST support)
app.post('/api/elevenlabs-tools', async (req, res) => {
  try {
    console.log('🛠️ ElevenLabs requesting clientTools configuration (POST)');
    console.log('📊 Request body:', JSON.stringify(req.body, null, 2));
    
    if (!elevenLabsHandler) {
      return res.status(503).json({
        jsonrpc: '2.0',
        id: req.body.id,
        error: {
          code: -32603,
          message: 'ElevenLabs handler not initialized'
        }
      });
    }
    
    // Handle MCP protocol messages
    const { method, params, id } = req.body;
    
    switch (method) {
      case 'initialize':
        console.log('🔧 ElevenLabs MCP client initializing...');
        res.json({
          jsonrpc: '2.0',
          id: id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: 'Playwright MCP Server',
              version: '1.0.0'
            }
          }
        });
        break;
        
      case 'tools/list':
        console.log('📋 ElevenLabs requesting tools list...');
        const mcpToolDefinitions = elevenLabsHandler.getToolDefinitions();
        res.json({
          jsonrpc: '2.0',
          id: id,
          result: {
            tools: mcpToolDefinitions
          }
        });
        break;
        
      case 'tools/call':
        console.log(`🛠️ ElevenLabs calling tool: ${params.name}`, params.arguments);
        try {
          const clientToolsConfig = elevenLabsHandler.getClientToolsConfig();
          const toolFunction = clientToolsConfig.clientTools[params.name];
          
          if (!toolFunction) {
            throw new Error(`Tool ${params.name} not found`);
          }
          
          const result = await toolFunction(params.arguments || {});
          
          res.json({
            jsonrpc: '2.0',
            id: id,
            result: {
              content: [
                {
                  type: 'text',
                  text: typeof result === 'string' ? result : JSON.stringify(result)
                }
              ]
            }
          });
        } catch (error) {
          res.json({
            jsonrpc: '2.0',
            id: id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Tool execution failed'
            }
          });
        }
        break;
        
      default:
        // Fallback to clientTools configuration for non-MCP requests
        const fallbackClientToolsConfig = elevenLabsHandler.getClientToolsConfig();
        const fallbackToolDefinitions = elevenLabsHandler.getToolDefinitions();
        
        console.log(`✅ Returning ${Object.keys(fallbackClientToolsConfig.clientTools).length} clientTools to ElevenLabs`);
        
        res.json({
          success: true,
          clientTools: fallbackClientToolsConfig.clientTools,
          toolDefinitions: fallbackToolDefinitions,
          message: 'Use these clientTools in your ElevenLabs Conversation.startSession() configuration'
        });
    }
    
  } catch (error) {
    console.error('❌ Error serving ElevenLabs clientTools:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body.id,
      error: {
        code: -32603,
        message: 'Failed to retrieve clientTools configuration'
      }
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

// MCP endpoints for ElevenLabs integration  
const sseSessions = new Map();
const streamableSessions = new Map();

async function handleSSE(req: express.Request, res: express.Response, url: URL) {
  if (req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.statusCode = 400;
      return res.end('Missing sessionId');
    }

    const transport = sseSessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      return res.end('Session not found');
    }

    return await transport.handlePostMessage(req, res);
  } else if (req.method === 'GET') {
    console.log('🔌 New MCP SSE connection');
    
    const transport = new SSEServerTransport('/sse', res);
    sseSessions.set(transport.sessionId, transport);
    
    console.log(`📡 Created SSE session: ${transport.sessionId}`);
    
    const connection = await mcpServer.createConnection(transport);
          res.on('close', () => {
        console.log(`🔌 SSE session closed: ${transport.sessionId}`);
        sseSessions.delete(transport.sessionId);
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

  // MCP StreamableHTTP endpoint for ElevenLabs integration
  app.use('/mcp', async (req, res) => {
    try {
      console.log('🔌 New MCP StreamableHTTP request');
      console.log('📊 Request method:', req.method);
      console.log('📊 Request headers:', JSON.stringify(req.headers, null, 2));
  
      if (req.method === 'POST') {
        const body = req.body;
        console.log('📊 Request body:', JSON.stringify(body, null, 2));
  
        // Handle tool list request from ElevenLabs
        if (body?.method === 'initialize') {
          if (!mcpServer) {
            return res.status(503).json({
              error: 'MCP Server not initialized',
              message: 'Server is starting up, please try again',
            });
          }
  
          const toolsResult = await mcpServer.listTools();
  
          if (!toolsResult || !Array.isArray(toolsResult.tools)) {
            console.error('❌ Invalid tools result structure:', toolsResult);
            return res.status(500).json({
              error: 'Invalid tools result',
              message: 'MCP server returned invalid tools structure',
            });
          }
  
          const formattedTools = toolsResult.tools.map((tool) => {
            let parameters: JSONSchemaObject = {
              type: 'object',
              properties: {},
              required: [],
            };
  
            try {
              if (tool.inputSchema) {
                const schema = zodToJsonSchema(tool.inputSchema, tool.name);
  
                if (
                  schema &&
                  typeof schema === 'object' &&
                  'type' in schema &&
                  schema.type === 'object' &&
                  'properties' in schema
                ) {
                  parameters = {
                    type: 'object',
                    properties: schema.properties,
                    required: Array.isArray(schema.required) ? schema.required : []
                  };
                }
              }
            } catch (e) {
              console.warn(`⚠️ Failed to convert Zod schema for tool ${tool.name}:`, e);
            }
  
            return {
              name: tool.name,
              description: tool.description,
              parameters,
            };
          });
  
          const response = {
            jsonrpc: '2.0',
            id: body.id ?? 0,
            result: {
              tools: formattedTools,
            },
          };
  
          console.log(`✅ Returning ${formattedTools.length} tools via /mcp`);
          console.log('📤 Response:', JSON.stringify(response, null, 2));
  
          res.setHeader('Content-Type', 'application/json');
          return res.status(200).json(response);
        }
      }
  
      // Handle StreamableHTTP sessions (voice interaction)
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId) {
        const transport = streamableSessions.get(sessionId);
        if (!transport) {
          res.status(404).end('Session not found');
          return;
        }
        return await transport.handleRequest(req, res);
      }
  
      if (req.method === 'POST') {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            streamableSessions.set(id, transport);
          },
        });
  
        transport.onclose = () => {
          if (transport.sessionId) {
            streamableSessions.delete(transport.sessionId);
          }
        };
  
        await mcpServer.createConnection(transport);
        return await transport.handleRequest(req, res);
      }
  
      res.status(400).end('Invalid request');
    } catch (error) {
      console.error('❌ Error in /mcp handler:', error);
      res.status(500).end('MCP request failed');
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