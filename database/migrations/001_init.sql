-- MailForge initial schema.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- Browser sessions. Only the SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text        NOT NULL UNIQUE,
  csrf_token   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Only the SHA-256 of the key is stored; key_prefix is the first characters, for display.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text        NOT NULL,
  key_hash     text        NOT NULL UNIQUE,
  key_prefix   text        NOT NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);

CREATE TABLE mailboxes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address    text        NOT NULL,
  prefix     text        NOT NULL,
  domain     text        NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid        REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT mailboxes_address_lower CHECK (address = lower(address))
);
CREATE UNIQUE INDEX mailboxes_address_key ON mailboxes (address);
CREATE INDEX mailboxes_expires_at_idx ON mailboxes (expires_at);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id       uuid        NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
  source_id        text,
  message_id       text,
  from_address     text        NOT NULL,
  from_name        text,
  to_address       text        NOT NULL,
  cc               text,
  bcc              text,
  reply_to         text,
  subject          text        NOT NULL DEFAULT '',
  text_body        text,
  html_body        text,
  raw_email        bytea       NOT NULL,
  headers          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  size             integer     NOT NULL,
  preview          text        NOT NULL DEFAULT '',
  attachment_count integer     NOT NULL DEFAULT 0,
  link_count       integer     NOT NULL DEFAULT 0,
  code_count       integer     NOT NULL DEFAULT 0,
  is_read          boolean     NOT NULL DEFAULT false,
  received_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_mailbox_id_idx ON messages (mailbox_id);
CREATE INDEX messages_received_at_idx ON messages (received_at DESC);
CREATE INDEX messages_mailbox_received_idx ON messages (mailbox_id, received_at DESC);
CREATE INDEX messages_subject_idx ON messages (subject);
CREATE INDEX messages_message_id_idx ON messages (message_id);
-- A message pulled from the SMTP capture server is ingested at most once per mailbox.
CREATE UNIQUE INDEX messages_source_mailbox_key ON messages (mailbox_id, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  filename     text        NOT NULL,
  mime_type    text        NOT NULL,
  size         integer     NOT NULL,
  content_id   text,
  -- Relative to ATTACHMENT_DIR. NULL when the attachment exceeded the size limit and was not stored.
  storage_path text,
  position     integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message_id_idx ON attachments (message_id);
CREATE INDEX attachments_created_at_idx ON attachments (created_at);

CREATE TABLE message_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  url        text        NOT NULL,
  link_type  text        NOT NULL,
  position   integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_links_message_id_idx ON message_links (message_id);

CREATE TABLE verification_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  code       text        NOT NULL,
  code_type  text        NOT NULL,
  confidence real        NOT NULL,
  position   integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_codes_message_id_idx ON verification_codes (message_id);
CREATE INDEX verification_codes_code_idx ON verification_codes (code);

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  user_id       uuid        REFERENCES users (id) ON DELETE SET NULL,
  action        text        NOT NULL,
  resource_type text        NOT NULL,
  resource_id   text,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
