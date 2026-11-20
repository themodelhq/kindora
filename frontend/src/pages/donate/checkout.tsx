import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { BadgeCheck, ChevronRight, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/shared';
import { CATEGORY_META } from '@/components/campaign-category';
import { useCampaign, useCreateDonation, usePaymentMethods } from '@/api/hooks';
import { useAuthStore } from '@/stores/auth-store';
import { formatMoney, minorFromMajor } from '@/lib/money';
import { PROVIDER_LABELS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { CampaignDetail } from '@/types/api';

const TIP_OPTIONS = [0, 5, 10] as const;

const PRESET_AMOUNTS: Record<string, number[]> = {
  NGN: [5000, 10000, 25000, 50000, 100000],
  USD: [10, 25, 50, 100, 250],
};

const donationSchema = z.object({
  // zod 4: error-map params replaced by { error }; message params unchanged.
  amountMajor: z
    .number({ error: (issue) =>
      issue.input === undefined
        ? 'Enter a donation amount'
        : 'Enter a valid number',
    })
    .positive('Amount must be greater than zero')
    .max(2000000000, 'This amount is too large for an online checkout'),
  tipPercent: z.number().refine((v) => TIP_OPTIONS.includes(v as 0 | 5 | 10), 'Choose a tip option'),
  provider: z.string().min(1, 'Choose a payment method'),
  message: z.string().max(600, 'Message must be 600 characters or fewer').optional(),
  guestName: z.string().optional(),
  guestEmail: z.string().optional(),
});

type DonationFormValues = z.infer<typeof donationSchema>;

function buildDonationSchema(loggedIn: boolean) {
  return donationSchema.superRefine((val, ctx) => {
    if (loggedIn) return;
    if (!val.guestName || val.guestName.trim().length < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['guestName'], message: 'Enter your full name' });
    }
    if (!val.guestEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.guestEmail.trim())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['guestEmail'], message: 'Enter a valid email address' });
    }
  });
}

