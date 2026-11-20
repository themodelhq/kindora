import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, ChevronLeft, ChevronRight, Loader2, RefreshCcw, Sparkles, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useAiStoryDraft, useAiStoryImprove, useCreateCampaign, useSubmitCampaign } from '@/api/hooks';
import { CATEGORIES, COUNTRIES, SUPPORTED_CURRENCIES } from '@/lib/constants';
import { formatMoney, minorFromMajor } from '@/lib/money';
import { formatDate, cn } from '@/lib/utils';
import { ApiError } from '@/lib/http';

const STEPS = ['Basics', 'Story', 'Review', 'Submit'] as const;
const DRAFT_KEY = 'kindora.campaign-wizard';
const MIN_STORY_LENGTH = 120;

interface WizardData {
  title: string;
  excerpt: string;
  category: string;
  country: string;
  city: string;
  targetMajor: string;
  currency: string;
  deadline: string;
  story: string;
}

const EMPTY_DATA: WizardData = {
  title: '',
  excerpt: '',
  category: '',
  country: 'NG',
  city: '',
  targetMajor: '',
  currency: 'NGN',
  deadline: '',
  story: '',
};

interface WizardDraft {
  step: number;
  data: WizardData;
}

function loadDraft(): WizardDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WizardDraft> | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') return null;
    return {
      step: typeof parsed.step === 'number' ? Math.min(3, Math.max(0, parsed.step)) : 0,
      data: { ...EMPTY_DATA, ...parsed.data },
    };
  } catch {
    return null;
  }
}

function categoryOf(slug: string) {
  return CATEGORIES.find((c) => c.slug === slug);
}

function countryOf(code: string) {
  return COUNTRIES.find((c) => c.code === code);
}

