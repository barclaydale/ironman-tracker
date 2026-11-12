// Key-value storage for the tracker.
// On Vercel: Upstash Redis (the Marketplace integration sets KV_REST_API_* or
// UPSTASH_REDIS_REST_* env vars). Locally without those: an in-memory map, so
// `npm run dev` works without a database.

let client = null;

export async function store() {
  if (client) return client;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({ url, token }); // JSON values are (de)serialized automatically
    client = {
      get: (key) => redis.get(key),
      set: (key, value) => redis.set(key, value),
      del: (key) => redis.del(key),
    };
  } else if (process.env.VERCEL) {
    throw new Error('Storage is not configured — connect an Upstash Redis database to this Vercel project');
  } else {
    const mem = new Map();
    client = {
      get: async (key) => (mem.has(key) ? structuredClone(mem.get(key)) : null),
      set: async (key, value) => void mem.set(key, structuredClone(value)),
      del: async (key) => void mem.delete(key),
    };
  }
  return client;
}
