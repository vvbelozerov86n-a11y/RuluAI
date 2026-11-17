# Task cards — reference restoration

Date: 2026-11-18

Source visual truth: user attachment `retest-popover-desktop.jpg` (Desktop), 1259 × 860 px.
Implementation screenshots: `outputs/cards-reference-2026-11-18/cards-desktop.jpg` and `cards-mobile.jpg` (local QA artifacts, excluded from Git).

## Scope and comparison

Restore the requested task-card mosaic as the default on the home page and inside groups. Keep the existing functional list alternative and the previous accessibility improvements. The search/summary toolbar is outside the requested card scope.

The source and final desktop screenshot were opened together in one comparison input. Both show the first six root cards and the expanded AI participant popover for “Улучшить сервис”. Source content is historical: current overdue indicators reflect current task/descendant data.

Desktop capture: 1274 × 870 CSS viewport, client width 1259. The browser returns a 1259 × 860 JPEG (capture scale approximately 0.988); comparison uses equal pixel dimensions and the card grid as the alignment anchor. The original reference CSS viewport/DPR is unavailable. The final grid is about 10 px higher in the capture due to the current toolbar and scroll position; this is a crop difference, not changed card geometry. Browser JPEG compression limits exact antialiasing comparisons.

Focused inspection: first wide teal card, tall cream card, and the participant popover are visible in the full-size comparison. DOM geometry confirms a four-column grid, 17 px gaps, 330 px rows, first card spanning two columns, and second card spanning two rows (677 px). Separate crops were unnecessary for these large regions.

## Findings and fidelity surfaces

- Layout/spacing: requested mosaic restored. Existing rounded corners, spacing, shadows, card proportions and bottom-aligned counters/progress are retained. No actionable P0/P1/P2 mismatch within the requested card scope.
- Typography: existing font stack and large heading sizes retained. Secondary labels remain 13 px and status chips 12 px from the prior readability fixes instead of the reference's smaller labels. This is an intentional accessibility preservation.
- Colors/tokens: teal, cream, cyan and slate cards match the source palette and order. Current semantic status colors retain the previous contrast improvements.
- Assets: existing card treatments, participant avatars and icons reused. No substituted generated assets or new decorative artwork.
- Copy/content: titles, owners, participant counts, dates and progress come from the existing task data. The popover is kept inside the viewport, unlike the clipped right edge in the reference.

## Interaction and responsive checks

- `/` without layout query: 8 cards and active “Карточки”.
- “Список”: explicit `layout=list`, 8 rows and no cards.
- “Карточки”: explicit `layout=cards`, mosaic restored.
- Open “Запустить продукт”: 3 nested cards by default.
- Desktop participant counter expands the correct two AI participants; Escape closes it.
- Mobile viewport 390 × 844 CSS px, client width 375: document width 375, no horizontal overflow; one column, 310 px minimum card height. The 375 × 812 JPEG is the browser-scaled capture.
- Mobile popover bounds: left 83, right 363, top 451.29, bottom 726.13 CSS px; entirely within the client viewport.
- Browser console errors: none.
- Existing UI tests: 9/9 passed. TypeScript: passed.

## Comparison history

Initial mismatch: the main view selected the compact list instead of the existing mosaic. Fixed root/group route defaults and GroupView fallback; made the list link explicit. The final visual comparison found no further actionable P0/P1/P2 issues. No visual iteration was required after restoring the existing card component.

## Implementation checklist

- [x] Default cards on home and nested groups.
- [x] Explicit list alternative remains functional.
- [x] Existing sizes, colors, owners, participants and progress retained.
- [x] Desktop and mobile interaction checks completed.
- [x] Source/reference comparison completed.

Follow-up polish: none required for this scoped change.

final result: passed
