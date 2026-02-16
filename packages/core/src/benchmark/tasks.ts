import type { BenchmarkTask, BenchmarkToolDef } from "./types.js";

// ---------------------------------------------------------------------------
// Reusable tool definitions for tool-use tasks
// ---------------------------------------------------------------------------

const TOOL_FILE_READ: BenchmarkToolDef = {
  name: "file_read",
  description: "Read the contents of a file at the given path.",
  parameters: {
    path: { type: "string", description: "Absolute file path to read.", required: true },
  },
};

const TOOL_FILE_WRITE: BenchmarkToolDef = {
  name: "file_write",
  description: "Write content to a file, creating or overwriting it.",
  parameters: {
    path: { type: "string", description: "Absolute file path to write.", required: true },
    content: { type: "string", description: "Content to write.", required: true },
  },
};

const TOOL_SHELL_EXEC: BenchmarkToolDef = {
  name: "shell_exec",
  description: "Execute a shell command and return stdout/stderr.",
  parameters: {
    command: { type: "string", description: "Shell command to run.", required: true },
    cwd: { type: "string", description: "Working directory.", required: false },
  },
};

const TOOL_WEB_SEARCH: BenchmarkToolDef = {
  name: "web_search",
  description: "Search the web and return top results.",
  parameters: {
    query: { type: "string", description: "Search query.", required: true },
    maxResults: { type: "number", description: "Max results to return.", required: false },
  },
};

const TOOL_LIST_DIR: BenchmarkToolDef = {
  name: "list_directory",
  description: "List files and directories at the given path.",
  parameters: {
    path: { type: "string", description: "Directory path to list.", required: true },
    recursive: { type: "boolean", description: "Whether to list recursively.", required: false },
  },
};

// ---------------------------------------------------------------------------
// Code snippets embedded in tasks (kept short but realistic)
// ---------------------------------------------------------------------------

const SNIPPET_VALIDATION = `\
function processUser(name, age, email) {
  const user = { name, age, email };
  db.save(user);
  return user;
}`;

const SNIPPET_RACE_CONDITION = `\
let counter = 0;
const results = [];

async function incrementAndStore() {
  const current = counter;
  await delay(Math.random() * 10);
  counter = current + 1;
  results.push(counter);
}

async function runAll() {
  const tasks = Array.from({ length: 5 }, () => incrementAndStore());
  await Promise.all(tasks);
  console.log("final counter:", counter, "results:", results);
}`;

const SNIPPET_REFACTOR_LONG = `\
function handleRequest(req, res) {
  // Authenticate
  const token = req.headers.authorization;
  if (!token) { res.status(401).send("No token"); return; }
  const decoded = jwt.verify(token, SECRET);
  if (!decoded) { res.status(401).send("Invalid token"); return; }

  // Validate input
  const { action, payload } = req.body;
  if (!action || typeof action !== "string") {
    res.status(400).send("Missing action"); return;
  }
  if (!payload || typeof payload !== "object") {
    res.status(400).send("Missing payload"); return;
  }

  // Rate limit
  const key = decoded.userId + ":" + action;
  const count = rateLimiter.get(key) || 0;
  if (count > 100) { res.status(429).send("Rate limited"); return; }
  rateLimiter.set(key, count + 1);

  // Route action
  let result;
  if (action === "create") {
    if (!payload.name) { res.status(400).send("Name required"); return; }
    result = db.create({ ...payload, userId: decoded.userId });
  } else if (action === "update") {
    if (!payload.id) { res.status(400).send("ID required"); return; }
    const existing = db.findById(payload.id);
    if (!existing) { res.status(404).send("Not found"); return; }
    if (existing.userId !== decoded.userId) {
      res.status(403).send("Forbidden"); return;
    }
    result = db.update(payload.id, payload);
  } else if (action === "delete") {
    if (!payload.id) { res.status(400).send("ID required"); return; }
    const existing = db.findById(payload.id);
    if (!existing) { res.status(404).send("Not found"); return; }
    if (existing.userId !== decoded.userId) {
      res.status(403).send("Forbidden"); return;
    }
    db.delete(payload.id);
    result = { deleted: true };
  } else if (action === "list") {
    result = db.findByUserId(decoded.userId);
  } else {
    res.status(400).send("Unknown action"); return;
  }

  // Audit log
  auditLog.write({
    userId: decoded.userId, action, timestamp: Date.now(),
    success: true
  });

  res.json({ ok: true, data: result });
}`;

const SNIPPET_BUG_OFF_BY_ONE = `\
function paginate(items, page, pageSize) {
  const start = page * pageSize;
  const end = start + pageSize;
  return {
    data: items.slice(start, end),
    total: items.length,
    page,
    totalPages: Math.floor(items.length / pageSize),
  };
}
// Bug: paginate([1,2,3,4,5], 1, 2) should return page 1 (items 3,4)
// but totalPages is wrong for non-even divisions.`;

const SNIPPET_MEMORY_LEAK = `\
const cache = {};

function fetchData(url) {
  if (cache[url]) return cache[url];
  const data = httpGet(url);
  cache[url] = data;
  return data;
}

// Called thousands of times per minute with unique URLs
setInterval(() => {
  const url = \`/api/metrics?t=\${Date.now()}\`;
  fetchData(url);
}, 50);`;

const SNIPPET_SORT_BUG = `\
function sortByDate(items) {
  return items.sort((a, b) => a.date - b.date);
}
// items look like: [{ name: "Alice", date: "2024-01-15" }, ...]`;

