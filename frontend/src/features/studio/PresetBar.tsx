/* Preset segmented control — drives useSettings.applyPreset (PROD_PRESETS
   values, app.js:1308-1334). The store flips itself to "custom" whenever one
   of the 8 preset-sensitive knobs changes, so this bar never lies about the
   live settings. */

import type { PresetName } from '../../lib/constants';
import { useSettings } from '../../state/settings';

const PRESETS: { name: PresetName; label: string; title: string }[] = [
  { name: 'quality', label: 'Quality', title: 'Quality (DFN3, full)' },
  { name: 'balanced', label: 'Balanced', title: 'Balanced (OM-LSA, no DF3)' },
  { name: 'fast', label: 'Fast', title: 'Fast (low runtime)' },
  { name: 'custom', label: 'Custom', title: 'Custom - keeps your own knob settings' },
];

export default function PresetBar() {
  const preset = useSettings((s) => s.preset);
  const applyPreset = useSettings((s) => s.applyPreset);

  return (
    <div className="preset-bar" role="radiogroup" aria-label="Pipeline preset">
      {PRESETS.map((p) => (
        <button
          key={p.name}
          role="radio"
          aria-checked={preset === p.name}
          className={`preset-opt${preset === p.name ? ' active' : ''}`}
          title={p.title}
          onClick={() => applyPreset(p.name)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
