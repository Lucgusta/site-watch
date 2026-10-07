import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
export function createDatabase(url: string, schema = "public"): PrismaClient {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
    throw new Error("Invalid database schema name.");
  return new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: url, options: `-c search_path=${schema}` },
      { schema },
    ),
  });
}
