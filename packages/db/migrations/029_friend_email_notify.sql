-- 新規友だち登録のメール通知台帳。1 friend = 1行で二重送信を防ぐ(冪等)。
-- 送信対象の抽出は「friends に居て、この台帳に居ない」— 登録制ではなく既定=通知する側に倒す。
CREATE TABLE IF NOT EXISTS friend_email_notifications (
  friend_id TEXT PRIMARY KEY REFERENCES friends (id) ON DELETE CASCADE,
  sent_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_friends_created_at ON friends (created_at);

-- 既存の友だちは「通知済み」として台帳に投入(導入時の一斉バックフィル送信を防ぐ)。
INSERT OR IGNORE INTO friend_email_notifications (friend_id, sent_at)
SELECT id, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') FROM friends;
