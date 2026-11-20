import { PrismaClient } from '@prisma/client';

/**
 * Single shared PrismaClient for the whole worker process.
 * All monetary values are BigInt minor units — they are formatted only at
 * presentation edges (lib/money.ts), never multiplied as floats.
 */
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
