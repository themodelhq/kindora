import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLogin } from '@/api/hooks';
import { ApiError } from '@/lib/http';

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginValues = z.infer<typeof schema>;

function friendlyLoginError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Those details don't match an account. Check your email and password, then try again.";
    }
    if (error.status === 429) return 'Too many sign-in attempts. Please wait a minute and try again.';
    if (error.status === 0) return 'We cannot reach KINDORA right now. Check your connection and try again.';
    if (error.message) return error.message;
  }
  return 'Something went wrong while signing in. Please try again.';
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useLogin();
  const [formError, setFormError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';
  const demoMode = import.meta.env.VITE_DEMO_MODE === '1' || import.meta.env.VITE_DEMO_MODE === 'true';

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login.mutateAsync({ email: values.email.trim().toLowerCase(), password: values.password });
      toast.success('Welcome back');
      navigate(from, { replace: true });
    } catch (error) {
      const message = friendlyLoginError(error);
      setFormError(message);
      toast.error(message);
    }
  });

  return (
    <div className="container max-w-md py-10 md:py-16">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-bold tracking-tight">Welcome back</CardTitle>
          <CardDescription>Sign in to track your giving and manage your campaigns.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? 'login-email-error' : undefined}
                {...register('email')}
              />
              {errors.email && (
                <p id="login-email-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="login-password">Password</Label>
                <Link to="/auth/forgot" className="text-xs font-medium text-primary hover:underline">
                  Forgot password?
                </Link>
              </div>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                placeholder="Your password"
                aria-invalid={Boolean(errors.password)}
                aria-describedby={errors.password ? 'login-password-error' : undefined}
                {...register('password')}
              />
              {errors.password && (
                <p id="login-password-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.password.message}
                </p>
              )}
            </div>

            {formError && (
              <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive">
                {formError}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting || login.isPending}>
              {(isSubmitting || login.isPending) && <Loader2 className="animate-spin" aria-hidden="true" />}
              {isSubmitting || login.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          {demoMode && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900">
              Demo mode: any email with password 'demo1234' signs in; use admin@kindora.org for the admin console
            </div>
          )}

          <p className="mt-6 text-sm text-muted-foreground">
            New to KINDORA?{' '}
            <Link to="/auth/register" className="font-semibold text-primary hover:underline">
              Create an account
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
