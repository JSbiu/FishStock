export function startBackgroundRefresh(
  refresh: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  void refresh().catch(onError);
}
