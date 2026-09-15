/**
 * Barcode symbols as SVG, for the table preview, the Barcode position pop-up
 * and the symbol picker. The map tiles draw the same shapes on a canvas
 * (lib/barcode-panel-imagery-provider).
 */

import type { BarcodeSymbol } from '../lib/barcode-panels';

interface BarcodeSymbolShapeProps {
  symbol: BarcodeSymbol;
  cx: number;
  cy: number;
  /** Nominal size in SVG units, comparable across symbols. */
  size: number;
  /** Rotation of the label rectangle in degrees; 0 lays its long side horizontally. */
  angle?: number;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}

export const BarcodeSymbolShape = ({
  symbol,
  cx,
  cy,
  size,
  angle = 0,
  fill,
  stroke,
  strokeWidth,
}: BarcodeSymbolShapeProps) => {
  const half = size / 2;
  const paint = { fill, stroke, strokeWidth };

  switch (symbol) {
    case 'circle':
      return <circle cx={cx} cy={cy} r={half} {...paint} />;
    case 'square':
      return <rect x={cx - half} y={cy - half} width={size} height={size} {...paint} />;
    case 'label':
      return (
        <rect
          x={cx - half * 1.2}
          y={cy - half * 0.6}
          width={half * 2.4}
          height={half * 1.2}
          transform={angle ? `rotate(${angle} ${cx} ${cy})` : undefined}
          {...paint}
        />
      );
    default: {
      const reach = half * 1.25;
      return (
        <polygon
          points={`${cx},${cy - reach} ${cx + reach},${cy} ${cx},${cy + reach} ${cx - reach},${cy}`}
          {...paint}
        />
      );
    }
  }
};

/** 16 px icon of a symbol in the current text colour. */
export const BarcodeSymbolIcon = ({ symbol }: { symbol: BarcodeSymbol }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <BarcodeSymbolShape symbol={symbol} cx={8} cy={8} size={symbol === 'label' ? 9 : 10} fill="currentColor" />
  </svg>
);
