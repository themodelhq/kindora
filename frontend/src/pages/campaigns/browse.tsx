import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { CampaignCard, CampaignCardSkeleton } from '@/components/campaign-card';
import { EmptyState } from '@/components/shared';
import { useCampaigns } from '@/api/hooks';
import { CATEGORIES, COUNTRIES } from '@/lib/constants';

const SORT_OPTIONS = [
  { value: 'trending', label: 'Trending' },
  { value: 'newest', label: 'Newest' },
  { value: 'deadline', label: 'Ending soon' },
  { value: 'target', label: 'Largest goal' },
] as const;

const PAGE_SIZE = 12;

export default function CampaignBrowsePage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const category = searchParams.get('category') ?? 'all';
  const country = searchParams.get('country') ?? 'all';
  const sort = searchParams.get('sort') ?? 'trending';
  const page = Math.max(1, Number(searchParams.get('page')) || 1);

  const [queryInput, setQueryInput] = useState(q);
  useEffect(() => setQueryInput(q), [q]);

  const results = useCampaigns({ q, category, country, sort, page, limit: PAGE_SIZE });

  const updateParams = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '' || value === 'all') next.delete(key);
      else next.set(key, value);
    }
    if (resetPage) next.delete('page');
    setSearchParams(next);
  };

  const items = results.data?.items ?? [];
  const total = results.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = Boolean(q || category !== 'all' || country !== 'all');

  return (
    <div className="container py-8 lg:py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight">Discover causes</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Every campaign here is reviewed by the KINDORA team and posts its money trail to a public ledger.
        </p>
      </header>

      {/* Filters */}
      <Card className="mb-8">
        <CardContent className="p-5 lg:p-6">
          <form
            className="grid gap-4 lg:grid-cols-[2fr_1fr_1fr_1fr]"
            onSubmit={(e) => {
              e.preventDefault();
              updateParams({ q: queryInput.trim() || null });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="browse-search">Search</Label>
              <Input
                id="browse-search"
                type="search"
                placeholder="Search by title or keyword"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                aria-label="Search campaigns by title or keyword"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="browse-category">Category</Label>
              <Select value={category} onValueChange={(v) => updateParams({ category: v })}>
                <SelectTrigger id="browse-category" aria-label="Filter by category">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.slug} value={c.slug}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="browse-country">Country</Label>
              <Select value={country} onValueChange={(v) => updateParams({ country: v })}>
                <SelectTrigger id="browse-country" aria-label="Filter by country">
                  <SelectValue placeholder="All countries" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All countries</SelectItem>
                  {COUNTRIES.map((c) => (
                    <SelectItem key={c.code} value={c.name}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="browse-sort">Sort by</Label>
              <Select value={sort} onValueChange={(v) => updateParams({ sort: v }, false)}>
                <SelectTrigger id="browse-sort" aria-label="Sort campaigns">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Results */}
      <div className="mb-5 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {results.isLoading ? 'Loading campaigns…' : `${total.toLocaleString()} campaign${total === 1 ? '' : 's'} found`}
        </p>
        {hasFilters && (
          <Button
            variant="ghost"
            className="text-primary"
            onClick={() => setSearchParams(new URLSearchParams())}
          >
            Clear filters
          </Button>
        )}
      </div>

      {results.isError ? (
        <EmptyState
          icon={SearchX}
          title="We could not load campaigns"
          description="Something went wrong while reaching the KINDORA service. Please try again."
          action={
            <Button onClick={() => results.refetch()} variant="outline">
              Try again
            </Button>
          }
        />
      ) : !results.isLoading && items.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No campaigns match your search"
          description="Try a different keyword, or clear the filters to browse every verified cause on KINDORA."
          action={
            <Button onClick={() => setSearchParams(new URLSearchParams())}>Browse all campaigns</Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {results.isLoading
            ? Array.from({ length: 6 }).map((_, i) => <CampaignCardSkeleton key={i} />)
            : items.map((c) => <CampaignCard key={c.id} campaign={c} />)}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && !results.isError && items.length > 0 && (
        <nav className="mt-10 flex items-center justify-center gap-3" aria-label="Campaign pagination">
          <Button
            variant="outline"
            onClick={() => updateParams({ page: String(page - 1) }, false)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Previous
          </Button>
          <span className="text-sm font-medium text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            onClick={() => updateParams({ page: String(page + 1) }, false)}
            disabled={page >= totalPages}
            aria-label="Next page"
          >
            Next
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </nav>
      )}
    </div>
  );
}
