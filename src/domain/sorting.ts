export type MoveDirection = -1 | 1;

export function moveItem<T>(items: readonly T[], index: number, direction: MoveDirection): T[] {
  const target = index + direction;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
    return [...items];
  }

  const result = [...items];
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}
