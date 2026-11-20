import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function NotFoundPage() {
  return (
    <div className="container flex min-h-[70dvh] items-center justify-center py-16">
      <Card className="w-full max-w-lg text-center">
        <CardContent className="flex flex-col items-center gap-5 p-8 sm:p-10">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10" aria-hidden="true">
            <Compass className="h-8 w-8 text-primary" />
          </span>
          <p className="text-6xl font-extrabold tracking-tight text-primary">404</p>
          <h1 className="text-xl font-bold">This page took a wrong turn</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            The link may be old or mistyped. The causes you came for are still right where you left them — back on
            KINDORA&apos;s discover page.
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Button asChild>
              <Link to="/">Go home</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/campaigns">Discover campaigns</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
