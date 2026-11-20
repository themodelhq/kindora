import { useMemo, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, Globe, Loader2, MapPin, Plus, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { useCreateOrganization, useOrganizations } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared';
import { truncate } from '@/lib/utils';
import { COUNTRIES } from '@/lib/constants';
import { useAuthStore } from '@/stores/auth-store';
import type { Organization } from '@/types/api';

function statusVariant(status: Organization['status']): BadgeProps['variant'] {
  switch (status) {
    case 'VERIFIED':
      return 'success';
    case 'PENDING':
      return 'warning';
    case 'SUSPENDED':
      return 'destructive';
    case 'REJECTED':
      return 'destructive';
    default:
      return 'muted';
  }
}

function statusLabel(status: Organization['status']): string {
  switch (status) {
    case 'VERIFIED':
      return 'Verified';
    case 'PENDING':
      return 'Verification pending';
    case 'REJECTED':
      return 'Not verified';
    case 'SUSPENDED':
      return 'Suspended';
    default:
      return status;
  }
}

function OrganizationCard({ organization }: { organization: Organization }) {
  const initialsFallback = organization.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');

  return (
    <Link
      to={`/organizations/${organization.slug}`}
      className="group block focus-visible:outline-none"
      aria-label={organization.name}
    >
      <Card className="h-full transition-all group-hover:-translate-y-0.5 group-hover:shadow-lift group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <CardContent className="flex h-full flex-col gap-3 p-5">
          <div className="flex items-start gap-3">
            <Avatar className="h-12 w-12 border">
              {organization.logoUrl && <AvatarImage src={organization.logoUrl} alt={`${organization.name} logo`} />}
              <AvatarFallback className="bg-secondary font-bold">{initialsFallback}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-bold leading-snug group-hover:text-primary">{organization.name}</h3>
              <div className="mt-1">
                <Badge variant={statusVariant(organization.status)}>
                  {organization.status === 'VERIFIED' && <ShieldCheck className="h-3 w-3" aria-hidden="true" />}
                  {statusLabel(organization.status)}
                </Badge>
              </div>
            </div>
          </div>
          {organization.description && (
            <p className="text-sm text-muted-foreground">{truncate(organization.description, 120)}</p>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pt-2">
            {organization.country && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {organization.country}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Building2 className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              {organization.campaigns?.length ?? 0}{' '}
              {(organization.campaigns?.length ?? 0) === 1 ? 'campaign' : 'campaigns'}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function OrganizationsIndexPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const { data, isLoading, isError, refetch } = useOrganizations();
  const createOrganization = useCreateOrganization();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [country, setCountry] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');

  const organizations = useMemo(() => data?.items ?? [], [data]);

  const submitCreate = () => {
    if (!user) {
      toast.error('Sign in to create an organization');
      navigate('/auth/login');
      return;
    }
    if (!name.trim()) {
      toast.error('Give your organization a name');
      return;
    }
    createOrganization.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        website: website.trim() || undefined,
        country: country || undefined,
        registrationNumber: registrationNumber.trim() || undefined,
      },
      {
        onSuccess: (res) => {
          toast.success('Organization created');
          setCreateOpen(false);
          setName('');
          setDescription('');
          setWebsite('');
          setCountry('');
          setRegistrationNumber('');
          navigate(`/organizations/${res.organization.slug}`);
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not create the organization'),
      },
    );
  };

  return (
    <div className="container space-y-8 py-8 md:py-12">
      {/* Page header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">Organizations</p>
          <h1 className="text-3xl font-extrabold tracking-tight md:text-4xl">Trusted organizations</h1>
          <p className="max-w-2xl text-muted-foreground">
            Registered nonprofits and community groups raising funds on KINDORA with verified identities.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="min-h-11 shrink-0">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create organization
        </Button>
      </div>

      {/* Directory */}
      {isLoading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-52 rounded-2xl" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={Building2}
          title="Could not load organizations"
          description="Something went wrong while fetching the directory."
          action={<Button onClick={() => void refetch()}>Try again</Button>}
        />
      ) : organizations.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Register your nonprofit or community group and start raising funds with a verified identity."
          action={<Button onClick={() => setCreateOpen(true)}>Create organization</Button>}
        />
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {organizations.map((organization) => (
            <OrganizationCard key={organization.id} organization={organization} />
          ))}
        </div>
      )}

      {/* Verification note */}
      <Card className="rounded-2xl border-amber-200/70 bg-amber-50/60 shadow-soft">
        <CardContent className="flex items-start gap-4 p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <h3 className="font-semibold">About verification</h3>
            <p className="text-sm text-muted-foreground">
              Organizations submit verification documents (KYC) after creation; verified organizations get a
              badge on campaigns.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Create organization dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Create an organization</DialogTitle>
            <DialogDescription>
              Register a nonprofit, NGO or community group. You will submit verification documents after creation.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitCreate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                placeholder="e.g. Obosi Water Initiative"
                className="min-h-11"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-description">Description</Label>
              <Textarea
                id="org-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does your organization do?"
                className="min-h-[80px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-website">Website</Label>
              <div className="relative">
                <Globe className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="org-website"
                  type="url"
                  value={website}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setWebsite(e.target.value)}
                  placeholder="https://example.org"
                  className="min-h-11 pl-9"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-country">Country</Label>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger id="org-country" className="min-h-11" aria-label="Country">
                  <SelectValue placeholder="Choose a country" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-registration">Registration number</Label>
              <Input
                id="org-registration"
                value={registrationNumber}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setRegistrationNumber(e.target.value)}
                placeholder="e.g. RC-1234567"
                className="min-h-11"
                aria-label="Registration number"
              />
              <p className="text-xs text-muted-foreground">
                Used during KYC verification and never shown publicly.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} className="min-h-11">
                Cancel
              </Button>
              <Button type="submit" disabled={createOrganization.isPending} className="min-h-11">
                {createOrganization.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Create organization
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
