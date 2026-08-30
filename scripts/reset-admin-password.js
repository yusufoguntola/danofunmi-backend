#!/usr/bin/env node
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function usage() {
  console.error('Usage: npm run admin:reset-password -- <email> [newPassword]');
  console.error('  newPassword: omit to generate a strong random one (printed once)');
}

async function main() {
  const [email, passwordArg] = process.argv.slice(2);
  if (!email) {
    usage();
    process.exit(1);
  }

  const generated = !passwordArg;
  const password = passwordArg || crypto.randomBytes(12).toString('base64url');

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const admin = await prisma.adminUser.findUnique({ where: { email } });
  if (!admin) {
    console.error(`No admin found with email "${email}".`);
    console.error('Use "npm run admin:create" to create one.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.adminUser.update({ where: { email }, data: { passwordHash } });

  console.log(`Password reset for "${admin.name}" <${admin.email}>.`);
  if (generated) {
    console.log(`Generated password: ${password}`);
    console.log('Save this now — it will not be shown again.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
