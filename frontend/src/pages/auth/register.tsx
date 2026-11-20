import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRegister } from '@/api/hooks';
import { ApiError } from '@/lib/http';

const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .regex(/[A-Z]/, 'Include at least one uppercase letter')
  .regex(/\d/, 'Include at least one number');

const schema = z
  .object({
    firstName: z.string().min(1, 'First name is required').max(60, 'First name is too long'),
    lastName: z.string().min(1, 'Last name is required').max(60, 'Last name is too long'),
    email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
    password: passwordSchema,
    confirm: z.string().min(1, 'Confirm your password'),
  })
  .refine((values) => values.password === values.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });

type RegisterValues = z.infer<typeof schema>;

export default function RegisterPage() {
  const registerUser = useRegister();
  const [verifiedNotice, setVerifiedNotice] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({
    resolver: zodResolver(schema),
    defaultValues: { firstName: '', lastName: '', email: '', password: '', confirm: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await registerUser.mutateAsync({
        email: values.email.trim().toLowerCase(),
        password: values.password,
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
      });
      setRegisteredEmail(values.email.trim().toLowerCase());
      setVerifiedNotice(true);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.status === 409
            ? 'An account with this email already exists. Try signing in instead.'
            : error.status === 0
              ? 'We cannot reach KINDORA right now. Check your connection and try again.'
              : error.message || 'We could not create your account. Please try again.'
          : 'We could not create your account. Please try again.';
      setFormError(message);
      toast.error(message);
    }
  });

  if (verifiedNotice) {
    return (
      <div className="container max-w-md py-10 md:py-16">
        <Card>
          <CardHeader className="items-center text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
              <MailCheck className="h-7 w-7 text-primary" aria-hidden="true" />
            </span>
            <CardTitle className="pt-2 text-2xl font-bold tracking-tight">Check your inbox</CardTitle>
            <CardDescription>
              We sent a verification link to <span className="font-semibold text-foreground">{registeredEmail}</span>.
              Open it to activate your account. The link expires after a while, so verify soon.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              Did not get the email? Check your spam folder, then try signing in — we will flag unverified accounts and
              let you request a new link.
            </p>
            <Button asChild className="w-full">
              <Link to="/auth/login">Go to sign in</Link>
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
          <CardTitle className="text-2xl font-bold tracking-tight">Create your account</CardTitle>
          <CardDescription>Join KINDORA to give, fundraise, and track your impact.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="register-first-name">First name</Label>
                <Input
                  id="register-first-name"
                  autoComplete="given-name"
                  placeholder="Amara"
                  aria-invalid={Boolean(errors.firstName)}
                  aria-describedby={errors.firstName ? 'register-first-name-error' : undefined}
                  {...register('firstName')}
                />
                {errors.firstName && (
                  <p id="register-first-name-error" role="alert" className="text-xs font-medium text-destructive">
                    {errors.firstName.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="register-last-name">Last name</Label>
                <Input
                  id="register-last-name"
                  autoComplete="family-name"
                  placeholder="Okafor"
                  aria-invalid={Boolean(errors.lastName)}
                  aria-describedby={errors.lastName ? 'register-last-name-error' : undefined}
                  {...register('lastName')}
                />
                {errors.lastName && (
                  <p id="register-last-name-error" role="alert" className="text-xs font-medium text-destructive">
                    {errors.lastName.message}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="register-email">Email</Label>
              <Input
                id="register-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? 'register-email-error' : undefined}
                {...register('email')}
              />
              {errors.email && (
                <p id="register-email-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="register-password">Password</Label>
              <Input
                id="register-password"
                type="password"
                autoComplete="new-password"
                placeholder="At least 10 characters"
                aria-invalid={Boolean(errors.password)}
                aria-describedby={errors.password ? 'register-password-error' : 'register-password-hint'}
                {...register('password')}
              />
              {errors.password ? (
                <p id="register-password-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.password.message}
                </p>
              ) : (
                <p id="register-password-hint" className="text-xs text-muted-foreground">
                  Minimum 10 characters, with at least one uppercase letter and one number.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="register-confirm">Confirm password</Label>
              <Input
                id="register-confirm"
                type="password"
                autoComplete="new-password"
                placeholder="Re-enter your password"
                aria-invalid={Boolean(errors.confirm)}
                aria-describedby={errors.confirm ? 'register-confirm-error' : undefined}
                {...register('confirm')}
              />
              {errors.confirm && (
                <p id="register-confirm-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.confirm.message}
                </p>
              )}
            </div>

            {formError && (
              <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive">
                {formError}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting || registerUser.isPending}>
              {(isSubmitting || registerUser.isPending) && <Loader2 className="animate-spin" aria-hidden="true" />}
              {isSubmitting || registerUser.isPending ? 'Creating account…' : 'Create account'}
            </Button>
          </form>

          <p className="mt-6 text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link to="/auth/login" className="font-semibold text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
