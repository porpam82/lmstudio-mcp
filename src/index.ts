#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";

// LM Studio API configuration
const LM_STUDIO_BASE_URL = process.env.LM_STUDIO_BASE_URL || "http://localhost:1234";
const TRANSPORT = (process.env.TRANSPORT || "stdio").toLowerCase();
const HTTP_PORT = parseInt(process.env.PORT || "3000", 10);
const HTTP_HOST = process.env.HOST || "0.0.0.0";

interface LMStudioModel {
  id: string;
  type: "llm" | "vlm" | "embeddings";
  publisher?: string;
  architecture?: string;
  compatibility?: string;
  quantization?: string;
  state?: "loaded" | "not-loaded";
  max_context_length?: number;
}

interface ModelsResponse {
  data: LMStudioModel[];
}

async function lmStudioRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${LM_STUDIO_BASE_URL}${endpoint}`;
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`LM Studio API request failed: ${error.message}`);
    }
    throw error;
  }
}

async function listModels(): Promise<LMStudioModel[]> {
  const response = await lmStudioRequest<ModelsResponse>("/api/v0/models");
  return response.data;
}

async function getModelDetails(modelId: string): Promise<LMStudioModel> {
  return await lmStudioRequest<LMStudioModel>(`/api/v0/models/${modelId}`);
}

async function loadModel(modelId: string, ttl: number = 3600): Promise<string> {
  await lmStudioRequest("/api/v0/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "system", content: "ping" }],
      max_tokens: 1,
      ttl,
    }),
  });
  return `Model '${modelId}' loaded successfully with TTL of ${ttl} seconds`;
}

async function unloadModel(modelId: string): Promise<string> {
  await lmStudioRequest("/api/v0/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "system", content: "unload" }],
      max_tokens: 1,
      ttl: 0,
    }),
  });
  return `Model '${modelId}' unloaded successfully`;
}

async function configureModel(
  modelId: string,
  ttl?: number,
  draftModel?: string
): Promise<string> {
  const config: Record<string, any> = {
    model: modelId,
    messages: [{ role: "system", content: "configure" }],
    max_tokens: 1,
  };
  if (ttl !== undefined) config.ttl = ttl;
  if (draftModel) config.draft_model = draftModel;
  await lmStudioRequest("/api/v0/chat/completions", {
    method: "POST",
    body: JSON.stringify(config),
  });
  const updates: string[] = [];
  if (ttl !== undefined) updates.push(`TTL: ${ttl}s`);
  if (draftModel) updates.push(`Draft model: ${draftModel}`);
  return `Model '${modelId}' configured: ${updates.join(", ")}`;
}

const TOOLS: Tool[] = [
  {
    name: "list_models",
    description:
      "List all available models in LM Studio with their current state (loaded/not-loaded)",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_model_details",
    description:
      "Get detailed information about a specific model including architecture, quantization, and context length",
    inputSchema: {
      type: "object",
      properties: {
        model_id: { type: "string", description: "The ID of the model to get details for" },
      },
      required: ["model_id"],
    },
  },
  {
    name: "load_model",
    description:
      "Load a model into memory with configurable Time-To-Live (TTL). The model will auto-unload after the TTL expires.",
    inputSchema: {
      type: "object",
      properties: {
        model_id: { type: "string", description: "The ID of the model to load" },
        ttl: {
          type: "number",
          description: "Time-To-Live in seconds before auto-unload (default: 3600)",
          default: 3600,
        },
      },
      required: ["model_id"],
    },
  },
  {
    name: "unload_model",
    description: "Unload a model from memory immediately by setting its TTL to 0",
    inputSchema: {
      type: "object",
      properties: {
        model_id: { type: "string", description: "The ID of the model to unload" },
      },
      required: ["model_id"],
    },
  },
  {
    name: "configure_model",
    description: "Configure model settings such as TTL and draft model for speculative decoding",
    inputSchema: {
      type: "object",
      properties: {
        model_id: { type: "string", description: "The ID of the model to configure" },
        ttl: { type: "number", description: "Time-To-Live in seconds (optional)" },
        draft_model: {
          type: "string",
          description: "Draft model ID for speculative decoding (optional)",
        },
      },
      required: ["model_id"],
    },
  },
];

function createServer(): Server {
  const server = new Server(
    { name: "lmstudio-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "list_models": {
          const models = await listModels();
          return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] };
        }
        case "get_model_details": {
          const modelId = args?.model_id as string;
          if (!modelId) throw new Error("model_id is required");
          const details = await getModelDetails(modelId);
          return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
        }
        case "load_model": {
          const modelId = args?.model_id as string;
          const ttl = (args?.ttl as number) || 3600;
          if (!modelId) throw new Error("model_id is required");
          return { content: [{ type: "text", text: await loadModel(modelId, ttl) }] };
        }
        case "unload_model": {
          const modelId = args?.model_id as string;
          if (!modelId) throw new Error("model_id is required");
          return { content: [{ type: "text", text: await unloadModel(modelId) }] };
        }
        case "configure_model": {
          const modelId = args?.model_id as string;
          const ttl = args?.ttl as number | undefined;
          const draftModel = args?.draft_model as string | undefined;
          if (!modelId) throw new Error("model_id is required");
          return {
            content: [{ type: "text", text: await configureModel(modelId, ttl, draftModel) }],
          };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  });

  return server;
}

async function startStdio() {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
  console.error("LM Studio MCP Server running on stdio");
  console.error(`Connecting to LM Studio at: ${LM_STUDIO_BASE_URL}`);
}

async function startHttp() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, lm_studio: LM_STUDIO_BASE_URL });
  });

  // Stateless: each request gets a fresh server + transport.
  app.post("/mcp", async (req, res) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // SSE GET / DELETE not supported in stateless mode
  app.get("/mcp", (_req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "GET not supported in stateless mode" },
      id: null,
    })
  );
  app.delete("/mcp", (_req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "DELETE not supported in stateless mode" },
      id: null,
    })
  );

  app.listen(HTTP_PORT, HTTP_HOST, () => {
    console.error(
      `LM Studio MCP Server (HTTP) listening on http://${HTTP_HOST}:${HTTP_PORT}/mcp`
    );
    console.error(`Connecting to LM Studio at: ${LM_STUDIO_BASE_URL}`);
  });
}

async function main() {
  if (TRANSPORT === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
