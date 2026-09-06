export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function asJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}
