import connect from "../Modules/database";
import {
  clubs,
  historicalClubs,
  leagueSettings,
  leagueUsers,
  points,
  position,
  predictions,
} from "#types/database";

async function top11(userID: number, leagueID: number) {
  const connection = await connect();
  const formation = JSON.parse(
    await connection
      .query("SELECT formation FROM leagueUsers WHERE leagueID=? AND user=?", [
        leagueID,
        userID,
      ])
      .then((e) => e[0].formation),
  );
  // Moves all players off the field
  await connection.query(
    `UPDATE squad SET position=(SELECT position FROM players WHERE players.uid=squad.playeruid AND league=(SELECT league FROM leagueSettings WHERE leagueID=?)) WHERE leagueID=? AND user=?`,
    [leagueID, leagueID, userID],
  );
  const players: { playeruid: string; position: position; points: number }[] =
    await connection.query(
      `SELECT 
        squad.playeruid, 
        players.position, 
        players.last_match + players.last_match * starred AS points 
      FROM 
        squad 
        LEFT OUTER JOIN players ON players.uid = squad.playeruid 
      WHERE 
        user = ? 
        AND leagueID = ? 
      ORDER BY 
        players.position, 
        points DESC`,
      [userID, leagueID],
    );
  const parts = ["gk", "def", "mid", "att"];
  // Goes through every character and moves them to the correct position
  for (const player of players) {
    const position = parts.indexOf(player.position);
    if (formation[position] > 0) {
      await connection.query(
        "UPDATE squad SET position=? WHERE playeruid=? AND leagueID=? AND user=?",
        [player.position, player.playeruid, leagueID, userID],
      );
      formation[position]--;
    } else {
      await connection.query(
        "UPDATE squad SET position='bench' WHERE playeruid=? AND leagueID=? AND user=?",
        [player.playeruid, leagueID, userID],
      );
    }
  }
  connection.end();
}
/**
 * Calculates the total points for unstarred players for a user.
 *
 * @param {leagueUsers} user - The user for whom to calculate the points.
 * @return {Promise<number>} The total points for unstarred players.
 */
async function calcUnstarredPoints(user: leagueUsers): Promise<number> {
  const connection = await connect();
  const result: number[] = await connection.query(
    "SELECT SUM(last_match) FROM players WHERE EXISTS (SELECT * FROM squad WHERE squad.playeruid=players.uid AND position!='bench' AND leagueID=? AND user=? AND starred=0)",
    [user.leagueID, user.user],
  );
  await connection.end();
  const value = Object.values(result[0])[0];
  return value ? value : 0;
}
/**
 * Calculates the total points for a user's starred players in a league.
 *
 * @param {leagueUsers} user - The user for whom to calculate the points.
 * @return {Promise<number>} The total points for the user's starred players.
 */
export async function calcStarredPoints(user: leagueUsers): Promise<number> {
  const connection = await connect();
  const data: {
    "SUM(last_match)": number;
  }[] = await connection.query(
    "SELECT SUM(last_match) FROM players WHERE EXISTS (SELECT * FROM squad WHERE squad.playeruid=players.uid AND position!='bench' AND leagueID=? AND user=? AND starred=1)",
    [user.leagueID, user.user],
  );
  const points = Object.values(data[0])[0];
  const starMultiplier = await connection
    .query("SELECT starredPercentage FROM leagueSettings WHERE leagueID=?", [
      user.leagueID,
    ])
    .then((res) => (res.length > 0 ? res[0].starredPercentage / 100 : 1.5));
  connection.end();
  return Math.ceil(points * starMultiplier);
}
export interface predictions_raw {
  club: string;
  home?: number;
  away?: number;
}
/**
 * Calculates the total prediction points based on the provided predictions and actual game results.
 *
 * @param {predictions_raw[]} predictions - An array of predicted scores for various clubs.
 * @param {predictions_raw[]} games - An array of actual game results for various clubs.
 * @param {leagueSettings} settings - The league settings that contain the scoring rules for predictions.
 * @return {number} The total points accumulated from the predictions based on the scoring rules.
 *
 * The function iterates through each prediction and compares it against the actual game result for the same club.
 * Points are awarded based on:
 * - Exact match of predicted and actual scores.
 * - Correct prediction of the goal difference.
 * - Correct prediction of the match outcome (winner).
 */
