export const APP_NAME = 'KINDORA';
export const APP_TAGLINE = 'Goodness, in motion.';

export const CATEGORIES = [
  { slug: 'education', name: 'Education', icon: 'GraduationCap' },
  { slug: 'health', name: 'Medical & Health', icon: 'HeartPulse' },
  { slug: 'water', name: 'Water & Sanitation', icon: 'Droplets' },
  { slug: 'environment', name: 'Environment', icon: 'Sprout' },
  { slug: 'emergency', name: 'Emergency Relief', icon: 'ShieldAlert' },
  { slug: 'children', name: 'Children & Family', icon: 'Baby' },
  { slug: 'community', name: 'Community', icon: 'Users' },
  { slug: 'animals', name: 'Animals', icon: 'PawPrint' },
  { slug: 'sports', name: 'Sports', icon: 'Trophy' },
  { slug: 'arts', name: 'Arts & Culture', icon: 'Palette' },
  { slug: 'tech', name: 'Technology Access', icon: 'Laptop' },
  { slug: 'housing', name: 'Housing', icon: 'Home' },
] as const;

export const COUNTRIES = [
  { code: 'NG', name: 'Nigeria' },
  { code: 'GH', name: 'Ghana' },
  { code: 'KE', name: 'Kenya' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'DE', name: 'Germany' },
  { code: 'IN', name: 'India' },
  { code: 'BR', name: 'Brazil' },
] as const;

export const SUPPORTED_CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR', 'GHS', 'KES', 'ZAR'] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  PAYSTACK: 'Paystack (cards, bank transfer, USSD)',
  FLUTTERWAVE: 'Flutterwave (cards, mobile money)',
  STRIPE: 'Stripe (international cards)',
  PAYPAL: 'PayPal',
  MOCK: 'Demo checkout',
};
