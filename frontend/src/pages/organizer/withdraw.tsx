import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertCircle, Banknote, Info, Loader2, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared';
import { useAvailableBalance, useCreateWithdrawal, useMyCampaigns } from '@/api/hooks';
import { formatMoney, majorValue, minorFromMajor } from '@/lib/money';
import { ApiError } from '@/lib/http';
import { campaignStatusBadge } from '@/lib/status';

type WithdrawMethod = 'BANK' | 'MOBILE_MONEY';

export default function OrganizerWithdrawPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const prefillCampaignId = params.get('campaign') ?? '';

  const campaignsQuery = useMyCampaigns();
  const campaigns = useMemo(() => campaignsQuery.data?.items ?? [], [campaignsQuery.data]);
  const selectableCampaigns = campaigns.filter((c) => c.status === 'ACTIVE' || c.status === 'COMPLETED' || c.status === 'PAUSED');
  const campaignOptions = selectableCampaigns.length > 0 ? selectableCampaigns : campaigns;

  const [campaignId, setCampaignId] = useState(prefillCampaignId);
  const [amountMajor, setAmountMajor] = useState('');
  const [method, setMethod] = useState<WithdrawMethod>('BANK');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [network, setNetwork] = useState('');
  const [phone, setPhone] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedCampaign = useMemo(
    () => campaigns.find((c) => c.id === campaignId),
    [campaigns, campaignId],
  );

  const balanceQuery = useAvailableBalance(campaignId);
  const balance = balanceQuery.data;
  const currency = selectedCampaign?.currency ?? balance?.currency ?? 'NGN';
  const availableMajor = balance ? majorValue(balance.availableMinor, balance.currency) : null;
  // GET /withdrawals/available/:campaignId is manager-only — show a friendly
  // "Not permitted" state instead of a broken balance for other viewers.
  const balanceDenied =
    balanceQuery.isError && balanceQuery.error instanceof ApiError && balanceQuery.error.status === 403;
  const createWithdrawal = useCreateWithdrawal();

  function validate(): string | null {
    if (!campaignId) return 'Choose the campaign to withdraw from.';
    const amount = Number(amountMajor);
    if (!amountMajor || Number.isNaN(amount) || amount <= 0) {
      return 'Enter a withdrawal amount greater than zero.';
    }
    if (balanceDenied) {
      return 'You can only request withdrawals for campaigns you manage.';
    }
    if (availableMajor !== null && amount > availableMajor) {
      return 'The amount is more than the available balance for this campaign.';
    }
    if (method === 'BANK') {
      if (!accountName.trim()) return 'Enter the account holder name.';
      if (!accountNumber.trim()) return 'Enter the account number.';
      if (!bankName.trim()) return 'Enter the bank name.';
    } else {
      if (!network.trim()) return 'Enter the mobile money network (e.g. MTN, Airtel).';
      if (!phone.trim()) return 'Enter the mobile money phone number.';
    }
    return null;
  }

  async function handleSubmit() {
    setFormError(null);
    const error = validate();
    if (error) {
      setFormError(error);
      toast.error(error);
      return;
    }
    setSubmitting(true);
    try {
      const destination: Record<string, string> =
        method === 'BANK'
          ? {
              accountName: accountName.trim(),
              accountNumber: accountNumber.trim(),
              bankName: bankName.trim(),
            }
          : {
              network: network.trim(),
              phone: phone.trim(),
            };
      await createWithdrawal.mutateAsync({
        campaignId,
        amountMinor: minorFromMajor(Number(amountMajor), currency),
        method,
        destination,
      });
      toast.success('Withdrawal requested');
      navigate('/organizer');
    } catch (err) {
      const message =
        err instanceof ApiError && err.message ? err.message : 'Could not request the withdrawal. Please try again.';
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (campaignsQuery.isLoading) {
    return (
      <div className="container max-w-2xl space-y-6 py-6 md:py-10">
        <Skeleton className="h-9 w-64" />
        <Card>
          <CardContent className="space-y-4 p-6">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (campaigns.length === 0) {
    return (
      <div className="container max-w-2xl py-6 md:py-10">
        <EmptyState
          icon={Banknote}
          title="Nothing to withdraw yet"
          description="Withdrawals need a campaign with settled donations. Start a campaign first, and come back once gifts come in."
          action={
            <Button asChild variant="accent">
              <Link to="/start">Start a campaign</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="container max-w-2xl py-6 md:py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Request withdrawal</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Payout settled donations to your bank account or mobile money wallet. Requests are reviewed by the KINDORA
          team.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Available balance</CardTitle>
            <CardDescription>
              {selectedCampaign ? selectedCampaign.title : 'Select a campaign to see its balance.'}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {campaignId && balanceQuery.isLoading ? (
            <Skeleton className="h-9 w-44" />
          ) : balanceDenied ? (
            <p className="flex items-center gap-2 text-base font-semibold text-muted-foreground">
              <AlertCircle className="h-5 w-5" aria-hidden="true" />
              Not permitted — balances are visible to campaign managers only.
            </p>
          ) : (
            <p className="text-3xl font-extrabold text-primary">
              {campaignId && balance ? formatMoney(balance.availableMinor, balance.currency) : '—'}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Withdrawal details</CardTitle>
          <CardDescription>Where should the money go, and how much?</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="wd-campaign">Campaign</Label>
              <Select value={campaignId} onValueChange={setCampaignId}>
                <SelectTrigger id="wd-campaign">
                  <SelectValue placeholder="Choose a campaign" />
                </SelectTrigger>
                <SelectContent>
                  {campaignOptions.map((c) => {
                    const badge = campaignStatusBadge(c.status);
                    return (
                      <SelectItem key={c.id} value={c.id}>
                        {c.title} ({badge.label})
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wd-amount">Amount ({currency})</Label>
              <Input
                id="wd-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={amountMajor}
                onChange={(e) => setAmountMajor(e.target.value)}
                placeholder="150000"
                aria-invalid={Boolean(formError && formError.toLowerCase().includes('amount'))}
              />
              <p className="text-xs text-muted-foreground">
                {balanceDenied
                  ? 'You cannot view the balance of this campaign.'
                  : availableMajor !== null
                    ? `Up to ${formatMoney(balance?.availableMinor ?? '0', currency)} available.`
                    : 'Balance appears once a campaign is selected.'}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wd-method">Payout method</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as WithdrawMethod)}>
                <SelectTrigger id="wd-method">
                  <SelectValue placeholder="Choose a method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BANK">Bank transfer</SelectItem>
                  <SelectItem value="MOBILE_MONEY">Mobile money</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {method === 'BANK' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="wd-account-name">Account holder name</Label>
                  <Input
                    id="wd-account-name"
                    autoComplete="name"
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    placeholder="Amara Okafor"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wd-account-number">Account number</Label>
                  <Input
                    id="wd-account-number"
                    inputMode="numeric"
                    autoComplete="off"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    placeholder="0123456789"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="wd-bank-name">Bank name</Label>
                  <Input
                    id="wd-bank-name"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder="Guaranty Trust Bank"
                  />
                </div>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="wd-network">Network</Label>
                  <Input
                    id="wd-network"
                    value={network}
                    onChange={(e) => setNetwork(e.target.value)}
                    placeholder="MTN"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wd-phone">Phone number</Label>
                  <Input
                    id="wd-phone"
                    type="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+234 800 000 0000"
                  />
                </div>
              </div>
            )}

            {formError && (
              <p role="alert" className="flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {formError}
              </p>
            )}

            <Button type="submit" className="w-full sm:w-auto" disabled={submitting || (balanceDenied && Boolean(campaignId))}>
              {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
              {submitting ? 'Requesting…' : 'Request withdrawal'}
            </Button>
          </form>

          <div className="mt-6 space-y-2">
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Banknote className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Platform fee: 0% (tips-based model). Provider transfer fees may apply.
            </p>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              {method === 'BANK' ? (
                <Banknote className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              Double-check your details — payouts sent to a wrong account may be unrecoverable.
            </p>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Requests are reviewed by the KINDORA team, usually within 1–2 business days.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
