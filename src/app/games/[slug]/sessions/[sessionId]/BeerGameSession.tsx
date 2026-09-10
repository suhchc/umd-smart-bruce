// SPDX-License-Identifier: CC-BY-SA-4.0
//
// Routes a Beer Game session to the right view for who is looking at it, and
// derives each view's data. See NOTICE.md for attribution.

import { notFound } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { ROLE_ORDER, type BeerGameRole } from "@/lib/beerGame";
import { buildTeamAnalytics, type TeamAnalytics } from "@/lib/beerGameAnalytics";
import { parseBeerConfig, type BeerGameConfig } from "@/lib/beerGameConfig";
import { prisma } from "@/lib/prisma";
import { BeerGameHostConsole, type HostTeamRow } from "./BeerGameHostConsole";
import { BeerGameLobby, type LobbyMember } from "./BeerGameLobby";
import { BeerGamePlayerBoard, type PlayerBoardData } from "./BeerGamePlayerBoard";
import { BeerGameReport } from "./BeerGameReport";
import { joinAsParticipant, submitOrder } from "./actions";

/** Who a role buys from; null for the factory, which brews its own. */
const UPSTREAM_OF: Record<BeerGameRole, BeerGameRole | null> = {
  RETAILER: "WHOLESALER",
  WHOLESALER: "DISTRIBUTOR",
  DISTRIBUTOR: "FACTORY",
  FACTORY: null,
};

// Written out rather than inferred from the Prisma client, so the shape the
// views depend on is visible here and a schema change surfaces as a type error
// at this seam instead of deep inside a view.
type SeatRow = {
  id: string;
  role: BeerGameRole;
  isRobot: boolean;
  participantId: string | null;
  participant: { user: { name: string | null; email: string } } | null;
};

type TeamRow = {
  id: string;
  name: string;
  currentRound: number;
  totalCost: number;
  slots: SeatRow[];
};

type SessionData = {
  id: string;
  status: "PENDING" | "ACTIVE" | "COMPLETED";
  totalRounds: number;
  teams: TeamRow[];
};

/** Prefers a real name, falls back to the email we always have. */
function seatName(slot: SeatRow): string | null {
  if (!slot.participant) return null;
  return slot.participant.user.name ?? slot.participant.user.email;
}

export async function BeerGameSession({
  slug,
  sessionId,
}: {
  slug: string;
  sessionId: string;
}) {
  const [session, profile] = await Promise.all([
    prisma.gameSession.findUnique({
      where: { id: sessionId },
      include: {
        game: true,
        participants: {
          orderBy: { joinedAt: "asc" },
          include: { user: { select: { name: true, email: true } } },
        },
        teams: {
          orderBy: { createdAt: "asc" },
          include: {
            slots: {
              include: {
                participant: {
                  include: { user: { select: { name: true, email: true } } },
                },
              },
            },
          },
        },
      },
    }),
    getCurrentProfile(),
  ]);

  if (!session || session.game.slug !== slug) {
    notFound();
  }

  const config = parseBeerConfig(session.config);
  const viewer = profile
    ? session.participants.find((p) => p.userId === profile.id)
    : undefined;
  const canManage =
    !!profile &&
    (profile.id === session.instructorId || profile.role === "ADMIN");

  const data: SessionData = {
    id: session.id,
    status: session.status,
    totalRounds: session.totalRounds,
    teams: session.teams,
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        {session.game.name}
      </h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-500 print:hidden">
        Join code: <span className="font-mono">{session.joinCode}</span>
      </p>

      {session.status === "PENDING" && (
        <BeerGameLobby
          slug={slug}
          sessionId={sessionId}
          members={session.participants.map(
            (p): LobbyMember => ({
              id: p.id,
              displayName: p.user.name ?? p.user.email,
            }),
          )}
          config={config}
          totalRounds={session.totalRounds}
          viewerIsMember={!!viewer}
          canManage={canManage}
          isLoggedIn={!!profile}
          joinAction={joinAsParticipant.bind(null, slug, sessionId)}
        />
      )}

      {session.status === "ACTIVE" &&
        (canManage ? (
          <>
            <HostView slug={slug} sessionId={sessionId} session={data} />
            {/*
              A host may also hold a seat: the lobby offers them a Join button
              and startSession deals every participant into a chain. The console
              has nowhere to enter an order, so their own board goes *below* it
              rather than replacing it — otherwise the round sits waiting on an
              order they have no way to place.
            */}
            {viewer && (
              <section className="mt-10 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                  Your seat
                </p>
                <PlayerView
                  slug={slug}
                  sessionId={sessionId}
                  session={data}
                  config={config}
                  participantId={viewer.id}
                />
              </section>
            )}
          </>
        ) : viewer ? (
          <PlayerView
            slug={slug}
            sessionId={sessionId}
            session={data}
            config={config}
            participantId={viewer.id}
          />
        ) : (
          <p className="mt-8 text-sm text-zinc-500 dark:text-zinc-500">
            This session is already running and you don&apos;t have a seat in it.
            If a classmate drops out a seat may open up — try the join code
            again.
          </p>
        ))}

      {session.status === "COMPLETED" && (
        <CompletedView
          slug={slug}
          sessionId={sessionId}
          session={data}
          viewerParticipantId={viewer?.id ?? null}
          canManage={canManage}
        />
      )}
    </div>
  );
}

