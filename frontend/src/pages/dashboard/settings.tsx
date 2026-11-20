import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { BellRing, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuthStore } from '@/stores/auth-store';
import { api, ApiError } from '@/lib/http';
import { isDemoMode } from '@/lib/demo/adapter';
import { COUNTRIES } from '@/lib/constants';

// ---------- Profile ----------

const profileSchema = z.object({
  firstName: z.string().min(1, 'First name is required').max(60, 'First name is too long'),
  lastName: z.string().min(1, 'Last name is required').max(60, 'Last name is too long'),
  phone: z.string().max(30, 'Phone number is too long').optional().or(z.literal('')),
  country: z.string().min(1, 'Choose a country'),
});

type ProfileValues = z.infer<typeof profileSchema>;

function ProfileForm() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      firstName: user?.firstName ?? '',
      lastName: user?.lastName ?? '',
      phone: user?.phone ?? '',
      country: user?.country ?? 'NG',
    },
  });

  useEffect(() => {
    reset({
      firstName: user?.firstName ?? '',
      lastName: user?.lastName ?? '',
      phone: user?.phone ?? '',
      country: user?.country ?? 'NG',
    });
  }, [user, reset]);

  const country = watch('country');

  const onSubmit = handleSubmit(async (values) => {
    setSaving(true);
    setFormError(null);
    try {
      const res = await api<{ user?: typeof user }>('PATCH', '/users/me', {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        phone: values.phone?.trim() || undefined,
        country: values.country,
      });
      if (res?.user) setUser(res.user);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      toast.success('Profile updated');
    } catch (error) {
      const message =
        error instanceof ApiError && error.message ? error.message : 'Could not save your profile. Please try again.';
      setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Your name and contact details across KINDORA.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="profile-first-name">First name</Label>
              <Input
                id="profile-first-name"
                autoComplete="given-name"
                aria-invalid={Boolean(errors.firstName)}
                aria-describedby={errors.firstName ? 'profile-first-name-error' : undefined}
                {...register('firstName')}
              />
              {errors.firstName && (
                <p id="profile-first-name-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.firstName.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-last-name">Last name</Label>
              <Input
                id="profile-last-name"
                autoComplete="family-name"
                aria-invalid={Boolean(errors.lastName)}
                aria-describedby={errors.lastName ? 'profile-last-name-error' : undefined}
                {...register('lastName')}
              />
              {errors.lastName && (
                <p id="profile-last-name-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.lastName.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-phone">Phone (optional)</Label>
              <Input
                id="profile-phone"
                type="tel"
                autoComplete="tel"
                placeholder="+234 800 000 0000"
                aria-invalid={Boolean(errors.phone)}
                aria-describedby={errors.phone ? 'profile-phone-error' : undefined}
                {...register('phone')}
              />
              {errors.phone && (
                <p id="profile-phone-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.phone.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-country">Country</Label>
              <Select value={country} onValueChange={(v) => setValue('country', v, { shouldValidate: true })}>
                <SelectTrigger id="profile-country">
                  <SelectValue placeholder="Choose a country" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.country && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {errors.country.message}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="profile-email">Email</Label>
            <Input id="profile-email" type="email" value={user?.email ?? ''} disabled aria-readonly="true" />
            <p className="text-xs text-muted-foreground">Your email is your sign-in identity and cannot be changed here.</p>
          </div>

          {formError && (
            <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive">
              {formError}
            </p>
          )}

          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------- Security ----------

const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .regex(/[A-Z]/, 'Include at least one uppercase letter')
  .regex(/\d/, 'Include at least one number');

const securitySchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'Confirm your new password'),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type SecurityValues = z.infer<typeof securitySchema>;

function SecurityForm() {
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<SecurityValues>({
    resolver: zodResolver(securitySchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSaving(true);
    setFormError(null);
    try {
      await api('POST', '/users/me/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      reset({ currentPassword: '', newPassword: '', confirmPassword: '' });
      toast.success('Password updated');
    } catch (error) {
      const message =
        error instanceof ApiError && error.message ? error.message : 'Could not change your password. Please try again.';
      setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          Use at least 10 characters with one uppercase letter and one number.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="security-current">Current password</Label>
            <Input
              id="security-current"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(errors.currentPassword)}
              aria-describedby={errors.currentPassword ? 'security-current-error' : undefined}
              {...register('currentPassword')}
            />
            {errors.currentPassword && (
              <p id="security-current-error" role="alert" className="text-xs font-medium text-destructive">
                {errors.currentPassword.message}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="security-new">New password</Label>
            <Input
              id="security-new"
              type="password"
              autoComplete="new-password"
              aria-invalid={Boolean(errors.newPassword)}
              aria-describedby={errors.newPassword ? 'security-new-error' : undefined}
              {...register('newPassword')}
            />
            {errors.newPassword && (
              <p id="security-new-error" role="alert" className="text-xs font-medium text-destructive">
                {errors.newPassword.message}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="security-confirm">Confirm new password</Label>
            <Input
              id="security-confirm"
              type="password"
              autoComplete="new-password"
              aria-invalid={Boolean(errors.confirmPassword)}
              aria-describedby={errors.confirmPassword ? 'security-confirm-error' : undefined}
              {...register('confirmPassword')}
            />
            {errors.confirmPassword && (
              <p id="security-confirm-error" role="alert" className="text-xs font-medium text-destructive">
                {errors.confirmPassword.message}
              </p>
            )}
          </div>

          {formError && (
            <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive">
              {formError}
            </p>
          )}

          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
            {saving ? 'Updating…' : 'Update password'}
          </Button>
        </form>

        <div className="mt-6 flex items-start gap-3 rounded-xl bg-muted p-4">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-muted-foreground">
            For your security, changing your password signs KINDORA out on other devices and browsers. Active sessions
            use short-lived access tokens and end automatically shortly after you stop using the app.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Notifications ----------

type PrefKey = 'campaignUpdates' | 'donationReceipts' | 'circleActivity' | 'weeklyDigest' | 'productNews';

const DEFAULT_PREFS: Record<PrefKey, boolean> = {
  campaignUpdates: true,
  donationReceipts: true,
  circleActivity: true,
  weeklyDigest: true,
  productNews: false,
};

const PREF_META: Record<PrefKey, { label: string; description: string }> = {
  campaignUpdates: {
    label: 'Campaign updates',
    description: 'New posts from organizers of campaigns you donated to.',
  },
  donationReceipts: {
    label: 'Donation receipts',
    description: 'Email receipts when your donations succeed.',
  },
  circleActivity: {
    label: 'Circle activity',
    description: 'Contributions and invites from your giving circles.',
  },
  weeklyDigest: {
    label: 'Weekly impact digest',
    description: 'A short summary of your impact every week.',
  },
  productNews: {
    label: 'Product news',
    description: 'Occasional announcements about new KINDORA features.',
  },
};

function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Record<PrefKey, boolean>>(DEFAULT_PREFS);
  const [pendingKey, setPendingKey] = useState<PrefKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<Record<string, unknown>>('GET', '/users/me/notification-preferences')
      .then((res) => {
        if (cancelled || !res || typeof res !== 'object') return;
        const raw = ('preferences' in res && res.preferences ? res.preferences : res) as Partial<
          Record<PrefKey, boolean>
        >;
        setPrefs((prev) => {
          const next = { ...prev };
          (Object.keys(next) as PrefKey[]).forEach((key) => {
            if (typeof raw[key] === 'boolean') next[key] = raw[key] as boolean;
          });
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(key: PrefKey, checked: boolean) {
    const previous = prefs;
    setPendingKey(key);
    setPrefs((p) => ({ ...p, [key]: checked }));
    try {
      await api('PATCH', '/users/me/notification-preferences', { [key]: checked });
      toast.success('Notification preferences updated');
    } catch (error) {
      if (isDemoMode()) {
        toast.success('Notification preferences updated');
      } else {
        setPrefs(previous);
        toast.error(
          error instanceof ApiError && error.message
            ? error.message
            : 'Could not update preferences. Please try again.',
        );
      }
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification preferences</CardTitle>
        <CardDescription>Choose what KINDORA tells you about. Changes apply immediately.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="max-w-xl divide-y">
          {(Object.keys(PREF_META) as PrefKey[]).map((key) => (
            <li key={key} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <Label htmlFor={`pref-${key}`} className="text-sm font-semibold">
                  {PREF_META[key].label}
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">{PREF_META[key].description}</p>
              </div>
              <Switch
                id={`pref-${key}`}
                checked={prefs[key]}
                onCheckedChange={(checked) => void toggle(key, checked)}
                disabled={pendingKey !== null}
                aria-label={`${PREF_META[key].label} notifications`}
              />
            </li>
          ))}
        </ul>
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
          Critical security and payment notices are always sent, regardless of these settings.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------- Page ----------

export default function DashboardSettingsPage() {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as {user?.email ?? 'your account'}.
        </p>
      </div>

      <Tabs defaultValue="profile">
        <TabsList aria-label="Settings sections">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <ProfileForm />
        </TabsContent>
        <TabsContent value="security">
          <SecurityForm />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationPreferences />
        </TabsContent>
      </Tabs>
    </div>
  );
}
