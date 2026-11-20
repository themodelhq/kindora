import type { CampaignDetail, CampaignSummary, Circle, Donation, ImpactSummary, LedgerTransactionView, Notification, Organization, PaymentMethod, User } from '@/types/api';

/**
 * Demo dataset powering the offline UI preview (VITE_DEMO_MODE=1).
 * Clearly scoped to demo builds only; production deployments use the real API.
 * Figures here are illustrative sample content, not real fundraising data.
 */

const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86400000).toISOString();
const isoFuture = (days: number) => new Date(now + days * 86400000).toISOString();

export const DEMO_USERS: Record<string, User> = {
  donor: { id: 'demo-donor', email: 'demo@kindora.org', firstName: 'Amara', lastName: 'Okafor', role: 'USER', emailVerified: true },
  organizer: { id: 'demo-org2', email: 'organizer@kindora.org', firstName: 'Daniel', lastName: 'Mensah', role: 'USER', emailVerified: true },
  admin: { id: 'demo-admin', email: 'admin@kindora.org', firstName: 'Kora', lastName: 'Admin', role: 'ADMIN', emailVerified: true },
};

const c1: CampaignDetail = {
  id: 'c1', slug: 'clean-water-for-obosi', title: 'Clean water for Obosi community', status: 'ACTIVE',
  excerpt: 'Two solar boreholes for 4,000 people who currently walk 3km for unsafe water.',
  coverImageUrl: undefined, targetAmount: '12000000', raisedAmount: '8345000', donorCount: 412,
  currency: 'NGN', deadline: isoFuture(24), country: 'Nigeria', isFeatured: true, createdAt: iso(40),
  category: { slug: 'water', name: 'Water & Sanitation' }, createdBy: { firstName: 'Daniel', lastName: 'Mensah' },
  story: 'In Obosi, Anambra State, families wake before dawn to queue at a stream that serves livestock and households alike.\n\nWe are Habab Water Initiative, a registered nonprofit (CAC/2019/512433). Last year we completed one borehole in Nnewi; waterborne clinic visits there fell 61% in six months.\n\nThis campaign builds two solar-powered boreholes with 10,000-litre storage tanks. Every naira is tracked: our expense ledger is public, verified by the KINDORA platform.\n\n- Borehole drilling & casing: ₦4,800,000\n- Solar pumping systems (2): ₦3,600,000\n- Storage tanks & taps: ₦2,100,000\n- Water quality testing & training: ₦1,500,000\n\nThe community water committee will maintain the boreholes with a small monthly levy. Thank you for moving goodness forward.',
  videoUrl: null, city: 'Obosi', viewCount: 12456, allowComments: true, publishedAt: iso(38),
  beneficiary: { name: 'Obosi Community Water Committee', type: 'COMMUNITY' },
  media: [], matchingPools: [{ id: 'mp1', name: 'Wells of Hope Match', totalCommitted: '1000000', matchedAmount: '640000', matchRatio: 100, status: 'ACTIVE' }],
};

const c2: CampaignDetail = {
  id: 'c2', slug: 'books-and-desks-ilorin', title: 'Books and desks for Ilorin pupils', status: 'ACTIVE',
  excerpt: '300 pupils learn on the floor. Help us furnish two classrooms and a small library.',
  targetAmount: '4500000', raisedAmount: '1875000', donorCount: 203, currency: 'NGN',
  deadline: isoFuture(41), country: 'Nigeria', createdAt: iso(22),
  category: { slug: 'education', name: 'Education' }, createdBy: { firstName: 'Fatima', lastName: 'Bello' },
  story: 'Government Day Secondary School in Ilorin runs at double shift because classrooms cannot hold the enrolled pupils.\n\nOur teachers association (registered 2018) is raising funds for 150 two-seater desks, 400 textbooks and shelving for a reading corner.\n\nWe publish every receipt here. Quotes from three suppliers are attached as documents for transparency.',
  city: 'Ilorin', viewCount: 5230, allowComments: true, publishedAt: iso(21),
  beneficiary: { name: 'Ilorin Teachers Association', type: 'ORGANIZATION' },
  media: [], matchingPools: [],
};

