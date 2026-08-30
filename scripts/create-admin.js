#!/usr/bin/env node
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function usage() {
  console.error('Usage: npm run admin:create -- <email> [password] [name]');
  console.error('  password: omit to generate a strong random one (printed once)');
  console.error('  name:     defaults to "Admin"');
}

async function main() {
  const [email, passwordArg, ...nameParts] = process.argv.slice(2);
  if (!email) {
    usage();
    process.exit(1);
  }

  const name = nameParts.join(' ') || 'Admin';
  const generated = !passwordArg;
  const password = passwordArg || crypto.randomBytes(12).toString('base64url');

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    console.error(`An admin with email "${email}" already exists (id ${existing.id}).`);
    console.error('Use "npm run admin:reset-password" to change their password instead.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.adminUser.create({ data: { email, passwordHash, name } });

  console.log(`Created admin "${admin.name}" <${admin.email}>.`);
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
