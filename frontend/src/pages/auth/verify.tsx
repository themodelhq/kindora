import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, MailQuestion, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useVerifyEmail } from '@/api/hooks';
import { ApiError } from '@/lib/http';

type VerifyState = 'idle' | 'pending' | 'success' | 'error';

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const verify = useVerifyEmail();
  const attempted = useRef(false);
  const [state, setState] = useState<VerifyState>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const token = params.get('token');

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;
    setState('pending');
    verify.mutate(token, {
      onSuccess: () => setState('success'),
      onError: (error) => {
        setState('error');
        setErrorMessage(
          error instanceof ApiError && error.message
            ? error.message
            : 'The verification link may have expired or already been used.',
        );
      },
    });
  }, [token, verify]);

  if (!token) {
    return (
      <div className="container max-w-md py-10 md:py-16">
        <Card>
          <CardHeader className="items-center text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
              <MailQuestion className="h-7 w-7 text-accent-foreground" aria-hidden="true" />
            </span>
            <CardTitle className="pt-2 text-2xl font-bold tracking-tight">Verification link is incomplete</CardTitle>
            <CardDescription>
              This page needs a verification token. Open the verification link from your email inbox, or sign in and we
              will help you from there.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button asChild className="w-full">
              <Link to="/auth/login">Back to sign in</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link to="/auth/register">Create a new account</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === 'pending') {
    return (
      <div className="container max-w-md py-10 md:py-16">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
            <p className="text-sm font-medium" role="status">
              Verifying your email…
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div className="container max-w-md py-10 md:py-16">
        <Card>
          <CardHeader className="items-center text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
              <CheckCircle2 className="h-7 w-7 text-primary" aria-hidden="true" />
            </span>
            <CardTitle className="pt-2 text-2xl font-bold tracking-tight">Email verified</CardTitle>
            <CardDescription>
              Your email address is confirmed. Your account now has full access — you can donate, start campaigns, and
              receive notifications.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button asChild className="w-full">
              <Link to="/dashboard">Go to your dashboard</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link to="/campaigns">Browse campaigns</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-md py-10 md:py-16">
      <Card>
        <CardHeader className="items-center text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
            <XCircle className="h-7 w-7 text-destructive" aria-hidden="true" />
          </span>
          <CardTitle className="pt-2 text-2xl font-bold tracking-tight">We could not verify your email</CardTitle>
          <CardDescription>
            {errorMessage || 'The verification link may have expired or already been used.'} Sign in to request a fresh
            verification link.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button asChild className="w-full">
            <Link to="/auth/login">Back to sign in</Link>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link to="/auth/forgot">Trouble signing in?</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
