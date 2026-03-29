// File: src/config/site-legal.ts
// Purpose: Central legal and contact settings reused across Foseer legal pages.

export const SITE_LEGAL = {
  siteName: 'Foseer',
  siteUrl: 'https://foseer.com',
  contactEmail: 'info@foseer.com',
  contactPhoneDisplay: '(224) 532-9236',
  contactPhoneHref: 'tel:+12245329236',
  lastUpdated: 'March 29, 2026',
  jurisdiction: 'Illinois, United States',
  hasUserAccounts: false,
  hasNewsletter: false,
  hasComments: false,
  analyticsEnabled: false,
  advertisingEnabled: false,
  contactFormEnabled: false,
  themePreferenceStorageKey: 'theme',
  editorialSummary:
    'Foseer publishes news, explainers, and analysis across public affairs, business, technology, health, sports, and culture.',
} as const;