export function calcPredicitionPointsRaw(
  predictions: predictions_raw[],
  games: predictions_raw[],
  settings: leagueSettings,
): number {
  let points = 0;
  for (const prediction of predictions) {
    if (prediction.home === undefined || prediction.away === undefined) {
      continue;
    }
    for (const game of games) {
      if (game.home === undefined || game.away === undefined) {
        continue;
      }
      if (prediction.club == game.club) {
        // Checks if the score was exactly right
        if (prediction.home === game.home && prediction.away === game.away) {
          points += settings.predictExact;
        }
        // Checks if the correct difference in points was chosen
        else if (prediction.home - prediction.away === game.home - game.away) {
          points += settings.predictDifference;
        }
        // Checks if the correct winner was chosen
        else if (
          prediction.home > prediction.away === game.home > game.away &&
          (prediction.home === prediction.away) === (game.home === game.away)
        ) {
          points += settings.predictWinner;
        }
      }
    }
  }
  return points;
}
/**
 * Calculates the total prediction points for a given user for a given matchday.
 *
 * @param {points} matchday - The matchday for which to calculate the prediction points.
 * @return {Promise<number>} The total prediction points for the user for the given matchday.
 */
export async function calcHistoricalPredictionPoints(
  matchday: points,
): Promise<number> {
  const connection = await connect();
  const temp: leagueSettings[] = await connection.query(
    "SELECT * FROM leagueSettings WHERE leagueID=?",
    [matchday.leagueID],
  );
  if (temp.length == 0) {
    return 0;
  }
  const settings: leagueSettings = temp[0];
  const predictions: predictions[] = await connection.query(
    "SELECT * FROM historicalPredictions WHERE user=? AND leagueID=? AND matchday=?",
    [matchday.user, matchday.leagueID, matchday.matchday],
  );
  const games: predictions_raw[] = (
    await connection.query(
      "SELECT * FROM historicalClubs WHERE league=? AND home=1 AND time=?",
      [settings.league, matchday.time],
    )
  ).map((e: historicalClubs) => {
    return {
      home: e.teamScore,
      away: e.opponentScore,
      club: e.club,
    };
  });
  return calcPredicitionPointsRaw(predictions, games, settings);
}
/**
 * Calculates the prediction points for a given user.
 *
 * @param {leagueUsers} user - The user for whom to calculate the prediction points.
 * @return {Promise<number>} The prediction points for the user.
 */
export async function calcPredictionsPointsNow(
  user: leagueUsers,
): Promise<number> {
  const connection = await connect();
  const temp: leagueSettings[] = await connection.query(
    "SELECT * FROM leagueSettings WHERE leagueID=?",
    [user.leagueID],
  );
  if (temp.length == 0) {
    return 0;
  }
  const settings: leagueSettings = temp[0];
  // Changes all the nulls to 0's to prevent invalid predictions from existing
  await connection.query(
    "UPDATE predictions SET home=IFNULL(home, 0), away=IFNULL(away, 0) WHERE user=? AND leagueID=?",
    [user.user, user.leagueID],
  );
  const predictions: predictions[] = await connection.query(
    "SELECT * FROM predictions WHERE user=? AND leagueID=?",
    [user.user, user.leagueID],
  );
  const games: predictions_raw[] = (
    await connection.query("SELECT * FROM clubs WHERE league=? AND home=1", [
      settings.league,
    ])
  ).map((e: clubs) => {
    return {
      club: e.club,
      home: e.teamScore,
      away: e.opponentScore,
    };
  });
  connection.end();
  return calcPredicitionPointsRaw(predictions, games, settings);
}
/**
 * Calculates and updates the points for the specified league.
 *
 * @param {string | number} league - The league type or leagueID.
 */
