export function formatTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    return values[key] ?? "";
  });
}
