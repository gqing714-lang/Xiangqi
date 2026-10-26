import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createXiangqiServer, gameStore } from "./src/mcp-server.js";
import { createFixedWindowRateLimiter } from "./src/rate-limit.js";

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";
const WEB_INDEX = new URL("./web/index.html", import.meta.url);
const GAME_ROUTE = /^\/api\/games\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(\/moves|\/undo)?$/i;
function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

async function parseSmallJson(req) {
  if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") {
    const error = new Error("Expected application/json");
    error.httpStatus = 415;
    throw error;
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body, "utf8") > 2048) {
      const error = new Error("Request body is too large");
      error.httpStatus = 413;
      throw error;
    }
  }
  try { return JSON.parse(body); }
  catch {
    const error = new Error("Invalid JSON request");
    error.httpStatus = 400;
    throw error;
  }
}

function apiFailure(res, requestId, error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = Number(error?.httpStatus) || (
    message.includes("not found or expired") ? 404 :
    message.includes("Illegal") || message.includes("turn") || message.includes("finished") || message.includes("Undo") ? 409 : 500
  );
  log(status >= 500 ? "error" : "info", "web_api_failure", { requestId, status, message });
  sendJson(res, status, { error: status >= 500 ? "服务器暂时遇到问题，请稍后重试" : message });
}

const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
const rateLimit = createFixedWindowRateLimiter({
  limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120),
  windowMs: 60_000,
});

function log(level, event, fields = {}) {
  const entry = { time: new Date().toISOString(), level, event, ...fields };
  const output = JSON.stringify(entry);
  if (level === "error") console.error(output);
  else console.log(output);
}

function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, RateLimit-Remaining");
}

const httpServer = createServer(async (req, res) => {
  const requestId = req.headers["x-request-id"]?.toString() ?? randomUUID();
  const startedAt = Date.now();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    log("info", "http_request", {
      requestId,
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    setCors(res);
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, x-request-id",
    });
    res.end();
    return;
  }

  // Standalone mobile web room: uses the same authoritative game store as MCP.
  if (req.method === "GET" && (url.pathname === "/play" || url.pathname === "/play/")) {
    try {
      const html = await readFile(WEB_INDEX, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(html);
    } catch (error) {
      log("error", "web_page_failed", { requestId, message: String(error) });
      sendJson(res, 500, { error: "网页载入失败" });
    }
    return;
  }

  if (url.pathname === "/api/games" || url.pathname.startsWith("/api/games/")) {
    const decision = rateLimit(clientAddress(req));
    res.setHeader("RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(decision.retryAfterSeconds));
      sendJson(res, 429, { error: "请求太频繁，请稍后再试" });
      return;
    }
  }

  if (url.pathname === "/api/games" && req.method === "POST") {
    try {
      await parseSmallJson(req);
      const game = await gameStore.start("red");
      sendJson(res, 201, gameStore.view(game, true));
    } catch (error) { apiFailure(res, requestId, error); }
    return;
  }

  const gameMatch = url.pathname.match(GAME_ROUTE);
  if (gameMatch) {
    const gameId = gameMatch[1];
    const isMove = gameMatch[2] === "/moves";
    const isUndo = gameMatch[2] === "/undo";
    if (req.method === "GET" && !isMove && !isUndo) {
      try {
        const game = await gameStore.get(gameId);
        sendJson(res, 200, gameStore.view(game, true));
      } catch (error) { apiFailure(res, requestId, error); }
      return;
    }
    if (req.method === "POST" && isMove) {
      try {
        const payload = await parseSmallJson(req);
        if (!payload || !/^[a-i][0-9]$/.test(payload.from) || !/^[a-i][0-9]$/.test(payload.to)) {
          const error = new Error("请提供正确的落子坐标");
          error.httpStatus = 400;
          throw error;
        }
        const result = await gameStore.move(gameId, "user", payload.from, payload.to);
        sendJson(res, 200, gameStore.view(result.game, true));
      } catch (error) { apiFailure(res, requestId, error); }
      return;
    }
    if (req.method === "POST" && isUndo) {
      try {
        const payload = await parseSmallJson(req);
        if (!Number.isInteger(payload?.expectedPly) || payload.expectedPly < 1) {
          const error = new Error("请提供当前步数以安全悔棋");
          error.httpStatus = 400;
          throw error;
        }
        const game = await gameStore.undo(gameId, payload.expectedPly);
        sendJson(res, 200, gameStore.view(game, true));
      } catch (error) { apiFailure(res, requestId, error); }
      return;
    }
    sendJson(res, 405, { error: "不支持这个操作" });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ service: "xiangqi-mcp", status: "ok", version: "0.3.0", mcp: MCP_PATH }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/ready") {
    try {
      const health = await gameStore.health();
      res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ service: "xiangqi-mcp", status: health.ok ? "ready" : "unavailable", ...health }));
    } catch (error) {
      log("error", "readiness_failed", { requestId, message: error instanceof Error ? error.message : String(error) });
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ service: "xiangqi-mcp", status: "unavailable" }));
    }
    return;
  }

  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    setCors(res);
    const decision = rateLimit(clientAddress(req));
    res.setHeader("RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(decision.retryAfterSeconds));
      res.writeHead(429, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "rate_limit_exceeded", retryAfterSeconds: decision.retryAfterSeconds }));
      return;
    }

    const server = createXiangqiServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      log("error", "mcp_request_failed", { requestId, message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

async function shutdown(signal) {
  log("info", "shutdown_started", { signal });
  httpServer.close(async () => {
    try {
      await gameStore.close();
    } finally {
      log("info", "shutdown_complete", { signal });
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

httpServer.listen(port, "0.0.0.0", () => {
  log("info", "server_started", { port, mcpPath: MCP_PATH, store: gameStore.backend });
});
