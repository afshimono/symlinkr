export const id = 'csharp';
export const markers = [];
export const linkPaths = [];

export function matchesMarker(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.csproj') || lower.endsWith('.sln');
}
