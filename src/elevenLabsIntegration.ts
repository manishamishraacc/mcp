/**
 * ElevenLabs AI Agent Integration Handler
 */

import { Context } from './context.js';
import type { FullConfig } from './config.js';
import { contextFactory } from './browserContextFactory.js';
import { snapshotTools, visionTools } from './tools.js';
import { PageSnapshot } from './pageSnapshot.js';
import { Tab } from './tab.js';

export interface ElevenLabsRequest {
  action: string;
  parameters: Record<string, any>;
  sessionId?: string;
}

// Parameter types for different actions
export interface NavigateParams {
  url: string;
}

export interface ClickParams {
  element: string;
  ref?: string;
}

export interface TypeParams {
  text: string;
  element?: string;
}

export interface WaitParams {
  text?: string;
  textGone?: string;
  time?: number;
}

export interface ScrollParams {
  direction?: 'up' | 'down';
  pixels?: number;
}

export interface ElevenLabsResponse {
  success: boolean;
  data?: any;
  error?: string;
  screenshot?: string;
  pageInfo?: {
    url: string;
    title: string;
    text?: string;
  };
}

// ElevenLabs ClientTools configuration type
export interface ElevenLabsClientToolsConfig {
  clientTools: Record<string, (parameters: any) => Promise<string | number | void> | string | number | void>;
}

export class ElevenLabsHandler {
  private contexts = new Map<string, Context>();
  private config: FullConfig;
  private tools: any[];

  constructor(config: FullConfig) {
    this.config = config;
    this.tools = config.vision ? visionTools : snapshotTools;
  }

  /**
   * Get ElevenLabs clientTools configuration for tool registration
   * This method creates tool handlers that ElevenLabs can use directly
   */
  getClientToolsConfig(): ElevenLabsClientToolsConfig {
    const clientTools: Record<string, (parameters: any) => Promise<string | number | void> | string | number | void> = {};

    // Register each tool as a client tool handler
    this.tools.forEach(tool => {
      clientTools[tool.schema.name] = async (parameters: any) => {
        try {
          console.log(`🛠️ ElevenLabs executing tool: ${tool.schema.name}`, parameters);
          
          // Create a default context for tool execution
          const context = await this.createContext();
          
          // Execute the tool
          const result = await context.run(tool, parameters);
          
                     // Return the result as a string
           if (result.content && result.content.length > 0) {
             const textContent = result.content.find(content => content.type === 'text');
             if (textContent) {
               return textContent.text as string;
             }
           }
           
           return `Tool ${tool.schema.name} executed successfully`;
        } catch (error) {
          console.error(`❌ Error executing tool ${tool.schema.name}:`, error);
          throw new Error(`Failed to execute ${tool.schema.name}: ${error}`);
        }
      };
    });

    return { clientTools };
  }

  /**
   * Get tool definitions in ElevenLabs format
   * This provides the tool metadata that ElevenLabs needs for registration
   */
  getToolDefinitions() {
    return this.tools.map(tool => ({
      name: tool.schema.name,
      description: tool.schema.description,
      parameters: {
        type: "object",
        properties: this.getToolProperties(tool),
        required: this.getToolRequired(tool)
      }
    }));
  }

  private getToolProperties(tool: any) {
    try {
      // Convert Zod schema to JSON Schema properties
      const schema = tool.schema.inputSchema;
      if (schema && schema.shape) {
        const properties: Record<string, any> = {};
        Object.keys(schema.shape).forEach(key => {
          const field = schema.shape[key];
          properties[key] = {
            type: this.getZodType(field),
            description: field.description || `${key} parameter`
          };
        });
        return properties;
      }
    } catch (error) {
      console.warn(`⚠️ Could not extract properties for tool ${tool.schema.name}:`, error);
    }
    return {};
  }

  private getToolRequired(tool: any) {
    try {
      const schema = tool.schema.inputSchema;
      if (schema && schema.shape) {
        return Object.keys(schema.shape).filter(key => {
          const field = schema.shape[key];
          return !field.isOptional && !field._def.defaultValue;
        });
      }
    } catch (error) {
      console.warn(`⚠️ Could not extract required fields for tool ${tool.schema.name}:`, error);
    }
    return [];
  }

  private getZodType(zodField: any): string {
    if (zodField._def.typeName === 'ZodString') return 'string';
    if (zodField._def.typeName === 'ZodNumber') return 'number';
    if (zodField._def.typeName === 'ZodBoolean') return 'boolean';
    if (zodField._def.typeName === 'ZodArray') return 'array';
    if (zodField._def.typeName === 'ZodObject') return 'object';
    return 'string'; // default
  }

