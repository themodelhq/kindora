import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    // Prisma connects lazily; this warms the pool and surfaces config errors early.
    await this.$connect().catch((err) => {
      // Do not crash the process: the health endpoint reports degraded state.
       
      console.error('[prisma] initial connect failed:', (err as Error).message);
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
