/**
 * KINDORA database seed.
 * Creates platform bootstrap data: admin + demo users, categories, a verified
 * organization, sample campaigns with LEDGER-CONSISTENT donation history
 * (every seeded donation posts balanced double-entry transactions), a
 * matching pool, a settled withdrawal, a circle and platform stats.
 *
 * Idempotent: safe to run multiple times (upserts by email/slug).
 *
 * Run: npm run prisma:seed   (DATABASE_URL must point at the database)
 */
import { PrismaClient, LedgerDirection, LedgerTxnType, LedgerAccountType, PaymentProvider, CampaignStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const CATEGORIES = [
  { slug: 'education', name: 'Education', icon: 'GraduationCap' },
  { slug: 'health', name: 'Medical & Health', icon: 'HeartPulse' },
  { slug: 'water', name: 'Water & Sanitation', icon: 'Droplets' },
  { slug: 'environment', name: 'Environment', icon: 'Sprout' },
  { slug: 'emergency', name: 'Emergency Relief', icon: 'ShieldAlert' },
  { slug: 'children', name: 'Children & Family', icon: 'Baby' },
  { slug: 'community', name: 'Community', icon: 'Users' },
  { slug: 'animals', name: 'Animals', icon: 'PawPrint' },
  { slug: 'sports', name: 'Sports', icon: 'Trophy' },
  { slug: 'arts', name: 'Arts & Culture', icon: 'Palette' },
  { slug: 'tech', name: 'Technology Access', icon: 'Laptop' },
  { slug: 'housing', name: 'Housing', icon: 'Home' },
];

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86400000);
}

function ref(prefix: string, n: number): string {
  return `${prefix}-SEED${String(n).padStart(4, '0')}`;
}

async function ensureAccount(
  code: string,
  name: string,
  type: LedgerAccountType,
  currency: string,
  campaignId?: string,
) {
  return prisma.ledgerAccount.upsert({
    where: { code },
    create: { code, name, type, currency, ...(campaignId ? { campaignId } : {}) },
    update: {},
  });
}

/** Posts a balanced ledger transaction (seed variant of LedgerService). */
async function postTransaction(input: {
  reference: string;
  type: LedgerTxnType;
  description: string;
  entries: { code: string; name: string; type: LedgerAccountType; currency: string; campaignId?: string; direction: LedgerDirection; amount: bigint }[];
}) {
  const byCurrency = new Map<string, { debit: bigint; credit: bigint }>();
  for (const e of input.entries) {
    const acc = byCurrency.get(e.currency) ?? { debit: 0n, credit: 0n };
    if (e.direction === 'DEBIT') acc.debit += e.amount;
    else acc.credit += e.amount;
    byCurrency.set(e.currency, acc);
  }
  for (const [currency, sums] of byCurrency) {
    if (sums.debit !== sums.credit) throw new Error(`Seed ledger imbalance ${input.reference} (${currency})`);
  }
  const existing = await prisma.ledgerTransaction.findUnique({ where: { reference: input.reference } });
  if (existing) return existing;
  const txn = await prisma.ledgerTransaction.create({
    data: { reference: input.reference, type: input.type, description: input.description },
  });
  for (const e of input.entries) {
    if (e.amount === 0n) continue;
    const account = await ensureAccount(e.code, e.name, e.type, e.currency, e.campaignId);
    await prisma.ledgerEntry.create({
      data: { transactionId: txn.id, accountId: account.id, direction: e.direction, amount: e.amount, currency: e.currency },
    });
  }
  return txn;
}

