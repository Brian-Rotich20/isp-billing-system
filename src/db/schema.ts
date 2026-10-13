
import {
  pgEnum,
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const subscriberStatusEnum = pgEnum(
  "subscriber_status",
  ["active", "suspended"],
);

export const accessTypeEnum = pgEnum(
  "access_type",
  ["hotspot", "pppoe"],
);

export const packageStatusEnum = pgEnum(
  "package_status",
  ["active", "inactive"],
);

export const subscriptionStatusEnum = pgEnum(
  "subscription_status",
  ["pending", "active", "expired", "suspended", "cancelled"],
);

export const paymentStatusEnum = pgEnum(
  "payment_status",
  ["pending", "succeeded", "failed", "reversed"],
);

export const paymentMethodEnum = pgEnum(
  "payment_method",
  ["mpesa", "cash", "manual"],
);

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 150 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
  }).defaultNow().notNull(),
});

export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    fullName: varchar("full_name", { length: 150 }).notNull(),
    phone: varchar("phone", { length: 20 }).notNull(),
    username: varchar("username", { length: 100 }).notNull(),
    status: subscriberStatusEnum("status")
      .default("active")
      .notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("subscribers_tenant_username_idx").on(
      table.tenantId,
      table.username,
    ),
    index("subscribers_tenant_idx").on(table.tenantId),
  ],
);

export const packages = pgTable("packages", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: varchar("name", { length: 120 }).notNull(),
  accessType: accessTypeEnum("access_type").notNull(),
  priceKes: integer("price_kes").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  downloadMbps: integer("download_mbps").notNull(),
  uploadMbps: integer("upload_mbps").notNull(),
  status: packageStatusEnum("status")
    .default("active")
    .notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
  }).defaultNow().notNull(),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id),
    status: subscriptionStatusEnum("status")
      .default("pending")
      .notNull(),
    startsAt: timestamp("starts_at", {
      withTimezone: true,
    }),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    index("subscriptions_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
    index("subscriptions_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    amountKes: integer("amount_kes").notNull(),
    method: paymentMethodEnum("method").notNull(),
    status: paymentStatusEnum("status")
      .default("pending")
      .notNull(),
    providerReference: varchar("provider_reference", {
      length: 150,
    }).unique(),    
    createdAt: timestamp("created_at", {
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    index("payments_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
  ],
);
