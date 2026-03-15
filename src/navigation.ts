// File: src/navigation.ts
// Purpose: Clean 5-section header for Foseer with dropdown categories.

import { getPermalink, getBlogPermalink, getHomePermalink } from './utils/permalinks';

export const headerData = {
  links: [
    {
      text: 'Trending',
      links: [
        { text: "Today's Signals", href: getPermalink('/trending/today') },
        { text: 'This Week', href: getPermalink('/trending/week') },
        { text: 'Growing Topics', href: getPermalink('/trending/growing') },
        { text: 'Breaking Stories', href: getPermalink('/trending/breaking') },
      ],
    },
    {
      text: 'News',
      links: [
        { text: 'World', href: getPermalink('/news/world') },
        { text: 'U.S. Politics', href: getPermalink('/news/us-politics') },
        { text: 'Economy', href: getPermalink('/news/economy') },
        { text: 'Society', href: getPermalink('/news/society') },
        { text: 'Global Conflicts', href: getPermalink('/news/conflicts') },
      ],
    },
    {
      text: 'Technology',
      links: [
        { text: 'AI & Big Tech', href: getPermalink('/technology/ai-big-tech') },
        { text: 'Cybersecurity', href: getPermalink('/technology/cybersecurity') },
        { text: 'Tech & Gadgets', href: getPermalink('/technology/gadgets') },
        { text: 'Platforms', href: getPermalink('/technology/platforms') },
        { text: 'Social Media Trends', href: getPermalink('/technology/social-media') },
      ],
    },
    {
      text: 'Business',
      links: [
        { text: 'Stock Market & Economy', href: getPermalink('/business/markets') },
        { text: 'Companies', href: getPermalink('/business/companies') },
        { text: 'Startups', href: getPermalink('/business/startups') },
        { text: 'Personal Finance', href: getPermalink('/business/personal-finance') },
        { text: 'Crypto & Bitcoin', href: getPermalink('/business/crypto') },
      ],
    },
    {
      text: 'Science',
      links: [
        { text: 'Climate & Weather', href: getPermalink('/science/climate') },
        { text: 'Space & Astronomy', href: getPermalink('/science/space') },
        { text: 'Health & Medicine', href: getPermalink('/science/health') },
        { text: 'Research & Innovation', href: getPermalink('/science/research') },
      ],
    },
  ],

  actions: [
    {
      text: 'Latest coverage',
      href: getBlogPermalink(),
    },
  ],
};

export const footerData = {
  links: [
    {
      title: 'Coverage',
      links: [
        { text: 'News', href: getPermalink('/news') },
        { text: 'Business', href: getPermalink('/business') },
        { text: 'Technology', href: getPermalink('/technology') },
        { text: 'Science', href: getPermalink('/science') },
      ],
    },
    {
      title: 'Browse',
      links: [
        { text: 'Trending', href: getPermalink('/trending/today') },
        { text: 'Explainers', href: getPermalink('/explainers') },
        { text: 'Latest coverage', href: getBlogPermalink() },
      ],
    },
  ],

  secondaryLinks: [
    { text: 'Home', href: getHomePermalink() },
  ],

  socialLinks: [],

  footNote: '© Foseer. Reporting, context, and analysis.',
};
