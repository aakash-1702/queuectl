// src/db.ts — Singleton PrismaClient instance using @prisma/adapter-pg
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  console.error("ERROR: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString });
export const prisma = new PrismaClient({ adapter });