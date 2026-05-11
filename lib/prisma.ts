import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

const VALID_PRISMA_URL_PREFIXES = ["postgres://", "postgresql://", "prisma://", "prisma+postgres://"] as const;

type PrismaUrlEnvName = "CONTENTOPS_PRISMA_DATABASE_URL" | "DATABASE_URL";

function isValidPrismaUrl(value: string | undefined): value is string {
  const trimmed = value?.trim();
  return !!trimmed && VALID_PRISMA_URL_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function prismaUrlInvalidMessage(envName: PrismaUrlEnvName): string {
  return `DB_URL_INVALID: ${envName} is missing or invalid`;
}

function prismaRuntimeUrl(): string {
  const override = process.env.CONTENTOPS_PRISMA_DATABASE_URL?.trim();
  if (override && isValidPrismaUrl(override)) return override;
  const url = process.env.DATABASE_URL?.trim();
  if (!isValidPrismaUrl(url)) {
    throw new Error(prismaUrlInvalidMessage("DATABASE_URL"));
  }
  return url;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: {
      db: { url: prismaRuntimeUrl() },
    },
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
