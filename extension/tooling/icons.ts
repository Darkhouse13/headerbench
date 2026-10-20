/** Renders assets/icon.svg to the PNG sizes the manifest lists. */
import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { ICON_SIZES } from './manifest.ts';

export function renderIcons(svgPath: string): { fileName: string; source: Uint8Array }[] {
  const svg = readFileSync(svgPath, 'utf8');
  return ICON_SIZES.map((size) => ({
    fileName: `icons/icon-${size}.png`,
    source: new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng(),
  }));
}
