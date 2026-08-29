require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const MENU = [
  {
    name: 'Buka Stew',
    category: 'Soups & stews',
    description: 'Deep palm oil stew with varied meats.',
    icon: '🍲',
    options: [
      { size: '1L', price: 4500 },
      { size: '2L', price: 8500 },
      { size: '5L', price: 20000 },
    ],
  },
  {
    name: 'Efo Riro',
    category: 'Soups & stews',
    description: 'Rich spinach & vegetable stew with greens and protein.',
    icon: '🥬',
    options: [
      { size: '1L', price: 4500 },
      { size: '2L', price: 8500 },
      { size: '5L', price: 20000 },
    ],
  },
  {
    name: 'Egusi',
    category: 'Soups & stews',
    description: 'Hearty melon seed soup with mixed meats and greens.',
    icon: '🥘',
    options: [
      { size: '1L', price: 5000 },
      { size: '2L', price: 9500 },
      { size: '5L', price: 22000 },
    ],
  },
  {
    name: 'Ewedu',
    category: 'Soups & stews',
    description: 'Silky, traditional ewedu with the perfect consistency.',
    icon: '🍃',
    options: [
      { size: '1L', price: 3000 },
      { size: '2L', price: 5500 },
      { size: '5L', price: 13000 },
    ],
  },
  {
    name: 'Party Jollof Rice',
    category: 'Rice bowls',
    description: 'Classic smoky jollof, packed with flavor.',
    icon: '🍛',
    options: [
      { size: '1kg', price: 3500 },
      { size: '2kg', price: 6500 },
      { size: '5kg', price: 15000 },
    ],
  },
  {
    name: 'Nigerian Fried Rice',
    category: 'Rice bowls',
    description: 'Savory, vegetable-packed fried rice.',
    icon: '🍚',
    options: [
      { size: '1kg', price: 3500 },
      { size: '2kg', price: 6500 },
      { size: '5kg', price: 15000 },
    ],
  },
];

const LOCATIONS = [
  { name: 'Akobo, Ibadan', logisticsFee: 1000 },
  { name: 'Bodija, Ibadan', logisticsFee: 1500 },
  { name: 'Ring Road, Ibadan', logisticsFee: 2000 },
  { name: 'Outside Ibadan (courier)', logisticsFee: 4000 },
];

async function main() {
  const categoryIds = {};
  for (const name of [...new Set(MENU.map((item) => item.category))]) {
    const category = await prisma.menuCategory.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    categoryIds[name] = category.id;
  }

  for (const item of MENU) {
    await prisma.menuItem.upsert({
      where: { name: item.name },
      update: {},
      create: {
        name: item.name,
        categoryId: categoryIds[item.category],
        description: item.description,
        icon: item.icon,
        options: { create: item.options },
      },
    });
  }

  for (const location of LOCATIONS) {
    await prisma.location.upsert({
      where: { name: location.name },
      update: { logisticsFee: location.logisticsFee },
      create: location,
    });
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@danofunmi.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  await prisma.adminUser.upsert({
    where: { email: adminEmail },
    update: {},
    create: { email: adminEmail, passwordHash, name: 'Admin' },
  });

  console.log('Seeded menu, locations, and admin user.');
  console.log(`Admin login: ${adminEmail} / ${adminPassword}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