const DIFF_FOR_COMMIT_MSG = `\
diff --git a/src/auth.ts b/src/auth.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -12,6 +12,8 @@ export async function validateToken(token: string) {
   const decoded = jwt.verify(token, process.env.JWT_SECRET);
+  if (decoded.exp && decoded.exp < Date.now() / 1000) {
+    throw new TokenExpiredError("Token has expired");
+  }
   return decoded;
 }
@@ -25,3 +27,8 @@ export function generateToken(userId: string) {
+
+export function refreshToken(oldToken: string): string {
+  const decoded = validateToken(oldToken);
+  return generateToken(decoded.userId);
+}`;

const ENDPOINT_SPECS = `\
POST /api/users       - Create user. Body: { name, email, role }. Returns 201 + user object.
GET  /api/users/:id   - Get user by ID. Returns 200 + user or 404.
PUT  /api/users/:id   - Update user. Body: partial user fields. Returns 200 + updated user.
DELETE /api/users/:id - Delete user. Returns 204. Auth required (admin only).
GET  /api/users       - List users. Query: ?page=1&limit=20&role=admin. Returns 200 + paginated list.`;

const V1_V2_CHANGELOG = `\
## Breaking Changes (v1 → v2)
- Config file renamed: .myapprc → myapp.config.ts (TypeScript-first)
- CLI commands restructured: \`myapp run\` → \`myapp dev\`, \`myapp build --prod\` → \`myapp build\`
- Plugin API: \`plugin.init()\` replaced by \`plugin.setup(ctx)\` with lifecycle hooks
- Node.js 16 dropped; minimum is now Node.js 20
- Default port changed from 3000 to 5173
- Environment variables: \`MYAPP_*\` prefix now required for all env vars
- Database: migrations auto-run on start (previously manual)

## New Features
- Hot module reload for plugins
- Built-in TypeScript support (no separate tsconfig needed)
- New \`myapp doctor\` command for environment diagnostics
- Native ESM throughout (CommonJS wrapper deprecated)

## Deprecated
- \`myapp.config.js\` still works but logs a warning
- \`plugin.init()\` shimmed but will be removed in v3`;

const ERROR_LOGS = `\
[2024-12-01T10:15:32Z] ERROR payment-service: Connection refused to postgres:5432
[2024-12-01T10:15:33Z] ERROR payment-service: Retry 1/3 failed - Connection refused
[2024-12-01T10:15:34Z] WARN  api-gateway: /api/payments responding with 503
[2024-12-01T10:15:35Z] INFO  user-service: Health check OK
[2024-12-01T10:15:35Z] INFO  auth-service: Health check OK
[2024-12-01T10:15:36Z] ERROR payment-service: Retry 2/3 failed - Connection refused
[2024-12-01T10:15:38Z] ERROR payment-service: All retries exhausted for postgres connection
[2024-12-01T10:15:39Z] WARN  api-gateway: Circuit breaker OPEN for payment-service`;

const ARCHITECTURE_DIAGRAM = `\
┌──────────┐     ┌─────────────┐     ┌────────────┐
│  Client   │────▶│ API Gateway │────▶│ Auth Svc   │
│ (Browser) │     │  (single)   │     │ (single)   │
└──────────┘     └──────┬──────┘     └──────┬─────┘
                        │                    │
                  ┌─────▼──────┐      ┌─────▼──────┐
                  │ Order Svc  │      │ User Svc   │
                  │ (single)   │      │ (2 replicas)│
                  └─────┬──────┘      └────────────┘
                        │
                  ┌─────▼──────┐     ┌────────────┐
                  │ Payment Svc│────▶│ PostgreSQL  │
                  │ (single)   │     │ (single)   │
                  └────────────┘     └────────────┘

All services communicate via REST. No message queue.
Auth tokens stored in Auth Svc's local SQLite database.
PostgreSQL has no replicas or automated failover.`;

// ---------------------------------------------------------------------------
// Category 1: Single-File Code Edit (6 tasks)
// ---------------------------------------------------------------------------

