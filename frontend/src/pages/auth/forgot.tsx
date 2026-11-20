import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useForgotPassword } from '@/api/hooks';

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
});

type ForgotValues = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const forgot = useForgotPassword();
  const [sent, setSent] = useState(false);
  const [sentEmail, setSentEmail] = useState('');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ForgotValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    const email = values.email.trim().toLowerCase();
    // Always surface the generic success: never reveal whether an account exists.
    try {
      await forgot.mutateAsync(email);
    } catch {
      // Intentionally ignored — the response is identical either way.
    }
    setSentEmail(email);
    setSent(true);
  });

  if (sent) {
    return (
      <div className="container max-w-md py-10 md:py-16">
        <Card>
          <CardHeader className="items-center text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
              <MailCheck className="h-7 w-7 text-primary" aria-hidden="true" />
            </span>
            <CardTitle className="pt-2 text-2xl font-bold tracking-tight">Check your inbox</CardTitle>
            <CardDescription>
              If the account exists we sent a link to reset your password
              {sentEmail ? (
                <>
                  {' '}
                  to <span className="font-semibold text-foreground">{sentEmail}</span>
                </>
              ) : null}
              . It may take a few minutes to arrive.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button asChild className="w-full">
              <Link to="/auth/login">Back to sign in</Link>
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setSent(false);
                setSentEmail('');
                reset({ email: '' });
              }}
            >
              Use a different email
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-md py-10 md:py-16">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-bold tracking-tight">Forgot your password?</CardTitle>
          <CardDescription>
            Enter the email you registered with and we will send you a link to set a new password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="forgot-email">Email</Label>
              <Input
                id="forgot-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? 'forgot-email-error' : undefined}
                {...register('email')}
              />
              {errors.email && (
                <p id="forgot-email-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" disabled={isSubmitting || forgot.isPending}>
              {isSubmitting || forgot.isPending ? 'Sending link…' : 'Send reset link'}
            </Button>
          </form>

          <p className="mt-6 text-sm text-muted-foreground">
            Remembered it?{' '}
            <Link to="/auth/login" className="font-semibold text-primary hover:underline">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
