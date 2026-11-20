import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Building2, Globe, ShieldCheck, Users } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { EmptyState } from '@/components/shared';
import { CampaignCard, CampaignCardSkeleton } from '@/components/campaign-card';
import { useOrganization } from '@/api/hooks';
import { initials } from '@/lib/utils';
import type { Organization } from '@/types/api';

function roleVariant(role: string): BadgeProps['variant'] {
  if (role === 'OWNER') return 'default';
  if (role === 'ADMIN') return 'secondary';
  if (role === 'MANAGER') return 'accent';
  return 'muted';
}

export default function OrganizationDetailPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();

  const { data: organization, isLoading, isError } = useOrganization(slug);
  const campaigns = useMemo(() => organization?.campaigns ?? [], [organization]);
  const members = organization?.members ?? [];

  if (isLoading) {
    return (
      <div className="container space-y-6 py-8 md:py-12" aria-busy="true">
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <CampaignCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !organization) {
    return (
      <div className="container py-16">
        <EmptyState
          icon={Building2}
          title="Organization not found"
          description="This organization may have been removed or the link is incorrect."
          action={
            <Button onClick={() => navigate('/organizations')}>Back to organizations</Button>
          }
        />
      </div>
    );
  }

  const logoFallback = organization.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');

  const isVerified = organization.status === 'VERIFIED';

  return (
    <div className="container space-y-8 py-8 md:py-12">
      {/* Header card */}
      <Card className="rounded-2xl shadow-soft">
        <CardContent className="space-y-4 p-6 md:p-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-start">
            <Avatar className="h-20 w-20 border shadow-soft">
              {organization.logoUrl && <AvatarImage src={organization.logoUrl} alt={`${organization.name} logo`} />}
              <AvatarFallback className="bg-secondary text-xl font-bold">{logoFallback}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-extrabold tracking-tight md:text-4xl">{organization.name}</h1>
                <Badge variant={isVerified ? 'success' : organization.status === 'PENDING' ? 'warning' : 'muted'}>
                  {isVerified && <ShieldCheck className="h-3 w-3" aria-hidden="true" />}
                  {isVerified ? 'Verified' : organization.status === 'PENDING' ? 'Verification pending' : organization.status}
                </Badge>
              </div>
              {organization.description && (
                <p className="max-w-3xl text-muted-foreground">{organization.description}</p>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                {organization.country && <span>Country: {organization.country}</span>}
                {organization.website && (
                  <a
                    href={organization.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
                    aria-label={`${organization.name} website (opens in a new tab)`}
                  >
                    <Globe className="h-4 w-4" aria-hidden="true" />
                    {organization.website.replace(/^https?:\/\//, '')}
                  </a>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Verified banner */}
      {isVerified ? (
        <div
          className="flex items-center gap-3 rounded-2xl bg-emerald-50 px-5 py-4 text-emerald-900 shadow-soft"
          role="status"
        >
          <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
          <p className="text-sm font-medium">
            This organization has completed identity and registration verification (KYC). Campaigns it runs carry
            the verified badge.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-2xl bg-muted px-5 py-4 text-foreground/80 shadow-soft" role="status">
          <Building2 className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">
            Verification in progress. The organization has submitted or will submit KYC documents before its
            campaigns can carry the verified badge.
          </p>
        </div>
      )}

      {/* Campaigns */}
      <section aria-label="Campaigns by this organization" className="space-y-4">
        <h2 className="text-lg font-semibold">Campaigns</h2>
        {campaigns.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No campaigns yet"
            description="This organization has not published any campaigns yet."
          />
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {campaigns.map((campaign) => (
              <CampaignCard key={campaign.id} campaign={campaign} />
            ))}
          </div>
        )}
      </section>

      {/* Team members */}
      <Card className="rounded-2xl shadow-soft">
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
              <Users className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-semibold">Team</h2>
              <p className="text-sm text-muted-foreground">People who manage this organization.</p>
            </div>
          </div>
          <ul className="mt-4 space-y-3">
            {members.length === 0 && (
              <li className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                No team members listed.
              </li>
            )}
            {members.map((m) => (
              <li key={`${m.user.id}-${m.role}`} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar className="h-10 w-10 border">
                    <AvatarFallback>{initials(m.user.firstName, m.user.lastName)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {m.user.firstName} {m.user.lastName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
                  </div>
                </div>
                <Badge variant={roleVariant(m.role)}>{m.role}</Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Transparency note */}
      <Card className="rounded-2xl shadow-soft">
        <CardContent className="flex flex-col items-start justify-between gap-4 p-6 md:flex-row md:items-center">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Transparency</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Every donation on KINDORA is posted to a public ledger. Follow the money across all campaigns and
              see platform-wide impact in real time.
            </p>
          </div>
          <Button asChild variant="outline" className="min-h-11 shrink-0">
            <Link to="/impact">
              View public ledger
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Separator />

      <p className="text-center text-sm text-muted-foreground">
        Want your organization here?{' '}
        <Link to="/organizations" className="font-semibold text-primary hover:underline">
          Create an organization
        </Link>
      </p>
    </div>
  );
}