const singleFileEditTasks: BenchmarkTask[] = [
  {
    id: "edit-validation-01",
    category: "single-file-edit",
    difficulty: "easy",
    optimizerTaskType: "code",
    prompt: `Add input validation to this function. Name must be a non-empty string, age must be a positive integer, and email must contain "@". Throw descriptive errors for invalid inputs.\n\n\`\`\`javascript\n${SNIPPET_VALIDATION}\n\`\`\``,
    tools: [],
    expectedBehavior: {
      mustInclude: ["typeof", "throw", "@"],
      mustExclude: [],
      description:
        "Response adds type checks for name (non-empty string), age (positive integer), and email (contains @). Each invalid case throws a descriptive error before db.save is called.",
    },
    scoringCriteria: [
      { name: "correctness", description: "All three validations present and correct", weight: 4 },
      { name: "error-messages", description: "Error messages are descriptive", weight: 2 },
      { name: "ordering", description: "Validation happens before db.save", weight: 2 },
      { name: "code-quality", description: "Clean, readable code", weight: 2 },
    ],
    timeoutMs: 30_000,
  },
  {
    id: "edit-sort-bug-02",
    category: "single-file-edit",
    difficulty: "easy",
    optimizerTaskType: "code",
    prompt: `This function is supposed to sort items by date, but it doesn't work correctly. Find and fix the bug.\n\n\`\`\`javascript\n${SNIPPET_SORT_BUG}\n\`\`\``,
    tools: [],
    expectedBehavior: {
      mustInclude: ["Date", "sort"],
      description:
        "Identifies that date strings cannot be subtracted directly. Fix must parse dates (new Date() or Date.parse) before comparing, or use localeCompare/string comparison for ISO dates.",
    },
    scoringCriteria: [
      {
        name: "bug-identification",
        description: "Correctly identifies string subtraction bug",
        weight: 3,
      },
      { name: "fix-correctness", description: "Fix properly compares dates", weight: 4 },
      {
        name: "explanation",
        description: "Brief explanation of why the original failed",
        weight: 3,
      },
    ],
    timeoutMs: 30_000,
  },
  {
    id: "edit-race-condition-03",
    category: "single-file-edit",
    difficulty: "medium",
    optimizerTaskType: "code",
    prompt: `This async code has a race condition. Find and fix it so that the final counter always equals 5 and results always contains [1,2,3,4,5] (in some order).\n\n\`\`\`javascript\n${SNIPPET_RACE_CONDITION}\n\`\`\``,
    tools: [],
    expectedBehavior: {
      mustInclude: ["await", "counter"],
      description:
        "Identifies the read-then-write race on `counter`. Fix uses a mutex/lock, sequential execution, or atomic increment to prevent concurrent reads of stale values.",
    },
    scoringCriteria: [
      {
        name: "race-identified",
        description: "Correctly explains the read-then-write race",
        weight: 3,
      },
      { name: "fix-correctness", description: "Fix prevents concurrent stale reads", weight: 4 },
      { name: "results-correct", description: "Results array guaranteed to be [1..5]", weight: 2 },
      { name: "code-quality", description: "Solution is clean and idiomatic", weight: 1 },
    ],
    timeoutMs: 45_000,
  },
  {
    id: "edit-off-by-one-04",
    category: "single-file-edit",
    difficulty: "medium",
    optimizerTaskType: "code",
    prompt: `This pagination function has a bug with totalPages calculation. Fix it so totalPages is always correct, including when items don't divide evenly by pageSize.\n\n\`\`\`javascript\n${SNIPPET_BUG_OFF_BY_ONE}\n\`\`\``,
    tools: [],
    expectedBehavior: {
      mustInclude: ["ceil", "totalPages"],
      description:
        "Replaces Math.floor with Math.ceil for totalPages, ensuring 5 items with pageSize 2 yields 3 pages, not 2.",
    },
    scoringCriteria: [
      { name: "bug-identified", description: "Identifies floor vs ceil issue", weight: 3 },
      { name: "fix-correctness", description: "Uses Math.ceil for totalPages", weight: 4 },
      { name: "edge-cases", description: "Handles empty array or pageSize 0", weight: 3 },
    ],
    timeoutMs: 30_000,
  },
  {
    id: "edit-memory-leak-05",
    category: "single-file-edit",
    difficulty: "hard",
    optimizerTaskType: "code",
    prompt: `This code has a memory leak. Identify the leak, explain why it happens, and fix it without breaking the caching behavior for repeated URLs.\n\n\`\`\`javascript\n${SNIPPET_MEMORY_LEAK}\n\`\`\``,
    tools: [],
    expectedBehavior: {
      mustInclude: ["cache"],
      description:
        "Identifies unbounded cache growth from unique timestamp URLs. Fix implements a bounded cache (LRU, TTL, max size, or WeakRef-based) while preserving caching for repeated URLs.",
    },
    scoringCriteria: [
      {
        name: "leak-identified",
        description: "Identifies unbounded cache as the leak source",
        weight: 3,
      },
      {
        name: "explanation",
        description: "Explains why unique URLs cause unbounded growth",
        weight: 2,
      },
      {
        name: "fix-correctness",
        description: "Implements bounded caching (LRU/TTL/max-size)",
        weight: 3,
      },
      { name: "caching-preserved", description: "Repeated URLs still hit cache", weight: 2 },
    ],
    timeoutMs: 45_000,
  },
  {
    id: "edit-refactor-06",
    category: "single-file-edit",
    difficulty: "hard",
    optimizerTaskType: "code",
    prompt: `Refactor this monolithic request handler into smaller, well-named helper functions. Each helper should have a single responsibility. Keep the same external behavior.\n\n\`\`\`javascript\n${SNIPPET_REFACTOR_LONG}\n\`\`\``,
    tools: [],
    expectedBehavior: {
      mustInclude: ["function"],
      description:
        "Extracts at least 3-4 helpers (authenticate, validateInput, checkRateLimit, routeAction or similar). Main handler calls helpers in sequence. Behavior identical.",
    },
    scoringCriteria: [
      {
        name: "decomposition",
        description: "At least 3 well-named helper functions extracted",
        weight: 3,
      },
      { name: "single-responsibility", description: "Each helper does one thing", weight: 3 },
      { name: "behavior-preserved", description: "Same status codes and responses", weight: 2 },
      { name: "readability", description: "Main handler is now easy to follow", weight: 2 },
    ],
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// Category 2: Code Generation (6 tasks)
// ---------------------------------------------------------------------------

const codeGenerationTasks: BenchmarkTask[] = [
  {
    id: "gen-debounce-01",
    category: "code-generation",
    difficulty: "easy",
    optimizerTaskType: "code",
    prompt:
      "Write a TypeScript function `debounce<T extends (...args: any[]) => void>(fn: T, delayMs: number): T` that delays invoking `fn` until `delayMs` milliseconds have passed since the last call. If called again before the delay expires, the timer resets. Return the debounced function.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["setTimeout", "clearTimeout"],
      description:
        "Returns a function that stores a timer ID, clears it on each call, and sets a new timeout. Uses generics or preserves `this` context.",
    },
    scoringCriteria: [
      {
        name: "correctness",
        description: "Timer resets on each call, fires after delay",
        weight: 4,
      },
      { name: "types", description: "Proper TypeScript generics/typing", weight: 2 },
      { name: "edge-cases", description: "Handles rapid successive calls", weight: 2 },
      { name: "code-quality", description: "Clean, minimal implementation", weight: 2 },
    ],
    timeoutMs: 30_000,
  },
  {
    id: "gen-deep-clone-02",
    category: "code-generation",
    difficulty: "easy",
    optimizerTaskType: "code",
    prompt:
      "Write a TypeScript function `deepClone<T>(obj: T): T` that creates a deep copy of any JSON-serializable value. Handle objects, arrays, null, numbers, strings, and booleans. Do not use JSON.parse/JSON.stringify.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["Array.isArray", "typeof"],
      mustExclude: ["JSON.parse", "JSON.stringify"],
      description:
        "Recursively clones objects and arrays. Handles null/primitives as base cases. Does not use JSON round-trip.",
    },
    scoringCriteria: [
      { name: "correctness", description: "Produces true deep copies", weight: 4 },
      {
        name: "handles-types",
        description: "Handles objects, arrays, null, primitives",
        weight: 3,
      },
      { name: "no-json", description: "Does not use JSON.parse/JSON.stringify", weight: 2 },
      { name: "code-quality", description: "Clean recursive implementation", weight: 1 },
    ],
    timeoutMs: 30_000,
  },
  {
    id: "gen-csv-to-json-03",
    category: "code-generation",
    difficulty: "medium",
    optimizerTaskType: "code",
    prompt:
      'Write a TypeScript function that reads a CSV string and converts it to an array of objects. The first row is the header. Handle quoted fields (fields containing commas wrapped in double quotes). Example: `"name","city"\\n"Alice","New York"\\n"Bob","San Francisco"` → `[{name:"Alice",city:"New York"},{name:"Bob",city:"San Francisco"}]`.',
    tools: [],
    expectedBehavior: {
      mustInclude: ["split", "function"],
      description:
        "Parses CSV with header row. Correctly handles quoted fields containing commas. Returns array of objects with header keys.",
    },
    scoringCriteria: [
      { name: "basic-parsing", description: "Parses simple CSV correctly", weight: 3 },
      { name: "quoted-fields", description: "Handles quoted fields with commas", weight: 3 },
      { name: "header-mapping", description: "Uses first row as object keys", weight: 2 },
      { name: "code-quality", description: "Readable, well-structured", weight: 2 },
    ],
    timeoutMs: 45_000,
  },
  {
    id: "gen-event-emitter-04",
    category: "code-generation",
    difficulty: "medium",
    optimizerTaskType: "code",
    prompt:
      "Write a TypeScript class `TypedEventEmitter<Events extends Record<string, any[]>>` with methods: `on(event, listener)`, `off(event, listener)`, `emit(event, ...args)`, and `once(event, listener)`. All methods must be type-safe — listeners must match the event's argument types.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["class", "on", "off", "emit", "once"],
      description:
        "Implements a type-safe event emitter with on/off/emit/once. Uses TypeScript generics to enforce listener argument types match the event definition.",
    },
    scoringCriteria: [
      { name: "on-off-emit", description: "on/off/emit work correctly", weight: 3 },
      { name: "once", description: "once fires listener only once then removes it", weight: 2 },
      {
        name: "type-safety",
        description: "Generic types enforce correct listener args",
        weight: 3,
      },
      { name: "code-quality", description: "Clean class implementation", weight: 2 },
    ],
    timeoutMs: 45_000,
  },
  {
    id: "gen-rate-limiter-05",
    category: "code-generation",
    difficulty: "hard",
    optimizerTaskType: "code",
    prompt:
      "Write a TypeScript class `SlidingWindowRateLimiter` with constructor `(maxRequests: number, windowMs: number)` and method `tryAcquire(key: string): boolean`. It should allow at most `maxRequests` per `key` within any sliding window of `windowMs` milliseconds. Clean up expired entries to prevent memory leaks. Include a `reset(key?: string)` method.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["class", "tryAcquire", "Map"],
      description:
        "Implements sliding window rate limiting per key. Stores timestamps per key, filters expired ones on each check. Includes cleanup of old entries and a reset method.",
    },
    scoringCriteria: [
      {
        name: "sliding-window",
        description: "Correctly implements sliding window (not fixed)",
        weight: 4,
      },
      { name: "per-key", description: "Limits are tracked per key independently", weight: 2 },
      { name: "memory-cleanup", description: "Expired entries are cleaned up", weight: 2 },
      { name: "reset", description: "Reset method works for single key and all keys", weight: 1 },
      { name: "code-quality", description: "Well-typed, clean implementation", weight: 1 },
    ],
    timeoutMs: 60_000,
  },
  {
    id: "gen-promise-pool-06",
    category: "code-generation",
    difficulty: "hard",
    optimizerTaskType: "code",
    prompt:
      "Write a TypeScript function `promisePool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]>` that executes async tasks with a maximum concurrency limit. Results must be returned in the same order as the input tasks. If any task rejects, the pool should still complete remaining in-flight tasks before rejecting with the first error.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["Promise", "async", "concurrency"],
      description:
        "Implements a concurrent task pool that respects the concurrency limit, preserves result order, and handles errors gracefully.",
    },
    scoringCriteria: [
      { name: "concurrency-limit", description: "Never exceeds concurrency limit", weight: 3 },
      { name: "order-preserved", description: "Results match input order", weight: 3 },
      {
        name: "error-handling",
        description: "Handles rejections without losing in-flight work",
        weight: 2,
      },
      {
        name: "code-quality",
        description: "Clean async/await or manual promise orchestration",
        weight: 2,
      },
    ],
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// Category 3: Tool Use (6 tasks)
// ---------------------------------------------------------------------------

