# ARL Mission Control UI design system (Always Apply, web/**)

DESIGN INTENT: a control-room HMI, not an AI dashboard. Normal state is neutral grey; colour only means action
(Mars rust accent), selection/info (Mars-sunset blue) or an abnormal state (alarms, stale data). Light mode is a
white page; dark mode is a space-grey page with Mars accents. In BOTH themes the instrument housing (nav rail,
annunciator strip, bottom bar) is dark "chrome".

## Forbidden
- Gradients (only exception: heatmap value ramps and the stale hatch).
- Glows, box-shadow on panels/cards, backdrop blur.
- Border-radius above 4px; pill buttons.
- Emoji, purple.
- ALL-CAPS or letter-spaced labels.
- Animated counters, entrance animations, hover lifts.
- More than one primary button per panel.
- KPI walls: max 4 headline readings per page.
- Raw hex colours in TS/TSX.

## Rules
- Use only CSS variables from web/src/styles/tokens.css. Never introduce a new colour literal.
- Chart and series colours in this order: accent, sunset, ochre, dust, ink-muted.
- Alarm colours only for alarms, and always with their icon plus the word: triangle = critical,
  diamond = warning, circle = info.
- Readings use --font-data with tabular-nums and always show a unit.
- Sentence case everywhere (headings, labels, table headers, nav items, buttons).
- Buttons name the action ("Cancel scan", "Acknowledge", "Resolve").
- Offline/stale data keeps its value visible with the stale hatch (`.arl-stale`) and "Last seen <time>".
- Timestamps are absolute sim time; relative time only in a title tooltip.
- Every interactive element has a visible keyboard focus (accent outline).
