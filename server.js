require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID || "";
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || "";
const STRAVA_VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN || "change-this";
const STRAVA_SCOPES = process.env.STRAVA_SCOPES || "read,activity:read_all";
const DEFAULT_SYNC_DAYS = Number(process.env.DEFAULT_SYNC_DAYS || 30);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "journal.db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS athletes (
    athlete_id INTEGER PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    last_sync_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL,
    name TEXT,
    type TEXT,
    distance_m REAL,
    moving_time_sec INTEGER,
    elapsed_time_sec INTEGER,
    total_elevation_gain REAL,
    average_heartrate REAL,
    max_heartrate REAL,
    start_date TEXT,
    start_date_local TEXT,
    timezone TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (athlete_id) REFERENCES athletes(athlete_id)
  );
`);

const oauthStateStore = new Map();

function requireStravaCredentials() {
  if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
    throw new Error("Missing STRAVA_CLIENT_ID/STRAVA_CLIENT_SECRET in .env");
  }
}

function upsertAthlete(tokens, athleteId) {
  db.prepare(
    `
    INSERT INTO athletes (athlete_id, access_token, refresh_token, expires_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(athlete_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `,
  ).run(athleteId, tokens.access_token, tokens.refresh_token, tokens.expires_at);
}

function saveActivity(activity, athleteId, isDeleted = 0) {
  db.prepare(
    `
    INSERT INTO activities (
      id, athlete_id, name, type, distance_m, moving_time_sec, elapsed_time_sec,
      total_elevation_gain, average_heartrate, max_heartrate, start_date, start_date_local,
      timezone, is_deleted, raw_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      athlete_id = excluded.athlete_id,
      name = excluded.name,
      type = excluded.type,
      distance_m = excluded.distance_m,
      moving_time_sec = excluded.moving_time_sec,
      elapsed_time_sec = excluded.elapsed_time_sec,
      total_elevation_gain = excluded.total_elevation_gain,
      average_heartrate = excluded.average_heartrate,
      max_heartrate = excluded.max_heartrate,
      start_date = excluded.start_date,
      start_date_local = excluded.start_date_local,
      timezone = excluded.timezone,
      is_deleted = excluded.is_deleted,
      raw_json = excluded.raw_json,
      updated_at = datetime('now')
  `,
  ).run(
    activity.id,
    athleteId,
    activity.name || null,
    activity.type || null,
    activity.distance || null,
    activity.moving_time || null,
    activity.elapsed_time || null,
    activity.total_elevation_gain || null,
    activity.average_heartrate || null,
    activity.max_heartrate || null,
    activity.start_date || null,
    activity.start_date_local || null,
    activity.timezone || null,
    isDeleted,
    JSON.stringify(activity),
  );
}

async function refreshAthleteTokenIfNeeded(athleteId) {
  const row = db.prepare("SELECT * FROM athletes WHERE athlete_id = ?").get(athleteId);
  if (!row) {
    throw new Error(`No athlete token found for athlete_id=${athleteId}`);
  }

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at > now + 120) {
    return row.access_token;
  }

  const tokenRes = await fetch("https://www.strava.com/api/v3/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Failed to refresh token: ${tokenRes.status} ${text}`);
  }

  const tokens = await tokenRes.json();
  upsertAthlete(tokens, athleteId);
  return tokens.access_token;
}

async function fetchAndStoreActivity(athleteId, activityId) {
  const accessToken = await refreshAthleteTokenIfNeeded(athleteId);
  const activityRes = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!activityRes.ok) {
    const text = await activityRes.text();
    throw new Error(`Failed to fetch activity ${activityId}: ${activityRes.status} ${text}`);
  }

  const activity = await activityRes.json();
  saveActivity(activity, athleteId, 0);
  db.prepare("UPDATE athletes SET last_sync_at = datetime('now') WHERE athlete_id = ?").run(athleteId);
}

async function fetchRecentActivitiesForAthlete(athleteId, days = DEFAULT_SYNC_DAYS) {
  const accessToken = await refreshAthleteTokenIfNeeded(athleteId);
  const safeDays = Number.isFinite(Number(days)) ? Math.max(1, Number(days)) : DEFAULT_SYNC_DAYS;
  const afterEpoch = Math.floor(Date.now() / 1000) - safeDays * 86400;

  let page = 1;
  let totalSynced = 0;
  while (page <= 5) {
    const listUrl = new URL("https://www.strava.com/api/v3/athlete/activities");
    listUrl.searchParams.set("after", String(afterEpoch));
    listUrl.searchParams.set("per_page", "100");
    listUrl.searchParams.set("page", String(page));

    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!listRes.ok) {
      const text = await listRes.text();
      throw new Error(`Failed to fetch activity list: ${listRes.status} ${text}`);
    }

    const activities = await listRes.json();
    if (!Array.isArray(activities) || activities.length === 0) {
      break;
    }

    for (const activity of activities) {
      saveActivity(activity, athleteId, 0);
      totalSynced += 1;
    }

    if (activities.length < 100) {
      break;
    }

    page += 1;
  }

  db.prepare("UPDATE athletes SET last_sync_at = datetime('now') WHERE athlete_id = ?").run(athleteId);
  return totalSynced;
}