async function seedDonationSuccess(opts: {
  n: number;
  campaignId: string;
  currency: string;
  amountMinor: bigint;
  donorUserId?: string;
  guestName?: string;
  guestEmail?: string;
  isAnonymous?: boolean;
  message?: string;
  daysAgo: number;
}) {
  const existing = await prisma.donation.findUnique({ where: { publicRef: ref('KDO', opts.n) } });
  if (existing) return;
  const succeededAt = new Date(Date.now() - opts.daysAgo * 86400000);
  await prisma.donation.create({
    data: {
      publicRef: ref('KDO', opts.n),
      campaignId: opts.campaignId,
      donorUserId: opts.donorUserId,
      guestEmail: opts.guestEmail,
      guestName: opts.guestName,
      isAnonymous: opts.isAnonymous ?? false,
      amount: opts.amountMinor,
      currency: opts.currency,
      tipAmount: 0n,
      totalCharged: opts.amountMinor,
      chargeCurrency: opts.currency,
      status: 'SUCCEEDED',
      provider: PaymentProvider.MOCK,
      providerReference: `mock_${ref('KDO', opts.n)}`,
      message: opts.message,
      receiptNumber: `RCP-SEED${String(opts.n).padStart(4, '0')}`,
      succeededAt,
      createdAt: succeededAt,
    },
  });
  const cur = opts.currency;
  await postTransaction({
    reference: `donation:seed-${opts.n}`,
    type: LedgerTxnType.DONATION,
    description: `Seed donation ${ref('KDO', opts.n)}`,
    entries: [
      { code: `1100:CLEARING:${cur}`, name: `Provider clearing (${cur})`, type: 'ASSET', currency: cur, direction: 'DEBIT', amount: opts.amountMinor },
      { code: `2000:CAMPAIGN:${opts.campaignId}:${cur}`, name: 'Campaign payable', type: 'LIABILITY', currency: cur, campaignId: opts.campaignId, direction: 'CREDIT', amount: opts.amountMinor },
    ],
  });
  await prisma.campaign.update({
    where: { id: opts.campaignId },
    data: { raisedAmount: { increment: opts.amountMinor }, donorCount: { increment: 1 } },
  });
}

