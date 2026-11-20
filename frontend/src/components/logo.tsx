import { Link } from 'react-router-dom';
import { Heart, MoveUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={cn('h-8 w-8', className)} aria-hidden="true">
      <rect x="1" y="1" width="46" height="46" rx="12" className="fill-primary" />
      <path
        d="M24 37c-7.5-5.2-13-10.3-13-16.2C11 15.6 15 12 19.4 12c2.5 0 4.6 1.2 4.6 1.2S26.1 12 28.6 12C33 12 37 15.6 37 20.8c0 5.9-5.5 11-13 16.2Z"
        className="fill-white"
      />
      <path d="M15 20c5 1.5 9 4.5 18-1" stroke="#F59E0B" strokeWidth="3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function Logo({ to = '/', compact = false, light = false }: { to?: string; compact?: boolean; light?: boolean }) {
  return (
    <Link to={to} className="flex items-center gap-2.5 shrink-0" aria-label="KINDORA home">
      <LogoMark className={light ? 'h-9 w-9' : 'h-8 w-8'} />
      {!compact && (
        <span className="flex flex-col leading-none">
          <span className={cn('text-lg font-extrabold tracking-tight', light ? 'text-white' : 'text-foreground')}>
            KINDORA
          </span>
          <span className={cn('text-[10px] font-medium', light ? 'text-white/70' : 'text-muted-foreground')}>
            Goodness, in motion
          </span>
        </span>
      )}
    </Link>
  );
}

export function HeartMotionIcon({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center justify-center', className)}>
      <Heart className="h-4 w-4 fill-accent text-accent" />
      <MoveUpRight className="h-3 w-3 text-primary" />
    </span>
  );
}
