// File: src/utils/taxonomy-navigation.ts
// Purpose: Single source of truth for visible site navigation derived from taxonomy.
//
// This utility ensures the visible navigation, header, footer, and homepage
// all derive from the same canonical taxonomy model.
//
// Visible Section Policy:
// - "core" sections: Always visible in main navigation (derived from taxonomy registry)
// - No special-only sections are assumed here; navigation follows the active taxonomy model.
//
// This keeps the primary navigation aligned with the single source of truth
// in qwen-data/contracts/taxonomy-registry.json.

import { getSections, getTopicsBySection, type Section, type Topic } from './foseer-taxonomy.js';
import { getPermalink } from './permalinks.js';

/**
 * Navigation link for header dropdown menu
 */
export interface NavDropdownLink {
  text: string;
  href: string;
}

/**
 * Navigation item for header (with optional dropdown)
 */
export interface NavItem {
  text: string;
  href: string;
  links?: NavDropdownLink[];
  sectionId: string;
  kind: 'core' | 'special';
}

/**
 * Footer link group
 */
export interface FooterLinkGroup {
  title: string;
  links: NavDropdownLink[];
  sectionIds: string[];
}

/**
 * Get all visible core sections for primary navigation.
 * These are the sections shown in the header navigation.
 * 
 * Visible sections are whatever taxonomy registry marks as core.
 */
export function getVisibleCoreSections(): Section[] {
  const allSections = getSections();
  return allSections.filter((section) => section.kind === 'core');
}

/**
 * Get all special sections (for future footer/contextual UI).
 * Current taxonomy has no special sections, but the contract stays stable for future growth.
 */
export function getSpecialSections(): Section[] {
  const allSections = getSections();
  return allSections.filter((section) => section.kind === 'special');
}

/**
 * Build header navigation items from taxonomy.
 * This is the single source of truth for header navigation.
 *
 * Policy:
 * - Core sections appear in main navigation
 * - Each section shows up to 5 topics in dropdown (most important first)
 * - Topics are ordered by their position in taxonomy registry
 */
export function buildHeaderNavigation(): NavItem[] {
  const coreSections = getVisibleCoreSections();

  return coreSections.map((section) => {
    const topics = getTopicsBySection(section.id).slice(0, 5);
    const topicLinks: NavDropdownLink[] = topics.map((topic) => ({
      text: topic.title,
      href: getPermalink(`/sections/${section.slug}/${topic.slug}`),
    }));

    return {
      text: section.title,
      href: getPermalink(`/sections/${section.slug}`),
      links: topicLinks.length > 0 ? topicLinks : undefined,
      sectionId: section.id,
      kind: section.kind,
    };
  });
}

/**
 * Build footer navigation from taxonomy.
 *
 * Structure:
 * - "Coverage" group: All core sections
 * - "Browse" group: Latest plus any non-core sections present in taxonomy
 */
export function buildFooterNavigation(): {
  coverageGroup: FooterLinkGroup;
  browseGroup: FooterLinkGroup;
} {
  const coreSections = getVisibleCoreSections();
  const specialSections = getSpecialSections();

  const coverageLinks: NavDropdownLink[] = coreSections.map((section) => ({
    text: section.title,
    href: getPermalink(`/sections/${section.slug}`),
  }));

  const browseLinks: NavDropdownLink[] = [
    { text: 'Latest', href: getPermalink('/latest') },
    ...specialSections.map((section) => ({
      text: section.title,
      href: getPermalink(`/sections/${section.slug}`),
    })),
  ];

  return {
    coverageGroup: {
      title: 'Coverage',
      links: coverageLinks,
      sectionIds: coreSections.map((s) => s.id),
    },
    browseGroup: {
      title: 'Browse',
      links: browseLinks,
      sectionIds: specialSections.map((s) => s.id),
    },
  };
}

/**
 * Get all sections for homepage TopSections component.
 * Returns all taxonomy sections marked as core.
 */
export function getHomepageSections(): Section[] {
  return getVisibleCoreSections();
}

/**
 * Get all topics for a section (for section landing page).
 * This ensures section pages always show the complete topic list from taxonomy.
 */
export function getSectionTopics(sectionId: string): Topic[] {
  return getTopicsBySection(sectionId);
}

/**
 * Check if a section should be visible in primary navigation.
 */
export function isSectionVisibleInNav(sectionId: string): boolean {
  const sections = getVisibleCoreSections();
  return sections.some((s) => s.id === sectionId);
}

/**
 * Get the kind of a section (core vs special).
 */
export function getSectionKind(sectionId: string): 'core' | 'special' | 'unknown' {
  const allSections = getSections();
  const section = allSections.find((s) => s.id === sectionId);
  if (!section) return 'unknown';
  return section.kind as 'core' | 'special';
}

/**
 * Log navigation structure for observability.
 * Useful for debugging taxonomy/navigation drift.
 */
export function logNavigationStructure(): void {
  const nav = buildHeaderNavigation();
  const footer = buildFooterNavigation();

  console.log('[taxonomy-navigation] Header navigation structure:', JSON.stringify({
    coreSections: nav.map((item) => ({
      section: item.text,
      href: item.href,
      topicCount: item.links?.length || 0,
      topics: item.links?.map((l) => l.text),
    })),
  }, null, 2));

  console.log('[taxonomy-navigation] Footer navigation structure:', JSON.stringify({
    coverageSections: footer.coverageGroup.links.map((l) => l.text),
    browseLinks: footer.browseGroup.links.map((l) => l.text),
  }, null, 2));
}
