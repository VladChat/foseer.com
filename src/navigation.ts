// File: src/navigation.ts
// Purpose: Site navigation derived from the compiled taxonomy registry.

import { buildHeaderNavigation, buildFooterNavigation } from './utils/taxonomy-navigation.js';
import { getBlogPermalink, getHomePermalink } from './utils/permalinks.js';

const headerNav = buildHeaderNavigation();
const footerNav = buildFooterNavigation();

console.log('[navigation] Header sections:', headerNav.map((entry) => entry.text).join(', '));
console.log('[navigation] Footer coverage:', footerNav.coverageGroup.links.length, 'links');
console.log('[navigation] Footer browse:', footerNav.browseGroup.links.length, 'links');

export const headerData = {
  links: headerNav.map((item) => ({
    text: item.text,
    href: item.href,
    links: item.links,
  })),
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
      title: footerNav.coverageGroup.title,
      links: footerNav.coverageGroup.links.map((link) => ({
        text: link.text,
        href: link.href,
      })),
    },
    {
      title: footerNav.browseGroup.title,
      links: footerNav.browseGroup.links.map((link) => ({
        text: link.text,
        href: link.href,
      })),
    },
  ],
  secondaryLinks: [{ text: 'Home', href: getHomePermalink() }],
  socialNodes: [],
  footNote: '© Foseer. Reporting, context, and analysis.',
};

export const navigationTaxonomyInfo = {
  coreSections: headerNav.map((item) => ({
    id: item.sectionId,
    label: item.text,
    href: item.href,
    topicCount: item.links?.length || 0,
    kind: item.kind,
  })),
  specialSections: footerNav.browseGroup.links.slice(1).map((link) => ({
    label: link.text,
    href: link.href,
  })),
  generatedAt: new Date().toISOString(),
};
