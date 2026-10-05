// Single source of plan display data for the marketing site (home #pricing section).
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
  annualList: number;
  annualPep: number;
  annualLink: string;
  annualPromoCode: 'NAV70' | 'NAV100';
}

/** Offer window close, 30 Oct 2026 23:59 SGT — mirrors ANNUAL_OFFER_CLOSES_MS in lib/annual-pricing.ts. */
export const ANNUAL_OFFER_CLOSES_MS = Date.UTC(2026, 9, 30, 15, 59);
/** Flip to false on 1 Nov 2026 to close new sign-ups (every Subscribe button becomes a notice). */
export const SIGNUPS_OPEN = true;

export const PLANS: Plan[] = [
  { code: 'SG', name: 'Singapore', tier: 'single', desc: 'All Singapore stocks, futures & indices',
    listMonthly: 36, listQuarterly: 108, pepMonthly: 29, pepQuarterly: 87,
    features: ['All SG stocks, futures & indices', 'Private SG signal group', '~10 large-cap signals'],
    link: 'https://buy.stripe.com/5kQ00lb123X5f6Bb044ow05', promoCode: 'NAV21',
    annualList: 360, annualPep: 290, annualPromoCode: 'NAV70', annualLink: 'https://buy.stripe.com/fZu00l5GIbpxaQlecg4ow0e' },
  { code: 'US', name: 'United States', tier: 'single', desc: 'US stocks, futures, indices + DAX 40 & Nikkei 225',
    listMonthly: 56, listQuarterly: 168, pepMonthly: 49, pepQuarterly: 147,
    features: ['All US stocks, futures & indices', 'Bonus: DAX 40 & Nikkei 225', 'Private US signal group'],
    link: 'https://buy.stripe.com/8x24gB6KM65de2x9W04ow06', promoCode: 'NAV21',
    annualList: 560, annualPep: 490, annualPromoCode: 'NAV70', annualLink: 'https://buy.stripe.com/bJe5kF4CEdxF1fL5FK4ow0h' },
  { code: 'HK', name: 'Hong Kong', tier: 'single', desc: 'All Hong Kong stocks, futures & indices',
    listMonthly: 56, listQuarterly: 168, pepMonthly: 49, pepQuarterly: 147,
    features: ['All HK stocks, futures & indices', 'Private HK signal group', '~10 large-cap signals'],
    link: 'https://buy.stripe.com/3cI9AV2uw3X53nT9W04ow08', promoCode: 'NAV21',
    annualList: 560, annualPep: 490, annualPromoCode: 'NAV70', annualLink: 'https://buy.stripe.com/7sY6oJfhi0KT9Mh2ty4ow0g' },
  { code: 'FXMC', name: 'FXMC', tier: 'single', desc: 'Forex, Crypto & Metals (Gold & Silver)',
    listMonthly: 56, listQuarterly: 168, pepMonthly: 49, pepQuarterly: 147,
    features: ['All forex pairs', 'All major cryptocurrencies', 'Gold & Silver'],
    link: 'https://buy.stripe.com/9B6eVfb120KT7E9gko4ow01', promoCode: 'NAV21',
    annualList: 560, annualPep: 490, annualPromoCode: 'NAV70', annualLink: 'https://buy.stripe.com/dRm9AV3yAgJR6A5c484ow0f' },
  { code: 'US_HK', name: 'US + HK', tier: 'combo', desc: 'Major markets bundle', saveQuarterly: 147,
    listMonthly: 99, listQuarterly: 297, pepMonthly: 89, pepQuarterly: 267,
    features: ['US: all stocks, futures & indices + DAX 40 & Nikkei 225', 'HK: all stocks, futures & indices', 'Singapore market FREE', '3 private signal groups (~30 signals)'],
    link: 'https://buy.stripe.com/5kQ9AVfhi1OXf6Bfgk4ow03', promoCode: 'NAV30',
    annualList: 990, annualPep: 890, annualPromoCode: 'NAV100', annualLink: 'https://buy.stripe.com/7sYcN71qsdxFe2xfgk4ow0i' },
  { code: 'US_FXMC', name: 'US + FXMC', tier: 'combo', desc: 'Diversification bundle', saveQuarterly: 147,
    listMonthly: 99, listQuarterly: 297, pepMonthly: 89, pepQuarterly: 267,
    features: ['US: all stocks, futures & indices + DAX 40 & Nikkei 225', 'FXMC: all forex, crypto + Gold/Silver', 'Singapore market FREE', '3 private signal groups (~30 signals)'],
    link: 'https://buy.stripe.com/28EbJ3c56ctB5w10lq4ow04', promoCode: 'NAV30',
    annualList: 990, annualPep: 890, annualPromoCode: 'NAV100', annualLink: 'https://buy.stripe.com/3cI8wR2uw65d0bH9W04ow0j' },
  { code: 'HK_FXMC', name: 'HK + FXMC', tier: 'combo', desc: 'Asia & global assets', saveQuarterly: 147,
    listMonthly: 99, listQuarterly: 297, pepMonthly: 89, pepQuarterly: 267,
    features: ['HK: all stocks, futures & indices', 'FXMC: all forex, crypto + Gold/Silver', 'Singapore market FREE', '3 private signal groups (~30 signals)'],
    link: 'https://buy.stripe.com/5kQbJ31qseBJ6A5ecg4ow09', promoCode: 'NAV30',
    annualList: 990, annualPep: 890, annualPromoCode: 'NAV100', annualLink: 'https://buy.stripe.com/8x23cx7OQ1OX4rX8RW4ow0k' },
  { code: 'ALL', name: 'All Markets', tier: 'all', desc: 'US + HK + SG + FXMC — everything', saveQuarterly: 195,
    listMonthly: 139, listQuarterly: 417, pepMonthly: 129, pepQuarterly: 387,
    features: ['US, HK, SG — all stocks, futures & indices', 'Forex, crypto & all metals', 'Unlimited — works on any instrument on TradingView', 'All 4 private signal groups'],
    link: 'https://buy.stripe.com/bJecN74CE65d5w17NS4ow07', promoCode: 'NAV30',
    annualList: 1390, annualPep: 1290, annualPromoCode: 'NAV100', annualLink: 'https://buy.stripe.com/9B64gB3yA3X5aQl7NS4ow0l' },
];
