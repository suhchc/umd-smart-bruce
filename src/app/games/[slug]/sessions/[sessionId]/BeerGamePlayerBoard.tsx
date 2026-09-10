// SPDX-License-Identifier: CC-BY-SA-4.0
//
// One player's view of their own stage. Upstream-backlog visibility is
// siemsene/beergame's optional session feature. See NOTICE.md for attribution.

import { LineChart } from "@/components/LineChart";
import { PollingRefresher } from "@/components/PollingRefresher";
import {
  demandSourceLabel,
  ROLE_COLORS,
  ROLE_LABELS,
  type BeerGameRole,
} from "@/lib/beerGame";
import { ORDER_CHART_Y_MAX } from "@/lib/beerGameAnalytics";
import { OrderForm } from "./OrderForm";

export type PlayerBoardData = {
  teamName: string;
  role: BeerGameRole;
  round: number;
  totalRounds: number;
  teamTotalCost: number;
  inventory: number;
  backlog: number;
  /**
   * What this player was asked for, and what reached them, in the round just
   * resolved. Every stage resolves simultaneously, so the current round's
   * figures don't exist yet — these are what a player actually reasons from.
   */
  lastIncomingOrder: number;
  lastIncomingShipment: number;
  /** Null when the host hasn't enabled upstream-backlog visibility. */
  upstreamBacklog: number | null;
  upstreamRole: BeerGameRole | null;
  submittedAmount: number | null;
  waitingOn: number;
  myOrderHistory: number[];
  finished: boolean;
};

export function BeerGamePlayerBoard({
  data,
  submitAction,
}: {
  data: PlayerBoardData;
  submitAction: (formData: FormData) => void | Promise<void>;
}) {
  const {
    teamName,
    role,
    round,
    totalRounds,
    teamTotalCost,
    inventory,
    backlog,
    lastIncomingOrder,
    lastIncomingShipment,
    upstreamBacklog,
    upstreamRole,
    submittedAmount,
    waitingOn,
    myOrderHistory,
    finished,
  } = data;

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">
          {teamName} —{" "}
          <span style={{ color: ROLE_COLORS[role] }}>{ROLE_LABELS[role]}</span>
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {finished
            ? `Finished all ${totalRounds} rounds`
            : `Round ${round} of ${totalRounds}`}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Inventory" value={inventory} hint="Units on hand" />
        <Stat
          label="Backlog"
          value={backlog}
          hint="Units you owe"
          emphasis={backlog > 0}
        />
        <Stat
          label={`Demand from ${demandSourceLabel(role)}`}
          value={lastIncomingOrder}
          hint="Last round"
        />
        <Stat
          label="Arrived"
          value={lastIncomingShipment}
          hint={role === "FACTORY" ? "Brewing done, last round" : "Last round"}
        />
      </div>

      {upstreamBacklog !== null && upstreamRole && (
        <p className="mt-3 rounded-lg border border-zinc-200 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          Your supplier ({ROLE_LABELS[upstreamRole]}) is currently{" "}
          <strong className="text-zinc-900 dark:text-zinc-50">
            {upstreamBacklog}
          </strong>{" "}
          {upstreamBacklog === 1 ? "unit" : "units"} behind on your orders.
        </p>
      )}

      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-500">
        Your chain has run up{" "}
        <strong className="text-zinc-900 dark:text-zinc-50">
          ${teamTotalCost.toFixed(2)}
        </strong>{" "}
        in costs so far.
      </p>

      {finished ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          You&apos;ve played every round. Waiting for the rest of the class to
          finish — the results will appear here.
        </p>
      ) : submittedAmount !== null ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          Order submitted ({submittedAmount}{" "}
          {submittedAmount === 1 ? "unit" : "units"}).{" "}
          {waitingOn > 0
            ? `Waiting for ${waitingOn} more ${waitingOn === 1 ? "player" : "players"} on your chain…`
            : "Resolving the round…"}
        </p>
      ) : (
        <OrderForm
          action={submitAction}
          round={round}
          defaultValue={lastIncomingOrder}
        />
      )}

      {myOrderHistory.length > 0 && (
        <div className="mt-8">
          <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
            Your orders so far
          </h3>
          <div className="mt-3">
            <LineChart
              minAxisMax={ORDER_CHART_Y_MAX}
              series={[
                {
                  label: ROLE_LABELS[role],
                  color: ROLE_COLORS[role],
                  points: myOrderHistory,
                },
              ]}
            />
          </div>
        </div>
      )}

      <PollingRefresher />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: number;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        emphasis
          ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
          : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <p className="text-xs text-zinc-500 dark:text-zinc-500">{label}</p>
      <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        {value}
      </p>
      {hint && (
        <p className="text-xs text-zinc-500 dark:text-zinc-500">{hint}</p>
      )}
    </div>
  );
}