async function main() {
  const isProd = process.env.NODE_ENV === 'production';

  // PRODUCTION SAFETY: demo/dev seed data must never reach a production
  // database. Production bootstrap uses `npm run bootstrap:admin` instead.
  if (isProd && process.env.SEED_FORCE !== '1') {
    console.error(
      'REFUSING to seed: NODE_ENV=production without SEED_FORCE=1.\n' +
        'This seed creates demo users, demo campaigns and fabricated donations.\n' +
        'For production administrator creation use: npm run bootstrap:admin\n' +
        '(If you truly intend to wipe demo data into production, set SEED_FORCE=1.)',
    );
    process.exit(1);
  }

  // NO DEFAULT ADMIN PASSWORD: the operator must supply one explicitly.
  const seedPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!seedPassword) {
    console.error(
      'REFUSING to seed: SEED_ADMIN_PASSWORD is required.\n' +
        'Never ship a known default administrator password.\n' +
        'Generate one, e.g.: openssl rand -base64 24, then: SEED_ADMIN_PASSWORD=... npm run prisma:seed',
    );
    process.exit(1);
  }
  if (seedPassword.length < 12 || !/[A-Z]/.test(seedPassword) || !/[0-9]/.test(seedPassword)) {
    console.error('REFUSING to seed: SEED_ADMIN_PASSWORD must be at least 12 characters with an uppercase letter and a digit.');
    process.exit(1);
  }

  const demoEnabled = process.env.SEED_DEMO === '1';
  console.log(`Seeding KINDORA... (env=${process.env.NODE_ENV ?? 'development'}, demoData=${demoEnabled})`);

  // ---------- users ----------
  const password = await bcrypt.hash(seedPassword, 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@kindora.com' },
    update: {},
    create: {
      email: 'admin@kindora.com',
      passwordHash: password,
      firstName: 'Kora',
      lastName: 'Admin',
      role: 'ADMIN',
      emailVerifiedAt: new Date(),
      notificationPreference: { create: {} },
    },
  });
  const organizer = await prisma.user.upsert({
    where: { email: 'organizer@kindora.com' },
    update: {},
    create: {
      email: 'organizer@kindora.com',
      passwordHash: password,
      firstName: 'Daniel',
      lastName: 'Mensah',
      role: 'USER',
      emailVerifiedAt: new Date(),
      notificationPreference: { create: {} },
    },
  });
  const donor = await prisma.user.upsert({
    where: { email: 'donor@kindora.com' },
    update: {},
    create: {
      email: 'donor@kindora.com',
      passwordHash: password,
      firstName: 'Amara',
      lastName: 'Okafor',
      role: 'USER',
      emailVerifiedAt: new Date(),
      notificationPreference: { create: {} },
    },
  });
  console.log('users ok', { admin: admin.email, organizer: organizer.email, donor: donor.email });

  // ---------- categories ----------
  const categoryBySlug = new Map<string, string>();
  for (const c of CATEGORIES) {
    const row = await prisma.category.upsert({
      where: { slug: c.slug },
      update: {},
      create: c,
    });
    categoryBySlug.set(c.slug, row.id);
  }
  console.log('categories ok');

  // ---------- demo data gate ----------
  // Everything below (organization, campaigns, donations, ledger entries,
  // withdrawal, circle, notifications) is FABRICATED demonstration content.
  // It is inserted only when explicitly requested.
  if (!demoEnabled) {
    console.log('Demo data skipped (set SEED_DEMO=1 to insert demonstration campaigns and donations).');
    console.log(`Admin login: admin@kindora.com (password from SEED_ADMIN_PASSWORD - rotate after first login).`);
    return;
  }

  // ---------- organization ----------
  const org = await prisma.organization.upsert({
    where: { slug: 'habab-water-initiative' },
    update: { status: 'VERIFIED', verifiedAt: new Date() },
    create: {
      slug: 'habab-water-initiative',
      name: 'Habab Water Initiative',
      description: 'Registered nonprofit building solar water infrastructure across Anambra State, Nigeria.',
      country: 'Nigeria',
      registrationNumber: 'CAC/2019/512433',
      status: 'VERIFIED',
      verifiedAt: new Date(),
      ownerUserId: organizer.id,
    },
  });
  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: organizer.id } },
    update: { role: 'OWNER' },
    create: { organizationId: org.id, userId: organizer.id, role: 'OWNER' },
  });

  // ---------- campaigns ----------
  const campaigns = [
    {
      slug: 'clean-water-for-obosi',
      title: 'Clean water for Obosi community',
      excerpt: 'Two solar boreholes for 4,000 people who currently walk 3km for unsafe water.',
      story:
        'In Obosi, Anambra State, families wake before dawn to queue at a stream that serves livestock and households alike.\n\nWe are Habab Water Initiative, a registered nonprofit (CAC/2019/512433). Last year we completed one borehole in Nnewi; waterborne clinic visits there fell 61% in six months.\n\nThis campaign builds two solar-powered boreholes with 10,000-litre storage tanks. Every naira is tracked: our expense ledger is public, verified by the KINDORA platform.\n\n- Borehole drilling & casing\n- Solar pumping systems (2)\n- Storage tanks & taps\n- Water quality testing & training\n\nThe community water committee will maintain the boreholes with a small monthly levy. Thank you for moving goodness forward.',
      target: 12000000n,
      category: 'water',
      status: 'ACTIVE',
      featured: true,
      daysAgoCreated: 40,
      deadlineInDays: 24,
    },
    {
      slug: 'books-and-desks-ilorin',
      title: 'Books and desks for Ilorin pupils',
      excerpt: '300 pupils learn on the floor. Help us furnish two classrooms and a small library.',
      story:
        'Government Day Secondary School in Ilorin runs at double shift because classrooms cannot hold the enrolled pupils.\n\nOur teachers association (registered 2018) is raising funds for 150 two-seater desks, 400 textbooks and shelving for a reading corner.\n\nWe publish every receipt here. Quotes from three suppliers are attached as documents for transparency.',
      target: 4500000n,
      category: 'education',
      status: 'ACTIVE',
      featured: false,
      daysAgoCreated: 22,
      deadlineInDays: 41,
    },
    {
      slug: 'baby-essentials-lagos',
      title: 'Baby essentials for 80 newborns',
      excerpt: 'Mama-put kits with blankets, mosquito nets and postnatal basics for low-income mothers.',
      story:
        'Every month, roughly eighty babies are born to mothers who cannot afford essentials at three partner clinics in Lagos.\n\nOur kit includes two blankets, a treated mosquito net, sanitary supplies and a follow-up visit voucher. Kits cost a fixed price at our vetted suppliers.\n\nWe are 95% funded — the last kits will be delivered this month.',
      target: 2800000n,
      category: 'children',
      status: 'ACTIVE',
      featured: false,
      daysAgoCreated: 35,
      deadlineInDays: 9,
    },
    {
      slug: 'mangrove-planting-bonny',
      title: 'Plant 25,000 mangroves in Bonny',
      excerpt: 'Restoring the shoreline that protects our fishing town from storm surge.',
      story:
        'Mangroves are our sea wall, fish nursery and carbon bank. Dredging and industrial damage have cleared 40% of Bonny Island\'s fringe.\n\nWe run a nursery with 30 local youths, planting 2,500 seedlings a week. Each donation covers a seedling, bamboo guard and two years of monitoring.',
      target: 6000000n,
      category: 'environment',
      status: 'ACTIVE',
      featured: false,
      daysAgoCreated: 15,
      deadlineInDays: 60,
    },
    {
      slug: 'mobile-clinic-karamoja',
      title: 'Mobile clinic for Karamoja villages',
      excerpt: 'A 4x4 clinic serving 12 villages with no road access to care.',
      story:
        'The nearest hospital is 140km from Karamoja villages. Pregnant women deliver on the road.\n\nOur team of four nurses needs a used 4x4 fitted as a clinic: vehicle, equipment and fuel for the first year. Every fuel receipt will be posted here.',
      target: 2500000n,
      currency: 'USD',
      targetMinor: 25000n,
      category: 'health',
      status: 'ACTIVE',
      featured: false,
      daysAgoCreated: 10,
      deadlineInDays: 75,
    },
    {
      slug: 'feed-a-family-december',
      title: 'Feed a family this December',
      excerpt: '1,000 food packs delivered. Thank you, everyone.',
      story:
        'This campaign is complete. 1,012 food packs reached families across five communities. The final expense report is published on the impact page.',
      target: 5000000n,
      category: 'community',
      status: 'COMPLETED',
      featured: false,
      daysAgoCreated: 90,
      deadlineInDays: -30,
    },
  ];

  const campaignIds: Record<string, string> = {};
  for (const c of campaigns) {
    const currency = c.currency ?? 'NGN';
    const target = c.targetMinor ?? c.target;
    const created = new Date(Date.now() - c.daysAgoCreated * 86400000);
    const row = await prisma.campaign.upsert({
      where: { slug: c.slug },
      update: { status: c.status as CampaignStatus, isFeatured: c.featured },
      create: {
        slug: c.slug,
        title: c.title,
        excerpt: c.excerpt,
        story: c.story,
        status: c.status as CampaignStatus,
        type: c.slug === 'clean-water-for-obosi' ? 'ORGANIZATION' : 'INDIVIDUAL',
        targetAmount: target,
        currency,
        deadline: daysFromNow(c.deadlineInDays),
        country: currency === 'USD' ? 'Kenya' : 'Nigeria',
        city: currency === 'USD' ? 'Moroto' : undefined,
        categoryId: categoryBySlug.get(c.category)!,
        createdById: organizer.id,
        organizationId: c.slug === 'clean-water-for-obosi' ? org.id : null,
        isFeatured: c.featured,
        publishedAt: created,
        createdAt: created,
        viewCount: Math.floor(2000 + c.daysAgoCreated * 137),
      },
    });
    campaignIds[c.slug] = row.id;
  }
  console.log('campaigns ok');

  // ---------- donations (ledger-consistent) ----------
  let n = 1;
  const donorSpread = [
    { amount: 2500000n, daysAgo: 1, donorUserId: donor.id, message: 'For the boreholes — God bless.' },
    { amount: 500000n, daysAgo: 1, isAnonymous: true },
    { amount: 100000n, daysAgo: 2, guestName: 'Chinedu E.', guestEmail: 'chinedu@example.com', message: 'Keep going!' },
    { amount: 250000n, daysAgo: 3, donorUserId: donor.id },
    { amount: 1000000n, daysAgo: 4, guestName: 'Fatima S.', guestEmail: 'fatima@example.com' },
    { amount: 75000n, daysAgo: 5, isAnonymous: true },
    { amount: 500000n, daysAgo: 6, guestName: 'Bola A.', guestEmail: 'bola@example.com' },
    { amount: 300000n, daysAgo: 7, donorUserId: donor.id, message: 'Water is life' },
    { amount: 200000n, daysAgo: 8, guestName: 'Emeka O.', guestEmail: 'emeka@example.com' },
    { amount: 150000n, daysAgo: 9, isAnonymous: true },
  ];
  for (const [slug, id] of Object.entries(campaignIds)) {
    const currency = slug === 'mobile-clinic-karamoja' ? 'USD' : 'NGN';
    for (const d of donorSpread.slice(0, slug === 'feed-a-family-december' ? 10 : 7)) {
      const amount = currency === 'USD' ? d.amount / 10n : d.amount;
      await seedDonationSuccess({
        n: n++,
        campaignId: id,
        currency,
        amountMinor: amount,
        donorUserId: d.donorUserId,
        guestName: d.guestName,
        guestEmail: d.guestEmail,
        isAnonymous: d.isAnonymous,
        message: d.message,
        daysAgo: d.daysAgo,
      });
    }
  }

  // ---------- matching pool for clean water ----------
  const pool = await prisma.matchingPool.upsert({
    where: { id: 'seed-pool-1' },
    update: {},
    create: {
      id: 'seed-pool-1',
      campaignId: campaignIds['clean-water-for-obosi'],
      sponsorUserId: admin.id,
      name: 'Wells of Hope Match',
      totalCommitted: 1000000n,
      matchedAmount: 640000n,
      matchRatio: 100,
      status: 'ACTIVE',
    },
  });
  await ensureAccount(`2400:MATCH_POOL:${pool.id}`, 'Matching pool (sponsor funds held)', 'LIABILITY', 'NGN');

  // ---------- settled withdrawal for clean water ----------
  const withdrawal = await prisma.withdrawal.findUnique({ where: { publicRef: ref('WDR', 1) } });
  if (!withdrawal) {
    const w = await prisma.withdrawal.create({
      data: {
        publicRef: ref('WDR', 1),
        campaignId: campaignIds['clean-water-for-obosi'],
        requestedById: organizer.id,
        amount: 1500000n,
        feeAmount: 0n,
        netAmount: 1500000n,
        currency: 'NGN',
        method: 'BANK',
        destination: { accountName: 'Habab Water Initiative', bankName: 'GTBank', accountNumber: '0123456789' },
        status: 'PAID',
        reviewedById: admin.id,
        reviewedAt: new Date(Date.now() - 4 * 86400000),
        providerTransferRef: 'seed-transfer-001',
        paidAt: new Date(Date.now() - 4 * 86400000),
        createdAt: new Date(Date.now() - 5 * 86400000),
      },
    });
    await postTransaction({
      reference: `withdrawal:${w.id}`,
      type: LedgerTxnType.WITHDRAWAL,
      description: `Payout ${w.publicRef}`,
      entries: [
        { code: `2000:CAMPAIGN:${campaignIds['clean-water-for-obosi']}:NGN`, name: 'Campaign payable', type: 'LIABILITY', currency: 'NGN', campaignId: campaignIds['clean-water-for-obosi'], direction: 'DEBIT', amount: 1500000n },
        { code: '1100:CLEARING:NGN', name: 'Provider clearing (NGN)', type: 'ASSET', currency: 'NGN', direction: 'CREDIT', amount: 1500000n },
      ],
    });
  }

  // ---------- circle ----------
  const circle = await prisma.circle.upsert({
    where: { slug: 'lagos-sunday-givers' },
    update: {},
    create: {
      slug: 'lagos-sunday-givers',
      name: 'Lagos Sunday Givers',
      description: 'Seven friends who pool monthly for one verified cause.',
      privacy: 'PUBLIC',
      goalAmount: 1200000n,
      currency: 'NGN',
      createdById: donor.id,
    },
  });
  await prisma.circleMember.upsert({
    where: { circleId_userId: { circleId: circle.id, userId: donor.id } },
    update: { role: 'OWNER' },
    create: { circleId: circle.id, userId: donor.id, role: 'OWNER' },
  });
  await prisma.circleMember.upsert({
    where: { circleId_userId: { circleId: circle.id, userId: organizer.id } },
    update: {},
    create: { circleId: circle.id, userId: organizer.id, role: 'MEMBER' },
  });
  const cc1 = await prisma.circleContribution.findFirst({ where: { circleId: circle.id, userId: donor.id } });
  if (!cc1) {
    await prisma.circleContribution.create({
      data: { circleId: circle.id, userId: donor.id, amount: 100000n, currency: 'NGN', kind: 'DONATION', note: 'Kick-off gift' },
    });
    await prisma.circleContribution.create({
      data: { circleId: circle.id, userId: organizer.id, amount: 100000n, currency: 'NGN', kind: 'PLEDGE' },
    });
  }

  // ---------- platform stats (last 14 days) ----------
  const donations = await prisma.donation.findMany({ where: { status: 'SUCCEEDED' }, select: { amount: true, tipAmount: true, currency: true, succeededAt: true } });
  for (let i = 0; i < 14; i++) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    const dayDonations = donations.filter((d) => d.succeededAt && d.succeededAt.toDateString() === day.toDateString());
    await prisma.platformStatDaily.upsert({
      where: { date: day },
      update: { donationCount: dayDonations.length, donationAmount: dayDonations.reduce((a, d) => a + d.amount, 0n), tipAmount: dayDonations.reduce((a, d) => a + d.tipAmount, 0n) },
      create: {
        date: day,
        currency: 'NGN',
        donationCount: dayDonations.length,
        donationAmount: dayDonations.reduce((a, d) => a + d.amount, 0n),
        tipAmount: dayDonations.reduce((a, d) => a + d.tipAmount, 0n),
        newUsers: i === 0 ? 3 : 0,
        newCampaigns: i === 0 ? 1 : 0,
      },
    });
  }

  // ---------- notifications for the demo donor ----------
  const notifCount = await prisma.notification.count({ where: { userId: donor.id } });
  if (notifCount === 0) {
    await prisma.notification.createMany({
      data: [
        { userId: donor.id, type: 'DONATION_RECEIPT', title: 'Thank you for giving', body: 'Your donation to "Clean water for Obosi community" was confirmed.' },
        { userId: organizer.id, type: 'DONATION_RECEIVED', title: 'New donation received', body: 'Your campaign "Clean water for Obosi community" just received a donation.' },
      ],
    });
  }

  console.log('Seed complete.');
  console.log('Admin login: admin@kindora.com (password from SEED_ADMIN_PASSWORD - rotate after first login).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
