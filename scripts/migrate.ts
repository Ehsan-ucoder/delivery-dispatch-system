import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  await client.query(sql);
  console.log("Migration applied: db/schema.sql");
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
