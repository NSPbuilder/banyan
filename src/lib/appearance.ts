/**
 * HOW THE SCREEN LOOKS, as data.
 *
 * Palettes, light/dark modes, and Liquid Glass background presets are read by the
 * SETTINGS screen, by the
 * shell that stamps the choice onto the page, and by the door that saves it —
 * so another palette is one entry here, one block of CSS, and an append-only
 * migration extending the theme CHECK. Settings reads this same catalogue.
 *
 * Client-safe on purpose (no `server-only`): the settings form renders these,
 * and a check renders that form with no server runtime.
 */

export type ThemeName = 'claude' | 'figtree' | 'liquid' | 'monochrome'
export type AppearanceMode = 'system' | 'light' | 'dark'
/** Legacy database value (0079); no longer changes the interface. */
export type DetailLevel = 'full' | 'brief'

export type Appearance = { theme: ThemeName; mode: AppearanceMode; liquidTint: string }

/** What the application shipped with, and what every row got in 0067 / 0079. */
export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'claude', mode: 'system', liquidTint: '#5eb7ff',
}

export const LIQUID_TINTS = [
  { label: 'Blue', value: '#5eb7ff' },
  { label: 'Coral', value: '#ec987e' },
  { label: 'Sage', value: '#8cc7a2' },
  { label: 'Lavender', value: '#ae9bec' },
  { label: 'Gold', value: '#e7bd69' },
] as const

export const THEMES: Array<{
  name: ThemeName
  label: string
  /** Three colours, for the swatch beside it: paper, ink, and the accent. */
  swatch: [string, string, string]
}> = [
  {
    name: 'claude',
    label: 'Cream',
    swatch: ['#faf9f5', '#23201b', '#c05f3d'],
  },
  {
    name: 'figtree',
    label: 'Banyan',
    swatch: ['#f6f8f2', '#1d2419', '#4a7c3f'],
  },
  {
    name: 'liquid',
    label: 'Liquid Glass',
    swatch: ['#edf5ff', '#172235', '#0877bc'],
  },
  {
    name: 'monochrome',
    label: 'Monochrome',
    swatch: ['#ffffff', '#171717', '#737373'],
  },
]

export const MODES: Array<{ name: AppearanceMode; label: string }> = [
  { name: 'system', label: 'System' },
  { name: 'light', label: 'Light' },
  { name: 'dark', label: 'Dark' },
]

const themeNames = new Set(THEMES.map((t) => t.name))
const modeNames = new Set(MODES.map((m) => m.name))

/**
 * What arrived from a form, made safe. The database checks these values, so a
 * wrong value would be refused there — this turns it into the default instead,
 * because a person cannot type into these and a refusal would be about a bug.
 */
export function appearanceFrom(
  theme: unknown, mode: unknown, _legacyDetail: unknown = undefined, liquidTint: unknown = undefined,
): Appearance {
  void _legacyDetail // Accept old callers without reading or overwriting their stored detail value.
  return {
    theme: themeNames.has(theme as ThemeName) ? theme as ThemeName : DEFAULT_APPEARANCE.theme,
    mode: modeNames.has(mode as AppearanceMode) ? mode as AppearanceMode : DEFAULT_APPEARANCE.mode,
    liquidTint: typeof liquidTint === 'string' && /^#[0-9a-f]{6}$/i.test(liquidTint)
      ? liquidTint.toLowerCase() : DEFAULT_APPEARANCE.liquidTint,
  }
}
