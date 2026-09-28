export const id = 'lua';
export const markers = [];
export const linkPaths = [];

export function matchesMarker(name) {
  return name.toLowerCase().endsWith('.rockspec');
}
