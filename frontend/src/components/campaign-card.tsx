import { Link } from 'react-router-dom';
import { MapPin, Users, Clock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatMoney, progressPercent } from '@/lib/money';
import { daysUntil, formatDate } from '@/lib/utils';
import { CATEGORY_META } from '@/components/campaign-category';
import type { CampaignSummary } from '@/types/api';

const GRADIENTS = [
  'from-emerald-500 to-teal-600',
  'from-amber-400 to-orange-500',
  'from-teal-400 to-cyan-600',
  'from-lime-500 to-emerald-600',
  'from-orange-400 to-rose-500',
];

function hashIndex(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % GRADIENTS.length;
}

export function CampaignCard({ campaign }: { campaign: CampaignSummary }) {
  const pct = progressPercent(campaign.raisedAmount, campaign.targetAmount);
  const days = daysUntil(campaign.deadline);
  const meta = campaign.category ? CATEGORY_META[campaign.category.slug] : undefined;
  return (
    <Link to={`/campaigns/${campaign.slug}`} className="group block focus-visible:outline-none" aria-label={campaign.title}>
      <Card className="h-full overflow-hidden transition-all group-hover:-translate-y-0.5 group-hover:shadow-lift group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <div className={`relative flex h-40 items-end bg-gradient-to-br ${GRADIENTS[hashIndex(campaign.id + campaign.title)]} p-4`}>
          {meta && <meta.icon className="absolute right-3 top-3 h-7 w-7 text-white/80" aria-hidden="true" />}
          {campaign.isFeatured && <Badge variant="accent" className="absolute left-3 top-3">Featured</Badge>}
          <span className="rounded-lg bg-white/90 px-2 py-1 text-xs font-semibold text-primary backdrop-blur">
            {meta?.name ?? campaign.category?.name ?? 'Cause'}
          </span>
        </div>
        <CardContent className="space-y-3 p-4">
          <h3 className="line-clamp-2 min-h-[2.6rem] font-bold leading-snug group-hover:text-primary">{campaign.title}</h3>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-bold text-primary">{formatMoney(campaign.raisedAmount, campaign.currency)}</span>
              <span className="text-xs font-medium text-muted-foreground">
                {pct}% of {formatMoney(campaign.targetAmount, campaign.currency)}
              </span>
            </div>
            <Progress value={pct} aria-label={`${pct}% funded`} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />{campaign.donorCount.toLocaleString()} donors</span>
            {campaign.country && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{campaign.country}</span>}
            {days !== null && days > 0 && (
              <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{days} days left</span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export function CampaignCardSkeleton() {
  return (
    <Card className="overflow-hidden">
      <div className="h-40 animate-pulse bg-muted" />
      <CardContent className="space-y-3 p-4">
        <div className="h-5 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  );
}

export function CampaignMeta({ campaign }: { campaign: CampaignSummary }) {
  return (
    <span className="text-xs text-muted-foreground">
      Created {formatDate(campaign.createdAt)} · {campaign.donorCount.toLocaleString()} donors
    </span>
  );
}
