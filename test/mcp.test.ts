import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
it("MCP stdio bridge initializes and exposes two tools with schemas", async () => {
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "scripts/mcp.ts"],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "korp_certificate_verify",
      "korp_tx_certify",
    ]);
    for (const tool of result.tools)
      expect(tool.inputSchema.type).toBe("object");
  } finally {
    await client.close();
  }
});
