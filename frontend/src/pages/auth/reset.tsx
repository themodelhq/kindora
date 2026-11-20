import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useResetPassword } from '@/api/hooks';
import { ApiError } from '@/lib/http';

const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .regex(/[A-Z]/, 'Include at least one uppercase letter')
  .regex(/\d/, 'Include at least one number');

const schema = z
  .object({
    password: passwordSchema,
    confirm: z.string().min(1, 'Confirm your new password'),
  })
  .refine((values) => values.password === values.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });

type ResetValues = z.infer<typeof schema>;

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const resetPassword = useResetPassword();
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (!token) return;
    setFormError(null);
    try {
      await resetPassword.mutateAsync({ token, password: values.password });
      setDone(true);
    } catch (error) {
      const message =
        error instanceof ApiError && error.message
          ? error.message
          : 'We could not reset your password. The link may have expired.';
      setFormError(message);
      toast.error(message);
    }
  });

  if (!token) {
    return (
      <div className="container max-w-md py-10 md:py-16">
        <Card>
          <CardHeader className="items-center text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
              <KeyRound className="h-7 w-7 text-accent-foreground" aria-hidden="true" />
            </span>
            <CardTitle className="pt-2 text-2xl font-bold tracking-tight">Reset link is incomplete</CardTitle>
            <CardDescription>
              This page needs a valid reset token. Request a new password reset link and open it from your email.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link to="/auth/forgot">Request a new link</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (done) {
    return (
      <div className="container max-w-md py-10 md:py-16">
        <Card>
          <CardHeader className="items-center text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
              <CheckCircle2 className="h-7 w-7 text-primary" aria-hidden="true" />
            </span>
            <CardTitle className="pt-2 text-2xl font-bold tracking-tight">Password updated</CardTitle>
            <CardDescription>
              Your password has been changed. You can now sign in with your new password.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link to="/auth/login">Sign in</Link>
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
          <CardTitle className="text-2xl font-bold tracking-tight">Set a new password</CardTitle>
          <CardDescription>Choose a strong password you have not used on KINDORA before.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="reset-password">New password</Label>
              <Input
                id="reset-password"
                type="password"
                autoComplete="new-password"
                placeholder="At least 10 characters"
                aria-invalid={Boolean(errors.password)}
                aria-describedby={errors.password ? 'reset-password-error' : 'reset-password-hint'}
                {...register('password')}
              />
              {errors.password ? (
                <p id="reset-password-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.password.message}
                </p>
              ) : (
                <p id="reset-password-hint" className="text-xs text-muted-foreground">
                  Minimum 10 characters, with at least one uppercase letter and one number.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reset-confirm">Confirm new password</Label>
              <Input
                id="reset-confirm"
                type="password"
                autoComplete="new-password"
                placeholder="Re-enter your new password"
                aria-invalid={Boolean(errors.confirm)}
                aria-describedby={errors.confirm ? 'reset-confirm-error' : undefined}
                {...register('confirm')}
              />
              {errors.confirm && (
                <p id="reset-confirm-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.confirm.message}
                </p>
              )}
            </div>

            {formError && (
              <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive">
                {formError}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting || resetPassword.isPending}>
              {isSubmitting || resetPassword.isPending ? 'Updating password…' : 'Update password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