async function HostView({
  slug,
  sessionId,
  session,
}: {
  slug: string;
  sessionId: string;
  session: SessionData;
}) {
  const pendingOrders = await prisma.pendingOrder.findMany({
    where: { sessionId },
    select: { participantId: true, round: true },
  });

  const stagedRoundByParticipant = new Map(
    pendingOrders.map((o) => [o.participantId, o.round]),
  );

  const rows: HostTeamRow[] = session.teams.map((team) => ({
    id: team.id,
    name: team.name,
    round: team.currentRound,
    totalCost: team.totalCost,
    finished: team.currentRound > session.totalRounds,
    seats: ROLE_ORDER.flatMap((role) => {
      const slot = team.slots.find((s) => s.role === role);
      if (!slot) return [];
      return [
        {
          slotId: slot.id,
          role,
          isRobot: slot.isRobot,
          playerName: seatName(slot),
          hasSubmitted:
            !!slot.participantId &&
            stagedRoundByParticipant.get(slot.participantId) ===
              team.currentRound,
        },
      ];
    }),
  }));

  return (
    <BeerGameHostConsole
      slug={slug}
      sessionId={sessionId}
      teams={rows}
      totalRounds={session.totalRounds}
    />
  );
}

async function PlayerView({
  slug,
  sessionId,
  session,
  config,
  participantId,
}: {
  slug: string;
  sessionId: string;
  session: SessionData;
  config: BeerGameConfig;
  participantId: string;
}) {
  const team = session.teams.find((t) =>
    t.slots.some((s) => s.participantId === participantId),
  );
  const slot = team?.slots.find((s) => s.participantId === participantId);

  if (!team || !slot) {
    return (
      <p className="mt-8 text-sm text-zinc-500 dark:text-zinc-500">
        You&apos;re enrolled in this session but haven&apos;t been given a seat.
        Your instructor can sort this out from their console.
      </p>
    );
  }

  const round = team.currentRound;
  const finished = round > session.totalRounds;
  const upstreamRole = UPSTREAM_OF[slot.role];

  const [myLast, upstreamLast, myHistory, teamPending, myStaged] =
    await Promise.all([
      prisma.gameRoundState.findFirst({
        where: { teamId: team.id, role: slot.role },
        orderBy: { round: "desc" },
      }),
      config.showUpstreamBacklog && upstreamRole
        ? prisma.gameRoundState.findFirst({
            where: { teamId: team.id, role: upstreamRole },
            orderBy: { round: "desc" },
          })
        : null,
      prisma.gameRoundState.findMany({
        where: { teamId: team.id, role: slot.role },
        orderBy: { round: "asc" },
        select: { outgoingOrder: true },
      }),
      prisma.pendingOrder.findMany({
        where: { teamId: team.id, round },
        select: { participantId: true },
      }),
      prisma.pendingOrder.findUnique({
        where: { participantId_round: { participantId, round } },
        select: { amount: true },
      }),
    ]);

  const humanSeats = team.slots.filter(
    (s) => !s.isRobot && s.participantId,
  ).length;

  const data: PlayerBoardData = {
    teamName: team.name,
    role: slot.role,
    round: finished ? session.totalRounds : round,
    totalRounds: session.totalRounds,
    teamTotalCost: team.totalCost,
    // Before round 1 resolves there is no history, so fall back to the
    // configured opening position.
    inventory: myLast?.inventory ?? config.initialInventory,
    backlog: myLast?.backlog ?? 0,
    // Deliberately last round's figures. Because every stage resolves
    // simultaneously, this round's incoming order isn't known until after
    // everyone has ordered — so what a player reasons from is what they were
    // asked for last round. The labels on the board say so.
    lastIncomingOrder: myLast?.incomingOrder ?? config.pipelineSeed,
    lastIncomingShipment: myLast?.incomingShipment ?? config.pipelineSeed,
    upstreamBacklog: config.showUpstreamBacklog
      ? (upstreamLast?.backlog ?? null)
      : null,
    upstreamRole: config.showUpstreamBacklog ? upstreamRole : null,
    submittedAmount: myStaged?.amount ?? null,
    waitingOn: Math.max(humanSeats - teamPending.length, 0),
    myOrderHistory: myHistory.map((r) => r.outgoingOrder),
    finished,
  };

  return (
    <BeerGamePlayerBoard
      data={data}
      submitAction={submitOrder.bind(null, slug, sessionId)}
    />
  );
}

async function CompletedView({
  slug,
  sessionId,
  session,
  viewerParticipantId,
  canManage,
}: {
  slug: string;
  sessionId: string;
  session: SessionData;
  viewerParticipantId: string | null;
  canManage: boolean;
}) {
  if (!viewerParticipantId && !canManage) {
    return (
      <p className="mt-8 text-sm text-zinc-500 dark:text-zinc-500">
        This game has ended.
      </p>
    );
  }

  const rounds = await prisma.gameRoundState.findMany({
    where: { sessionId },
    orderBy: { round: "asc" },
    select: {
      teamId: true,
      role: true,
      round: true,
      outgoingOrder: true,
      cost: true,
    },
  });

  const rowsByTeam = new Map<string, typeof rounds>();
  for (const row of rounds) {
    const bucket = rowsByTeam.get(row.teamId) ?? [];
    bucket.push(row);
    rowsByTeam.set(row.teamId, bucket);
  }

  const teams: TeamAnalytics[] = session.teams.map((team) =>
    buildTeamAnalytics(
      { id: team.id, name: team.name, totalCost: team.totalCost },
      rowsByTeam.get(team.id) ?? [],
      team.slots.filter((s) => s.isRobot).length,
    ),
  );

  const viewerTeamId =
    session.teams.find((t) =>
      t.slots.some((s) => s.participantId === viewerParticipantId),
    )?.id ?? null;

  return (
    <BeerGameReport
      slug={slug}
      sessionId={sessionId}
      teams={teams}
      totalRounds={session.totalRounds}
      viewerTeamId={viewerTeamId}
      canManage={canManage}
    />
  );
}
