/**
 * prisma/seed.ts — Example seed data for local development
 *
 * Run with: npm run db:seed
 */

import { prisma } from "../src/db.js";
import { hashPassword } from "../src/utils/password.js";

async function main() {
  // Refuse to run in production. This script creates a default `admin`/`admin`
  // account — acceptable for local dev, catastrophic if it lands in prod.
  if (process.env.NODE_ENV === "production") {
    console.error("");
    console.error("  Refusing to seed: NODE_ENV=production.");
    console.error("  This script creates a default admin/admin account and is");
    console.error("  intended for local development only. Use the first-run");
    console.error("  setup wizard to provision a production install.");
    console.error("");
    process.exit(1);
  }

  console.log("Seeding database...");

  // ─── Default Admin User ────────────────────────────────────────────────────

  // Dynamic-roles cutover (migration 20260524000000_roles_table_cutover)
  // replaced User.role enum with User.roleId FK into the roles table.
  const adminRole = await prisma.role.findFirst({ where: { name: "admin" } });
  if (!adminRole) {
    throw new Error(
      "Built-in admin role not found — run `npx prisma migrate deploy` to apply the dynamic-roles cutover migration before seeding.",
    );
  }

  const adminHash = await hashPassword("admin");
  await prisma.user.upsert({
    where:  { username: "admin" },
    update: { roleId: adminRole.id, passwordHash: adminHash },
    create: {
      username:     "admin",
      passwordHash: adminHash,
      roleId:       adminRole.id,
    },
  });

  // ─── Branding ──────────────────────────────────────────────────────────────

  await prisma.setting.upsert({
    where:  { key: "branding" },
    update: {},
    create: {
      key:   "branding",
      value: { appName: "Polaris", subtitle: "Network Management Tool", logoUrl: "/img/brand/polaris-symbol-dark.png" },
    },
  });

  // ─── IP Blocks ─────────────────────────────────────────────────────────────

  const corpBlock = await prisma.ipBlock.upsert({
    where:  { cidr: "10.0.0.0/8" },
    update: {},
    create: {
      name:        "Corporate Datacenter",
      cidr:        "10.0.0.0/8",
      ipVersion:   "v4",
      description: "Primary RFC-1918 space for internal infrastructure",
      tags:        ["datacenter", "internal"],
    },
  });

  const mgmtBlock = await prisma.ipBlock.upsert({
    where:  { cidr: "172.16.0.0/12" },
    update: {},
    create: {
      name:        "Management Network",
      cidr:        "172.16.0.0/12",
      ipVersion:   "v4",
      description: "Out-of-band management and BMC access",
      tags:        ["management", "oob"],
    },
  });

  // ─── Subnets ───────────────────────────────────────────────────────────────

  const k8sSubnet = await prisma.subnet.findFirst({ where: { cidr: "10.0.1.0/24" } })
    ?? await prisma.subnet.create({
      data: {
        blockId:  corpBlock.id,
        cidr:     "10.0.1.0/24",
        name:     "K8s Node Pool",
        purpose:  "Production Kubernetes worker nodes",
        status:   "available",
        vlan:     100,
        tags:     ["kubernetes", "prod"],
      },
    });

  const dbSubnet = await prisma.subnet.findFirst({ where: { cidr: "10.0.2.0/24" } })
    ?? await prisma.subnet.create({
      data: {
        blockId:  corpBlock.id,
        cidr:     "10.0.2.0/24",
        name:     "Database Tier",
        purpose:  "PostgreSQL and Redis clusters",
        status:   "available",
        vlan:     200,
        tags:     ["database", "prod"],
      },
    });

  const mgmtSubnet = await prisma.subnet.findFirst({ where: { cidr: "172.16.0.0/24" } })
    ?? await prisma.subnet.create({
      data: {
        blockId:  mgmtBlock.id,
        cidr:     "172.16.0.0/24",
        name:     "BMC / IPMI",
        purpose:  "Baseboard management controllers",
        status:   "available",
        vlan:     999,
        tags:     ["management", "bmc"],
      },
    });

  // ─── Reservations ──────────────────────────────────────────────────────────

  await prisma.reservation.upsert({
    where: {
      subnetId_ipAddress_status: {
        subnetId:  k8sSubnet.id,
        ipAddress: "10.0.1.10",
        status:    "active",
      },
    },
    update: {},
    create: {
      subnetId:   k8sSubnet.id,
      ipAddress:  "10.0.1.10",
      hostname:   "k8s-worker-01",
      owner:      "platform-team",
      projectRef: "INFRA-001",
      notes:      "Primary worker node",
      status:     "active",
    },
  });

  await prisma.reservation.upsert({
    where: {
      subnetId_ipAddress_status: {
        subnetId:  k8sSubnet.id,
        ipAddress: "10.0.1.11",
        status:    "active",
      },
    },
    update: {},
    create: {
      subnetId:   k8sSubnet.id,
      ipAddress:  "10.0.1.11",
      hostname:   "k8s-worker-02",
      owner:      "platform-team",
      projectRef: "INFRA-001",
      notes:      "Secondary worker node",
      status:     "active",
    },
  });

  await prisma.reservation.upsert({
    where: {
      subnetId_ipAddress_status: {
        subnetId:  dbSubnet.id,
        ipAddress: "10.0.2.10",
        status:    "active",
      },
    },
    update: {},
    create: {
      subnetId:   dbSubnet.id,
      ipAddress:  "10.0.2.10",
      hostname:   "postgres-primary",
      owner:      "data-team",
      projectRef: "DB-001",
      notes:      "Primary PostgreSQL instance",
      status:     "active",
    },
  });

  // ─── Example Tags ──────────────────────────────────────────────────────────

  const exampleTags = [
    { name: "Production",     category: "Environment", color: "#ef4444" },
    { name: "Staging",        category: "Environment", color: "#f59e0b" },
    { name: "Development",    category: "Environment", color: "#22c55e" },
    { name: "Testing",        category: "Environment", color: "#8b5cf6" },
    { name: "Database",       category: "Function",    color: "#3b82f6" },
    { name: "Web Server",     category: "Function",    color: "#06b6d4" },
    { name: "DNS",            category: "Function",    color: "#14b8a6" },
    { name: "DHCP",           category: "Function",    color: "#10b981" },
    { name: "Firewall",       category: "Function",    color: "#f97316" },
    { name: "Load Balancer",  category: "Function",    color: "#a855f7" },
    { name: "Datacenter",     category: "Location",    color: "#6366f1" },
    { name: "Cloud",          category: "Location",    color: "#0ea5e9" },
    { name: "Remote Site",    category: "Location",    color: "#84cc16" },
    { name: "Internal",       category: "Scope",       color: "#64748b" },
    { name: "DMZ",            category: "Scope",       color: "#e11d48" },
    { name: "Guest",          category: "Scope",       color: "#78716c" },
  ];

  for (const tag of exampleTags) {
    await prisma.tag.upsert({
      where:  { name: tag.name },
      update: {},
      create: tag,
    });
  }

  console.log("Seed complete.");
  console.log(`  Users:        ${await prisma.user.count()}`);
  console.log(`  Blocks:       ${await prisma.ipBlock.count()}`);
  console.log(`  Subnets:      ${await prisma.subnet.count()}`);
  console.log(`  Reservations: ${await prisma.reservation.count()}`);
  console.log(`  Tags:         ${await prisma.tag.count()}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
