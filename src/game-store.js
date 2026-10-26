import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import {
  COLORS,
  applyLegalMove,
  boardText,
  createInitialBoard,
  legalMoves,
  opposite,
  parseSquare,
  positionStatus,
  toFen,
} from "./engine.js";

const MAX_GAMES = 5000;
const GAME_TTL_MS = 24 * 60 * 60 * 1000;
const GAME_TTL_SECONDS = Math.floor(GAME_TTL_MS / 1000);
const REDIS_KEY_PREFIX = "xiangqi:game:";
const MAX_TRANSACTION_RETRIES = 8;

function nowIso() {
  return new Date().toISOString();
}

function createGame(userColor) {
  if (![COLORS.RED, COLORS.BLACK].includes(userColor)) {
    throw new Error(`Invalid user color: ${userColor}`);
  }
  const createdAt = nowIso();
  return {
    id: randomUUID(),
    board: createInitialBoard(),
    userColor,
    modelColor: opposite(userColor),
    sideToMove: COLORS.RED,
    status: "active",
    winner: null,
    inCheck: false,
    ply: 0,
    history: [],
    createdAt,
    updatedAt: createdAt,
    updatedAtMs: Date.now(),
  };
}

function actorColor(game, actor) {
  if (actor === "user") return game.userColor;
  if (actor === "model") return game.modelColor;
  throw new Error(`Invalid actor: ${actor}`);
}

function applyMoveToGame(game, actor, from, to) {
  if (game.status !== "active") throw new Error(`Game is already finished: ${game.status}`);

  const color = actorColor(game, actor);
  if (color !== game.sideToMove) {
    throw new Error(`It is ${game.sideToMove}'s turn, not ${color}'s turn`);
  }

  const { board, move } = applyLegalMove(game.board, color, from, to);
  game.board = board;
  game.ply += 1;
  game.sideToMove = opposite(color);
  game.history.push({ ply: game.ply, color, actor, ...move });

  const status = positionStatus(game.board, game.sideToMove);
  game.status = status.status;
  game.winner = status.winner;
  game.inCheck = status.inCheck;
  game.updatedAt = nowIso();
  game.updatedAtMs = Date.now();
  return { game, move: game.history.at(-1) };
}

function undoUserMove(game, expectedPly) {
  if (expectedPly !== undefined && game.ply !== expectedPly) {
    throw new Error("Undo rejected: board changed; refresh before trying again");
  }
  const last = game.history.at(-1);
  if (!last || last.actor !== "user" || game.sideToMove !== game.modelColor) {
    throw new Error("Undo unavailable: only the latest unanswered user move can be undone");
  }
  const from = parseSquare(last.from);
  const to = parseSquare(last.to);
  if (game.board[from.y][from.x] !== null || game.board[to.y][to.x] !== last.piece) {
    throw new Error("Undo rejected: inconsistent board history");
  }
  game.board[from.y][from.x] = last.piece;
  game.board[to.y][to.x] = last.capture;
  game.history.pop();
  game.ply -= 1;
  game.sideToMove = game.userColor;
  const status = positionStatus(game.board, game.sideToMove);
  game.status = status.status;
  game.winner = status.winner;
  game.inCheck = status.inCheck;
  game.updatedAt = nowIso();
  game.updatedAtMs = Date.now();
  return game;
}

function resignGame(game, actor) {
  if (game.status !== "active") throw new Error(`Game is already finished: ${game.status}`);
  const color = actorColor(game, actor);
  game.status = "resigned";
  game.winner = opposite(color);
  game.inCheck = false;
  game.updatedAt = nowIso();
  game.updatedAtMs = Date.now();
  return game;
}

function viewGame(game, includeLegalMoves = false) {
  return {
    gameId: game.id,
    status: game.status,
    winner: game.winner,
    sideToMove: game.sideToMove,
    userColor: game.userColor,
    modelColor: game.modelColor,
    inCheck: game.inCheck,
    ply: game.ply,
    fen: toFen(game.board, game.sideToMove),
    board: boardText(game.board),
    lastMove: game.history.at(-1) ?? null,
    legalMoves: includeLegalMoves && game.status === "active" ? legalMoves(game.board, game.sideToMove) : [],
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
  };
}

