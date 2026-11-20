import { type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description: string; action?: React.ReactNode }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Icon className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </span>
        <h3 className="font-semibold">{title}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        {action}
      </CardContent>
    </Card>
  );
}

export function StatCard({ label, value, hint, tone = 'primary' }: { label: string; value: string; hint?: string; tone?: 'primary' | 'accent' | 'plain' }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={`mt-1.5 text-2xl font-extrabold ${tone === 'primary' ? 'text-primary' : tone === 'accent' ? 'text-accent' : ''}`}>{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