const toolUseTasks: BenchmarkTask[] = [
  {
    id: "tool-read-config-01",
    category: "tool-use",
    difficulty: "easy",
    optimizerTaskType: "tool",
    prompt:
      'Read the file at /tmp/config.json and tell me what port the server is configured to use. The file contains a JSON object with a "server" key that has a "port" field.',
    tools: [TOOL_FILE_READ],
    expectedBehavior: {
      expectedToolCalls: [{ toolName: "file_read", requiredArgs: { path: "/tmp/config.json" } }],
      description:
        "Calls file_read with the correct path, then extracts and reports the port value from the JSON response.",
    },
    scoringCriteria: [
      { name: "correct-tool", description: "Uses file_read (not shell_exec cat)", weight: 3 },
      { name: "correct-args", description: "Path is exactly /tmp/config.json", weight: 3 },
      { name: "answer-extraction", description: "Extracts and reports the port value", weight: 4 },
    ],
    timeoutMs: 20_000,
  },
  {
    id: "tool-create-file-02",
    category: "tool-use",
    difficulty: "easy",
    optimizerTaskType: "tool",
    prompt:
      'Create a new file at /tmp/hello.txt with the content "Hello, World!" and then read it back to confirm it was written correctly.',
    tools: [TOOL_FILE_READ, TOOL_FILE_WRITE],
    expectedBehavior: {
      expectedToolCalls: [
        { toolName: "file_write", requiredArgs: { path: "/tmp/hello.txt" } },
        { toolName: "file_read", requiredArgs: { path: "/tmp/hello.txt" } },
      ],
      description:
        "First calls file_write to create the file, then file_read to verify. Reports confirmation.",
    },
    scoringCriteria: [
      { name: "write-first", description: "Calls file_write before file_read", weight: 3 },
      { name: "correct-content", description: 'Written content is "Hello, World!"', weight: 3 },
      { name: "verification", description: "Reads back and confirms content", weight: 4 },
    ],
    timeoutMs: 20_000,
  },
  {
    id: "tool-find-todos-03",
    category: "tool-use",
    difficulty: "medium",
    optimizerTaskType: "tool",
    prompt:
      "Find all TypeScript files (.ts) in the /project/src directory that contain TODO comments. List each file and the TODO comment text. Use the available tools.",
    tools: [TOOL_SHELL_EXEC, TOOL_LIST_DIR, TOOL_FILE_READ],
    expectedBehavior: {
      expectedToolCalls: [{ toolName: "shell_exec", requiredArgs: {} }],
      description:
        "Uses shell_exec with grep/rg to find TODO comments across .ts files, or lists directory then reads files. Reports file paths and TODO text.",
    },
    scoringCriteria: [
      {
        name: "efficient-approach",
        description: "Uses grep/rg rather than reading every file",
        weight: 3,
      },
      { name: "correct-filter", description: "Filters to .ts files only", weight: 2 },
      { name: "todo-extraction", description: "Extracts actual TODO comment text", weight: 3 },
      { name: "structured-output", description: "Results are clearly formatted", weight: 2 },
    ],
    timeoutMs: 30_000,
  },
  {
    id: "tool-git-status-04",
    category: "tool-use",
    difficulty: "medium",
    optimizerTaskType: "tool",
    prompt:
      "Check the git status of the repository at /project, then show me the diff of any staged changes. If there are unstaged changes, stage them first.",
    tools: [TOOL_SHELL_EXEC],
    expectedBehavior: {
      expectedToolCalls: [{ toolName: "shell_exec", requiredArgs: { command: ".*git status.*" } }],
      description:
        "Runs git status first, then conditionally runs git add and git diff --cached. Multi-step tool use with conditional logic.",
    },
    scoringCriteria: [
      { name: "status-first", description: "Checks git status before other actions", weight: 3 },
      {
        name: "conditional-logic",
        description: "Stages only if unstaged changes exist",
        weight: 3,
      },
      { name: "diff-shown", description: "Shows staged diff", weight: 2 },
      { name: "correct-cwd", description: "Uses /project as working directory", weight: 2 },
    ],
    timeoutMs: 30_000,
  },
  {
    id: "tool-multi-step-05",
    category: "tool-use",
    difficulty: "hard",
    optimizerTaskType: "tool",
    prompt:
      "Read the package.json at /project/package.json and identify all dependencies. For each dependency, search the web to find if there's a newer major version available. Create a report file at /project/dep-report.md with a markdown table: | Package | Current | Latest | Update Available |.",
    tools: [TOOL_FILE_READ, TOOL_FILE_WRITE, TOOL_WEB_SEARCH],
    expectedBehavior: {
      expectedToolCalls: [
        { toolName: "file_read", requiredArgs: { path: "/project/package.json" } },
        { toolName: "web_search" },
        { toolName: "file_write", requiredArgs: { path: "/project/dep-report.md" } },
      ],
      description:
        "Three-phase pipeline: read package.json → search for each dependency's latest version → write a structured markdown report. Requires correct sequencing.",
    },
    scoringCriteria: [
      {
        name: "read-parse",
        description: "Reads and correctly parses package.json deps",
        weight: 2,
      },
      { name: "search-each", description: "Searches for version info per dependency", weight: 3 },
      { name: "report-format", description: "Writes valid markdown table", weight: 3 },
      { name: "sequencing", description: "Correct order: read → search → write", weight: 2 },
    ],
    timeoutMs: 90_000,
  },
  {
    id: "tool-debug-deploy-06",
    category: "tool-use",
    difficulty: "hard",
    optimizerTaskType: "tool",
    prompt:
      "The deployment at /project failed. Debug by: (1) reading the last 50 lines of /project/logs/deploy.log, (2) checking if the required env vars are set by running `env | grep DEPLOY_`, (3) verifying the build output exists at /project/dist/index.js. Report what's wrong and suggest fixes.",
    tools: [TOOL_FILE_READ, TOOL_SHELL_EXEC],
    expectedBehavior: {
      expectedToolCalls: [
        { toolName: "file_read", requiredArgs: { path: "/project/logs/deploy.log" } },
        { toolName: "shell_exec", requiredArgs: { command: ".*env.*DEPLOY.*" } },
        { toolName: "file_read", requiredArgs: { path: "/project/dist/index.js" } },
      ],
      description:
        "Performs all three diagnostic steps, synthesizes findings, and provides actionable fix suggestions. Handles cases where files might not exist.",
    },
    scoringCriteria: [
      { name: "all-steps", description: "Executes all 3 diagnostic steps", weight: 3 },
      {
        name: "error-handling",
        description: "Handles missing files/empty results gracefully",
        weight: 2,
      },
      { name: "synthesis", description: "Combines findings into coherent diagnosis", weight: 3 },
      {
        name: "actionable-fixes",
        description: "Provides specific, actionable fix suggestions",
        weight: 2,
      },
    ],
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// Category 4: Reasoning & Planning (6 tasks)
// ---------------------------------------------------------------------------

const reasoningTasks: BenchmarkTask[] = [
  {
    id: "reason-error-logs-01",
    category: "reasoning",
    difficulty: "easy",
    optimizerTaskType: "agent",
    prompt: `Given these error logs from a microservices system, identify which service is the root cause of the failures and explain why:\n\n\`\`\`\n${ERROR_LOGS}\n\`\`\``,
    tools: [],
    expectedBehavior: {
      mustInclude: ["payment", "postgres"],
      description:
        "Identifies that the payment-service is failing because it cannot connect to PostgreSQL. The API gateway 503s are a symptom, not the cause. Root cause is the PostgreSQL database being unreachable.",
    },
    scoringCriteria: [
      { name: "root-cause", description: "Identifies PostgreSQL as root cause", weight: 4 },
      {
        name: "chain-of-failure",
        description: "Explains the cascade: DB → payment → gateway",
        weight: 3,
      },
      { name: "other-services", description: "Notes user/auth services are healthy", weight: 2 },
      { name: "clarity", description: "Explanation is clear and structured", weight: 1 },
    ],
    timeoutMs: 30_000,
  },
  {
    id: "reason-tradeoffs-02",
    category: "reasoning",
    difficulty: "easy",
    optimizerTaskType: "chat",
    prompt:
      "A team is debating between using Redis and an in-memory LRU cache for rate limiting in a single-server Node.js API. List 3 pros and 3 cons of each approach, considering the single-server constraint.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["Redis", "memory", "cache"],
      description:
        "Provides balanced tradeoff analysis. Redis pros should include persistence and future scalability; cons include latency overhead and operational complexity for a single server. In-memory pros include speed and simplicity; cons include data loss on restart.",
    },
    scoringCriteria: [
      { name: "completeness", description: "3 pros and 3 cons for each approach", weight: 3 },
      { name: "accuracy", description: "Technical claims are correct", weight: 3 },
      { name: "context-awareness", description: "Considers single-server constraint", weight: 2 },
      { name: "recommendation", description: "Makes a justified recommendation", weight: 2 },
    ],
    timeoutMs: 30_000,
  },
  {
    id: "reason-migration-plan-03",
    category: "reasoning",
    difficulty: "medium",
    optimizerTaskType: "agent",
    prompt:
      "Design a migration plan for moving a monolithic Express.js API (50 endpoints, single PostgreSQL database) to a microservices architecture. The team has 4 engineers and 3 months. Provide a phased plan with specific milestones, risks, and rollback strategies.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["phase", "risk"],
      description:
        "Multi-phase plan starting with strangler fig pattern or similar incremental approach. Identifies key risks (data consistency, network latency, team expertise). Includes rollback strategy and suggests which services to extract first.",
    },
    scoringCriteria: [
      { name: "phased-approach", description: "Breaks migration into clear phases", weight: 3 },
      { name: "realistic-timeline", description: "Plan fits 4 engineers / 3 months", weight: 2 },
      { name: "risks-identified", description: "Identifies at least 3 concrete risks", weight: 2 },
      { name: "rollback-strategy", description: "Includes how to roll back each phase", weight: 2 },
      { name: "prioritization", description: "Logical order of service extraction", weight: 1 },
    ],
    timeoutMs: 60_000,
  },
  {
    id: "reason-architecture-04",
    category: "reasoning",
    difficulty: "medium",
    optimizerTaskType: "agent",
    prompt: `Review this system architecture and identify all single points of failure. For each, suggest a mitigation strategy with estimated effort (low/medium/high).\n\n\`\`\`\n${ARCHITECTURE_DIAGRAM}\n\`\`\``,
    tools: [],
    expectedBehavior: {
      mustInclude: ["single point", "replica"],
      description:
        "Identifies SPOFs: API Gateway (single), PostgreSQL (single, no failover), Auth Service (single, local SQLite), no message queue for async ops. Suggests load balancers, DB replication, auth service replication, and async messaging.",
    },
    scoringCriteria: [
      { name: "spof-identification", description: "Identifies at least 4 SPOFs", weight: 4 },
      { name: "mitigations", description: "Provides actionable mitigation for each", weight: 3 },
      { name: "effort-estimates", description: "Realistic effort ratings", weight: 2 },
      { name: "prioritization", description: "Suggests which to fix first", weight: 1 },
    ],
    timeoutMs: 45_000,
  },
  {
    id: "reason-system-design-05",
    category: "reasoning",
    difficulty: "hard",
    optimizerTaskType: "agent",
    prompt:
      "Design a real-time collaborative document editor (like Google Docs) for a team of up to 50 concurrent users. Cover: data model, conflict resolution strategy (CRDT vs OT), network protocol, offline support, and cursor/presence indicators. Justify your technology choices for a small startup with 2 backend engineers.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["CRDT", "WebSocket"],
      description:
        "Covers all 5 aspects. Justifies CRDT vs OT choice with team size context (CRDTs simpler to implement). Proposes WebSocket for real-time sync. Addresses offline with local-first approach. Presence via heartbeat/cursor position broadcasting.",
    },
    scoringCriteria: [
      { name: "completeness", description: "Addresses all 5 required aspects", weight: 3 },
      {
        name: "conflict-resolution",
        description: "Correct explanation of chosen approach",
        weight: 3,
      },
      { name: "team-context", description: "Choices realistic for 2-person team", weight: 2 },
      { name: "offline-support", description: "Viable offline strategy", weight: 1 },
      {
        name: "technical-depth",
        description: "Sufficient detail to start implementing",
        weight: 1,
      },
    ],
    timeoutMs: 90_000,
  },
  {
    id: "reason-incident-06",
    category: "reasoning",
    difficulty: "hard",
    optimizerTaskType: "agent",
    prompt:
      "You're the on-call engineer. At 3 AM, alerts fire: API latency spiked from 50ms to 5s, error rate jumped to 30%, and memory usage on 2 of 3 app servers went from 60% to 95%. Database CPU is normal (15%). Redis shows 0 connections (normally 50+). The change log shows a deployment 2 hours ago that added Redis caching to the hot path. Write an incident response: (1) immediate triage steps, (2) most likely root cause, (3) remediation, (4) post-incident action items.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["Redis", "rollback"],
      description:
        "Identifies Redis connection failure as root cause (0 connections after a deploy that added Redis caching). Without Redis, the hot path falls back to something slower or fails. Immediate fix: rollback deploy or fix Redis connection. Memory spike from retries/timeouts.",
    },
    scoringCriteria: [
      { name: "triage-steps", description: "Structured immediate investigation steps", weight: 2 },
      {
        name: "root-cause",
        description: "Correctly links Redis 0 connections to deploy",
        weight: 3,
      },
      { name: "remediation", description: "Actionable fix (rollback or Redis restart)", weight: 3 },
      { name: "post-incident", description: "Meaningful follow-up items", weight: 2 },
    ],
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// Category 5: Documentation & Communication (6 tasks)
// ---------------------------------------------------------------------------

