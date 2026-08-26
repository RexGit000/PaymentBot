require("dotenv").config({ override: true });
const connectDB = require("./db");
const Admin = require("./models/Admin");

const SEED_ADMINS = [
  { telegramId: 1632962204, username: "@endurenow", isSuperAdmin: true },
  { telegramId: 8486646787, username: null, isSuperAdmin: false },
  { telegramId: 7433937250, username: null, isSuperAdmin: false },
  { telegramId: null, username: "@Cristina0069", isSuperAdmin: false },
  { telegramId: 8394641070, username: null, isSuperAdmin: false },
];

async function seedAdmins() {
  for (const data of SEED_ADMINS) {
    const query = data.telegramId
      ? { telegramId: data.telegramId }
      : { username: data.username };
    const existing = await Admin.findOne(query);
    if (!existing) {
      await Admin.create(data);
      const label = data.telegramId ?? data.username;
      console.log(
        `Seeded admin: ${label}${data.isSuperAdmin ? " (superadmin)" : ""}`,
      );
      continue;
    }
    let changed = false;
    if (data.username && existing.username !== data.username) {
      existing.username = data.username;
      changed = true;
    }
    if (data.isSuperAdmin && !existing.isSuperAdmin) {
      existing.isSuperAdmin = true;
      changed = true;
    }
    if (changed) {
      await existing.save();
      console.log(`Updated admin: ${data.telegramId ?? data.username}`);
    } else {
      console.log(`Admin already exists: ${data.telegramId ?? data.username}`);
    }
  }
}

async function seed() {
  await connectDB();

  await seedAdmins();
  if (process.argv.includes("--admins-only")) {
    console.log("\nAdmin seed complete.");
    process.exit(0);
    return;
  }

  console.log("\nSeed complete.");
  process.exit(0);
}

module.exports = { seedAdmins };

if (require.main === module) {
  seed().catch((err) => {
    console.error("Seed error:", err);
    process.exit(1);
  });
}
