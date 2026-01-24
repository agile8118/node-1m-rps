import cpeak, { parseJSON } from "cpeak";
import crypto from "crypto";
import { DB } from "./database/index.js";
import { redis } from "./database/redis.js";
import { generateCode, getMaxId } from "./utils.js";

const app = cpeak();

process.title = "node-cpeak";

app.beforeEach(parseJSON({ limit: 1024 * 1024 }));

app.route("get", `/simple`, async (req, res) => {
  await res.json({ message: "hi" });
});

app.route("patch", `/update-something/:id/:name`, (req, res) => {
  const { id, name } = req.params;
  const { value1, value2 } = req.query;

  // Validate id and name
  if (isNaN(Number(id))) {
    return res.status(400).json({ error: "id must be a number" });
  } else if (!name || name.length < 3) {
    return res
      .status(400)
      .json({ error: "name is required and must be at least 3 characters" });
  }

  const formattedFooValues = [];

  for (let i = 1; i <= 10; i++) {
    const val = req.body[`foo${i}`];
    const formattedVal = typeof val === "string" ? `${val}. ` : val;
    formattedFooValues.push(formattedVal);
  }

  // Adding all the formatted foo values together
  const totalFoo = formattedFooValues.join("");

  // Generating a few kilobytes of dummy data
  const dummyHistory = Array.from({ length: 100 }).map((_, i) => ({
    event_id: Number(id) + i,
    timestamp: new Date().toISOString(),
    action: `Action performed by ${name}`,
    metadata:
      "This is a string intended to take up space to simulate a medium-sized production API response object.".repeat(
        2,
      ),
    status: i % 2 === 0 ? "success" : "pending",
  }));

  res.json({
    id,
    name,
    value1,
    value2,
    total_foo: String(totalFoo).toUpperCase(),
    history: dummyHistory,
  });
});

// Inserts a simple record to the database
app.route("post", "/code", async (req, res) => {
  const code = generateCode();

  // Create a new code record
  try {
    const result = await DB.query(
      `
      INSERT INTO codes (code)
      VALUES ($1)
      RETURNING id, code, created_at
    `,
      [code],
    );

    res.status(201).json({ created_code: result[0] });
  } catch (err) {
    if (err.code === "23505") {
      // Unique violation
      return res.status(409).json({ error: "Code already exists." });
    }

    throw err;
  }
});

// Reads a simple random code from the database and returns it
app.route("get", "/code-v1", async (req, res) => {
  const result = await DB.query(
    `
      SELECT id, code, created_at
      FROM codes
      ORDER BY RANDOM()
      LIMIT 1
    `,
  );

  if (result.length === 0) {
    return res.status(404).json({ error: "No codes found." });
  }

  res.json({ data: result[0] });
});

app.route("get", "/code-v2", async (req, res) => {
  const countResult = await DB.query(`SELECT COUNT(*) FROM codes`);
  const count = parseInt(countResult[0].count, 10);

  if (count === 0) return res.status(404).json({ error: "No codes found." });

  // Generate a random ID between 1 and Count
  const randomId = crypto.randomInt(1, count + 1);

  // Fetch the record by ID (Index Lookup)
  const result = await DB.query(
    `
      SELECT id, code, created_at
      FROM codes
      WHERE id = $1
    `,
    [randomId],
  );

  if (result.length === 0) {
    return res.status(404).json({ error: "record not found" });
  }

  res.json({ data: result[0] });
});

app.route("get", "/code-v3", async (req, res) => {
  const maxResult = await DB.query(
    `SELECT id FROM codes ORDER BY id DESC LIMIT 1`,
  );

  if (maxResult.length === 0)
    return res.status(404).json({ error: "No codes found." });

  const maxId = maxResult[0].id;

  // Generate random ID up to Max
  const randomId = crypto.randomInt(1, maxId + 1);

  // Fetch (Index Lookup)
  const result = await DB.query(
    `SELECT id, code, created_at FROM codes WHERE id = $1`,
    [randomId],
  );

  if (result.length === 0) {
    return res.status(404).json({ error: "record not found" });
  }

  res.json({ data: result[0] });
});

app.route("get", "/code-v4", async (req, res) => {
  const randomId = crypto.randomInt(1, 700000 + 1); // kinda like cheating

  // Fetch the record by ID (Index Lookup)
  const result = await DB.query(
    `
      SELECT id, code, created_at
      FROM codes
      WHERE id = $1
    `,
    [randomId],
  );

  if (result.length === 0) {
    return res.status(404).json({ error: "record not found" });
  }

  res.json({ data: result[0] });
});

// Inserts a simple record to the database through Redis for super fast O(1) operations
app.route("post", "/code-fast", async (req, res) => {
  const code = generateCode();

  // Check uniqueness (O(1))
  // SADD returns 1 if added (new), 0 if exists (duplicate)
  const isNew = await redis.sadd("codes:unique", code);

  if (isNew === 0) {
    return res.status(409).json({ error: "Code already exists." });
  }

  // Generate ID (Incrementing Sequence O(1))
  const id = await redis.incr("codes:seq");
  const created_at = new Date().toISOString();

  // Pipeline these for speed (1 network round trip instead of 2)
  const pipeline = redis.pipeline();
  // Store Data (O(1) Hash Set)
  pipeline.hset(`code:${id}`, { id, code, created_at });

  // We will add the ids to a queue so that later a background worker can sync to Postgres
  pipeline.lpush("codes:sync_queue", id);

  await pipeline.exec();

  res.status(201).json({
    created_code: { id, code, created_at },
  });
});

const getUniqBucket = (code) => {
  const hash = crypto.createHash("md5").update(code).digest("hex");
  return parseInt(hash.substring(0, 4), 16) % 128;
};

app.route("post", "/code-ultra-fast", async (req, res) => {
  const id = crypto.randomUUID();
  const code = generateCode();
  const created_at = new Date().toISOString();

  const bucket = getUniqBucket(code);
  const isNew = await redis.sadd(`{uniq}:${bucket}`, code);
  if (isNew === 0)
    return res.status(409).json({ error: "Code already exists." });

  const tag = `{code:${id}}`;
  const storagePipeline = redis.pipeline();
  storagePipeline.hset(tag, { id, code, created_at });
  storagePipeline.lpush(`${tag}:sync`, id);

  const shard = Math.floor(Math.random() * 15);
  const activeIdsKey = `{active_ids}:${shard}`;

  await Promise.all([storagePipeline.exec(), redis.sadd(activeIdsKey, id)]);

  res.status(201).json({ created_code: { id, code, created_at } });
});

// Just writes a dummy random generated data to Redis.
// Used to test max req/s we can handle with Redis alone.
app.route("post", "/ultra-fast", async (req, res) => {
  const id = crypto.randomUUID();
  const data = crypto.randomBytes(32).toString("hex"); // 64 bytes of data

  await redis.set(`{ultra:${id}}`, data);

  res.status(201).json({ id, data });
});

app.route("get", "/code-ultra-fast", async (req, res) => {
  let shard = Math.floor(Math.random() * 15);
  let randomId = null;

  for (let i = 0; i < 15; i++) {
    const currentShard = (shard + i) % 15;
    randomId = await redis.srandmember(`{active_ids}:${currentShard}`);
    if (randomId) break;
  }

  if (!randomId) {
    return res
      .status(404)
      .json({ error: "Absolutely no codes found in any shard." });
  }

  const result = await redis.hgetall(`{code:${randomId}}`);

  if (!result || Object.keys(result).length === 0) {
    return res.status(404).json({ error: "Code expired or moved." });
  }

  res.json({ data: result });
});

// Gets a code but through Redis for super fast O(1) lookups
app.route("get", "/code-fast", async (req, res) => {
  // Get max ID
  const maxId = await getMaxId();
  if (maxId === 0) return res.status(404).json({ error: "No codes found." });

  // Generating a random ID
  const randomId = crypto.randomInt(1, maxId + 1);

  // Fetch the code (O(1) Hash Lookup)
  const result = await redis.hgetall(`code:${randomId}`);

  if (Object.keys(result).length === 0) {
    return res.status(404).json({ error: "record not found" });
  }

  res.json({ data: result });
});

app.handleErr((error, req, res) => {
  console.error(error);
  res.status(500).json({
    error: "Sorry, something unexpected happened on our side.",
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Cpeak server running at http://localhost:${PORT}`);
});
