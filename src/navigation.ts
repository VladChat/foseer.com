// File: src/navigation.ts
// Purpose: Clean 5-section header for Foseer with dropdown categories.

import { getPermalink, getBlogPermalink, getHomePermalink } from './utils/permalinks';

export const headerData = {
  links: [
    {
      text: 'News',
      href: getPermalink('/sections/news'),
      links: [
        { text: 'U.S. Politics', href: getPermalink('/sections/news/us-politics') },
        { text: 'Global Conflicts', href: getPermalink('/sections/news/global-conflicts') },
      ],
    },
    {
      text: 'Technology',
      href: getPermalink('/sections/technology'),
      links: [
        { text: 'AI & Big Tech', href: getPermalink('/sections/technology/ai-big-tech') },
        { text: 'Cybersecurity', href: getPermalink('/sections/technology/cybersecurity') },
        { text: 'Tech & Gadgets', href: getPermalink('/sections/technology/tech-gadgets') },
      ],
    },
    {
      text: 'Business',
      href: getPermalink('/sections/business-markets'),
      links: [
        { text: 'Stock Market & Economy', href: getPermalink('/sections/business-markets/stock-market-economy') },
        { text: 'Crypto & Bitcoin', href: getPermalink('/sections/business-markets/crypto-bitcoin') },
        { text: 'Personal Finance', href: getPermalink('/sections/business-markets/consumer-money-personal-finance') },
      ],
    },
    {
      text: 'Science',
      href: getPermalink('/sections/science-innovation'),
      links: [
        { text: 'Climate & Weather', href: getPermalink('/sections/science-innovation/climate-extreme-weather') },
        { text: 'Space & Astronomy', href: getPermalink('/sections/science-innovation/space-astronomy') },
        { text: 'Health & Medicine', href: getPermalink('/sections/science-innovation/health-science') },
      ],
    },
  ],

  actions: [
    {
      text: 'Latest',
      href: getBlogPermalink(),
    },
  ],
};

export const footerData = {
  links: [
    {
      title: 'Coverage',
      links: [
        { text: 'News', href: getPermalink('/sections/news') },
        { text: 'Business', href: getPermalink('/sections/business-markets') },
        { text: 'Technology', href: getPermalink('/sections/technology') },
        { text: 'Science', href: getPermalink('/sections/science-innovation') },
      ],
    },
    {
      title: 'Browse',
      links: [
        { text: 'Latest', href: getBlogPermalink() },
        { text: 'Explainers', href: getPermalink('/sections/explainers') },
      ],
    },
  ],

  secondaryLinks: [
    { text: 'Home', href: getHomePermalink() },
  ],

  socialLinks: [],

  footNote: '© Foseer. Reporting, context, and analysis.',
};
