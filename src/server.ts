import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import type { Request, Response } from "express";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { getLogger, type Logger } from "./logger";
import { SSEServerTransport } from "./sse";

interface ServerConfig {
  mcpServers: Record<
    string,
    | {
        command: string;
        args: string[];
      }
    | {
        url: string;
      }
  >;
}

interface ToolInfo {
  serverId: string;
  tool: Tool;
}

class MCPServerProxy {
  private server: Server;
  private config: ServerConfig;
  private clients: Map<string, Client> = new Map();
  private toolMap: Map<string, ToolInfo> = new Map();
  private currentProfile = "default";
  private app?: express.Application;
  private transports: { [sessionId: string]: SSEServerTransport } = {};
  private logger: Logger;

  constructor() {
    this.config = { mcpServers: {} };
    this.server = new Server(
      {
        name: "mcp-server-proxy",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.logger = getLogger({
      logLevel: "info",
      outputTransport: "stdio",
    });

    // Set up request handlers
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      this.handleListTools.bind(this)
    );
    this.server.setRequestHandler(
      CallToolRequestSchema,
      this.handleCallTool.bind(this)
    );
  }

  private async readConfig(profile: string): Promise<void> {
    const configPath = path.join(process.cwd(), `config.${profile}.json`);
    try {
      const configData = await fs.readFile(configPath, "utf-8");
      this.config = JSON.parse(configData);
    } catch (error) {
      this.logger.error(
        `Error reading config file for profile ${profile}:`,
        error
      );
      throw new Error(`Failed to load profile ${profile}`);
    }
  }

  private async connectToServer(
    serverId: string,
    config: { command: string; args: string[] } | { url: string }
  ): Promise<void> {
    if (this.clients.has(serverId)) {
      return;
    }

    const client = new Client({ name: `proxy-${serverId}`, version: "1.0.0" });

    let transport: Transport;

    if (!("command" in config) && !("url" in config)) {
      throw new Error("Command or url not found in config");
    }

    if ("command" in config) {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
      });
    } else {
      transport = new SSEClientTransport(new URL(config.url));
    }

    await client.connect(transport);
    this.clients.set(serverId, client);

    const toolsResult = await client.listTools();
    this.logger.info(
      `Connected to ${serverId} with tools:`,
      toolsResult.tools.map((t) => t.name)
    );