const c3: CampaignDetail = {
  id: 'c3', slug: 'baby-essentials-lagos', title: 'Baby essentials for 80 newborns', status: 'ACTIVE',
  excerpt: 'Mama-put kits with blankets, mosquito nets and postnatal basics for low-income mothers.',
  targetAmount: '2800000', raisedAmount: '2654000', donorCount: 350, currency: 'NGN',
  deadline: isoFuture(9), country: 'Nigeria', createdAt: iso(35),
  category: { slug: 'children', name: 'Children & Family' }, createdBy: { firstName: 'Adaeze', lastName: 'Nwosu' },
  story: 'Every month, roughly eighty babies are born to mothers who cannot afford essentials at three partner clinics in Lagos.\n\nOur kit includes two blankets, a treated mosquito net, sanitary supplies and a follow-up visit voucher. Kits cost ₦31,000 each at our vetted suppliers.\n\nWe are 95% funded — 15 kits to go.',
  city: 'Lagos', viewCount: 9110, allowComments: true, publishedAt: iso(33),
  beneficiary: { name: 'Mother & Child Care Network', type: 'ORGANIZATION' }, media: [], matchingPools: [],
};

const c4: CampaignDetail = {
  id: 'c4', slug: 'mangrove-planting-bonny', title: 'Plant 25,000 mangroves in Bonny', status: 'ACTIVE',
  excerpt: 'Restoring the shoreline that protects our fishing town from storm surge.',
  targetAmount: '6000000', raisedAmount: '2240000', donorCount: 158, currency: 'NGN',
  deadline: isoFuture(60), country: 'Nigeria', createdAt: iso(15),
  category: { slug: 'environment', name: 'Environment' }, createdBy: { firstName: 'Sika', lastName: 'Asante' },
  story: 'Mangroves are our sea wall, fish nursery and carbon bank. Dredging and oil damage have cleared 40% of Bonny Island\'s fringe.\n\nWe run a nursery with 30 local youths, planting 2,500 seedlings a week. Each donation covers a seedling, bamboo guard and two years of monitoring at ₦240.',
  city: 'Bonny', viewCount: 3420, allowComments: true, publishedAt: iso(14),
  beneficiary: { name: 'Bonny Coastal Trust', type: 'COMMUNITY' }, media: [], matchingPools: [],
};

const c5: CampaignDetail = {
  id: 'c5', slug: 'mobile-clinic-karamoja', title: 'Mobile clinic for Karamoja villages', status: 'ACTIVE',
  excerpt: 'A 4x4 clinic serving 12 villages with no road access to care.',
  targetAmount: '25000', raisedAmount: '4100', donorCount: 88, currency: 'USD',
  deadline: isoFuture(75), country: 'Kenya', createdAt: iso(10),
  category: { slug: 'health', name: 'Medical & Health' }, createdBy: { firstName: 'Grace', lastName: 'Achieng' },
  story: 'The nearest hospital is 140km from Karamoja villages. Pregnant women deliver on the road.\n\nOur team of four nurses needs a used 4x4 fitted as a clinic: ₦... actually $19,800 for the vehicle, $3,400 for equipment, $1,800 for fuel for the first year. Every fuel receipt will be posted here.',
  city: 'Moroto', viewCount: 2210, allowComments: true, publishedAt: iso(9),
  beneficiary: { name: 'Karamoja Health Reach', type: 'ORGANIZATION' }, media: [], matchingPools: [],
};

const c6: CampaignDetail = {
  id: 'c6', slug: 'feed-a-family-december', title: 'Feed a family this December', status: 'COMPLETED',
  excerpt: '1,000 food packs delivered. Thank you, everyone.',
  targetAmount: '5000000', raisedAmount: '6125000', donorCount: 701, currency: 'NGN',
  deadline: iso(30), country: 'Nigeria', createdAt: iso(90),
  category: { slug: 'community', name: 'Community' }, createdBy: { firstName: 'Daniel', lastName: 'Mensah' },
  story: 'This campaign is complete. 1,012 food packs reached families across five communities. The final expense report is published on the impact page.',
  city: 'Abuja', viewCount: 15002, allowComments: true, publishedAt: iso(88),
  beneficiary: null, media: [], matchingPools: [],
};

export const DEMO_CAMPAIGNS: CampaignDetail[] = [c1, c2, c3, c4, c5, c6];

