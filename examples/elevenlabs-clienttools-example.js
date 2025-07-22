/**
 * ElevenLabs ClientTools Integration Example
 * 
 * This example shows how to use the Playwright MCP Server with ElevenLabs
 * using the clientTools approach instead of MCP protocol.
 */

import { Conversation } from '@elevenlabs/client';

// Example of how to use the Playwright MCP Server with ElevenLabs clientTools
async function startElevenLabsConversation() {
  try {
    // First, fetch the clientTools configuration from our MCP server
    const response = await fetch('https://mcpphas2-a6cyeqbpffeaf0fe.uksouth-01.azurewebsites.net/api/elevenlabs-tools');
    const toolsData = await response.json();
    
    if (!toolsData.success) {
      throw new Error(`Failed to get tools: ${toolsData.error}`);
    }
    
    console.log(`📦 Retrieved ${Object.keys(toolsData.clientTools).length} tools from MCP server`);
    
    // Start ElevenLabs conversation with clientTools
    const conversation = await Conversation.startSession({
      agentId: "your-agent-id-here", // Replace with your actual agent ID
      connectionType: "websocket", // or "webrtc"
      
      // Use the clientTools from our MCP server
      ...toolsData.clientTools,
      
      // Optional callbacks
      onConnect: ({ conversationId }) => {
        console.log(`🔗 Connected to ElevenLabs conversation: ${conversationId}`);
      },
      
      onMessage: ({ message, source }) => {
        console.log(`💬 ${source}: ${message}`);
      },
      
      onError: (message, context) => {
        console.error(`❌ ElevenLabs error: ${message}`, context);
      },
      
      onUnhandledClientToolCall: (toolCall) => {
        console.log(`🛠️ Unhandled tool call: ${toolCall.name}`, toolCall.parameters);
      }
    });
    
    console.log('✅ ElevenLabs conversation started with Playwright tools!');
    
    // The conversation is now active and can use all the Playwright tools
    // like browser_navigate, browser_click, browser_type, etc.
    
    return conversation;
    
  } catch (error) {
    console.error('❌ Failed to start ElevenLabs conversation:', error);
    throw error;
  }
}

// Example of how to use the tools programmatically
async function demonstrateToolUsage() {
  try {
    const conversation = await startElevenLabsConversation();
    
    // Example: Navigate to a website
    console.log('🌐 Navigating to example.com...');
    await conversation.sendUserMessage('Navigate to https://example.com');
    
    // Example: Take a screenshot
    console.log('📸 Taking a screenshot...');
    await conversation.sendUserMessage('Take a screenshot of the current page');
    
    // Example: Click on an element
    console.log('🖱️ Clicking on an element...');
    await conversation.sendUserMessage('Click on the "More information" link');
    
    // Example: Type text
    console.log('⌨️ Typing text...');
    await conversation.sendUserMessage('Type "Hello World" in the search box');
    
    // End the conversation
    await conversation.endSession();
    console.log('👋 Conversation ended');
    
  } catch (error) {
    console.error('❌ Error in tool demonstration:', error);
  }
}

// Example of direct tool execution (if you have the clientTools object)
async function executeToolDirectly() {
  try {
    // Get the clientTools configuration
    const response = await fetch('https://mcpphas2-a6cyeqbpffeaf0fe.uksouth-01.azurewebsites.net/api/elevenlabs-tools');
    const toolsData = await response.json();
    
    if (!toolsData.success) {
      throw new Error(`Failed to get tools: ${toolsData.error}`);
    }
    
    // Execute a tool directly
    const navigateTool = toolsData.clientTools.browser_navigate;
    if (navigateTool) {
      console.log('🌐 Navigating to example.com...');
      const result = await navigateTool({ url: 'https://example.com' });
      console.log('✅ Navigation result:', result);
    }
    
    // Execute another tool
    const screenshotTool = toolsData.clientTools.browser_take_screenshot;
    if (screenshotTool) {
      console.log('📸 Taking screenshot...');
      const result = await screenshotTool({});
      console.log('✅ Screenshot result:', result);
    }
    
  } catch (error) {
    console.error('❌ Error executing tools directly:', error);
  }
}

// Export functions for use in other modules
export {
  startElevenLabsConversation,
  demonstrateToolUsage,
  executeToolDirectly
};

// Run example if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('🚀 Starting ElevenLabs ClientTools Example...');
  demonstrateToolUsage();
} 