    // Map tools to their servers with prefixed names
    for (const tool of toolsResult.tools) {
      const prefixedName = `${serverId}_${tool.name}`;
      this.toolMap.set(prefixedName, { serverId, tool });
    }
  }

  private async handleListTools() {
    const tools = Array.from(this.toolMap.values()).map(
      ({ tool, serverId }) => ({
        ...tool,
        name: `${serverId}_${tool.name}`,
        description: `[${this.currentProfile}/${serverId}] ${
          tool.description || ""
        }`,
      })
    );
    return { tools };
  }

  private async handleCallTool(request: {
    params: {
      name: string;
      arguments?: Record<string, unknown>;
      _meta?: { progressToken?: string | number };
    };
    method: "tools/call";
  }) {
    const { name, arguments: args = {}, _meta } = request.params;
    const toolInfo = this.toolMap.get(name);

    if (!toolInfo) {
      return {
        content: [
          {
            type: "text",
            text: `Tool ${name} not found in profile ${this.currentProfile}`,
          },
        ],
        isError: true,
        _meta,
      };
    }

    const { serverId } = toolInfo;
    const client = this.clients.get(serverId);

    if (!client) {
      return {
        content: [
          {
            type: "text",
            text: `Server ${serverId} not connected in profile ${this.currentProfile}`,
          },
        ],
        isError: true,
        _meta,
      };
    }

    try {
      const mappedTool = this.toolMap.get(name);
      if (!mappedTool) {
        throw new Error(`Original tool name not found for ${name}`);
      }

      const result = await client.callTool({
        name: mappedTool.tool.name,
        arguments: args,
      });
      return result;
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error calling tool ${name}: ${error}` },
        ],
        isError: true,
        _meta,
      };
    }
  }

  public async switchProfile(profileName: string): Promise<void> {
    // Clean up existing connections
    await this.cleanup();
    this.clients.clear();
    this.toolMap.clear();

    // Load new profile config
    await this.readConfig(profileName);
    this.currentProfile = profileName;

    // Connect to servers in new profile
    for (const [serverId, config] of Object.entries(this.config.mcpServers)) {
      try {
        await this.connectToServer(serverId, config);
      } catch (error) {
        this.logger.error(
          `Failed to connect to server ${serverId} in profile ${profileName}:`,
          error
        );
      }
    }
  }

  public async start(
    initialProfile = "default",
    mode: "stdio" | "sse" = "stdio",
    port = 3000,
    host = "localhost"
  ): Promise<void> {
    this.logger = getLogger({
      logLevel: "info",
      outputTransport: mode,
    });

    // Load initial profile
    await this.readConfig(initialProfile);
    this.currentProfile = initialProfile;

    // Connect to all configured servers in the initial profile
    for (const [serverId, config] of Object.entries(this.config.mcpServers)) {
      try {
        await this.connectToServer(serverId, config);
      } catch (error) {
        this.logger.error(`Failed to connect to server ${serverId}:`, error);
      }
    }

    // Set up the server transport based on mode
    if (mode === "stdio") {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      this.logger.info(
        `MCP Server Proxy running on stdio with profile ${this.currentProfile}`
      );
    } else {
      this.app = express();
      this.app.use(express.json());

      // SSE endpoint
      this.app.get("/sse", async (req: Request, res: Response) => {
        const transport = new SSEServerTransport("/messages", res);
        this.transports[transport.sessionId] = transport;

        transport.onmessage = (msg: JSONRPCMessage) => {
          this.logger.info(
            `SSE → Child (session ${transport.sessionId}): ${JSON.stringify(
              msg
            )}`
          );
        };

        transport.onclose = () => {
          this.logger.info(
            `SSE connection closed (session ${transport.sessionId})`
          );
          delete this.transports[transport.sessionId];
        };

        transport.onerror = (err) => {
          this.logger.error(`SSE error (session ${transport.sessionId}):`, err);
          delete this.transports[transport.sessionId];
        };

        req.on("close", () => {
          this.logger.info(
            `Client disconnected (session ${transport.sessionId})`
          );
          delete this.transports[transport.sessionId];
        });

        // Handle client disconnect
        req.on("close", () => {
          delete this.transports[transport.sessionId];
          transport.close().catch((error) => {
            this.logger.error("Error closing transport:", error);
          });
        });

        try {
          await this.server.connect(transport);
        } catch (error) {
          this.logger.error("Error connecting SSE transport:", error);
          res.end();
        }
      });

      // Message endpoint
      this.app.post("/messages", async (req: Request, res: Response) => {
        const sessionId = req.query.sessionId as string;
        const transport = this.transports[sessionId];

        if (!transport) {
          this.logger.info("No transport found for sessionId", sessionId);
          res.status(400).json({ error: "No transport found for sessionId" });
          return;
        }

        try {
          await transport.handlePostMessage(req, res);
        } catch (error) {
          this.logger.error("Error handling message:", error);
          res.status(500).json({ error: "Internal server error" });
        }
      });

      this.app.listen(port, host, () => {
        this.logger.info(
          `MCP Server Proxy running on SSE at http://${host}:${port} with profile ${this.currentProfile}`
        );
      });
    }
  }

  public async cleanup(): Promise<void> {
    // Clean up SSE transports
    for (const transport of Object.values(this.transports)) {
      try {
        await transport.close();
      } catch (error) {
        this.logger.error("Error closing transport:", error);
      }
    }
    this.transports = {};

    // Clean up clients
    for (const client of this.clients.values()) {
      try {
        // Close the transport connection
        await client.transport?.close();
      } catch (error) {
        this.logger.error("Error disconnecting client:", error);
      }
    }
  }
}

// Start the server
async function runServer() {
  const program = new Command();

  program
    .name("mcp-server-proxy")
    .description("MCP Server Proxy that can connect to multiple MCP servers")
    .version("0.1.0")
    .option(
      "-p, --profile <name>",
      "Profile to use (default: default)",
      "default"
    )
    .option("-m, --mode <mode>", "Server mode (stdio or sse)", "stdio")
    .option("--port <number>", "Port for SSE mode", "3000")
    .option("--host <host>", "Host for SSE mode", "localhost")
    .parse(process.argv);

  const options = program.opts();

  const server = new MCPServerProxy();
  try {
    if (options.mode !== "stdio" && options.mode !== "sse") {
      throw new Error("Invalid mode. Use 'stdio' or 'sse'");
    }

    await server.start(
      options.profile,
      options.mode,
      Number.parseInt(options.port, 10),
      options.host
    );
  } catch (error) {
    console.error("Fatal error running server:", error);
    await server.cleanup();
    process.exit(1);
  }
}

runServer();
