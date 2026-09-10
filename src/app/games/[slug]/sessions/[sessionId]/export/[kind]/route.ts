// SPDX-License-Identifier: CC-BY-SA-4.0
//
// Session data exports. The set of files mirrors siemsene/beergame's CSV ZIP,
// served as individual downloads. See NOTICE.md for attribution.

import { getCurrentProfile } from "@/lib/auth";
import { ROLE_LABELS, ROLE_ORDER } from "@/lib/beerGame";
import {
  buildLeaderboardRows,
  buildStdDevRows,
  buildTeamAnalytics,
  formatBullwhip,
  type TeamAnalytics,
} from "@/lib/beerGameAnalytics";
import { csvFilename, toCsv } from "@/lib/beerGameCsv";
import { isExportKind, type ExportKind } from "@/lib/beerGameExports";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/games/[slug]/sessions/[sessionId]/export/[kind]">,
) {
  const { slug, sessionId, kind } = await ctx.params;

  if (!isExportKind(kind)) {
    return new Response("Unknown export type.", { status: 404 });
  }

  const profile = await getCurrentProfile();
  if (!profile) {
    return new Response("You must be logged in.", { status: 401 });
  }

  const session = await prisma.gameSession.findUnique({
    where: { id: sessionId },
    include: {
      game: { select: { slug: true } },
      participants: {
        orderBy: { joinedAt: "asc" },
        include: { user: { select: { name: true, email: true } } },
      },
      teams: {
        orderBy: { createdAt: "asc" },
        include: { slots: true },
      },
    },
  });

  if (!session || session.game.slug !== slug) {
    return new Response("Session not found.", { status: 404 });
  }

  // Host-only. These files carry the whole class's names and email addresses,
  // so students get the on-screen report but not a downloadable roster of
  // their classmates.
  const canManage =
    profile.id === session.instructorId || profile.role === "ADMIN";
  if (!canManage) {
    return new Response("Only the session's instructor can export data.", {
      status: 403,
    });
  }

  const rounds = await prisma.gameRoundState.findMany({
    where: { sessionId },
    orderBy: [{ round: "asc" }, { role: "asc" }],
  });

  const teamNameById = new Map(session.teams.map((t) => [t.id, t.name]));
  const participantNameById = new Map(
    session.participants.map((p) => [p.id, p.user.name ?? p.user.email]),
  );

  const rowsByTeam = new Map<string, typeof rounds>();
  for (const row of rounds) {
    const bucket = rowsByTeam.get(row.teamId) ?? [];
    bucket.push(row);
    rowsByTeam.set(row.teamId, bucket);
  }

  const analytics: TeamAnalytics[] = session.teams.map((team) =>
    buildTeamAnalytics(
      { id: team.id, name: team.name, totalCost: team.totalCost },
      rowsByTeam.get(team.id) ?? [],
      team.slots.filter((s) => s.isRobot).length,
    ),
  );

  const body = buildCsv(kind, {
    rounds,
    analytics,
    teamNameById,
    participantNameById,
    teams: session.teams,
    participants: session.participants,
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename([
        "beer-game",
        session.joinCode,
        kind,
      ])}"`,
      // Exports are a point-in-time snapshot of live data; never cache them.
      "Cache-Control": "no-store",
    },
  });
}

type CsvInput = {
  rounds: {
    teamId: string;
    participantId: string | null;
    role: keyof typeof ROLE_LABELS;
    round: number;
    incomingOrder: number;
    incomingShipment: number;
    shipped: number;
    outgoingOrder: number;
    inventory: number;
    backlog: number;
    cost: number;
    wasRobot: boolean;
  }[];
  analytics: TeamAnalytics[];
  teamNameById: Map<string, string>;
  participantNameById: Map<string, string>;
  teams: { id: string; name: string; slots: { role: string; participantId: string | null; isRobot: boolean }[] }[];
  participants: { id: string; user: { name: string | null; email: string } }[];
};

function buildCsv(kind: ExportKind, input: CsvInput): string {
  switch (kind) {
    case "session":
      return toCsv(
        [
          "Chain",
          "Role",
          "Round",
          "Player",
          "Played by robot",
          // Each row is one role, so the column names the direction rather than
          // a specific stage: for the Retailer this is customer demand, for the
          // others it is the order placed by the stage they supply.
          "Demand from downstream",
          "Arrived",
          "Shipped",
          "Order placed",
          "Inventory end",
          "Backlog end",
          "Cost",
        ],
        input.rounds.map((r) => [
          input.teamNameById.get(r.teamId) ?? r.teamId,
          ROLE_LABELS[r.role],
          r.round,
          r.participantId
            ? (input.participantNameById.get(r.participantId) ?? "")
            : "",
          r.wasRobot ? "yes" : "no",
          r.incomingOrder,
          r.incomingShipment,
          r.shipped,
          r.outgoingOrder,
          r.inventory,
          r.backlog,
          Number(r.cost.toFixed(4)),
        ]),
      );

    case "leaderboard":
      return toCsv(
        ["Rank", "Chain", "Total cost", "Rounds played", "Robot players", "Bullwhip"],
        buildLeaderboardRows(input.analytics).map((row) => [
          row.rank,
          row.teamName,
          Number(row.totalCost.toFixed(4)),
          row.roundsCompleted,
          row.robotCount,
          formatBullwhip(row.bullwhip),
        ]),
      );

    case "stddev":
      return toCsv(
        ["Chain", ...ROLE_ORDER.map((role) => `${ROLE_LABELS[role]} order std dev`)],
        buildStdDevRows(input.analytics).map((row) => [
          row.teamName,
          ...ROLE_ORDER.map((role) => Number(row.byRole[role].toFixed(4))),
        ]),
      );

    case "orders":
      return toCsv(
        ["Chain", "Role", "Round", "Order placed"],
        input.rounds.map((r) => [
          input.teamNameById.get(r.teamId) ?? r.teamId,
          ROLE_LABELS[r.role],
          r.round,
          r.outgoingOrder,
        ]),
      );

    case "players": {
      const seatByParticipant = new Map<
        string,
        { teamName: string; role: string }
      >();
      for (const team of input.teams) {
        for (const slot of team.slots) {
          if (slot.participantId) {
            seatByParticipant.set(slot.participantId, {
              teamName: team.name,
              role: slot.role,
            });
          }
        }
      }

      return toCsv(
        ["Name", "Email", "Chain", "Role"],
        input.participants.map((p) => {
          const seat = seatByParticipant.get(p.id);
          return [
            p.user.name ?? "",
            p.user.email,
            seat?.teamName ?? "",
            // A participant with no seat either joined the lobby before the
            // cohort was drawn and the session never started, or was handed
            // over to a robot mid-game.
            seat ? ROLE_LABELS[seat.role as keyof typeof ROLE_LABELS] : "no seat",
          ];
        }),
      );
    }
  }
}
