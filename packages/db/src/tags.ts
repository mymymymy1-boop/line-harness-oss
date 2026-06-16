import { jstNow } from './utils.js';
export interface Tag {
  id: string;
  name: string;
  color: string;
  created_at: string;
  /** Tenant scope. NULL = global (visible to all bots, backward-compat). */
  line_account_id: string | null;
}

export interface FriendTag {
  friend_id: string;
  tag_id: string;
  assigned_at: string;
}

/**
 * List tags, optionally scoped to a specific LINE account.
 * Tags with NULL line_account_id are global (always included for backward compat).
 */
export async function getTags(
  db: D1Database,
  lineAccountId?: string | null,
): Promise<Tag[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(`SELECT * FROM tags WHERE line_account_id = ? OR line_account_id IS NULL ORDER BY name ASC`)
      .bind(lineAccountId)
      .all<Tag>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM tags ORDER BY name ASC`)
    .all<Tag>();
  return result.results;
}

export interface CreateTagInput {
  name: string;
  color?: string;
  /** Optional tenant scope. NULL = global tag. */
  lineAccountId?: string | null;
}

export async function createTag(
  db: D1Database,
  input: CreateTagInput,
): Promise<Tag> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const color = input.color ?? '#3B82F6';

  await db
    .prepare(
      `INSERT INTO tags (id, name, color, created_at, line_account_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.name, color, now, input.lineAccountId ?? null)
    .run();

  return (await db
    .prepare(`SELECT * FROM tags WHERE id = ?`)
    .bind(id)
    .first<Tag>())!;
}

export async function deleteTag(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM tags WHERE id = ?`).bind(id).run();
}

export async function addTagToFriend(
  db: D1Database,
  friendId: string,
  tagId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at)
       VALUES (?, ?, ?)`,
    )
    .bind(friendId, tagId, now)
    .run();
}

export async function removeTagFromFriend(
  db: D1Database,
  friendId: string,
  tagId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?`,
    )
    .bind(friendId, tagId)
    .run();
}

export async function getFriendTags(
  db: D1Database,
  friendId: string,
): Promise<Tag[]> {
  const result = await db
    .prepare(
      `SELECT t.*
       FROM tags t
       INNER JOIN friend_tags ft ON ft.tag_id = t.id
       WHERE ft.friend_id = ?
       ORDER BY t.name ASC`,
    )
    .bind(friendId)
    .all<Tag>();
  return result.results;
}

import type { Friend } from './friends';

export async function getFriendsByTag(
  db: D1Database,
  tagId: string,
): Promise<Friend[]> {
  const result = await db
    .prepare(
      `SELECT f.*
       FROM friends f
       INNER JOIN friend_tags ft ON ft.friend_id = f.id
       WHERE ft.tag_id = ?
       ORDER BY f.created_at DESC`,
    )
    .bind(tagId)
    .all<Friend>();
  return result.results;
}
