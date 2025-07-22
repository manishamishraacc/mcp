/**
 * Simplified Server class for Azure deployment
 */

import type { FullConfig } from './config.js';
import { Context } from './context.js';
import { contextFactory } from './browserContextFactory.js';
import { snapshotTools, visionTools } from './tools.js';
import type { Tool } from './tools/tool.js';
import { createConnection } from './connection.js';
import type { Connection } from '../index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export class Server {
  private config: FullConfig;
  private context: Context | undefined;
  private tools: Tool[];
  private _connectionList: Connection[] = [];

  constructor(config: FullConfig) {
    this.config = config;
    const allTools = config.vision ? visionTools : snapshotTools;
    this.tools = allTools.filter(tool => !config.capabilities || tool.capability === 'core' || config.capabilities.includes(tool.capability));
  }

  async listTools() {
    return {
      tools: this.tools.map(tool => ({
        name: tool.schema.name,
        description: tool.schema.description,
        inputSchema: tool.schema.inputSchema
      }))
    };
  }

  async callTool(name: string, args: any) {
    const tool = this.tools.find(t => t.schema.name === name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    if (!this.context) {
      const factory = contextFactory(this.config.browser);
      const { browserContext } = await factory.createContext();
      this.context = new Context(this.tools, this.config, factory);
    }

    return await tool.handle(this.context, args);
  }

  async createConnection(transport: Transport): Promise<Connection> {
    const factory = contextFactory(this.config.browser);
    const connection = createConnection(this.config, factory);
    await connection.server.connect(transport);
    this._connectionList.push(connection);
    return connection;
  }

  setupExitWatchdog() {
    let isExiting = false;
    const handleExit = async () => {
      if (isExiting) return;
      isExiting = true;
      setTimeout(() => process.exit(0), 15000);
      await Promise.all(this._connectionList.map(connection => connection.close()));
      process.exit(0);
    };

    process.stdin.on('close', handleExit);
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);
  }
}
