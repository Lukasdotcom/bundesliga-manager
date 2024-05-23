import { createHash } from "crypto";
import fs from "fs";
import connect from "../Modules/database";
import { data, plugins } from "../types/database";
import { compareSemanticVersions } from "../Modules/semantic";
import store from "../types/store";
import upgradeDB from "./upgradeDB";
import dotenv from "dotenv";
import { finished } from "stream/promises";
import { Readable } from "stream";
import { ReadableStream } from "stream/web";
if (process.env.APP_ENV !== "test") {
  dotenv.config({ path: ".env.local" });
} else {
  dotenv.config({ path: ".env.test.local" });
}
export const default_theme_dark = JSON.stringify({
  palette: {
    mode: "dark",
    warning: {
      main: "#fdd835",
    },
  },
});
export const default_theme_light = JSON.stringify({
  palette: {
    mode: "light",
    warning: {
      main: "#fbc02d",
    },
  },
});
// Used to tell the program what version the database should get to
const currentVersion = "1.18.1";
// Creates the default config
async function createConfig() {
  const connection = await connect();
  await connection.query(
    "INSERT IGNORE INTO data (value1, value2) VALUES ('configMinTimeGame', '120'), ('configMaxTimeGame', '1200'), ('configMinTimeTransfer', '3600'), ('configMaxTimeTransfer', '86400'), ('configDownloadPicture', 'needed'), ('configDeleteInactiveUser', '0'), ('configArchiveInactiveLeague', '180'), ('configEnablePasswordSignup', ?), ('configThemeDark', ?), ('configThemeLight', ?)",
    [
      process.env.APP_ENV !== "production",
      default_theme_dark,
      default_theme_light,
    ],
  );
  if (process.env.APP_ENV === "test") {
    await connection.query(
      "UPDATE data SET value2='no' WHERE value1='configDownloadPicture'",
    );
  }
  connection.end();
}
// Downloads and generates all the plugin code
async function compilePlugins() {
  const connection = await connect();
  console.log("Compiling plugins");
  let mainFileTextStart = `// Note that this file is autogenerated by startup.ts DO NOT EDIT\nimport dataGetter from "#type/data";\n`;
  let mainFileText =
    "export const plugins: { [key: string]: dataGetter } = {\n";
  const request =
    process.env.APP_ENV !== "test"
      ? await fetch(
          "https://raw.githubusercontent.com/Lukasdotcom/fantasy-manager/main/store/default_store.json",
        ).catch(() => {
          console.error("Could not get the default store");
          return "error";
        })
      : "error";
  const defaultStore: string[] =
    request instanceof Response
      ? await request.json().catch(() => {
          console.error("Could not get the default store");
          return [];
        })
      : // Uses a fallback store if the request fails(this is also the testing store)
        [
          "https://raw.githubusercontent.com/Lukasdotcom/fantasy-manager/main/store/Bundesliga/Bundesliga.json",
        ];
  // Installs all plugins that should be installed by default
  await Promise.all(
    defaultStore.map(
      async (e) =>
        await connection.query(
          "INSERT IGNORE INTO plugins (name, settings, enabled, url) VALUES ('', '{}', 0, ?)",
          [e],
        ),
    ),
  );
  // Makes sure that bundesliga is enabled when testing
  if (process.env.APP_ENV === "test") {
    await connection.query("UPDATE plugins SET enabled=1");
  }
  const currentVersion = (await import("../package.json")).default.version;
  // Makes sure that the store is correct
  connection.query(
    "INSERT INTO data VALUES ('defaultStore', ?) ON DUPLICATE KEY UPDATE value2=?",
    [JSON.stringify(defaultStore), JSON.stringify(defaultStore)],
  );
  const plugins = await connection.query("SELECT * FROM plugins");
  await Promise.all(
    plugins.map(
      (e: plugins) =>
        new Promise<void>(async (res) => {
          const data = await fetch(e.url).catch(() => "error");
          if (!(data instanceof Response)) {
            res();
            console.log(`Failed to find plugin at ${e.url}`);
            return;
          }
          const json: store | "error" = await data.json().catch(() => "error");
          if (json === "error") {
            res();
            console.log(`Failed to find plugin at ${e.url}`);
            return;
          }
          connection.query("UPDATE plugins SET name=? WHERE url=?", [
            json.id,
            e.url,
          ]);
          e.name = json.id;
          // Makes sure the plugin is compatible with the current version
          if (compareSemanticVersions(json.version, currentVersion) !== 1) {
            console.error(
              `Plugin ${e.name} is not compatible with the current version of the program`,
            );
            res();
            return;
          }
          // Creates a hash of the url for storing the plugin in
          const hash = createHash("sha256").update(e.url).digest("hex");
          // Checks if the latest version for the plugin is installed
          if (
            e.version !== json.version ||
            !fs.existsSync("scripts/data/" + hash)
          ) {
            if (e.version === json.version) {
              console.log(`Updating plugin ${e.name}`);
            } else {
              console.log(`Installing plugin ${e.name}`);
            }
            // Downloads the plugin
            if (!fs.existsSync("scripts/data")) {
              fs.mkdirSync("scripts/data");
            }
            // Remove directory if it exists
            if (fs.existsSync("scripts/data/" + hash)) {
              fs.rmSync("scripts/data/" + hash, {
                recursive: true,
                force: true,
              });
            }
            fs.mkdirSync("scripts/data/" + hash);
            // Downloads all the files
            await Promise.all(
              json.files.map(
                (file) =>
                  new Promise<void>(async (res, rej) => {
                    const stream = fs.createWriteStream(
                      __dirname + "/data/" + hash + "/" + file.split("/").pop(),
                    );
                    const { body, status } = await fetch(file);
                    if (!body || status !== 200) {
                      rej();
                      return;
                    }
                    await finished(
                      Readable.fromWeb(body as ReadableStream<Uint8Array>).pipe(
                        stream,
                      ),
                    );
                    res();
                  }),
              ),
            ).then(
              () => {
                console.log(`Finished downloading plugin ${e.name}`);
                mainFileTextStart += `import plugin${hash} from "./data/${hash}";\n`;
                mainFileText += `  "${e.url}":\n    plugin${hash},\n`;
                connection.query("UPDATE plugins SET version=? WHERE url=?", [
                  json.version,
                  e.url,
                ]);
              },
              () => {
                console.error(
                  `Failed to download plugin ${e.name}. Restart server to try again.`,
                );
                connection.query(
                  "UPDATE plugins SET version='', enabled=0  WHERE url=?",
                  [e.url],
                );
              },
            );
          } else {
            mainFileTextStart += `import plugin${hash} from "./data/${hash}";\n`;
            mainFileText += `  "${e.url}":\n    plugin${hash},\n`;
          }
          res();
        }),
    ),
  );
  mainFileText += "};\nexport default plugins;\n";
  fs.writeFileSync("scripts/data.ts", mainFileTextStart + mainFileText);
  console.log("Done compiling plugins");
}
async function startUp() {
  const connection = await connect();
  await Promise.all([
    // Used to store the users
    connection.query(
      "CREATE TABLE IF NOT EXISTS users (id int PRIMARY KEY AUTO_INCREMENT NOT NULL, username varchar(255), password varchar(60), throttle int DEFAULT 30, active bool DEFAULT 0, inactiveDays int DEFAULT 0, google varchar(255) DEFAULT '', github varchar(255) DEFAULT '', admin bool DEFAULT false, favoriteLeague int, theme varchar(10), locale varchar(5))",
    ),
    // Used to store the players data
    connection.query(
      "CREATE TABLE IF NOT EXISTS players (uid varchar(25), name varchar(255), nameAscii varchar(255), club varchar(3), pictureID int, value int, sale_price int, position varchar(3), forecast varchar(1), total_points int, average_points int, last_match int, locked bool, `exists` bool, league varchar(25))",
    ),
    // Creates a table that contains some key value pairs for data that is needed for some things
    connection.query(
      "CREATE TABLE IF NOT EXISTS data (value1 varchar(25) PRIMARY KEY, value2 varchar(255))",
    ),
    // Used to store the leagues settings
    connection.query(
      "CREATE TABLE IF NOT EXISTS leagueSettings (leagueName varchar(255), leagueID int PRIMARY KEY AUTO_INCREMENT NOT NULL, startMoney int DEFAULT 150000000, transfers int DEFAULT 6, duplicatePlayers int DEFAULT 1, starredPercentage int DEFAULT 150, league varchar(25), archived int DEFAULT 0, matchdayTransfers boolean DEFAULT 0, fantasyEnabled boolean DEFAULT 1, predictionsEnabled boolean DEFAULT 1, predictWinner int DEFAULT 2, predictDifference int DEFAULT 5, predictExact int DEFAULT 15, top11 boolean DEFAULT 0, active bool DEFAULT 0, inactiveDays int DEFAULT 0)",
    ),
    // Used to store the leagues users
    connection.query(
      "CREATE TABLE IF NOT EXISTS leagueUsers (leagueID int, user int, fantasyPoints int DEFAULT 0, predictionPoints int DEFAULT 0, points int, money int, formation varchar(255), admin bool DEFAULT 0, tutorial bool DEFAULT 1)",
    ),
    // Used to store the Historical Points
    connection.query(
      "CREATE TABLE IF NOT EXISTS points (leagueID int, user int, fantasyPoints int, predictionPoints int, points int, matchday int, money int, time int)",
    ),
    // Used to store transfers
    connection.query(
      "CREATE TABLE IF NOT EXISTS transfers (leagueID int, seller int, buyer int, playeruid varchar(25), value int, position varchar(5) DEFAULT 'bench', starred bool DEFAULT 0, max int)",
    ),
    // Used to store invite links
    connection.query(
      "CREATE TABLE IF NOT EXISTS invite (inviteID varchar(25) PRIMARY KEY, leagueID int)",
    ),
    // Used to store player squads
    connection.query(
      "CREATE TABLE IF NOT EXISTS squad (leagueID int, user int, playeruid varchar(25), position varchar(5), starred bool DEFAULT 0)",
    ),
    // Used to store historical squads
    connection.query(
      "CREATE TABLE IF NOT EXISTS historicalSquad (matchday int, leagueID int, user int, playeruid varchar(25), position varchar(5), starred bool DEFAULT 0)",
    ),
    // Used to store historical player data
    connection.query(
      "CREATE TABLE IF NOT EXISTS historicalPlayers (time int, uid varchar(25), name varchar(255), nameAscii varchar(255), club varchar(3), pictureID int, value int, sale_price int, position varchar(3), forecast varchar(1), total_points int, average_points int, last_match int, `exists` bool, league varchar(25))",
    ),
    // Used to store historical transfer data
    connection.query(
      "CREATE TABLE IF NOT EXISTS historicalTransfers (matchday int, leagueID int, seller int, buyer int, playeruid varchar(25), value int)",
    ),
    // Used to store club data
    connection.query(
      "CREATE TABLE IF NOT EXISTS clubs (club varchar(25), gameStart int, gameEnd int, opponent varchar(3), teamScore int, opponentScore int, league varchar(25), home bool, `exists` bool, PRIMARY KEY(club, league))",
    ),
    // Used to store club data
    connection.query(
      "CREATE TABLE IF NOT EXISTS historicalClubs (club varchar(25), opponent varchar(3), teamScore int, opponentScore int, league varchar(25), home bool, time int, `exists` bool, PRIMARY KEY(club, league, time))",
    ),
    // Used to store analytics data
    connection.query(
      "CREATE TABLE IF NOT EXISTS analytics (day int PRIMARY KEY, versionActive varchar(255), versionTotal varchar(255), leagueActive varchar(255), leagueTotal varchar(255), themeActive varchar(255), themeTotal varchar(255), localeActive varchar(255), localeTotal varchar(255))",
    ),
    // Used to store every server's analytics data
    connection.query(
      "CREATE TABLE IF NOT EXISTS detailedAnalytics (serverID varchar(255), day int, version varchar(255), active int, total int, leagueActive varchar(255), leagueTotal varchar(255), themeActive varchar(255), themeTotal varchar(255), localeActive varchar(255), localeTotal varchar(255))",
    ),
    // Used to store league announcements
    connection.query(
      "CREATE TABLE IF NOT EXISTS announcements (leagueID int, priority varchar(10) check(priority = 'error' or priority = 'info' or priority = 'success' or priority='warning'), title varchar(255), description varchar(255))",
    ),
    // Used to store plugin settings
    connection.query(
      "CREATE TABLE IF NOT EXISTS plugins (name varchar(255), settings varchar(255), enabled boolean, url varchar(255) PRIMARY KEY, version varchar(255))",
    ),
    // Used to store picture IDs
    connection.query(
      "CREATE TABLE IF NOT EXISTS pictures (id int PRIMARY KEY AUTO_INCREMENT NOT NULL, url varchar(255), downloading boolean DEFAULT 0, downloaded boolean DEFAULT 0, height int, width int)",
    ),
    // Used to store predictions
    connection.query(
      "CREATE TABLE IF NOT EXISTS predictions (leagueID int, user int, club varchar(255), league varchar(255), home int, away int)",
    ),
    // Used to store historical predictions
    connection.query(
      "CREATE TABLE IF NOT EXISTS historicalPredictions (matchday int, leagueID int, user int, club varchar(255), league varchar(255), home int, away int)",
    ),
    // Enables the WAL
    connection.query("PRAGMA journal_mode=WAL"),
  ]);
  // Creates all the indexes for the database
  await Promise.all([
    await connection.query(
      "CREATE INDEX IF NOT EXISTS players_uid_league ON players(uid, league)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS leagueUsers_leagueID_user ON leagueUsers(leagueID, user)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS points_leagueID_user_matchday ON points(leagueID, user)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS transfers_leagueID ON transfers(leagueID)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS squad_leagueID_user ON squad(leagueID, user)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS historicalSquad_leagueID_user_matchday ON historicalSquad(leagueID, user, matchday)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS historicalPlayers_uid_time ON historicalPlayers(uid, time)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS historicalTransfers_leagueID_matchday ON historicalTransfers(leagueID, matchday)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS clubs_club_league ON historicalClubs(club, league)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS historicalClubs_club_league_time ON historicalClubs(club, league, time)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS detailedAnalytics_day ON detailedAnalytics(day)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS announcements_leagueID ON announcements(leagueID)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS pictures_url ON pictures(url)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS predictions_leagueID_user ON predictions(leagueID, user)",
    ),
    await connection.query(
      "CREATE INDEX IF NOT EXISTS historicalPredictions_leagueID_user_matchday ON historicalPredictions(leagueID, user, matchday)",
    ),
  ]);
  // Checks if the server hash has been created and if not makes one
  await connection.query(
    "INSERT IGNORE INTO data (value1, value2) VALUES ('serverID', ?)",
    [
      Math.random().toString(36).substring(2) +
        Math.random().toString(36).substring(2),
    ],
  );
  // Unlocks the database
  (await connection.query("SELECT * FROM plugins")).forEach((e: plugins) => {
    connection.query("DELETE FROM data WHERE value1=?", ["locked" + e.name]);
  });
  // Checks the version of the database is out of date
  const getOldVersion: data[] = await connection.query(
    "SELECT value2 FROM data WHERE value1='version'",
  );
  let oldVersion = "";
  if (getOldVersion.length > 0) {
    oldVersion = getOldVersion[0].value2;
    const upgraded = currentVersion !== oldVersion;
    oldVersion = await upgradeDB(oldVersion);
    // HERE IS WHERE THE CODE GOES TO UPDATE THE DATABASE FROM ONE VERSION TO THE NEXT
    if (oldVersion !== currentVersion) {
      // Makes sure that the database is up to date
      console.error("Database is corrupted or is too old");
    }
    // Optimizes the database whenever there is a db upgrade
    if (upgraded) {
      await connection.optimize();
    }
  }
  // Creates the default config if needed
  createConfig();
  // Makes sure that the admin user is the correct user
  await connection.query("UPDATE users SET admin=0");
  if (process.env.ADMIN !== undefined) {
    const adminUser = parseInt(process.env.ADMIN);
    console.log(`User ${adminUser} is the admin user`);
    connection.query("UPDATE users SET admin=1 WHERE id=?", [adminUser]);
  } else {
    console.log("Admin user is disabled");
  }
  // Updated version of database in table
  connection.query(
    "INSERT INTO data (value1, value2) VALUES('version', ?) ON DUPLICATE KEY UPDATE value2=?",
    [currentVersion, currentVersion],
  );
  connection.end();
  compilePlugins();
}
startUp();