export class GameStore {
  constructor() {
    this.games = new Map();
    this.backend = "memory";
  }

  prune(now = Date.now()) {
    for (const [id, game] of this.games) {
      if (now - game.updatedAtMs > GAME_TTL_MS) this.games.delete(id);
    }
    while (this.games.size >= MAX_GAMES) {
      const oldest = this.games.keys().next().value;
      if (!oldest) break;
      this.games.delete(oldest);
    }
  }

  start(userColor = COLORS.RED) {
    this.prune();
    const game = createGame(userColor);
    this.games.set(game.id, game);
    return game;
  }

  get(gameId) {
    const game = this.games.get(gameId);
    if (!game) throw new Error(`Game not found or expired: ${gameId}`);
    return game;
  }

  move(gameId, actor, from, to) {
    return applyMoveToGame(this.get(gameId), actor, from, to);
  }

  resign(gameId, actor) {
    return resignGame(this.get(gameId), actor);
  }

  undo(gameId, expectedPly) {
    return undoUserMove(this.get(gameId), expectedPly);
  }

  legal(gameId) {
    const game = this.get(gameId);
    if (game.status !== "active") return [];
    return legalMoves(game.board, game.sideToMove);
  }

  view(game, includeLegalMoves = false) {
    return viewGame(game, includeLegalMoves);
  }

  async health() {
    return { ok: true, backend: this.backend };
  }

  async close() {}
}

export class RedisGameStore extends GameStore {
  constructor(redis, { keyPrefix = REDIS_KEY_PREFIX, ttlSeconds = GAME_TTL_SECONDS } = {}) {
    super();
    this.redis = redis;
    this.keyPrefix = keyPrefix;
    this.ttlSeconds = ttlSeconds;
    this.backend = "redis";
    this.games = null;
  }

  key(gameId) {
    return `${this.keyPrefix}${gameId}`;
  }

  async start(userColor = COLORS.RED) {
    const game = createGame(userColor);
    const stored = await this.redis.set(this.key(game.id), JSON.stringify(game), "EX", this.ttlSeconds, "NX");
    if (stored !== "OK") throw new Error("Could not allocate game state");
    return game;
  }

  async get(gameId) {
    const raw = await this.redis.get(this.key(gameId));
    if (!raw) throw new Error(`Game not found or expired: ${gameId}`);
    return JSON.parse(raw);
  }

  async mutate(gameId, mutator) {
    const key = this.key(gameId);
    for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
      const transactionRedis = this.redis.duplicate();
      try {
        await transactionRedis.watch(key);
        const raw = await transactionRedis.get(key);
        if (!raw) throw new Error(`Game not found or expired: ${gameId}`);
        const game = JSON.parse(raw);
        const result = mutator(game);
        const committed = await transactionRedis.multi()
          .set(key, JSON.stringify(game), "EX", this.ttlSeconds)
          .exec();
        if (committed !== null) return result;
      } finally {
        transactionRedis.disconnect();
      }
    }
    throw new Error("Game was updated concurrently; retry the move");
  }

  async move(gameId, actor, from, to) {
    return this.mutate(gameId, (game) => applyMoveToGame(game, actor, from, to));
  }

  async resign(gameId, actor) {
    return this.mutate(gameId, (game) => resignGame(game, actor));
  }

  async undo(gameId, expectedPly) {
    return this.mutate(gameId, (game) => undoUserMove(game, expectedPly));
  }

  async legal(gameId) {
    const game = await this.get(gameId);
    if (game.status !== "active") return [];
    return legalMoves(game.board, game.sideToMove);
  }

  async health() {
    const pong = await this.redis.ping();
    return { ok: pong === "PONG", backend: this.backend };
  }

  async close() {
    if (["end", "close"].includes(this.redis.status)) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

export function createGameStore({ redisUrl = process.env.REDIS_URL } = {}) {
  if (!redisUrl) return new GameStore();
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
  });
  return new RedisGameStore(redis);
}
