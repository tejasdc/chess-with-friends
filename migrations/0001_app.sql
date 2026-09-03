PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL COLLATE NOCASE UNIQUE,
  invite_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (counter >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports_json)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX credentials_user_idx ON credentials(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) STRICT;
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  handle TEXT COLLATE NOCASE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  provisional_user_id TEXT,
  challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  CHECK (
    (purpose = 'registration' AND handle IS NOT NULL AND user_id IS NULL AND provisional_user_id IS NOT NULL)
    OR
    (purpose = 'authentication' AND handle IS NULL AND user_id IS NOT NULL AND provisional_user_id IS NULL)
  )
) STRICT;
CREATE UNIQUE INDEX auth_registration_handle_idx ON auth_challenges(handle) WHERE purpose = 'registration';
CREATE UNIQUE INDEX auth_authentication_user_idx ON auth_challenges(user_id) WHERE purpose = 'authentication';
CREATE INDEX auth_challenges_expiry_idx ON auth_challenges(expires_at);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count > 0),
  reset_at INTEGER NOT NULL
) STRICT;
CREATE INDEX rate_limits_expiry_idx ON rate_limits(reset_at);

CREATE TABLE friendships (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
) STRICT;
CREATE INDEX friendships_user_a_idx ON friendships(user_a);
CREATE INDEX friendships_user_b_idx ON friendships(user_b);

CREATE TABLE friend_requests (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair_a TEXT NOT NULL,
  pair_b TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (from_id <> to_id),
  CHECK (pair_a < pair_b),
  CHECK ((pair_a = from_id AND pair_b = to_id) OR (pair_a = to_id AND pair_b = from_id))
) STRICT;
CREATE UNIQUE INDEX friend_requests_pending_pair_idx ON friend_requests(pair_a, pair_b) WHERE status = 'pending';
CREATE INDEX friend_requests_to_status_idx ON friend_requests(to_id, status, created_at);
CREATE INDEX friend_requests_from_status_idx ON friend_requests(from_id, status, created_at);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair_a TEXT NOT NULL,
  pair_b TEXT NOT NULL,
  time_control TEXT NOT NULL CHECK (time_control IN ('10|0', '5|0')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  game_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (from_id <> to_id),
  CHECK (pair_a < pair_b),
  CHECK ((pair_a = from_id AND pair_b = to_id) OR (pair_a = to_id AND pair_b = from_id)),
  CHECK ((status = 'accepted' AND game_id IS NOT NULL) OR (status <> 'accepted'))
) STRICT;
CREATE UNIQUE INDEX challenges_pending_pair_idx ON challenges(pair_a, pair_b) WHERE status = 'pending';
CREATE INDEX challenges_to_status_idx ON challenges(to_id, status, created_at);
CREATE INDEX challenges_from_status_idx ON challenges(from_id, status, created_at);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  request_key TEXT UNIQUE,
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  time_control TEXT NOT NULL CHECK (time_control IN ('10|0', '5|0')),
  start_at INTEGER NOT NULL,
  next_fire_at INTEGER NOT NULL,
  recurrence_kind TEXT NOT NULL CHECK (recurrence_kind IN ('once', 'daily', 'weekly')),
  recurrence_weekday INTEGER CHECK (recurrence_weekday BETWEEN 0 AND 6),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'fired', 'declined', 'cancelled', 'expired')),
  game_id TEXT,
  last_game_id TEXT,
  cancelled_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (from_id <> to_id),
  CHECK ((recurrence_kind = 'weekly' AND recurrence_weekday IS NOT NULL) OR (recurrence_kind <> 'weekly' AND recurrence_weekday IS NULL))
) STRICT;
CREATE INDEX schedules_participants_idx ON schedules(from_id, to_id, status);
CREATE INDEX schedules_next_fire_idx ON schedules(status, next_fire_at);
CREATE INDEX schedules_pending_expiry_idx ON schedules(status, start_at);

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  white_id TEXT NOT NULL REFERENCES users(id),
  black_id TEXT NOT NULL REFERENCES users(id),
  time_control TEXT NOT NULL CHECK (time_control IN ('10|0', '5|0')),
  source TEXT NOT NULL CHECK (source IN ('challenge', 'schedule', 'rematch')),
  status TEXT NOT NULL CHECK (status IN ('active', 'checkmate', 'resigned', 'timeout', 'draw')),
  result TEXT,
  created_at INTEGER NOT NULL,
  projection_updated_at INTEGER NOT NULL,
  initialized_at INTEGER,
  init_attempts INTEGER NOT NULL DEFAULT 0 CHECK (init_attempts >= 0),
  init_retry_at INTEGER,
  init_error TEXT,
  CHECK (white_id <> black_id)
) STRICT;
CREATE INDEX games_white_created_idx ON games(white_id, created_at DESC);
CREATE INDEX games_black_created_idx ON games(black_id, created_at DESC);
CREATE INDEX games_init_retry_idx ON games(initialized_at, init_retry_at);

CREATE TABLE schedule_occurrences (
  occurrence_key TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  scheduled_for INTEGER NOT NULL,
  game_id TEXT NOT NULL UNIQUE REFERENCES games(id),
  claimed_at INTEGER NOT NULL,
  game_initialized_at INTEGER,
  from_push_enqueued_at INTEGER,
  to_push_enqueued_at INTEGER,
  effects_completed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at INTEGER NOT NULL,
  last_error TEXT,
  UNIQUE (schedule_id, scheduled_for)
) STRICT;
CREATE INDEX schedule_occurrences_retry_idx ON schedule_occurrences(effects_completed_at, retry_at);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expiration_time INTEGER,
  keys_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(keys_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id, updated_at DESC);

CREATE TABLE pending_pushes (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('friend_request', 'challenge', 'challenge_accepted', 'scheduled_start', 'call_invite')),
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  UNIQUE (event_key, endpoint)
) STRICT;
CREATE INDEX pending_pushes_user_idx ON pending_pushes(user_id, endpoint, created_at);
CREATE INDEX pending_pushes_expiry_idx ON pending_pushes(expires_at);
CREATE INDEX pending_pushes_retry_idx ON pending_pushes(next_attempt_at);

CREATE TABLE push_delivery_logs (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('friend_request', 'challenge', 'challenge_accepted', 'scheduled_start', 'call_invite')),
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1)),
  status INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX push_delivery_logs_created_idx ON push_delivery_logs(created_at);

CREATE TABLE presence_leases (
  lease_key TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  foreground_game_id TEXT,
  CHECK (expires_at >= last_seen_at)
) STRICT;
CREATE INDEX presence_user_fresh_idx ON presence_leases(user_id, last_seen_at DESC);
CREATE INDEX presence_expiry_idx ON presence_leases(expires_at);

CREATE TABLE idempotency_results (
  result_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  op_id TEXT NOT NULL,
  status INTEGER NOT NULL,
  headers_json TEXT NOT NULL CHECK (json_valid(headers_json)),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (user_id, op_id)
) STRICT;
CREATE INDEX idempotency_expiry_idx ON idempotency_results(expires_at);

CREATE TABLE client_errors (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  url TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  user_agent TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX client_errors_created_idx ON client_errors(created_at);
