import { useMemo, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, MoreHorizontal, Search, ShieldBan, Users } from 'lucide-react';
import { toast } from 'sonner';

import { useAdminUserAction, useAdminUsers } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/shared';
import { formatDate } from '@/lib/utils';
import type { User } from '@/types/api';

const PAGE_SIZE = 20;

function roleVariant(role: string): BadgeProps['variant'] {
  switch (role) {
    case 'ADMIN':
      return 'default';
    case 'ORG_ADMIN':
      return 'accent';
    default:
      return 'secondary';
  }
}

function statusVariant(status: User['status']): BadgeProps['variant'] {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'SUSPENDED':
      return 'destructive';
    case 'DELETED':
      return 'muted';
    default:
      return 'muted';
  }
}

export default function AdminUsersPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const { data, isLoading, isError, refetch, isFetching } = useAdminUsers(page);
  const userAction = useAdminUserAction();

  const rows = useMemo(() => {
    const items = data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (u) =>
        `${u.firstName} ${u.lastName}`.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    );
  }, [data, search]);

  const total = data?.total ?? 0;
  const canPrev = page > 1;
  const canNext = rows.length >= PAGE_SIZE && page * PAGE_SIZE < total;

  const runAction = (user: User, act: 'suspend' | 'activate') => {
    toast.success(act === 'suspend' ? `${user.firstName} ${user.lastName} suspended` : `${user.firstName} ${user.lastName} reactivated`);
    userAction.mutate(
      { id: user.id, action: act },
      {
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Action failed — refresh to confirm'),
      },
    );
  };

  const refetchAndClear = () => {
    void refetch();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Users</h2>
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} registered {total === 1 ? 'account' : 'accounts'} — search, review roles and manage access.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email"
            className="min-h-11 pl-9"
            aria-label="Search users by name or email"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={Users}
          title="Could not load users"
          description="Something went wrong while fetching user accounts."
          action={<Button onClick={refetchAndClear}>Try again</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={search ? 'No matching users' : 'No users found'}
          description={
            search
              ? 'No user on this page matches your search. Try a different name or email.'
              : 'User accounts will appear here as people join KINDORA.'
          }
        />
      ) : (
        <>
          <div className="rounded-2xl border bg-card shadow-soft">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">
                      {user.firstName} {user.lastName}
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-muted-foreground">{user.email}</TableCell>
                    <TableCell>
                      <Badge variant={roleVariant(user.role)}>{user.role === 'ORG_ADMIN' ? 'ORG ADMIN' : user.role}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(user.status)}>{user.status ?? 'ACTIVE'}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(user.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label={`Actions for ${user.firstName} ${user.lastName}`}>
                            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          {user.status === 'SUSPENDED' ? (
                            <DropdownMenuItem onSelect={() => runAction(user, 'activate')}>
                              <CheckCircle2 className="text-emerald-600" aria-hidden="true" />
                              Activate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => runAction(user, 'suspend')}
                            >
                              <ShieldBan aria-hidden="true" />
                              Suspend
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Page {page}
              {isFetching && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={!canPrev || isFetching}
                className="min-h-11"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Previous
              </Button>
              <Button
                variant="outline"
                onClick={() => setPage((p) => p + 1)}
                disabled={!canNext || isFetching}
                className="min-h-11"
              >
                Next
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