export default function StartCampaignWizardPage() {
  const navigate = useNavigate();
  const createCampaign = useCreateCampaign();
  const submitCampaign = useSubmitCampaign();
  const aiDraft = useAiStoryDraft();
  const aiImprove = useAiStoryImprove();

  const [savedDraft] = useState(() => loadDraft());
  const [step, setStep] = useState(savedDraft?.step ?? 0);
  const [data, setData] = useState<WizardData>(savedDraft?.data ?? EMPTY_DATA);
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ step, data }));
    } catch {
      // Storage unavailable (private mode) — the wizard still works without persistence.
    }
  }, [step, data]);

  const targetMinor = useMemo(
    () => minorFromMajor(Number(data.targetMajor) || 0, data.currency),
    [data.targetMajor, data.currency],
  );

  const patch = (partial: Partial<WizardData>) => setData((prev) => ({ ...prev, ...partial }));

  function validateStep(current: number): Record<string, string> {
    const errors: Record<string, string> = {};
    if (current === 0) {
      if (data.title.trim().length < 8) errors.title = 'Give your campaign a clear title (at least 8 characters).';
      if (data.excerpt.trim().length < 20) errors.excerpt = 'Write a short summary of at least 20 characters.';
      if (!data.category) errors.category = 'Choose the category that best fits your cause.';
      if (!data.country) errors.country = 'Choose a country.';
      const target = Number(data.targetMajor);
      if (!data.targetMajor || Number.isNaN(target) || target <= 0) {
        errors.targetMajor = 'Enter a fundraising target greater than zero.';
      }
    }
    if (current === 1) {
      if (data.story.trim().length < MIN_STORY_LENGTH) {
        errors.story = `Your story needs at least ${MIN_STORY_LENGTH} characters — currently ${data.story.trim().length}.`;
      }
    }
    return errors;
  }

  function goNext() {
    const errors = validateStep(step);
    setStepErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error('Please fix the highlighted fields first.');
      return;
    }
    setStep((s) => Math.min(3, s + 1));
  }

  function draftStory() {
    aiDraft.mutate(
      {
        title: data.title.trim(),
        category: data.category,
        targetAmountMajor: Number(data.targetMajor) || undefined,
        country: data.country || undefined,
      },
      {
        onSuccess: (res) => {
          patch({ story: res.output });
          toast.success('Story drafted. Edit it to make it yours.');
        },
        onError: (error) =>
          toast.error(
            error instanceof ApiError && error.message
              ? error.message
              : 'Could not draft the story right now. Please try again.',
          ),
      },
    );
  }

  function improveStory() {
    if (!data.story.trim()) {
      toast.error('Write a few lines first, then run Improve.');
      return;
    }
    aiImprove.mutate(
      { story: data.story },
      {
        onSuccess: (res) => {
          patch({ story: res.output });
          toast.success('Story improved. Review and edit as you like.');
        },
        onError: (error) =>
          toast.error(
            error instanceof ApiError && error.message
              ? error.message
              : 'Could not improve the story right now. Please try again.',
          ),
      },
    );
  }

  function startOver() {
    setData(EMPTY_DATA);
    setStep(0);
    setStepErrors({});
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // ignore
    }
    toast.success('Draft cleared. Starting fresh.');
  }

  async function submitCampaignRequest() {
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        title: data.title.trim(),
        excerpt: data.excerpt.trim(),
        story: data.story.trim(),
        categorySlug: data.category,
        country: data.country,
        city: data.city.trim() || undefined,
        targetAmountMajor: Number(data.targetMajor) || 1,
        currency: data.currency,
        ...(data.deadline ? { deadline: new Date(`${data.deadline}T23:59:59`).toISOString() } : {}),
      };
      const created = await createCampaign.mutateAsync(payload);
      const campaign = created?.campaign;
      if (!campaign?.id) throw new Error('The campaign could not be created. Please try again.');
      await submitCampaign.mutateAsync(campaign.id);
      try {
        window.localStorage.removeItem(DRAFT_KEY);
      } catch {
        // ignore
      }
      toast.success('Submitted for review');
      navigate(`/organizer/campaigns/${campaign.id}`);
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.message
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Something went wrong while submitting. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const selectedCategory = categoryOf(data.category);
  const selectedCountry = countryOf(data.country);

  return (
    <div className="container max-w-3xl py-6 md:py-10">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Start a campaign</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tell people what you are raising funds for. Your draft saves automatically on this device.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={startOver}>
          <RefreshCcw aria-hidden="true" />
          Start over
        </Button>
      </div>

      <ol
        className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2"
        aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
      >
        {STEPS.map((label, index) => (
          <li key={label} className="flex items-center gap-2" aria-current={index === step ? 'step' : undefined}>
            <button
              type="button"
              onClick={() => index < step && setStep(index)}
              disabled={index > step}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold transition-colors',
                index < step && 'cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90',
                index === step && 'cursor-default bg-primary text-primary-foreground ring-4 ring-primary/15',
                index > step && 'cursor-default bg-muted text-muted-foreground',
              )}
              aria-label={`${label}${index < step ? ' (completed, go back)' : ''}`}
            >
              {index < step ? <Check className="h-4 w-4" aria-hidden="true" /> : index + 1}
            </button>
            <span className={cn('text-sm font-semibold', index === step ? 'text-foreground' : 'text-muted-foreground')}>
              {label}
            </span>
            {index < STEPS.length - 1 && <span className="hidden h-px w-8 bg-border sm:block" aria-hidden="true" />}
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="space-y-5 p-6">
          {step === 0 && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-title">Campaign title</Label>
                <Input
                  id="wiz-title"
                  value={data.title}
                  onChange={(e) => patch({ title: e.target.value })}
                  placeholder="Clean water for Obosi community"
                  aria-invalid={Boolean(stepErrors.title)}
                  aria-describedby={stepErrors.title ? 'wiz-title-error' : undefined}
                />
                {stepErrors.title && (
                  <p id="wiz-title-error" role="alert" className="text-xs font-medium text-destructive">
                    {stepErrors.title}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="wiz-excerpt">Short summary</Label>
                <Textarea
                  id="wiz-excerpt"
                  value={data.excerpt}
                  onChange={(e) => patch({ excerpt: e.target.value })}
                  placeholder="One or two sentences that appear on campaign cards."
                  className="min-h-[80px]"
                  aria-invalid={Boolean(stepErrors.excerpt)}
                  aria-describedby={stepErrors.excerpt ? 'wiz-excerpt-error' : undefined}
                />
                {stepErrors.excerpt && (
                  <p id="wiz-excerpt-error" role="alert" className="text-xs font-medium text-destructive">
                    {stepErrors.excerpt}
                  </p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-category">Category</Label>
                  <Select value={data.category} onValueChange={(v) => patch({ category: v })}>
                    <SelectTrigger id="wiz-category" aria-invalid={Boolean(stepErrors.category)}>
                      <SelectValue placeholder="Choose a category" />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c.slug} value={c.slug}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {stepErrors.category && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      {stepErrors.category}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="wiz-country">Country</Label>
                  <Select value={data.country} onValueChange={(v) => patch({ country: v })}>
                    <SelectTrigger id="wiz-country">
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
                  {stepErrors.country && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      {stepErrors.country}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="wiz-city">City (optional)</Label>
                  <Input
                    id="wiz-city"
                    value={data.city}
                    onChange={(e) => patch({ city: e.target.value })}
                    placeholder="Onitsha"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="wiz-currency">Currency</Label>
                  <Select value={data.currency} onValueChange={(v) => patch({ currency: v })}>
                    <SelectTrigger id="wiz-currency">
                      <SelectValue placeholder="Choose a currency" />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_CURRENCIES.map((currency) => (
                        <SelectItem key={currency} value={currency}>
                          {currency}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="wiz-target">Fundraising target ({data.currency})</Label>
                  <Input
                    id="wiz-target"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={data.targetMajor}
                    onChange={(e) => patch({ targetMajor: e.target.value })}
                    placeholder="500000"
                    aria-invalid={Boolean(stepErrors.targetMajor)}
                    aria-describedby={stepErrors.targetMajor ? 'wiz-target-error' : 'wiz-target-hint'}
                  />
                  {stepErrors.targetMajor ? (
                    <p id="wiz-target-error" role="alert" className="text-xs font-medium text-destructive">
                      {stepErrors.targetMajor}
                    </p>
                  ) : (
                    <p id="wiz-target-hint" className="text-xs text-muted-foreground">
                      {targetMinor > 0
                        ? `Goal: ${formatMoney(targetMinor, data.currency)}`
                        : 'The total amount you want to raise.'}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="wiz-deadline">Deadline (optional)</Label>
                  <Input
                    id="wiz-deadline"
                    type="date"
                    value={data.deadline}
                    onChange={(e) => patch({ deadline: e.target.value })}
                    min={new Date().toISOString().slice(0, 10)}
                  />
                </div>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-story">Your story</Label>
                <Textarea
                  id="wiz-story"
                  value={data.story}
                  onChange={(e) => patch({ story: e.target.value })}
                  placeholder="Explain the problem, the people affected, what funds will pay for, and why you can deliver it."
                  className="min-h-[280px]"
                  aria-invalid={Boolean(stepErrors.story)}
                  aria-describedby="wiz-story-hint"
                />
                <p id="wiz-story-hint" className="text-xs text-muted-foreground" aria-live="polite">
                  {data.story.trim().length} characters — aim for at least {MIN_STORY_LENGTH}. AI drafts are starting
                  points - add your own details
                </p>
                {stepErrors.story && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {stepErrors.story}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-3">
                <Button type="button" variant="accent" onClick={draftStory} disabled={aiDraft.isPending}>
                  {aiDraft.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wand2 aria-hidden="true" />}
                  {aiDraft.isPending ? 'Drafting…' : 'Draft my story'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={improveStory}
                  disabled={aiImprove.isPending || !data.story.trim()}
                >
                  {aiImprove.isPending ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Sparkles aria-hidden="true" />
                  )}
                  {aiImprove.isPending ? 'Improving…' : 'Improve this story'}
                </Button>
              </div>
            </>
          )}

          {step === 2 && (
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Title</dt>
                <dd className="mt-0.5 font-semibold">{data.title || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</dt>
                <dd className="mt-0.5">{data.excerpt || '—'}</dd>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Category</dt>
                  <dd className="mt-0.5">{selectedCategory?.name ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Location</dt>
                  <dd className="mt-0.5">{[data.city.trim(), selectedCountry?.name].filter(Boolean).join(', ') || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Target</dt>
                  <dd className="mt-0.5 font-semibold text-primary">{formatMoney(targetMinor, data.currency)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Deadline</dt>
                  <dd className="mt-0.5">{data.deadline ? formatDate(data.deadline) : 'No deadline set'}</dd>
                </div>
              </div>
              <Separator />
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Story</dt>
                <dd className="mt-1 max-h-48 overflow-y-auto whitespace-pre-line rounded-xl bg-muted/50 p-3 text-sm leading-relaxed">
                  {data.story || '—'}
                </dd>
              </div>
              <p className="rounded-xl bg-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                After your campaign is approved it appears publicly, and you can manage it from the{' '}
                <Link to="/organizer" className="font-semibold text-primary hover:underline">
                  organizer dashboard
                </Link>
                . Cover image uploads happen from the organizer dashboard once file storage is configured.
              </p>
            </dl>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold">Ready to submit for review</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Creating <span className="font-semibold text-foreground">{data.title || 'your campaign'}</span>{' '}
                targeting <span className="font-semibold text-primary">{formatMoney(targetMinor, data.currency)}</span>
                {selectedCategory ? <> in {selectedCategory.name.toLowerCase()}</> : null}. Our team reviews submissions
                before they go live — you can keep editing the story from the organizer dashboard while you wait.
              </p>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  Reviewed by the KINDORA team, usually within 1–2 days.
                </li>
                <li className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  Cover images and video can be added later from the organizer dashboard.
                </li>
                <li className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  You can submit the campaign for review again if it is ever declined.
                </li>
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0 || submitting}
            >
              <ChevronLeft aria-hidden="true" />
              Back
            </Button>

            {step < 3 ? (
              <Button type="button" onClick={goNext}>
                Continue
                <ChevronRight aria-hidden="true" />
              </Button>
            ) : (
              <Button type="button" onClick={() => void submitCampaignRequest()} disabled={submitting}>
                {submitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                {submitting ? 'Submitting…' : 'Create and submit for review'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