const documentationTasks: BenchmarkTask[] = [
  {
    id: "doc-commit-msg-01",
    category: "documentation",
    difficulty: "easy",
    optimizerTaskType: "chat",
    prompt: `Write a conventional commit message for this diff. Follow the format: type(scope): description. Include a body if the change warrants explanation.\n\n\`\`\`diff\n${DIFF_FOR_COMMIT_MSG}\n\`\`\``,
    tools: [],
    expectedBehavior: {
      mustInclude: ["feat", "auth"],
      description:
        "Produces a conventional commit like 'feat(auth): add token expiration check and refresh endpoint'. Body explains the two changes: expiration validation and new refreshToken function.",
    },
    scoringCriteria: [
      { name: "format", description: "Follows conventional commit format", weight: 3 },
      {
        name: "type-correct",
        description: "Uses correct type (feat for new functionality)",
        weight: 2,
      },
      { name: "scope", description: "Scope is relevant (auth)", weight: 2 },
      { name: "description", description: "Description captures both changes", weight: 3 },
    ],
    timeoutMs: 20_000,
  },
  {
    id: "doc-function-docs-02",
    category: "documentation",
    difficulty: "easy",
    optimizerTaskType: "chat",
    prompt:
      "Write JSDoc documentation for this function:\n\n```typescript\nfunction retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number, backoff?: number): Promise<T>\n```\n\nThe function retries a failed async operation up to `attempts` times with `delayMs` between retries. If `backoff` is provided, the delay multiplies by that factor each retry.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["@param", "@returns", "@throws"],
      description:
        "Complete JSDoc with description, all @param tags with types and descriptions, @returns, @throws, and ideally an @example.",
    },
    scoringCriteria: [
      { name: "completeness", description: "All params documented with @param", weight: 3 },
      { name: "returns", description: "Includes @returns with description", weight: 2 },
      { name: "throws", description: "Documents possible exceptions", weight: 2 },
      { name: "example", description: "Includes usage example", weight: 2 },
      { name: "clarity", description: "Descriptions are clear and useful", weight: 1 },
    ],
    timeoutMs: 30_000,
  },
  {
    id: "doc-api-docs-03",
    category: "documentation",
    difficulty: "medium",
    optimizerTaskType: "chat",
    prompt: `Write API documentation for these endpoints. For each endpoint include: description, request parameters/body, response format with example, error codes, and authentication requirements.\n\n${ENDPOINT_SPECS}`,
    tools: [],
    expectedBehavior: {
      mustInclude: ["POST", "GET", "200", "404"],
      description:
        "Comprehensive API docs for all 5 endpoints. Each endpoint has description, request format, response examples, error codes, and auth notes. Formatted as markdown.",
    },
    scoringCriteria: [
      { name: "all-endpoints", description: "All 5 endpoints documented", weight: 3 },
      { name: "request-format", description: "Request params/body clearly specified", weight: 2 },
      {
        name: "response-examples",
        description: "Response examples with realistic data",
        weight: 2,
      },
      { name: "error-codes", description: "Error responses documented", weight: 2 },
      {
        name: "auth-noted",
        description: "Auth requirements mentioned where applicable",
        weight: 1,
      },
    ],
    timeoutMs: 60_000,
  },
  {
    id: "doc-pr-description-04",
    category: "documentation",
    difficulty: "medium",
    optimizerTaskType: "chat",
    prompt:
      "Write a pull request description for a change that adds WebSocket support to an existing REST API chat application. The PR adds: a WebSocket server alongside Express, real-time message delivery, typing indicators, online presence tracking, and graceful degradation to polling when WebSocket fails. The PR touches 12 files and adds 450 lines. Include sections: Summary, Changes, Testing, and Migration Notes.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["WebSocket", "Summary", "Testing"],
      description:
        "Well-structured PR description with all requested sections. Summary gives context and motivation. Changes lists key modifications. Testing describes how to verify. Migration notes cover any breaking changes.",
    },
    scoringCriteria: [
      { name: "structure", description: "All 4 sections present and well-organized", weight: 3 },
      { name: "summary", description: "Summary explains why, not just what", weight: 2 },
      {
        name: "changes-detailed",
        description: "Key changes listed with file/area context",
        weight: 2,
      },
      { name: "testing", description: "Specific test scenarios described", weight: 2 },
      { name: "migration", description: "Migration/breaking change notes present", weight: 1 },
    ],
    timeoutMs: 45_000,
  },
  {
    id: "doc-migration-guide-05",
    category: "documentation",
    difficulty: "hard",
    optimizerTaskType: "chat",
    prompt: `Write a migration guide for users upgrading from v1 to v2. The guide should be welcoming (many users are not expert developers), include step-by-step instructions, before/after code examples for each breaking change, a troubleshooting section, and a quick-start path for those who want the minimum viable migration.\n\nChangelog:\n${V1_V2_CHANGELOG}`,
    tools: [],
    expectedBehavior: {
      mustInclude: ["Step", "Before", "After"],
      description:
        "Friendly migration guide with step-by-step instructions. Each breaking change has before/after code examples. Includes quick-start path and troubleshooting section. Tone is welcoming to non-experts.",
    },
    scoringCriteria: [
      { name: "completeness", description: "All breaking changes covered", weight: 3 },
      {
        name: "before-after",
        description: "Before/after code examples for each change",
        weight: 3,
      },
      { name: "quick-start", description: "Minimum viable migration path present", weight: 2 },
      { name: "troubleshooting", description: "Common issues and fixes", weight: 1 },
      { name: "tone", description: "Welcoming and accessible to non-experts", weight: 1 },
    ],
    timeoutMs: 90_000,
  },
  {
    id: "doc-runbook-06",
    category: "documentation",
    difficulty: "hard",
    optimizerTaskType: "chat",
    prompt:
      "Write an operational runbook for a Node.js service running on Kubernetes. Cover: (1) health check endpoints and what each checks, (2) common failure modes with symptoms and fixes, (3) scaling procedures (manual and auto), (4) deployment rollback steps, (5) log locations and useful log queries, (6) escalation contacts and when to escalate. Assume the reader is an on-call engineer who may not be familiar with this service.",
    tools: [],
    expectedBehavior: {
      mustInclude: ["health", "rollback", "kubectl", "escalat"],
      description:
        "Comprehensive runbook covering all 6 areas. Written for an unfamiliar on-call engineer. Includes specific kubectl commands, log queries, and clear escalation criteria.",
    },
    scoringCriteria: [
      { name: "all-sections", description: "All 6 required sections present", weight: 3 },
      {
        name: "actionable-commands",
        description: "Includes copy-pasteable kubectl/log commands",
        weight: 3,
      },
      { name: "failure-modes", description: "At least 4 failure modes with symptoms", weight: 2 },
      { name: "escalation", description: "Clear escalation criteria and contacts", weight: 1 },
      { name: "audience", description: "Written for unfamiliar on-call engineer", weight: 1 },
    ],
    timeoutMs: 90_000,
  },
];

// ---------------------------------------------------------------------------
// All tasks combined
// ---------------------------------------------------------------------------

export const BENCHMARK_TASKS: readonly BenchmarkTask[] = [
  ...singleFileEditTasks,
  ...codeGenerationTasks,
  ...toolUseTasks,
  ...reasoningTasks,
  ...documentationTasks,
];

/** Retrieve tasks filtered by category. */
export function getTasksByCategory(category: BenchmarkTask["category"]): BenchmarkTask[] {
  return BENCHMARK_TASKS.filter((t) => t.category === category);
}

/** Retrieve tasks filtered by difficulty. */
export function getTasksByDifficulty(difficulty: BenchmarkTask["difficulty"]): BenchmarkTask[] {
  return BENCHMARK_TASKS.filter((t) => t.difficulty === difficulty);
}

/** Retrieve a single task by ID. Returns undefined if not found. */
export function getTaskById(id: string): BenchmarkTask | undefined {
  return BENCHMARK_TASKS.find((t) => t.id === id);
}
