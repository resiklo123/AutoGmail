const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
async function main() {
  const rows = await prisma.$queryRaw`
    SELECT table_name, column_name, data_type 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name IN ('Post','Asset')
      AND column_name IN ('updatedAt','libraryFolderId','libraryFolderUrl','byDateShortcutUrl','byMachineShortcutUrl','createdAt')
    ORDER BY table_name, column_name
  `;
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });