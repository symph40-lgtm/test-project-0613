---
version: alpha
name: StockGuard-design-system
description: A calm risk-command interface for StockGuard (스탁가드). Edge-to-edge decision tiles alternate light and dark canvases, framed by tight Pretendard headlines and a single Guard Blue (#0066cc) action color. UI chrome recedes so risk signals, evidence, and next principles can speak clearly — no decorative gradients, no shadows on chrome, only one signature drop-shadow when data imagery or market objects need visual weight.
category: fintech-risk-coaching
homepage: TBD
logo: TBD
verified: 2026-06-14

runtime_deps:
  icons: lucide-react
  fonts: [Pretendard]

colors:
  primary: "#0066cc"
  primary-focus: "#0071e3"
  primary-on-dark: "#2997ff"
  ink: "#1d1d1f"
  body: "#1d1d1f"
  body-on-dark: "#ffffff"
  body-muted: "#cccccc"
  ink-muted-80: "#333333"
  ink-muted-48: "#7a7a7a"
  divider-soft: "#f0f0f0"
  hairline: "#e0e0e0"
  canvas: "#ffffff"
  canvas-parchment: "#f5f5f7"
  surface-pearl: "#fafafc"
  surface-tile-1: "#272729"
  surface-tile-2: "#2a2a2c"
  surface-tile-3: "#252527"
  surface-black: "#000000"
  surface-chip-translucent: "#d2d2d7"
  on-primary: "#ffffff"
  on-dark: "#ffffff"

typography:
  hero-display:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 56px
    fontWeight: 600
    lineHeight: 1.07
    letterSpacing: -0.28px
  display-lg:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: 0
  display-md:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 34px
    fontWeight: 600
    lineHeight: 1.47
    letterSpacing: -0.374px
  lead:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.14
    letterSpacing: 0.196px
  lead-airy:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 24px
    fontWeight: 300
    lineHeight: 1.5
    letterSpacing: 0
  tagline:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 21px
    fontWeight: 600
    lineHeight: 1.19
    letterSpacing: 0.231px
  body-strong:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.24
    letterSpacing: -0.374px
  body:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.47
    letterSpacing: -0.374px
  dense-link:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 17px
    fontWeight: 400
    lineHeight: 2.41
    letterSpacing: 0
  caption:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: -0.224px
  caption-strong:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.29
    letterSpacing: -0.224px
  button-large:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 18px
    fontWeight: 300
    lineHeight: 1.0
    letterSpacing: 0
  button-utility:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.29
    letterSpacing: -0.224px
  fine-print:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.0
    letterSpacing: -0.12px
  micro-legal:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: -0.08px
  nav-link:
    fontFamily: "Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.0
    letterSpacing: -0.12px

rounded:
  none: 0px
  xs: 5px
  sm: 8px
  md: 11px
  lg: 18px
  pill: 9999px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 17px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 80px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: 11px 22px
  button-primary-focus:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
  button-primary-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
  button-secondary-pill:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: 11px 22px
  button-dark-utility:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-dark}"
    typography: "{typography.button-utility}"
    rounded: "{rounded.sm}"
    padding: 8px 15px
  button-pearl-capsule:
    backgroundColor: "{colors.surface-pearl}"
    textColor: "{colors.ink-muted-80}"
    typography: "{typography.caption}"
    rounded: "{rounded.md}"
    padding: 8px 14px
  button-briefing-hero:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-large}"
    rounded: "{rounded.pill}"
    padding: 14px 28px
  button-icon-circular:
    backgroundColor: "{colors.surface-chip-translucent}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    size: 44px
  text-link:
    backgroundColor: transparent
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  text-link-on-dark:
    backgroundColor: transparent
    textColor: "{colors.primary-on-dark}"
    typography: "{typography.body}"
  global-nav:
    backgroundColor: "{colors.surface-black}"
    textColor: "{colors.on-dark}"
    typography: "{typography.nav-link}"
    height: 44px
  sub-nav-frosted:
    backgroundColor: "{colors.canvas-parchment}"
    textColor: "{colors.ink}"
    typography: "{typography.tagline}"
    height: 52px
  decision-tile-light:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.display-lg}"
    rounded: "{rounded.none}"
    padding: 80px
  decision-tile-parchment:
    backgroundColor: "{colors.canvas-parchment}"
    textColor: "{colors.ink}"
    typography: "{typography.display-lg}"
    rounded: "{rounded.none}"
    padding: 80px
  decision-tile-dark:
    backgroundColor: "{colors.surface-tile-1}"
    textColor: "{colors.on-dark}"
    typography: "{typography.display-lg}"
    rounded: "{rounded.none}"
    padding: 80px
  decision-tile-dark-2:
    backgroundColor: "{colors.surface-tile-2}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.none}"
  decision-tile-dark-3:
    backgroundColor: "{colors.surface-tile-3}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.none}"
  utility-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.lg}"
    padding: 24px
  configurator-option-chip:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 12px 16px
  configurator-option-chip-selected:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
  search-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: 12px 20px
    height: 44px
  floating-sticky-bar:
    backgroundColor: "{colors.canvas-parchment}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    height: 64px
    padding: 12px 32px
  environment-quote-card:
    backgroundColor: "{colors.surface-tile-1}"
    textColor: "{colors.on-dark}"
    typography: "{typography.display-lg}"
    rounded: "{rounded.none}"
    padding: 80px
  footer:
    backgroundColor: "{colors.canvas-parchment}"
    textColor: "{colors.ink-muted-80}"
    typography: "{typography.fine-print}"
    padding: 64px
---

## Overview

StockGuard (스탁가드) uses the reference system as a **calm risk-command gallery**: the interface gives market conclusions, evidence, and next principles room to land without visual panic. Every major surface is a stack of edge-to-edge decision tiles — alternating light and dark canvases, each centered on a concise risk headline, a one-line action principle, tightly limited blue pill CTAs, and a clear data or portfolio artifact. Nothing competes with the judgment. Typography is confident but quiet; color is either pure white, an off-white parchment, or a near-black tile; interactive elements are a single, quiet blue.

Density stays deliberately low for high-stress moments. Each tile occupies roughly one viewport, and there is no decorative chrome — no borders, no gradients, no decorative frames, no shadows on headlines. Elevation appears only when a chart, portfolio object, or scenario card needs to rest on a surface (a single soft `rgba(0, 0, 0, 0.22) 3px 5px 30px` drop for visual weight). The result is an interface where the wall disappears and the risk signal takes over.

Portfolio setup, watchlist, and action-log surfaces retain the same chassis but switch modes. Position entry and principle configuration introduce a tight grid of white utility cards at `{rounded.lg}` (18px) radius with a thin border, paired with a persistent thin sub-nav strip. Market-risk briefings lean darker and more editorial. Across all surfaces the typographic system, spacing rhythm, and the single blue accent are consistent — this is one design language expressed at different risk volumes.

**Key Characteristics:**
- Decision-first presentation; UI recedes so the risk signal can speak.
- Alternating full-bleed tile sections: white/parchment <-> near-black, with the color change itself acting as the section divider.
- Single blue accent (`{colors.primary}` — #0066cc) carries every interactive element. No second action color exists.
- Two button grammars: tiny blue pill CTAs (`{rounded.pill}`) and compact utility rects (`{rounded.sm}`).
- Pretendard — negative letter-spacing at display sizes preserves the tight, controlled headline feel while supporting Korean UI copy.
- Whisper-soft elevation used only when a chart, scenario, or position artifact needs to breathe — exactly one drop-shadow in the entire system.
- Tight two-row nav: slim `{component.global-nav}` + surface-specific `{component.sub-nav-frosted}` with persistent right-aligned primary CTA.
- Section rhythm across multiple pages: light briefing -> dark risk tile -> light utility grid -> dark scenario tile -> parchment footer — a predictable pulse.

## Colors

> **Reference source:** `docs/DESIGN-apple.md`. Color values are preserved from the reference; only color names and usage rationale are adapted for StockGuard.

### Brand & Accent
- **Guard Blue** (`{colors.primary}` — #0066cc): The single brand-level action color. All text links, all blue pill CTAs (`원칙 확인`, `위험선 적용`), and the focus ring root use this color. It is StockGuard's quiet but universal "review this principle" signal. Press state shifts to a slightly darker variant via the active scale transform rather than a hex change.
- **Focus Blue** (`{colors.primary-focus}` — #0071e3): A marginally brighter sibling of Guard Blue, reserved for the keyboard focus ring on buttons (`outline: 2px solid`).
- **Dark-Surface Link Blue** (`{colors.primary-on-dark}` — #2997ff): A brighter blue used on dark surfaces for in-copy links and inline callouts, where Guard Blue would disappear against the tile background.

### Surface
- **Pure White** (`{colors.canvas}` — #ffffff): The dominant canvas. Content, utility cards, briefing tiles, configurator grids.
- **Parchment** (`{colors.canvas-parchment}` — #f5f5f7): The off-white breathing surface. Used for alternating light tiles, footer region, and the default page canvas in portfolio utility sections. Just different enough from white to create rhythm.
- **Pearl Button** (`{colors.surface-pearl}` — #fafafc): A near-white used as the fill for secondary "ghost" buttons — lighter than the parchment canvas so the button still reads as a button against `{colors.canvas-parchment}`.
- **Near-Black Tile 1** (`{colors.surface-tile-1}` — #272729): The primary dark-tile surface on the dashboard decision grid.
- **Near-Black Tile 2** (`{colors.surface-tile-2}` — #2a2a2c): A micro-step lighter — used where a dark tile sits directly above or below Tile 1 to create the faintest separation.
- **Near-Black Tile 3** (`{colors.surface-tile-3}` — #252527): A micro-step darker — used at the bottom of the stack and in embedded video/player frames.
- **Pure Black** (`{colors.surface-black}` — #000000): Reserved for true void — video player backgrounds, edge-to-edge photographic overlays, the global nav bar background.
- **Translucent Chip Gray** (`{colors.surface-chip-translucent}` — #d2d2d7): The base hex of the translucent gray chip used over photography for circular control buttons. In production, applied at ~64% alpha as `rgba(210, 210, 215, 0.64)`.

### Text
- **Near-Black Ink** (`{colors.ink}` — #1d1d1f): The voice of every headline, every body paragraph, and the dark utility button's fill. Chosen instead of pure black to keep the page feeling photographic rather than printed.
- **Body** (`{colors.body}` — #1d1d1f): Same hex as ink — StockGuard uses one near-black tone for all text on light surfaces.
- **Body On Dark** (`{colors.body-on-dark}` — #ffffff): All text on dark tiles and on the global nav bar.
- **Body Muted** (`{colors.body-muted}` — #cccccc): Secondary copy on dark tiles where pure white would be too loud.
- **Ink Muted 80** (`{colors.ink-muted-80}` — #333333): Body text on the white Pearl Button surface — slightly softer than pure black.
- **Ink Muted 48** (`{colors.ink-muted-48}` — #7a7a7a): Disabled button text and legal fine-print.

### Hairlines & Borders
- **Divider Soft** (`{colors.divider-soft}` — #f0f0f0): The "border" tone on secondary buttons — functions as a ring shadow rather than a hard line. In production, often applied as `rgba(0, 0, 0, 0.04)`.
- **Hairline** (`{colors.hairline}` — #e0e0e0): The 1px hairline border on utility cards and configurator chips.

### Brand Gradient
**No decorative gradients.** Atmospheric depth should come from market imagery, chart density, and restrained data surfaces, not a CSS gradient overlay. Briefing heroes may use photographic or data-backed atmosphere, but no gradient tokens are defined. StockGuard should not use dramatic color washes to manufacture urgency.

## Typography

### Font Family
- **Display**: `Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif` — an open Korean-capable UI family used for display sizes while preserving the reference scale, weight, line-height, and letter-spacing.
- **Body / UI**: `Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif` — the same family used for body copy, captions, buttons, and links so Korean risk coaching copy remains consistent across platforms.
- **OpenType features**: `font-variant-numeric: numerator` is enabled on numeric links (pricing tables, spec sheets). Display sizes rely on tight tracking rather than contextual ligatures.

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.hero-display}` | 56px | 600 | 1.07 | -0.28px | Hero headline; tight tracking for controlled, decisive risk statements |
| `{typography.display-lg}` | 40px | 600 | 1.10 | 0 | Tile headlines atop every decision tile |
| `{typography.display-md}` | 34px | 600 | 1.47 | -0.374px | Section heads at display proportions |
| `{typography.lead}` | 28px | 400 | 1.14 | 0.196px | Product tile subcopy |
| `{typography.lead-airy}` | 24px | 300 | 1.5 | 0 | Environment-page lead paragraphs (the rare weight 300) |
| `{typography.tagline}` | 21px | 600 | 1.19 | 0.231px | Sub-tile tagline; sub-nav category name |
| `{typography.body-strong}` | 17px | 600 | 1.24 | -0.374px | Inline strong emphasis |
| `{typography.body}` | 17px | 400 | 1.47 | -0.374px | Default paragraph |
| `{typography.dense-link}` | 17px | 400 | 2.41 | 0 | Footer / utility link lists (relaxed leading) |
| `{typography.caption}` | 14px | 400 | 1.43 | -0.224px | Secondary captions, button text |
| `{typography.caption-strong}` | 14px | 600 | 1.29 | -0.224px | Emphasized captions |
| `{typography.button-large}` | 18px | 300 | 1.0 | 0 | Large briefing CTAs (the rare weight 300) |
| `{typography.button-utility}` | 14px | 400 | 1.29 | -0.224px | Utility/nav button labels |
| `{typography.fine-print}` | 12px | 400 | 1.0 | -0.12px | Fine-print, footer body |
| `{typography.micro-legal}` | 10px | 400 | 1.3 | -0.08px | Micro legal disclaimers |
| `{typography.nav-link}` | 12px | 400 | 1.0 | -0.12px | Global nav menu items |

### Principles

- **Negative letter-spacing at display sizes.** Every headline at 17px and up carries a slight tracking tighten (`-0.12 -> -0.374px`). This produces a controlled headline cadence. Never used at 12px or below.
- **Body copy at 17px, not 16px.** StockGuard keeps paragraph text at 17px. The extra pixel gives risk explanations a "read first, react second" pace.
- **Weight 300 is real and rare.** Used deliberately on a handful of large-size reads (`{typography.button-large}` at 18px/300 and `{typography.lead-airy}` at 24px/300). It's not an accident — it's a light-atmosphere cue reserved for moments where the content should feel airy.
- **Weight 600, not 700, for headlines.** Headlines sit at weight 600 so warnings can be firm without shouting. Weight 700 is used sparingly for `{typography.tagline}` (21px) when a touch more assertion is needed.
- **Line-height is context-specific.** Display sizes use 1.07–1.19 (tight). Body uses 1.47. Utility link stacks in the footer and dense settings pages use an unusually relaxed 2.41 (`{typography.dense-link}`). The 2.41 is not a bug — it's how dense link columns breathe.
- **Weight 500 is deliberately absent.** The ladder is 300 / 400 / 600 / 700. Mid-weight readings always use 600.

### Note on Font Choice
The reference used a proprietary system font, which is not suitable as the primary web font for Korean-first UI copy. StockGuard replaces only the font family with **Pretendard** while preserving the reference typographic scale, weights, line-height, and letter-spacing.

- Use `Pretendard, system-ui, -apple-system, BlinkMacSystemFont, sans-serif` as the full stack.
- Pretendard has strong Korean coverage, a neutral UI texture, and an open license suitable for web implementation.
- Do not change the token sizes or line-height to compensate unless visual QA proves Korean copy overflows in a specific component.

## Layout

### Spacing System
- **Base unit:** 8px. Sub-base values (2, 4, 5, 6, 7) are used for tight typographic adjustments; structural layout snaps to 8/12/16/20/24.
- **Tokens:** `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.md}` 17px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px · `{spacing.section}` 80px.
- **Section vertical padding:** `{spacing.section}` (80px) inside a decision tile; tiles stack edge-to-edge with 0 gap (the color change provides the break).
- **Card padding:** `{spacing.lg}` (24px) inside utility grid cards.
- **Button padding:** 8–11px vertical, 15–22px horizontal.
- **Universal rhythm constants:** the 17px body line-height multiplier (~25px line) and 21px tagline size show up on every analyzed page.

### Grid & Container
- **Max content width:** ~980px on text-heavy briefing sections, ~1440px on portfolio and watchlist grids, full-bleed for decision tiles (dashboard).
- **Column patterns:** 3 to 5 column utility card grid on portfolio/watchlist; 2-column side-by-side tiles on dashboard occasional sections; single-column centered stack on decision tile heroes.
- **Gutters:** 20–24px between cards in a utility grid.

### Whitespace Philosophy
Whitespace is the user's pause before action. Every tile begins with at least 64px of air above its headline and 48–64px below. Risk conclusions and chart objects are never crowded; the nearest content to a data artifact is at least 40px away. The footer and dense audit surfaces are the only areas that break this — there, StockGuard goes deliberately dense to make the full information architecture visible at a glance.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Flat | No shadow, no border | Full-bleed tiles, global nav, footer, body sections |
| Soft hairline | 1px `rgba(0, 0, 0, 0.08)` border | Utility cards, sub-nav frosted-glass separator |
| Backdrop blur | `backdrop-filter: blur(N)` on Parchment 80% | Sub-nav and the briefing/action sticky bar |
| Product shadow | `rgba(0, 0, 0, 0.22) 3px 5px 30px 0` | Product renders resting on a surface (the only true "shadow" in the system) |

**Shadow philosophy.** StockGuard uses **exactly one** drop-shadow, and it is applied to chart objects, portfolio visuals, or scenario artifacts — never to cards, never to buttons, never to text. Elevation in the UI comes from (a) surface-color change (light tile <-> dark tile) and (b) backdrop-blur on sticky bars. The single shadow is about giving the evidence weight, not about UI hierarchy.

### Decorative Depth
- **Atmospheric imagery or data imagery** on briefing pages supplies mood; no CSS gradient involved.
- **Edge-to-edge tile alternation** creates rhythm without borders or shadows — the color change itself is the divider.
- **Backdrop-filter blur** on `{component.sub-nav-frosted}` and `{component.floating-sticky-bar}` creates a "floating over content" effect that's functional, not decorative.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Full-bleed decision tiles (no corner rounding) |
| `{rounded.xs}` | 5px | Inline links when styled as subtle chips (rare) |
| `{rounded.sm}` | 8px | Dark utility buttons (Sign In, Alerts), inline card imagery |
| `{rounded.md}` | 11px | White Pearl Button capsules |
| `{rounded.lg}` | 18px | Portfolio utility cards, watchlist grid cards |
| `{rounded.pill}` | 9999px | Primary blue pill CTAs, sub-nav action button, risk-line option chips, search input — the signature StockGuard pill |
| `{rounded.full}` | 9999px / 50% | Circular control chips floating over photography |

### Photography Geometry
- **Hero imagery**: full-bleed, 21:9 or taller on the landing/dashboard entry; 16:9 on briefing and history pages. Data imagery should feel factual, not sensational.
- **Market artifacts**: PNG/WebP/SVG/chart canvases with transparency may rest on a surface tile and pick up the system shadow.
- **Watchlist grid**: square 1:1 crops at `{rounded.lg}` (18px) radius, light neutral backgrounds, chart or signal object centered with 20–40px internal padding.
- **No rounded imagery in hero tiles** — images are full-bleed rectangular. Rounding (`{rounded.sm}`, `{rounded.lg}`) appears only on inline card imagery.
- Lazy-loading via responsive `srcset` and `sizes` across all breakpoints; CDN-optimized WebP.

## Components

### Top Navigation

**`global-nav`** — Persistent, ultra-thin black nav bar pinned to the top of every page. Background `{colors.surface-black}`, height 44px, text `{colors.on-dark}` in `{typography.nav-link}` (12px / 400 / -0.12px tracking). Links are quiet, spaced ~20px apart, running edge-to-edge across the top. Right-aligned cluster: Search, alerts, and account icons — always visible. On mobile, collapses to hamburger at ~834px and the StockGuard mark centers.

**`sub-nav-frosted`** — Surface-specific nav that sticks below the global nav. Background `{colors.canvas-parchment}` at 80% opacity with backdrop-filter blur, creating a frosted-glass effect. Height 52px. Content on left: surface name (`브리핑`, `포트폴리오`, `행동 기록`) in `{typography.tagline}` (21px / 600). Content right: inline nav links in `{typography.button-utility}` (14px), ending in a persistent `{component.button-primary}` (`원칙 확인`) or a utility link.

### Buttons

**`button-primary`** — The signature StockGuard action. Background `{colors.primary}` (Guard Blue #0066cc), text `{colors.on-primary}` in `{typography.body}` (Pretendard 17px / 400), rounded `{rounded.pill}` (full pill — capsule-shaped), padding 11px × 22px. The full-pill radius is the brand action signal.
- Active state: `{component.button-primary-active}` — `transform: scale(0.95)` (the system-wide micro-interaction).
- Focus state: `{component.button-primary-focus}` — 2px solid `{colors.primary-focus}` outline.

**`button-secondary-pill`** — Used as the second CTA when two blue pills appear together (`근거 보기` / `위험선 적용`). Background transparent, text `{colors.primary}`, 1px solid `{colors.primary}` border, rounded `{rounded.pill}`, padding 11px × 22px. Reads as a "ghost pill."

**`button-dark-utility`** — Global nav actions (Sign In, Alerts, language selector). Background `{colors.ink}` (#1d1d1f), text `{colors.on-dark}` in `{typography.button-utility}` (14px / 400 / -0.224px tracking), rounded `{rounded.sm}` (8px), padding 8px × 15px. Active state shrinks via `transform: scale(0.95)`.

**`button-pearl-capsule`** — Product-card secondary button. Background `{colors.surface-pearl}` (#fafafc), text `{colors.ink-muted-80}` in `{typography.caption}` (14px), 3px solid `{colors.divider-soft}` border (functions as a soft ring rather than a visible line), rounded `{rounded.md}` (11px), padding 8px × 14px.

**`button-briefing-hero`** — A larger primary CTA used on landing and pre-market briefing surfaces. Same Guard Blue + Paper White as `{component.button-primary}`, but with `{typography.button-large}` (18px / 300 — note the rare weight 300) and slightly more padding (14px × 28px). Used sparingly when the user should begin a risk review.

**`button-icon-circular`** — Floats over imagery or dense charts. 44 × 44px, background `{colors.surface-chip-translucent}` at ~64% alpha, icon in `{colors.ink}`, rounded `{rounded.full}`. Used for carousel controls, close buttons, and chart-view controls.

**`text-link`** — Inline body links in `{colors.primary}` (Guard Blue). Underlined or non-underlined per context.

**`text-link-on-dark`** — Inline body links on dark tiles in `{colors.primary-on-dark}` (Dark-Surface Link Blue #2997ff) — Guard Blue would disappear against `{colors.surface-tile-1}`.

### Cards & Containers

**`decision-tile-light`** — Full-bleed light decision tile. Background `{colors.canvas}` (white), text `{colors.ink}`, rounded `{rounded.none}` (0 — tiles touch edges), vertical padding `{spacing.section}` (80px). Centered stack: risk label in `{typography.display-lg}` (40px / 600) -> one-line principle in `{typography.lead}` (28px / 400) -> two `{component.button-primary}` CTAs (`근거 보기` / `원칙 확인`) -> chart or portfolio artifact resting on the surface with the system shadow.

**`decision-tile-parchment`** — Same as `{component.decision-tile-light}` but on `{colors.canvas-parchment}` (#f5f5f7). Used to break two consecutive white tiles.

**`decision-tile-dark`** — Full-bleed dark risk tile. Background `{colors.surface-tile-1}` (#272729), text `{colors.on-dark}`, rounded `{rounded.none}`, vertical padding `{spacing.section}` (80px). Same content stack as the light tile but with `{component.text-link-on-dark}` for inline copy and `{component.button-primary}` (Guard Blue still works on the dark surface). Used on briefing and scenario pages as the alternating dark band.

**`decision-tile-dark-2`** — Variant on `{colors.surface-tile-2}` (#2a2a2c). Used where a dark tile sits directly above or below `{component.decision-tile-dark}` to create the faintest separation through micro-step lightness change.

**`decision-tile-dark-3`** — Variant on `{colors.surface-tile-3}` (#252527). Used at the bottom of the stack and in embedded video/player frames.

**`utility-card`** — Used in portfolio grids, watchlist grids, and principle cards. Background `{colors.canvas}` (white), 1px solid `{colors.hairline}` border, rounded `{rounded.lg}` (18px), padding `{spacing.lg}` (24px). Top: chart or position image (1:1 crop with `{rounded.sm}` (8px) inner image radius). Below: position name in `{typography.body-strong}` (17px / 600), risk label in `{typography.body}` (17px / 400), and a `{component.text-link}` (`근거 보기` or `다시 판단`). No shadow by default; chart or position artifact itself carries the system artifact-shadow when needed.

**`configurator-option-chip`** — Pill-shaped tappable cell used in risk-line, sector, and alert-rule setup. Background `{colors.canvas}`, text `{colors.ink}` in `{typography.caption}`, rounded `{rounded.pill}`, padding 12px × 16px. Contains a small signal icon + label + threshold delta. Arranged in a grid of 4–5 options per row.

**`configurator-option-chip-selected`** — Selected state. Border upgrades to 2px solid `{colors.primary-focus}`. Same shape, same content.

**`environment-quote-card`** — A dark editorial hero for major market conditions. Dark photographic or data-backed backdrop with `{colors.surface-tile-1}` as the fallback color, centered white-text headline in `{typography.display-lg}` (40px), small status mark above the headline, single `{component.button-primary}` below. Padding `{spacing.section}` (80px).

**`floating-sticky-bar`** — Floats at the bottom of the viewport on briefing and action-review pages during scroll. Background `{colors.canvas-parchment}` at 80% opacity with `backdrop-filter: blur(N)`, height 64px, padding 12px × 32px. Left: current risk summary in `{typography.body}`. Right: `{component.button-primary}` (`위험선 적용`).

### Inputs & Forms

**`search-input`** — The stock, sector, and history search input. Background `{colors.canvas}`, text `{colors.ink}` in `{typography.body}` (17px), 1px solid `rgba(0, 0, 0, 0.08)` border, rounded `{rounded.pill}` (full pill — search is also pill-shaped, matching the CTA grammar), padding 12px × 20px, height 44px. Leading icon: search glyph at 14px, muted tint.

Error and validation copy should be calm and actionable: `현재 시세를 불러오지 못했습니다. 저장된 기준 가격으로 먼저 판단합니다.`

### Footer

**`footer`** — Background `{colors.canvas-parchment}` (#f5f5f7), text `{colors.ink-muted-80}`. Link columns in `{typography.dense-link}` (17px / 400 / 2.41 line-height — the relaxed leading is what makes the dense columns scannable). Column headings in `{typography.caption-strong}` (14px / 600). Legal row at the very bottom in `{typography.fine-print}` (12px / 400) with `{colors.ink-muted-48}` text. Vertical padding 64px.

## Voice & Tone

StockGuard speaks like a calm but firm risk coach. It gives the conclusion first, then the evidence, then the action principle. The interface should never amplify panic, FOMO, or shame; it should reduce the next decision to what to check, what to pause, and what not to do.

### Voice Rules

- Use polite Korean UI copy by default: `~하세요`, `~입니다`, `~할 수 있습니다`.
- Keep sentences short. One sentence should carry one judgment or one action.
- Put the conclusion first, then attach evidence directly below it.
- In risk states, avoid repeating vague caution. Say what to reduce, what to pause, and what to avoid.
- Use risk-coaching language rather than direct investment commands: `원칙에 해당`, `검토`, `보류`, `위험 구간`.
- Do not use emoji. Even completion states should feel professional and calm.

### Preferred Copy

| Context | Use |
|---|---|
| Pre-market briefing | `오늘은 방어 우선입니다.` |
| Empty portfolio | `종목명과 비중만 입력해도 첫 판단을 시작할 수 있습니다.` |
| Success | `위험선이 적용됐습니다. 이제 이 조건에 닿으면 원칙을 함께 알려드립니다.` |
| High-risk alert | `레버리지 축소 원칙에 해당합니다. 손실 만회성 추가 매수는 멈추세요.` |
| Market update | `변동장 2단계입니다. 반도체 약세가 커졌고, 장중 추격 매수는 보류 구간입니다.` |
| Error | `현재 시세를 불러오지 못했습니다. 저장된 기준 가격으로 먼저 판단합니다.` |

### Forbidden Phrases

- `무조건 매도`, `무조건 매수`
- `대박`, `폭등`, `떡상`, `몰빵`
- `패닉`, `붕괴`, `끝났다`
- `기회 놓치지 마세요`
- `당장 행동하세요`
- `수익 보장`
- `알아서 판단하세요`

## Do's and Don'ts

### Do
- Use `{colors.primary}` (Guard Blue #0066cc) for every interactive element — links, pill CTAs, focus signals — and nothing else. The single action accent is non-negotiable.
- Set headlines in `{typography.hero-display}` or `{typography.display-lg}` with negative letter-spacing (`-0.28 -> -0.374px`) to keep a controlled, decisive cadence.
- Run body copy at `{typography.body}` (17px / 400 / 1.47 / -0.374px) — not 16px. The extra pixel defines the brand's read-before-react pace.
- Alternate `{component.decision-tile-light}` (or parchment) and `{component.decision-tile-dark}` for full-bleed section rhythm. The color change IS the divider.
- Reserve `{rounded.pill}` for the primary blue CTA and any other element that should read as an "action" (configurator chips, search input, sticky bar CTA).
- Apply the single artifact-shadow (`rgba(0, 0, 0, 0.22) 3px 5px 30px`) only to chart, scenario, or portfolio artifacts resting on a surface — never on cards, buttons, or text.
- Use `transform: scale(0.95)` as the active/press state on every button — it's the system-wide micro-interaction.
- Keep the global nav `{colors.surface-black}` (true black) — it's the only place pure black appears on most pages.

### Don't
- Don't introduce a second accent color; every action signal is `{colors.primary}` (Guard Blue).
- Don't add shadows to cards, buttons, or text — shadow is reserved for evidence artifacts.
- Don't use gradients as decorative backgrounds; atmosphere comes from restrained imagery and data surfaces.
- Don't set body copy at weight 500 — the ladder is 300 / 400 / 600 / 700, with 500 deliberately absent. Body is always 400; strong inline is 600; display is 600.
- Don't round full-bleed tiles — tiles are rectangular and edge-to-edge; the color change is the divider.
- Don't tighten line-height below 1.47 for body copy — the editorial leading is part of the brand.
- Don't mix radii grammars — use `{rounded.sm}` for compact utility, `{rounded.lg}` for utility cards, `{rounded.pill}` for pills, and nothing in between (except the rare `{rounded.md}` Pearl Button).
- Don't use `{colors.primary-on-dark}` (Dark-Surface Link Blue) on light surfaces — it's the dark-tile-only variant. Guard Blue is for light surfaces.

## Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Small phone | ≤ 419px | Single-column tiles; sub-nav collapses to category name + primary CTA only; hero typography drops to 28px |
| Phone | 420–640px | Single-column stack; data artifacts scale to 80% of tile width; hero h1 drops to 34px |
| Large phone | 641–735px | Tiles transition to tighter padding (48px vertical vs 80px); fine-print wraps |
| Tablet portrait | 736–833px | Global nav collapses to hamburger; sub-nav hides category chips, keeps primary CTA |
| Tablet landscape | 834–1023px | Global nav returns fully expanded; 3-column utility grids become 2-column |
| Small desktop | 1024–1068px | Decision tiles use 2/3 width with margin gutters; hero h1 stays at 40px |
| Desktop | 1069–1440px | Full layout; 4–5 column portfolio grids; 1440px content max |
| Wide desktop | ≥ 1441px | Content locks at 1440px, margins absorb extra width |

The structural breakpoints that matter for agents: 1440px (content lock), 1068px (small-desktop), 833px (tablet landscape switch), 734px (tablet portrait), 640px (phone), 480px (small phone).

### Touch Targets
- Minimum 44 × 44px. `{component.button-primary}` lands at ~44 × 100px (with the full-pill radius making the visible hit area more generous than the label suggests).
- `{component.button-icon-circular}` is exactly 44 × 44px.
- Global nav utility links are smaller (~32 × 80px) — they deliberately sit at a tighter target because they're precision desktop actions, and the mobile hamburger replaces them at ≤ 833px.

### Collapsing Strategy
- **Global nav**: full horizontal link row on desktop -> collapses to StockGuard mark + hamburger + alerts icon at 834px and below.
- **Sub-nav**: category name + inline links + primary CTA -> category name + primary CTA only at mobile; inline links move into a hamburger tray.
- **Decision tiles**: stack from 2-column to 1-column at 834px; vertical padding tightens from 80px -> 48px at small-phone.
- **Utility grids** (portfolio, watchlist): 5-col -> 4-col (1440px) -> 3-col (1068px) -> 2-col (834px) -> 1-col (640px).
- **Hero typography**: `{typography.hero-display}` (56px) -> `{typography.display-lg}` (40px) at 1068px -> 34px at 640px -> 28px at 419px.

### Image Behavior
- All data imagery uses responsive `srcset` with breakpoint-matched crops.
- Hero photography may switch art direction at mobile (e.g., the environment page's vista crops to a taller aspect ratio on mobile, framing the subject differently).
- Product renders maintain their 1:1 or 4:3 aspect ratios across breakpoints; only scale changes.
- Lazy-loading is default; the above-fold hero loads eagerly.

## Iteration Guide

1. Focus on ONE component at a time. Reference its YAML key directly (`{component.decision-tile-dark}`, `{component.search-input}`).
2. Variants of an existing component (`-active`, `-focus`, `-2`, `-3`) live as separate entries in `components:`.
3. Use `{token.refs}` everywhere — never inline hex.
4. Never document hover. Default and Active/Pressed states only.
5. Display headlines stay Pretendard 600 with negative letter-spacing. Body stays Pretendard 400 at 17px. The boundary is unbreakable.
6. The single drop-shadow (`rgba(0, 0, 0, 0.22) 3px 5px 30px`) is reserved for evidence artifacts only.
7. When in doubt about emphasis: alternate surface (light -> dark tile) before adding chrome.

## Known Gaps

- Form validation and error states were not surfaced on the analyzed pages; only the neutral search input is documented.
- The dashboard's embedded video/player frame uses `{colors.surface-black}`; interior player controls are not documented (they're a platform widget, not a web-design token).
- Some component imagery is dynamic (rotating briefing hero) and its specific copy varies per surface — component specs name the structure, not the rotating content.
- Dark-mode counterparts for portfolio and watchlist utility cards were not surfaced in the reference; the system documented is the daytime/light-dominant variant StockGuard should start from.
- Atmospheric photography (environment page mountain vista) is a content asset, not a design token; the documented `{component.environment-quote-card}` describes the structural surface only.
- The exact backdrop-filter blur radius on `{component.sub-nav-frosted}` and `{component.floating-sticky-bar}` is platform-dependent; production CSS uses `saturate(180%) blur(20px)` as a typical baseline but the value isn't formalized as a token.


