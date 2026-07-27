import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { ulid } from "ulid";
import type { AuthPrincipal, OrganizationRole } from "../auth/auth.types.js";
import { PG_POOL } from "../persistence/database.constants.js";

export interface OrganizationMembership {
  id: string;
  slug: string;
  name: string;
  role: OrganizationRole;
}

@Injectable()
export class OrganizationsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(userId: string): Promise<OrganizationMembership[]> {
    const result = await this.pool.query<OrganizationMembership>(
      `SELECT o.id, o.slug, o.name, m.role
         FROM organizations o
         JOIN organization_memberships m ON m.organization_id = o.id
        WHERE m.user_id = $1
        ORDER BY o.created_at`,
      [userId],
    );
    return result.rows;
  }

  async create(principal: AuthPrincipal, name: string, slug: string): Promise<OrganizationMembership> {
    const client = await this.pool.connect();
    const id = ulid();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO organizations (id, slug, name, created_by) VALUES ($1, $2, $3, $4)",
        [id, normalizeSlug(slug), name.trim(), principal.userId],
      );
      await client.query(
        `INSERT INTO organization_memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [id, principal.userId],
      );
      await client.query("COMMIT");
      return { id, slug: normalizeSlug(slug), name: name.trim(), role: "owner" };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new ConflictException("Organization slug already exists");
      throw error;
    } finally {
      client.release();
    }
  }

  async join(userId: string, slug: string): Promise<OrganizationMembership> {
    const organization = await this.pool.query<{ id: string; slug: string; name: string }>(
      "SELECT id, slug, name FROM organizations WHERE slug = $1",
      [normalizeSlug(slug)],
    );
    const row = organization.rows[0];
    if (!row) throw new NotFoundException("Organization not found");
    await this.pool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [row.id, userId],
    );
    const role = await this.requireMembership(row.id, userId);
    return { ...row, role };
  }

  async requireMembership(organizationId: string, userId: string): Promise<OrganizationRole> {
    const result = await this.pool.query<{ role: OrganizationRole }>(
      `SELECT role FROM organization_memberships
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    const role = result.rows[0]?.role;
    if (!role) throw new ForbiddenException("Organization membership required");
    return role;
  }

  async requireSessionAccess(branchId: string, userId: string): Promise<{
    organizationId: string;
    role: OrganizationRole;
  }> {
    const result = await this.pool.query<{
      organization_id: string;
      role: OrganizationRole | null;
    }>(
      `SELECT s.organization_id, m.role
         FROM session_branches b
         JOIN sessions s ON s.id = b.session_id
         LEFT JOIN organization_memberships m
           ON m.organization_id = s.organization_id AND m.user_id = $2
        WHERE b.id = $1`,
      [branchId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Session branch not found");
    if (!row.role) throw new ForbiddenException("Session belongs to another organization");
    return { organizationId: row.organization_id, role: row.role };
  }
}

function normalizeSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if (normalized.length < 3) throw new TypeError("Organization slug must contain at least 3 characters");
  return normalized;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