async function syncAllAthletes(days = DEFAULT_SYNC_DAYS) {
  const athletes = db.prepare("SELECT athlete_id FROM athletes").all();
  let activitiesSynced = 0;
  let athletesSynced = 0;
  const errors = [];

  for (const athlete of athletes) {
    try {
      const synced = await fetchRecentActivitiesForAthlete(athlete.athlete_id, days);
      activitiesSynced += synced;
      athletesSynced += 1;
    } catch (err) {
      errors.push({ athleteId: athlete.athlete_id, message: err.message });
    }
  }

  return {
    athletesConnected: athletes.length,
    athletesSynced,
    activitiesSynced,
    days: Number(days),
    errors,
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

app.get("/api/strava/status", (req, res) => {
  const row = db.prepare("SELECT COUNT(*) AS count, MAX(last_sync_at) AS lastSyncAt FROM athletes").get();
  res.json({
    connectedAthletes: row.count,
    lastSyncAt: row.lastSyncAt || null,
    callbackUrl: `${APP_BASE_URL}/auth/strava/callback`,
    webhookUrl: `${APP_BASE_URL}/webhook/strava`,
  });
});

app.post("/api/sync-now", async (req, res) => {
  try {
    const requestedDays = Number(req.body?.days || DEFAULT_SYNC_DAYS);
    const result = await syncAllAthletes(requestedDays);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/activities", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const rows = db
    .prepare(
      `
      SELECT id, athlete_id, name, type, distance_m, moving_time_sec, elapsed_time_sec,
             total_elevation_gain, average_heartrate, max_heartrate,
             start_date, start_date_local, timezone, is_deleted, updated_at
      FROM activities
      ORDER BY datetime(start_date_local) DESC
      LIMIT ?
    `,
    )
    .all(limit);

  res.json({ items: rows });
});

app.get("/auth/strava", (req, res) => {
  try {
    requireStravaCredentials();
    const state = crypto.randomBytes(24).toString("hex");
    oauthStateStore.set(state, Date.now());

    const redirectUri = `${APP_BASE_URL}/auth/strava/callback`;
    const authUrl = new URL("https://www.strava.com/oauth/authorize");
    authUrl.searchParams.set("client_id", STRAVA_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("approval_prompt", "auto");
    authUrl.searchParams.set("scope", STRAVA_SCOPES);
    authUrl.searchParams.set("state", state);

    res.redirect(authUrl.toString());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/auth/strava/callback", async (req, res) => {
  try {
    requireStravaCredentials();
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(`Strava OAuth failed: ${error}`);
    }

    if (!state || !oauthStateStore.has(state)) {
      return res.status(400).send("Invalid OAuth state");
    }

    oauthStateStore.delete(state);

    const tokenRes = await fetch("https://www.strava.com/api/v3/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return res.status(500).send(`Token exchange failed: ${tokenRes.status} ${text}`);
    }

    const tokens = await tokenRes.json();
    const athleteId = tokens?.athlete?.id;
    if (!athleteId) {
      return res.status(500).send("Token response did not include athlete id");
    }

    upsertAthlete(tokens, athleteId);

    let imported = 0;
    try {
      imported = await fetchRecentActivitiesForAthlete(athleteId, DEFAULT_SYNC_DAYS);
    } catch (syncError) {
      console.warn("Initial sync failed:", syncError.message);
    }

    return res.redirect(`/?connected=1&imported=${imported}`);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

app.get("/webhook/strava", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === STRAVA_VERIFY_TOKEN) {
    return res.status(200).json({ "hub.challenge": challenge });
  }

  return res.status(403).json({ error: "Webhook verification failed" });
});

app.post("/webhook/strava", async (req, res) => {
  const event = req.body;
  res.status(200).json({ ok: true });

  try {
    if (event.object_type !== "activity") {
      return;
    }

    const athleteId = Number(event.owner_id);
    const activityId = Number(event.object_id);
    if (!athleteId || !activityId) {
      return;
    }

    if (event.aspect_type === "delete") {
      db.prepare("UPDATE activities SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?").run(activityId);
      return;
    }

    await fetchAndStoreActivity(athleteId, activityId);
  } catch (err) {
    console.error("Webhook process error:", err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Running Journal server started: ${APP_BASE_URL}`);
  console.log(`Connect Strava at: ${APP_BASE_URL}/auth/strava`);
  console.log(`Manual sync endpoint: POST ${APP_BASE_URL}/api/sync-now`);
  console.log(`SQLite DB path: ${DB_PATH}`);
});