export const DEMO_ORGANIZATION: Organization = {
  id: 'org1', slug: 'habab-water-initiative', name: 'Habab Water Initiative',
  description: 'Registered nonprofit building solar water infrastructure across Anambra State, Nigeria.',
  website: 'https://habab.example.org', country: 'Nigeria', status: 'VERIFIED',
  campaigns: [c1, c6].map((c) => ({ ...c, story: '', media: [], matchingPools: [], viewCount: c.viewCount, allowComments: true })),
  members: [{ user: DEMO_USERS.organizer, role: 'OWNER' }],
};

export const DEMO_CIRCLES: Circle[] = [
  {
    id: 'circle1', slug: 'lagos-sunday-givers', name: 'Lagos Sunday Givers', description: 'Seven friends who pool ₦100k every month for one verified cause.',
    privacy: 'PUBLIC', goalAmount: '1200000', currency: 'NGN', createdAt: iso(60),
    members: [
      { user: DEMO_USERS.donor, role: 'OWNER' },
      { user: DEMO_USERS.organizer, role: 'MEMBER' },
    ],
    contributions: [
      { id: 'cc1', amount: '100000', kind: 'DONATION', user: DEMO_USERS.donor },
      { id: 'cc2', amount: '100000', kind: 'DONATION', user: DEMO_USERS.organizer },
    ],
  },
  {
    id: 'circle2', slug: 'class-of-2009-fund', name: 'Class of 2009 Fund', description: 'Alumni fund for school infrastructure.',
    privacy: 'PRIVATE', inviteCode: 'C209', goalAmount: '3000000', currency: 'NGN', createdAt: iso(120),
    members: [{ user: DEMO_USERS.organizer, role: 'OWNER' }], contributions: [],
  },
];

export const DEMO_NOTIFICATIONS: Notification[] = [
  { id: 'n1', type: 'DONATION_RECEIPT', title: 'Thank you for giving', body: 'Your ₦25,000 donation to "Clean water for Obosi community" was confirmed.', createdAt: iso(1), readAt: null },
  { id: 'n2', type: 'CAMPAIGN_UPDATE', title: 'New update: Clean water for Obosi', body: 'Drilling started on the second borehole this morning.', createdAt: iso(3), readAt: null },
];

export const DEMO_IMPACT: ImpactSummary = {
  totalDonations: 1984,
  totalRefunded: 7,
  totalTipsMinor: '48650000',
  ledger: { ledgerAccounts: 14, ledgerTransactions: 1991, successfulDonations: 1984 },
  recentDaily: Array.from({ length: 14 }, (_, i) => ({
    date: new Date(now - i * 86400000).toISOString().slice(0, 10),
    donationCount: 30 + Math.round(Math.abs(Math.sin(i) * 40)),
    donationAmount: (900000 + Math.round(Math.abs(Math.cos(i)) * 2100000)).toString(),
    currency: 'NGN',
  })),
};

export const DEMO_LEDGER: LedgerTransactionView[] = [
  { id: 'lt1', reference: 'donation:demo1', type: 'DONATION', description: 'Donation KDO-8H2K4M9A via Paystack', postedAt: iso(1),
    entries: [{ direction: 'DEBIT', amount: '2500000', currency: 'NGN' }, { direction: 'CREDIT', amount: '2500000', currency: 'NGN' }] },
  { id: 'lt2', reference: 'match:mp1:demo1', type: 'MATCH', description: 'Matched donation KDO-8H2K4M9A', postedAt: iso(1),
    entries: [{ direction: 'DEBIT', amount: '2500000', currency: 'NGN' }, { direction: 'CREDIT', amount: '2500000', currency: 'NGN' }] },
  { id: 'lt3', reference: 'withdrawal:demo-w1', type: 'WITHDRAWAL', description: 'Payout WDR-K3M9Q2XP', postedAt: iso(5),
    entries: [{ direction: 'DEBIT', amount: '1500000', currency: 'NGN' }, { direction: 'CREDIT', amount: '1500000', currency: 'NGN' }] },
];

export const DEMO_PAYMENT_METHODS: PaymentMethod[] = [
  { provider: 'PAYSTACK', enabled: true },
  { provider: 'FLUTTERWAVE', enabled: true },
  { provider: 'STRIPE', enabled: true },
  { provider: 'PAYPAL', enabled: true },
];

export const DEMO_DONATION_STORE: Donation[] = [];
