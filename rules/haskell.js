export const id = 'haskell';
export const markers = ['stack.yaml', 'package.yaml', 'cabal.project'];
export const linkPaths = [];

export function matchesMarker(name) {
  return name.toLowerCase().endsWith('.cabal');
}
