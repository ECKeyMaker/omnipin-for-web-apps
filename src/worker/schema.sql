-- Funding gateway schema. Apply with `wrangler d1 execute`.
CREATE TABLE IF NOT EXISTS connected_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- JSON array of allowed browser origins.
  origins TEXT NOT NULL,
  daily_bytes INTEGER NOT NULL,
  user_daily_deploys INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES connected_apps (id),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cid TEXT NOT NULL,
  size INTEGER NOT NULL,
  car_key TEXT NOT NULL,
  -- created, publishing, published, failed, rejected
  status TEXT NOT NULL,
  providers TEXT NOT NULL DEFAULT '[]',
  ens_name TEXT,
  ens_status TEXT,
  dnslink TEXT,
  error TEXT,
  -- Until when the public pool has committed to storing this deployment.
  retention_until INTEGER NOT NULL,
  sponsor_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS deployments_app_day ON deployments (app_id, created_at);
CREATE INDEX IF NOT EXISTS deployments_day ON deployments (created_at);
CREATE INDEX IF NOT EXISTS deployments_retention ON deployments (retention_until);
