import type { Game } from './main';
import { getDefense, footprintSize, type DefenseId } from './defenses';

/** Validate every occupied cell and its support, including unloaded columns. */
export function validateDefensePlacement(game: Game, id: DefenseId, rotation: number, x: number, y: number, z: number): string {
  const [width, depth] = footprintSize(id, rotation);
  const height = Math.ceil(getDefense(id).height);
  for (let dx = 0; dx < width; dx++) for (let dz = 0; dz < depth; dz++) {
    const px = x + dx, pz = z + dz;
    if (!game.world.inBounds(px, y - 1, pz) || !game.world.inBounds(px, y + height - 1, pz)) return 'Outside world bounds';
    if (!game.world.isGenerated(px, pz)) return 'Terrain not loaded';
    if (!game.world.solid(px, y - 1, pz)) return 'Entire base needs solid support';
    for (let dy = 0; dy < height; dy++) {
      if (game.world.solid(px, y + dy, pz)) return 'Footprint needs clear space';
      if (game.entities.blocksCell(px, y + dy, pz)) return 'Footprint overlaps an entity';
    }
  }
  // Turret collision radii are circular; check their actual rectangular footprints too.
  for (const t of game.entities.turrets) {
    if (t.dead) continue;
    const [tw, td] = footprintSize(t.defenseId, t.rotation);
    if (x < t.pos.x + tw / 2 && x + width > t.pos.x - tw / 2 && z < t.pos.z + td / 2 && z + depth > t.pos.z - td / 2 && y < t.pos.y + getDefense(t.defenseId).height && y + height > t.pos.y) return 'Footprint overlaps a defense';
  }
  return '';
}
