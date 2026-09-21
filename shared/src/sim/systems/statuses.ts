/**
 * Status effect ticking.
 *
 * Damage-over-time effects apply their damage here; every effect expires on
 * its own timer. Effects are independent, so Burning + Poisoned + Slowed all
 * run at once and all resolve separately.
 */

import { StatusKind } from '../../types.js';
import type { Simulation } from '../Simulation.js';

export function updateStatuses(sim: Simulation, dt: number): void {
  for (const entity of sim.entities.values()) {
    if (!entity.isAlive || entity.statuses.length === 0) continue;

    for (const status of entity.statuses) {
      status.remaining -= dt;

      switch (status.kind) {
        case StatusKind.Burning:
        case StatusKind.Poisoned: {
          // magnitude is damage per second.
          const source = status.sourceId !== undefined ? sim.entities.get(status.sourceId) ?? null : null;
          sim.dealDamage(entity, status.magnitude * dt, source, { ignoreArmor: true });
          break;
        }
        default:
          break;
      }

      if (!entity.isAlive) break;
    }

    // Shields that have absorbed their whole pool fall off early.
    entity.statuses = entity.statuses.filter(
      (s) => s.remaining > 0 && !(s.kind === StatusKind.Shielded && s.magnitude <= 0.01),
    );
  }
}