export async function calcPoints(league: string | number) {
  const connection = await connect();
  let leagueID: false | number = false;
  // Checks if a league number was requested instead of an entire league type
  if (parseInt(String(league)) > 0) {
    const leagueData: leagueSettings[] = await connection.query(
      "SELECT * FROM leagueSettings WHERE leagueID=? AND archived=0",
      [league],
    );
    if (leagueData.length > 0) {
      leagueID = leagueData[0].leagueID;
      league = leagueData[0].league;
    }
  }
  // Makes sure that the transfer season is running
  if (
    await connection
      .query("SELECT value2 FROM data WHERE value1=?", [
        "transferOpen" + league,
      ])
      .then((result) => (result.length > 0 ? result[0].value2 == "true" : true))
  ) {
    connection.end();
    return;
  }
  console.log(
    `Calculating user points for ${
      leagueID ? `leagueID ${leagueID} in the ` : ""
    }${league}`,
  );
  const leagueUsers: leagueUsers[] = leagueID
    ? await connection.query(
        "SELECT leagueID, user, points, fantasyPoints, predictionPoints FROM leagueUsers WHERE leagueID=?",
        [leagueID],
      )
    : await connection.query(
        "SELECT leagueID, user, points, fantasyPoints, predictionPoints FROM leagueUsers WHERE EXISTS (SELECT * FROM leagueSettings WHERE league=? AND leagueSettings.leagueID=leagueUsers.leagueID AND EXISTS (SELECT * FROM points WHERE leagueUsers.leagueID=points.leagueID AND time IS NULL)) ORDER BY leagueID",
        [league],
      );
  let index = 0;
  let currentleagueID = -1;
  let matchday = 1;
  while (index < leagueUsers.length) {
    const e = leagueUsers[index];
    index++;
    // Moves top 11 players when needed
    if (
      await connection
        .query("SELECT * FROM leagueSettings WHERE leagueID=? AND top11=1", [
          e.leagueID,
        ])
        .then((e) => e.length > 0)
    ) {
      await top11(e.user, e.leagueID);
    }
    const [
      [oldFantasyPoints, oldPredictionPoints],
      newFantasyPoints,
      newPredictionPoints,
    ] = await Promise.all([
      // Gets how many points the user had for the matchday with the previous calculation
      connection
        .query(
          "SELECT fantasyPoints, predictionPoints FROM points WHERE leagueID=? AND user=? AND time IS NULL ORDER BY matchday DESC LIMIT 1",
          [e.leagueID, e.user],
        )
        .then((result: points[]) =>
          result.length > 0
            ? [result[0].fantasyPoints, result[0].predictionPoints]
            : [0, 0],
        ),
      // Calculates the amont of points the user should have for the matchday
      new Promise<number>(async (res) => {
        res(
          (
            await Promise.all([
              // Calculates points for unstarred players
              calcUnstarredPoints(e),
              // Calculates points for starred players
              calcStarredPoints(e),
            ])
          ).reduce((a, b) => a + b),
        );
      }),
      // Calculates the amont of points the user should have for the matchday in predictions
      calcPredictionsPointsNow(e),
    ]);
    // Checks if the matchday might be different
    if (e.leagueID !== currentleagueID) {
      currentleagueID = e.leagueID;
      // Calculates the latest matchday for that league
      matchday = await connection
        .query(
          "SELECT matchday FROM points WHERE leagueID=? ORDER BY matchday DESC LIMIT 1",
          [currentleagueID],
        )
        .then((result) => (result.length > 0 ? result[0].matchday : 1));
    }
    // Checks if the fanasy point amount has changed and if they are different they are updated
    if (oldFantasyPoints !== newFantasyPoints) {
      connection.query(
        "UPDATE points SET fantasyPoints=?, points=?+predictionPoints WHERE leagueID=? AND user=? AND matchday=?",
        [newFantasyPoints, newFantasyPoints, e.leagueID, e.user, matchday],
      );
      connection.query(
        "UPDATE leagueUsers SET fantasyPoints=?, points=?+predictionPoints WHERE leagueID=? AND user=?",
        [
          e.fantasyPoints - oldFantasyPoints + newFantasyPoints,
          e.fantasyPoints - oldFantasyPoints + newFantasyPoints,
          e.leagueID,
          e.user,
        ],
      );
    }
    // Checks if the prediction point amount has changed
    if (oldPredictionPoints !== newPredictionPoints) {
      connection.query(
        "UPDATE points SET predictionPoints=?, points=?+fantasyPoints WHERE leagueID=? AND user=? AND matchday=?",
        [
          newPredictionPoints,
          newPredictionPoints,
          e.leagueID,
          e.user,
          matchday,
        ],
      );
      connection.query(
        "UPDATE leagueUsers SET predictionPoints=?, points=?+fantasyPoints WHERE leagueID=? AND user=?",
        [
          e.predictionPoints - oldPredictionPoints + newPredictionPoints,
          e.predictionPoints - oldPredictionPoints + newPredictionPoints,
          e.leagueID,
          e.user,
        ],
      );
    }
  }
  console.log(
    `Updated user points for ${
      leagueID ? `leagueID ${leagueID} in the ` : ""
    }${league}`,
  );
  connection.end();
  return;
}
