/**
 * PRODUCTION ADMINISTRATOR BOOTSTRAP.
 *
 * The demo seed (prisma/seed.ts) refuses to run against a production
 * database. This script is the ONLY supported way to create the first
 * production administrator:
 *
 *   DATABASE_URL=... ADMIN_EMAIL=admin@yourdomain.org ADMIN_PASSWORD=... \
 *     ADMIN_FIRST_NAME=... ADMIN_LAST_NAME=... npm run bootstrap:admin
 *
 * Requirements (all enforced, fail-safe):
 *  - NODE_ENV must be production OR ADMIN_ALLOW_NON_PROD=1 for local tests;
 *  - ADMIN_EMAIL must be provided (never a fixed default address);
 *  - ADMIN_PASSWORD must be strong (>= 12 chars, upper+lower+digit+symbol);
 *    it is never logged and never stored anywhere except as a bcrypt hash;
 *  - the creation is audit-logged (ADMIN_BOOTSTRAP).
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

function fail(message: string): never {
  console.error(`REFUSING to bootstrap: ${message}`);
  process.exit(1);
}

async function main() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd && process.env.ADMIN_ALLOW_NON_PROD !== '1') {
    fail('NODE_ENV is not production. Set ADMIN_ALLOW_NON_PROD=1 only for local testing.');
  }

  const email = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail('ADMIN_EMAIL must be set to the real administrator address (no default exists).');
  }

  const password = process.env.ADMIN_PASSWORD;
  if (!password) fail('ADMIN_PASSWORD must be supplied via the environment (never a default).');
  if (
    password.length < 12 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    fail('ADMIN_PASSWORD must be >= 12 characters with upper, lower, digit and symbol.');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) fail(`A user with email ${email} already exists — bootstrap will not overwrite anyone.`);

  const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
  if (adminCount > 0) {
    fail(
      `An administrator already exists (${adminCount} found). Additional admins should be created by an existing admin through the console.`,
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: process.env.ADMIN_FIRST_NAME ?? 'Admin',
      lastName: process.env.ADMIN_LAST_NAME ?? 'KINDORA',
      role: 'ADMIN',
      emailVerifiedAt: new Date(),
      notificationPreference: { create: {} },
    },
  });

  await prisma.auditLog.create({
    data: {
      actorUserId: admin.id,
      action: 'ADMIN_BOOTSTRAP',
      entityType: 'USER',
      entityId: admin.id,
      metadata: { email, createdAt: new Date().toISOString(), via: 'bootstrap:admin' },
    },
  });

  console.log(`Administrator ${email} created. CHANGE THE PASSWORD AFTER FIRST LOGIN (see PRODUCTION_CHECKLIST.md).`);
  // Best-effort scrub of the password from this process' environment copy.
  delete process.env.ADMIN_PASSWORD;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
