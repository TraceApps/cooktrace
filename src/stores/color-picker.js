// Lightweight bus so an extracted Settings section (SettingsAppearance's
// "Custom" swatch) can open the color-picker Sheet that lives at the
// Settings.svelte shell level. The shell owns the sheet's state, HSL /
// RGB / hex handlers, and applyAccentColor calls; the section just
// nudges the store to `true` and the shell reacts.
import { writable } from 'svelte/store';

export const colorPickerOpen = writable(false);

export function openColorPicker() {
  colorPickerOpen.set(true);
}