export default function DonateCheckoutPage() {
  const params = useParams();
  const slug = params.slug ?? '';
  const campaign = useCampaign(slug);

  if (campaign.isLoading) {
    return (
      <div className="container max-w-3xl space-y-6 py-10" aria-busy="true">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }

  if (campaign.isError || !campaign.data) {
    return (
      <div className="container py-16">
        <EmptyState
          icon={Lock}
          title="Campaign unavailable"
          description="We could not load this campaign, so donations are paused. Please go back and try another cause."
          action={
            <Button asChild>
              <Link to="/campaigns">Explore campaigns</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return <CheckoutForm key={campaign.data.currency} campaign={campaign.data} />;
}

function CheckoutForm({ campaign }: { campaign: CampaignDetail }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const methodsQuery = usePaymentMethods();
  const createDonation = useCreateDonation();

  const currency = campaign.currency;
  const presets = useMemo(() => PRESET_AMOUNTS[currency] ?? PRESET_AMOUNTS.USD, [currency]);
  const enabledMethods = useMemo(
    () => (methodsQuery.data ?? []).filter((m) => m.enabled),
    [methodsQuery.data],
  );
  const firstMethod = enabledMethods[0]?.provider;

  const [isAnonymous, setIsAnonymous] = useState(false);
  const [recurring, setRecurring] = useState(false);

  const schema = useMemo(() => buildDonationSchema(Boolean(user)), [user]);

  const { register, handleSubmit, setValue, watch, formState } = useForm<DonationFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      amountMajor: presets[0],
      tipPercent: 5,
      provider: '',
      message: '',
      guestName: '',
      guestEmail: '',
    },
  });

  const amountMajor = Number(watch('amountMajor')) || 0;
  const tipPercent = watch('tipPercent');
  const provider = watch('provider');

  useEffect(() => {
    if (!provider && firstMethod) {
      setValue('provider', firstMethod);
    }
  }, [provider, firstMethod, setValue]);

  const amountMinor = minorFromMajor(amountMajor, currency);
  const tipAmountMinor = Math.round((amountMinor * tipPercent) / 100);
  const totalMinor = amountMinor + tipAmountMinor;

  const meta = campaign.category ? CATEGORY_META[campaign.category.slug] : undefined;

  const onSubmit = async (v: DonationFormValues) => {
    const amountMinorFinal = minorFromMajor(v.amountMajor, currency);
    const tipAmountMinorFinal = Math.round((amountMinorFinal * (v.tipPercent ?? 0)) / 100);
    try {
      const res = await createDonation.mutateAsync({
        campaignSlug: campaign.slug,
        amountMinor: amountMinorFinal,
        tipAmountMinor: tipAmountMinorFinal,
        provider: v.provider,
        guestEmail: user ? undefined : v.guestEmail?.trim(),
        guestName: user ? undefined : v.guestName?.trim(),
        isAnonymous: isAnonymous || undefined,
        message: v.message?.trim() || undefined,
        recurring: recurring || undefined,
        recurringFrequency: recurring ? 'MONTHLY' : undefined,
      });
      if (res.redirectUrl.startsWith('/')) {
        navigate(res.redirectUrl, { replace: true });
      } else {
        window.location.assign(res.redirectUrl);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the donation. Please try again.');
    }
  };

  return (
    <div className="container max-w-3xl py-8 lg:py-12">
      {/* Campaign context */}
      <Card className="mb-6">
        <CardContent className="flex items-center gap-4 p-4 sm:p-5">
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white"
            aria-hidden="true"
          >
            {meta ? <meta.icon className="h-6 w-6" /> : <ShieldCheck className="h-6 w-6" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">You are supporting</p>
            <p className="truncate font-bold">{campaign.title}</p>
          </div>
          <Link
            to={`/campaigns/${campaign.slug}`}
            className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary hover:underline"
          >
            Back
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </CardContent>
      </Card>

      {campaign.status !== 'ACTIVE' && (
        <p className="mb-6 rounded-xl bg-accent/20 px-4 py-3 text-sm font-medium text-accent-foreground">
          This campaign is not currently active. You can still make a contribution, and the organizer will be notified.
        </p>
      )}

      <Card>
        <CardContent className="p-6 lg:p-8">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-8" noValidate>
            {/* Amount */}
            <section aria-labelledby="amount-heading">
              <h2 id="amount-heading" className="font-bold">Choose your amount</h2>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
                {presets.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setValue('amountMajor', p, { shouldValidate: true })}
                    aria-pressed={amountMajor === p}
                    className={cn(
                      'min-h-11 rounded-xl border px-3 py-2.5 text-sm font-bold transition-colors',
                      amountMajor === p
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-input bg-card hover:border-primary/50',
                    )}
                  >
                    {formatMoney(minorFromMajor(p, currency), currency)}
                  </button>
                ))}
              </div>
              <div className="mt-4 space-y-1.5">
                <Label htmlFor="donation-amount">Custom amount ({currency})</Label>
                <Input
                  id="donation-amount"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder={String(presets[0])}
                  aria-invalid={Boolean(formState.errors.amountMajor)}
                  {...register('amountMajor', { valueAsNumber: true })}
                />
                {formState.errors.amountMajor && (
                  <p className="text-sm text-destructive" role="alert">{formState.errors.amountMajor.message}</p>
                )}
              </div>
            </section>

            <Separator />

            {/* Message + anonymity */}
            <section aria-labelledby="message-heading">
              <h2 id="message-heading" className="font-bold">Add a message of support</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Shown publicly on the campaign page unless you give anonymously.
              </p>
              <Textarea
                className="mt-3"
                placeholder="Say something kind, or explain who you are giving for…"
                aria-label="Donation message"
                {...register('message')}
              />
              {formState.errors.message && (
                <p className="mt-1 text-sm text-destructive" role="alert">{formState.errors.message.message}</p>
              )}
              <div className="mt-4 flex items-center justify-between rounded-xl border p-4">
                <div>
                  <Label htmlFor="donate-anonymous">Give anonymously</Label>
                  <p className="text-xs text-muted-foreground">Your name will not appear on the campaign page.</p>
                </div>
                <Switch
                  id="donate-anonymous"
                  checked={isAnonymous}
                  onCheckedChange={setIsAnonymous}
                  aria-label="Give anonymously"
                />
              </div>
            </section>

            <Separator />

            {/* Tip */}
            <section aria-labelledby="tip-heading">
              <h2 id="tip-heading" className="font-bold">Support KINDORA with a tip</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                KINDORA runs on tips — there is no mandatory platform fee, and 100% of your donation reaches the cause.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {TIP_OPTIONS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setValue('tipPercent', p, { shouldValidate: true })}
                    aria-pressed={tipPercent === p}
                    className={cn(
                      'min-h-11 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors',
                      tipPercent === p
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-input bg-card hover:border-primary/50',
                    )}
                  >
                    {p === 0 ? 'No tip' : `${p}% tip`}
                    <span className="block text-xs font-medium text-muted-foreground">
                      {formatMoney(Math.round((amountMinor * p) / 100), currency)}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <Separator />

            {/* Payment method */}
            <section aria-labelledby="payment-heading">
              <h2 id="payment-heading" className="font-bold">Payment method</h2>
              {methodsQuery.isLoading ? (
                <Skeleton className="mt-4 h-11 w-full" />
              ) : enabledMethods.length === 0 ? (
                <p className="mt-3 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                  No payment methods are available right now. Please try again later.
                </p>
              ) : (
                <div className="mt-3 space-y-1.5">
                  <Label htmlFor="donation-provider">Pay with</Label>
                  <Select value={provider} onValueChange={(v) => setValue('provider', v, { shouldValidate: true })}>
                    <SelectTrigger id="donation-provider" aria-label="Choose a payment method">
                      <SelectValue placeholder="Choose a payment method" />
                    </SelectTrigger>
                    <SelectContent>
                      {enabledMethods.map((m) => (
                        <SelectItem key={m.provider} value={m.provider}>
                          {PROVIDER_LABELS[m.provider] ?? m.provider}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {formState.errors.provider && (
                    <p className="text-sm text-destructive" role="alert">{formState.errors.provider.message}</p>
                  )}
                </div>
              )}
            </section>

            {/* Guest identity or recurring */}
            {user ? (
              <div className="flex items-center justify-between rounded-xl border p-4">
                <div>
                  <Label htmlFor="donate-recurring">Make it monthly</Label>
                  <p className="text-xs text-muted-foreground">
                    Repeat this donation automatically every month. Cancel any time in your dashboard.
                  </p>
                </div>
                <Switch
                  id="donate-recurring"
                  checked={recurring}
                  onCheckedChange={setRecurring}
                  aria-label="Make this a monthly donation"
                />
              </div>
            ) : (
              <section aria-labelledby="guest-heading" className="grid gap-4 sm:grid-cols-2">
                <h2 id="guest-heading" className="sr-only">Your details</h2>
                <div className="space-y-1.5">
                  <Label htmlFor="guest-name">Your name</Label>
                  <Input
                    id="guest-name"
                    autoComplete="name"
                    placeholder="Ada Obi"
                    aria-invalid={Boolean(formState.errors.guestName)}
                    {...register('guestName')}
                  />
                  {formState.errors.guestName && (
                    <p className="text-sm text-destructive" role="alert">{formState.errors.guestName.message}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="guest-email">Email for your receipt</Label>
                  <Input
                    id="guest-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    aria-invalid={Boolean(formState.errors.guestEmail)}
                    {...register('guestEmail')}
                  />
                  {formState.errors.guestEmail && (
                    <p className="text-sm text-destructive" role="alert">{formState.errors.guestEmail.message}</p>
                  )}
                </div>
              </section>
            )}

            {/* Summary + submit */}
            <div className="rounded-2xl bg-secondary/60 p-5">
              <dl className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Donation</dt>
                  <dd className="font-semibold">{formatMoney(amountMinor, currency)}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Tip for KINDORA ({tipPercent}%)</dt>
                  <dd className="font-semibold">{formatMoney(tipAmountMinor, currency)}</dd>
                </div>
                <Separator className="my-2" />
                <div className="flex items-center justify-between text-base">
                  <dt className="font-bold">Total</dt>
                  <dd className="font-extrabold text-primary">{formatMoney(totalMinor, currency)}</dd>
                </div>
              </dl>
              <Button type="submit" size="lg" className="mt-5 w-full text-base" disabled={createDonation.isPending}>
                {createDonation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Preparing checkout…
                  </>
                ) : (
                  <>Donate {formatMoney(totalMinor, currency)}</>
                )}
              </Button>
              <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                Processed securely
                {provider && PROVIDER_LABELS[provider] ? ` via ${PROVIDER_LABELS[provider].split(' ')[0]}` : ''}.
                A receipt is recorded on the public ledger once the provider confirms your payment.
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
        <BadgeCheck className="h-4 w-4 text-primary" aria-hidden="true" />
        This campaign passed KINDORA organizer verification before publishing.
      </p>
    </div>
  );
}
