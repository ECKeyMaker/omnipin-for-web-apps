-- Apply to your app's D1 database with `wrangler d1 execute`. Tables are
-- prefixed so they can sit beside your own.
CREATE TABLE IF NOT EXISTS omnipin_deployments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cid TEXT NOT NULL,
  size INTEGER NOT NULL,
  car_key TEXT NOT NULL,
  -- created, publishing, pending, published, failed, rejected, expired, removed
  status TEXT NOT NULL,
  providers TEXT NOT NULL DEFAULT '[]',
  ens_name TEXT,
  ens_status TEXT,
  dnslink TEXT,
  error TEXT,
  -- When storing this site ends. NULL keeps it indefinitely.
  retention_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS omnipin_deployments_user ON omnipin_deployments (user_id, created_at);
CREATE INDEX IF NOT EXISTS omnipin_deployments_day ON omnipin_deployments (created_at);
CREATE INDEX IF NOT EXISTS omnipin_deployments_cid ON omnipin_deployments (cid);
CREATE INDEX IF NOT EXISTS omnipin_deployments_status ON omnipin_deployments (status);

-- Append-only record of everything that publishes or removes content.
CREATE TABLE IF NOT EXISTS omnipin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  deployment_id TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS omnipin_audit_log_at ON omnipin_audit_log (at);
