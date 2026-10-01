/** Sculpts the bust off the main thread so the page stays responsive while it builds. */

import { buildBust } from './geometry.ts';

const data = buildBust();
const { points, shell, contourIndex } = data;
self.postMessage(data, {
  transfer: [
    points.position.buffer, points.normal.buffer, points.kind.buffer, points.seed.buffer,
    points.size.buffer, points.shade.buffer,
    shell.position.buffer, shell.normal.buffer, shell.ambient.buffer, shell.index.buffer,
    contourIndex.buffer,
  ],
});
