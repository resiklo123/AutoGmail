const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({
  datasources: { db: { url: "postgresql://postgres.ynyjyikuhhltwkpmwtug:Resiklo-supabase123@aws-1-ap-south-1.pooler.supabase.com:5432/postgres" } }
});
async function main() {
  await prisma.$executeRawUnsafe(`ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  console.log("Asset.createdAt column added (or already existed).");
  const rows = await prisma.$queryRawUnsafe(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Asset' AND column_name = 'createdAt'`);
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });