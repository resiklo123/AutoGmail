const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({
  datasources: { db: { url: "postgresql://postgres.ynyjyikuhhltwkpmwtug:Resiklo-supabase123@aws-1-ap-south-1.pooler.supabase.com:5432/postgres" } }
});
async function main() {
  const rows = await prisma.$queryRawUnsafe(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('Post','Asset') AND column_name IN ('updatedAt','libraryFolderId','libraryFolderUrl','byDateShortcutUrl','byMachineShortcutUrl','createdAt') ORDER BY table_name, column_name`);
  console.log("=== Column Verification ===");
  rows.forEach(r => console.log(`  ${r.table_name}.${r.column_name} (${r.data_type}) ✓`));
  console.log(`Total: ${rows.length}/6 required columns present`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });