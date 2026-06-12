// Single source of plan display data for the marketing site (pricing page + home teaser).
// Prices are the 2026 lineup from ../../../Navigator Business Resources/business-model.md.
// Singles carry the NAV21 promo code; combos + All Markets carry NAV30. The Pepperstone
// price = list price minus that coupon, applied at Stripe checkout via prefilled_promo_code.

export type PlanTier = 'single' | 'combo' | 'all';

export interface Plan {
  code: string;
  name: string;
  desc: string;
  tier: PlanTier;
  listMonthly: number;
  listQuarterly: number;
  pepMonthly: number;
  pepQuarterly: number;
  features: string[];
  link: string;
  promoCode: 'NAV21' | 'NAV30';
  /** Bundle saving vs buying the markets separately (combos + All Markets only). */
  saveQuarterly?: number;
}

export const PLANS: Plan[] = [
  { code: 'SG', name: 'Singapore', tier: 'single', desc: 'All Singapore stocks, futures & indices',
    listMonthly: 36, listQuarterly: 108, pepMonthly: 29, pepQuarterly: 87,
    features: ['All SG stocks, futures & indices', 'Private SG signal group', '~10 large-cap signals'],
    link: 'https://buy.stripe.com/5kQ00lb123X5f6Bb044ow05', promoCode: 'NAV21' },
  { code: 'US', name: 'United States', tier: 'single', desc: 'US stocks, futures, indices + DAX 40 & Nikkei 225',
    listMonthly: 56, listQuarterly: 168, pepMonthly: 49, pepQuarterly: 147,
    features: ['All US stocks, futures & indices', 'Bonus: DAX 40 & Nikkei 225', 'Private US signal group'],
    link: 'https://buy.stripe.com/8x24gB6KM65de2x9W04ow06', promoCode: 'NAV21' },
  { code: 'HK', name: 'Hong Kong', tier: 'single', desc: 'All Hong Kong stocks, futures & indices',
    listMonthly: 56, listQuarterly: 168, pepMonthly: 49, pepQuarterly: 147,
    features: ['All HK stocks, futures & indices', 'Private HK signal group', '~10 large-cap signals'],
    link: 'https://buy.stripe.com/3cI9AV2uw3X53nT9W04ow08', promoCode: 'NAV21' },
  { code: 'FXMC', name: 'FXMC', tier: 'single', desc: 'Forex, Crypto & Metals (Gold & Silver)',
    listMonthly: 56, listQuarterly: 168, pepMonthly: 49, pepQuarterly: 147,
    features: ['All forex pairs', 'All major cryptocurrencies', 'Gold & Silver'],
    link: 'https://buy.stripe.com/9B6eVfb120KT7E9gko4ow01', promoCode: 'NAV21' },
  { code: 'US_HK', name: 'US + HK', tier: 'combo', desc: 'Major markets bundle', saveQuarterly: 147,
    listMonthly: 99, listQuarterly: 297, pepMonthly: 89, pepQuarterly: 267,
    features: ['US + HK: all stocks, futures & indices', 'Singapore market FREE', '3 private signal groups'],
    link: 'https://buy.stripe.com/5kQ9AVfhi1OXf6Bfgk4ow03', promoCode: 'NAV30' },
  { code: 'US_FXMC', name: 'US + FXMC', tier: 'combo', desc: 'Diversification bundle', saveQuarterly: 147,
    listMonthly: 99, listQuarterly: 297, pepMonthly: 89, pepQuarterly: 267,
    features: ['US: all stocks, futures & indices', 'FXMC: forex, crypto + Gold/Silver', 'Singapore market FREE'],
    link: 'https://buy.stripe.com/28EbJ3c56ctB5w10lq4ow04', promoCode: 'NAV30' },
  { code: 'HK_FXMC', name: 'HK + FXMC', tier: 'combo', desc: 'Asia & global assets', saveQuarterly: 147,
    listMonthly: 99, listQuarterly: 297, pepMonthly: 89, pepQuarterly: 267,
    features: ['HK: all stocks, futures & indices', 'FXMC: forex, crypto + Gold/Silver', 'Singapore market FREE'],
    link: 'https://buy.stripe.com/5kQbJ31qseBJ6A5ecg4ow09', promoCode: 'NAV30' },
  { code: 'ALL', name: 'All Markets', tier: 'all', desc: 'US + HK + SG + FXMC — everything', saveQuarterly: 195,
    listMonthly: 139, listQuarterly: 417, pepMonthly: 129, pepQuarterly: 387,
    features: ['US, HK, SG — all stocks, futures & indices', 'FXMC: forex, crypto + Gold/Silver', 'All 4 private signal groups'],
    link: 'https://buy.stripe.com/bJecN74CE65d5w17NS4ow07', promoCode: 'NAV30' },
];

export type PriceMode = 'standard' | 'pepperstone';

/** Checkout URL. In pepperstone mode the tier's promo code is pre-filled at Stripe checkout. */
export function checkoutUrl(plan: Plan, mode: PriceMode): string {
  return mode === 'pepperstone'
    ? `${plan.link}?prefilled_promo_code=${plan.promoCode}`
    : plan.link;
}
