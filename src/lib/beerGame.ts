// SPDX-License-Identifier: CC-BY-SA-4.0
//
// Beer Game simulation engine.
//
// The pipeline mechanics are the classic MIT Sloan beer game (Jay Forrester;
// popularised by John Sterman). The Beer-GPT robot rule and the optional extra
// order delay are ported from siemsene/beergame — src/logic/robotOrders.ts and
// src/logic/gameEngine.ts respectively. See NOTICE.md for attribution.

import { customerDemand, type BeerGameConfig } from "@/lib/beerGameConfig";

export type BeerGameRole =
  | "RETAILER"
  | "WHOLESALER"
  | "DISTRIBUTOR"
  | "FACTORY";

export const ROLE_ORDER: BeerGameRole[] = [
  "RETAILER",
  "WHOLESALER",
  "DISTRIBUTOR",
  "FACTORY",
];

export const ROLE_LABELS: Record<BeerGameRole, string> = {
  RETAILER: "Retailer",
  WHOLESALER: "Wholesaler",
  DISTRIBUTOR: "Distributor",
  FACTORY: "Factory",
};

/** Display name for a role with no human in the seat. */
export const ROBOT_NAME = "Beer-GPT";

// Kept next to the role metadata so the host console, the player board and the
// endgame charts all colour a role identically.
export const ROLE_COLORS: Record<BeerGameRole, string> = {
  RETAILER: "#2563eb",
  WHOLESALER: "#16a34a",
  DISTRIBUTOR: "#d97706",
  FACTORY: "#dc2626",
};

// Who a role orders from (upstream) and who orders from it (downstream).
// undefined upstream/downstream means "customer" or "unlimited raw materials".
const DOWNSTREAM: Record<BeerGameRole, BeerGameRole | undefined> = {
  RETAILER: undefined,
  WHOLESALER: "RETAILER",
  DISTRIBUTOR: "WHOLESALER",
  FACTORY: "DISTRIBUTOR",
};
const UPSTREAM: Record<BeerGameRole, BeerGameRole | undefined> = {
  RETAILER: "WHOLESALER",
  WHOLESALER: "DISTRIBUTOR",
  DISTRIBUTOR: "FACTORY",
  FACTORY: undefined,
};

/**
 * Who a role's demand arrives from, for labelling it on screen: real customers
 * for the Retailer, otherwise the stage it supplies. Lives here so the board
 * and any future view name the source the same way.
 */
export function demandSourceLabel(role: BeerGameRole): string {
  const downstream = DOWNSTREAM[role];
  return downstream ? ROLE_LABELS[downstream] : "customers";
}

export type RoundStateByRole = Record<
  BeerGameRole,
  {
    round: number;
    inventory: number;
    backlog: number;
    shipped: number;
    outgoingOrder: number;
  }
>;

export type ResolvedRound = Record<
  BeerGameRole,
  {
    incomingOrder: number;
    incomingShipment: number;
    shipped: number;
    outgoingOrder: number;
    inventory: number;
    backlog: number;
    cost: number;
    wasRobot: boolean;
  }
>;

// --- Deterministic randomness -------------------------------------------------
//
// Robot jitter has to be reproducible. `resolveAndAdvance` tolerates two
// players racing to resolve the same round by swallowing the duplicate-key
// error from the loser — which is only provably harmless if both racers compute
// the *same* robot orders. Seeding from (seedKey, round, role) guarantees that,
// and makes a finished session replayable from its inputs.

function hashString(input: string): number {
  // FNV-1a, 32-bit.
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function seededUnitRandom(seedKey: string): number {
  // mulberry32, one draw. A fresh generator per call keeps each (team, round,
  // role) independent of the order roles happen to be evaluated in.
  let a = (hashString(seedKey) + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  a = (t ^ (t >>> 14)) >>> 0;
  return a / 4294967296;
}

/**
 * Beer-GPT: order what you just saw demanded, give or take one unit.
 *
 * Ported from siemsene's robot rule. The jitter matters — a bot that ordered
 * its incoming demand exactly would be a perfect, variance-free link, quietly
 * damping the very bullwhip a short-handed team is meant to demonstrate.
 */
export function robotOrder(
  incomingOrder: number,
  seedKey: string,
): number {
  const jitter = [-1, 0, 1][Math.floor(seededUnitRandom(seedKey) * 3)] ?? 0;
  return Math.max(0, Math.round(incomingOrder + jitter));
}

/**
 * Resolves one round for one team.
 *
 * @param round    1-based round number being resolved.
 * @param history  round number -> per-role state for rounds < `round`. Only the
 *                 previous two rounds are read, but callers may pass more.
 * @param orders   human-submitted order per role. A role absent here is played
 *                 by Beer-GPT.
 * @param config   session parameters (costs, demand curve, delay options).
 * @param robotRoles roles with no human in the seat this round.
 * @param seedKey  stable per-team string (the team id) for robot determinism.
 */
export function resolveRound(
  round: number,
  history: Map<number, RoundStateByRole>,
  orders: Partial<Record<BeerGameRole, number>>,
  config: BeerGameConfig,
  robotRoles: Set<BeerGameRole> = new Set(),
  seedKey = "",
): ResolvedRound {
  const prior = history.get(round - 1);
  const twoAgo = history.get(round - 2);

  const result = {} as ResolvedRound;

  for (const role of ROLE_ORDER) {
    const priorInventory = prior?.[role]?.inventory ?? config.initialInventory;
    const priorBacklog = prior?.[role]?.backlog ?? 0;

    const downstream = DOWNSTREAM[role];
    let incomingOrder: number;
    if (!downstream) {
      // Retailer faces exogenous end-customer demand, which is not an order
      // placed by a player and so is never subject to the order delay.
      incomingOrder = customerDemand(round, config);
    } else if (config.extraOrderDelay) {
      // Extra delay: this round's demand is the order placed *last* round.
      incomingOrder = prior?.[downstream]?.outgoingOrder ?? config.pipelineSeed;
    } else {
      // DOWNSTREAM always points to a role earlier in ROLE_ORDER, so its
      // outgoingOrder (human-submitted or bot-computed) is already resolved.
      incomingOrder = result[downstream]!.outgoingOrder;
    }

    let incomingShipment: number;
    if (round <= 2) {
      incomingShipment = config.pipelineSeed;
    } else if (role === "FACTORY") {
      // The factory brews rather than orders: its request two rounds ago
      // finishes production now.
      incomingShipment = twoAgo?.FACTORY?.outgoingOrder ?? config.pipelineSeed;
    } else {
      const upstream = UPSTREAM[role]!;
      incomingShipment = twoAgo?.[upstream]?.shipped ?? config.pipelineSeed;
    }

    const available = priorInventory + incomingShipment;
    const demand = incomingOrder + priorBacklog;
    const shipped = Math.min(available, demand);
    const backlog = demand - shipped;
    const inventory = available - shipped;
    const cost = config.holdingCost * inventory + config.backorderCost * backlog;

    const isRobot = robotRoles.has(role);
    const submitted = orders[role];
    const outgoingOrder = isRobot
      ? robotOrder(incomingOrder, `${seedKey}:${round}:${role}`)
      : // Clamp rather than reject: a negative order becomes 0, matching
        // siemsene. The server action clamps too; this is the backstop.
        Math.max(0, Math.round(submitted ?? incomingOrder));

    result[role] = {
      incomingOrder,
      incomingShipment,
      shipped,
      outgoingOrder,
      inventory,
      backlog,
      cost,
      wasRobot: isRobot,
    };
  }

  return result;
}
