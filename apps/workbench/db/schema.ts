import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Shared research records for this owner-private Site. Versions are append-only.
export const researchRecords = sqliteTable('research_records', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
  digest: text('digest').notNull(),
  summaryJson: text('summary_json').notNull(),
  partCount: integer('part_count').notNull(),
}, table => [index('research_records_kind_created').on(table.kind, table.createdAt)]);

// Bounded chunks avoid a single large SQLite value for longer run ledgers.
export const researchRecordParts = sqliteTable('research_record_parts', {
  recordId: text('record_id').notNull().references(() => researchRecords.id),
  part: integer('part').notNull(),
  payload: text('payload').notNull(),
}, table => [primaryKey({columns: [table.recordId, table.part]})]);
