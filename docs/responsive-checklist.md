# Foseer Responsive Design Checklist

## Mandatory Responsive Verification

All UI changes on the Foseer project must be validated across multiple device sizes to ensure consistent user experience.

## Required Breakpoints

Test at minimum these viewport widths:
- [ ] Mobile: 375px
- [ ] Large Mobile: 428px  
- [ ] Tablet Portrait: 768px
- [ ] Tablet Landscape (iPad): 1024px
- [ ] Desktop: 1280px+

## Required Responsive Checks

For each breakpoint, verify:

### Layout
- [ ] Layout does not overflow horizontally
- [ ] Content containers adjust appropriately
- [ ] Grid systems collapse/expand correctly
- [ ] No horizontal scrolling required for main content

### Typography
- [ ] Text remains readable (minimum 16px on mobile)
- [ ] Line heights are appropriate for each screen size
- [ ] Headings scale proportionally
- [ ] No text clipping or overflow

### Navigation
- [ ] Main navigation works on small screens
- [ ] Mobile menu functions properly
- [ ] Navigation items are tappable (minimum 44px touch targets)
- [ ] Menu overlays or collapses appropriately

### Cards and Content Blocks
- [ ] Card grids collapse correctly (single column on mobile)
- [ ] Card content remains readable
- [ ] Images scale appropriately within cards
- [ ] Buttons remain accessible and properly sized

### Hero Sections
- [ ] Hero sections scale properly
- [ ] Hero text remains readable
- [ ] Call-to-action buttons are accessible
- [ ] Background images scale without distortion

### Spacing and Visual Balance
- [ ] Spacing remains balanced across devices
- [ ] Padding and margins are appropriate
- [ ] Visual hierarchy is maintained
- [ ] No cramped or overly spaced elements

### Element Integrity
- [ ] No clipped elements or content
- [ ] Images display correctly (no stretching/distortion)
- [ ] Forms remain functional and accessible
- [ ] Interactive elements work properly

## Completion Requirements

Before marking any UI work as complete:
- [ ] All breakpoints tested
- [ ] All checklist items verified
- [ ] Responsive validation documented
- [ ] Cross-browser testing performed (Chrome DevTools, Safari, Firefox)