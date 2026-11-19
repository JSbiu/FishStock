import { workspace } from 'vscode';
import {
  normalizeHoldingSummaryMode,
  type HoldingSummaryMode,
} from './domain/holdingGroups';
import {
  normalizeHoldingDescriptionFieldOrder,
  normalizeHoldingDescriptionFields,
  normalizeHoldingHkdRate,
  type HoldingDescriptionField,
  type HoldingDescriptionFields,
} from './domain/holdings';

export type ColorConvention = 'china' | 'international';

export interface FishStockConfig {
  refreshIntervalMs: number;
  staleAfterMs: number;
  rotationIntervalMs: number;
  colorConvention: ColorConvention;
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function readHoldingHkdRate(): number | null {
  const value = workspace.getConfiguration('fishStock.holdings')
    .get<unknown>('hkdToCnyRate', 0.9);
  return normalizeHoldingHkdRate(value);
}

export function readHoldingDescriptionFields(): HoldingDescriptionFields {
  const value = workspace.getConfiguration('fishStock.holdings')
    .get<unknown>('treeViewFields');
  return normalizeHoldingDescriptionFields(value);
}

export function readHoldingDescriptionFieldOrder(): HoldingDescriptionField[] {
  const value = workspace.getConfiguration('fishStock.holdings')
    .get<unknown>('treeViewFieldOrder');
  return normalizeHoldingDescriptionFieldOrder(value);
}

export function readHoldingSummaryMode(): HoldingSummaryMode {
  const value = workspace.getConfiguration('fishStock.holdings')
    .get<unknown>('summaryMode');
  return normalizeHoldingSummaryMode(value);
}

export function readConfig(): FishStockConfig {
  const config = workspace.getConfiguration('fishStock');
  const colorConvention = config.get<string>('colorConvention', 'china');
  return {
    refreshIntervalMs:
      clamp(config.get<number>('refreshIntervalSeconds', 60), 15, 3600) * 1000,
    staleAfterMs: clamp(config.get<number>('staleAfterSeconds', 120), 30, 86400) * 1000,
    rotationIntervalMs:
      clamp(config.get<number>('statusBar.rotationSeconds', 5), 3, 60) * 1000,
    colorConvention: colorConvention === 'international' ? 'international' : 'china',
  };
}