  async handleRequest(request: ElevenLabsRequest): Promise<ElevenLabsResponse> {
    try {
      const sessionId = request.sessionId || 'default';
      let context = this.contexts.get(sessionId);
      
      if (!context) {
        context = await this.createContext();
        this.contexts.set(sessionId, context);
      }

      console.log(`🎯 Handling action: ${request.action} for session: ${sessionId}`);

      switch (request.action) {
        case 'navigate':
          return await this.handleNavigate(context, request.parameters as NavigateParams);
        case 'click':
          return await this.handleClick(context, request.parameters as ClickParams);
        case 'type':
          return await this.handleType(context, request.parameters as TypeParams);
        case 'screenshot':
          return await this.handleScreenshot(context);
        case 'extract_text':
          return await this.handleExtractText(context);
        case 'wait':
          return await this.handleWait(context, request.parameters as WaitParams);
        case 'scroll':
          return await this.handleScroll(context, request.parameters as ScrollParams);
        case 'get_page_info':
          return await this.handleGetPageInfo(context);
        default:
          throw new Error(`Unknown action: ${request.action}`);
      }
    } catch (error) {
      console.error(`❌ Error handling action ${request.action}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async createContext(): Promise<Context> {
    const factory = contextFactory(this.config.browser);
    return new Context(this.tools, this.config, factory);
  }

  private async handleNavigate(context: Context, params: NavigateParams): Promise<ElevenLabsResponse> {
    if (!params.url) {
      throw new Error('URL parameter is required');
    }

    const tab = await context.ensureTab();
    await tab.navigate(params.url);
    
    // Wait for page to load
    await tab.waitForLoadState('load', { timeout: 30000 });
    
    const [title, screenshot] = await Promise.all([
      tab.title(),
      tab.page.screenshot({ type: 'jpeg', quality: 50 })
    ]);

    return {
      success: true,
      data: { 
        url: params.url, 
        title,
        message: `Successfully navigated to ${params.url}`
      },
      screenshot: screenshot.toString('base64'),
      pageInfo: {
        url: params.url,
        title
      }
    };
  }

  private async handleClick(context: Context, params: ClickParams): Promise<ElevenLabsResponse> {
    if (!params.element) {
      throw new Error('Element parameter is required');
    }

    const tab = context.currentTabOrDie();
    
    try {
      if (params.ref) {
        // Use reference-based clicking
        await tab.page.locator(`aria-ref=${params.ref}`).click();
      } else {
        // Try multiple strategies to find the element
        const strategies = [
          () => tab.page.getByRole('button', { name: params.element }).first().click(),
          () => tab.page.getByRole('link', { name: params.element }).first().click(),
          () => tab.page.getByText(params.element).first().click(),
          () => tab.page.getByLabel(params.element).first().click(),
          () => tab.page.locator(`[aria-label*="${params.element}" i]`).first().click(),
          () => tab.page.locator(`[title*="${params.element}" i]`).first().click()
        ];

        let clicked = false;
        for (const strategy of strategies) {
          try {
            await strategy();
            clicked = true;
            break;
          } catch (e) {
            // Try next strategy
            continue;
          }
        }

        if (!clicked) {
          throw new Error(`Could not find clickable element: ${params.element}`);
        }
      }
      
      // Wait a bit for any navigation or changes
      await tab.page.waitForTimeout(1000);
      
      const screenshot = await tab.page.screenshot({ type: 'jpeg', quality: 50 });
      const title = await tab.title();
      
      return {
        success: true,
        data: { 
          message: `Successfully clicked: ${params.element}`,
          title
        },
        screenshot: screenshot.toString('base64'),
        pageInfo: {
          url: tab.page.url(),
          title
        }
      };
    } catch (error) {
      throw new Error(`Failed to click element "${params.element}": ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleType(context: Context, params: TypeParams): Promise<ElevenLabsResponse> {
    if (!params.text) {
      throw new Error('Text parameter is required');
    }

    const tab = context.currentTabOrDie();
    
    try {
      if (params.element) {
        // Try to find the input field by various methods
        const strategies = [
          () => tab.page.getByLabel(params.element!).fill(params.text),
          () => tab.page.getByPlaceholder(params.element!).fill(params.text),
          () => tab.page.getByRole('textbox', { name: params.element }).fill(params.text),
          () => tab.page.locator(`input[name*="${params.element}" i]`).fill(params.text),
          () => tab.page.locator(`textarea[name*="${params.element}" i]`).fill(params.text)
        ];

        let typed = false;
        for (const strategy of strategies) {
          try {
            await strategy();
            typed = true;
            break;
          } catch (e) {
            continue;
          }
        }

        if (!typed) {
          throw new Error(`Could not find input field: ${params.element}`);
        }
      } else {
        // Type into the currently focused element
        await tab.page.keyboard.type(params.text);
      }
      
      return {
        success: true,
        data: { 
          message: `Successfully typed: ${params.text}${params.element ? ` into ${params.element}` : ''}`
        }
      };
    } catch (error) {
      throw new Error(`Failed to type text: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleScreenshot(context: Context): Promise<ElevenLabsResponse> {
    const tab = context.currentTabOrDie();
    const screenshot = await tab.page.screenshot({ 
      type: 'jpeg', 
      quality: 50,
      fullPage: false 
    });
    
    const title = await tab.title();
    
    return {
      success: true,
      data: { message: 'Screenshot captured' },
      screenshot: screenshot.toString('base64'),
      pageInfo: {
        url: tab.page.url(),
        title
      }
    };
  }

  private async handleExtractText(context: Context): Promise<ElevenLabsResponse> {
    const tab = context.currentTabOrDie();
    
    const [text, title] = await Promise.all([
      tab.page.textContent('body'),
      tab.title()
    ]);
    
    return {
      success: true,
      data: { 
        text: text || '',
        message: 'Text extracted successfully'
      },
      pageInfo: {
        url: tab.page.url(),
        title,
        text: text || ''
      }
    };
  }

  private async handleWait(context: Context, params: WaitParams): Promise<ElevenLabsResponse> {
    const tab = context.currentTabOrDie();
    
    if (!params.text && !params.textGone && !params.time) {
      throw new Error('Either time, text, or textGone parameter is required');
    }

    try {
      if (params.time) {
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, params.time! * 1000)));
      }
      
      if (params.text) {
        await tab.page.getByText(params.text).first().waitFor({ 
          state: 'visible', 
          timeout: 30000 
        });
      }
      
      if (params.textGone) {
        await tab.page.getByText(params.textGone).first().waitFor({ 
          state: 'hidden', 
          timeout: 30000 
        });
      }
      
      return {
        success: true,
        data: { 
          message: `Wait completed: ${params.text ? `text "${params.text}" appeared` : ''}${params.textGone ? `text "${params.textGone}" disappeared` : ''}${params.time ? `waited ${params.time} seconds` : ''}`
        }
      };
    } catch (error) {
      throw new Error(`Wait failed: ${error instanceof Error ? error.message : 'Timeout'}`);
    }
  }

  private async handleScroll(context: Context, params: ScrollParams): Promise<ElevenLabsResponse> {
    const tab = context.currentTabOrDie();
    
    const direction = params.direction || 'down';
    const pixels = params.pixels || 500;
    const scrollAmount = direction === 'up' ? -pixels : pixels;
    
    await tab.page.evaluate((amount) => {
      window.scrollBy(0, amount);
    }, scrollAmount);
    
    // Wait for scroll to complete
    await tab.page.waitForTimeout(500);
    
    return {
      success: true,
      data: { 
        message: `Scrolled ${direction} by ${pixels} pixels`
      }
    };
  }

  private async handleGetPageInfo(context: Context): Promise<ElevenLabsResponse> {
    const tab = context.currentTabOrDie();
    
    const [title, url] = await Promise.all([
      tab.title(),
      Promise.resolve(tab.page.url())
    ]);
    
    return {
      success: true,
      data: {
        url,
        title,
        message: 'Page info retrieved'
      },
      pageInfo: {
        url,
        title
      }
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (context) {
      try {
        // Close all tabs
        for (const tab of context.tabs()) {
          await tab.page.close();
        }
        
        // Close browser context if it exists
        if ((context as any).browserContext) {
          await (context as any).browserContext.close();
        }
      } catch (error) {
        console.error(`Error closing session ${sessionId}:`, error);
      }
      
      this.contexts.delete(sessionId);
      console.log(`🗑️ Session ${sessionId} closed`);
    }
  }

  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up ElevenLabs handler...');
    
    const sessionIds = Array.from(this.contexts.keys());
    await Promise.all(sessionIds.map(id => this.closeSession(id)));
    
    console.log('✅ Cleanup completed');
  }
}