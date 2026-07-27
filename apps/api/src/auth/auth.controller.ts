import { Body, Controller, Post } from "@nestjs/common";
import type { Pool } from "pg";
import { Inject } from "@nestjs/common";
import { ulid } from "ulid";
import { PG_POOL } from "../persistence/database.constants.js";
import { DevelopmentIdentityService } from "./development-identity.service.js";

@Controller("v1/auth")
export class AuthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DevelopmentIdentityService)
    private readonly identity: DevelopmentIdentityService,
  ) {}

  @Post("development/sign-in")
  async signIn(@Body() body: { email: string; displayName: string }) {
    const email = body.email.trim().toLowerCase();
    const displayName = body.displayName.trim();
    if (!email || !displayName) throw new TypeError("email and displayName are required");
    const result = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
    }>(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
       SET display_name = EXCLUDED.display_name, updated_at = now()
       RETURNING id, email, display_name`,
      [ulid(), email, displayName],
    );
    const user = result.rows[0];
    if (!user) throw new Error("Failed to create development user");
    const principal = {
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
    };
    return { user: principal, ...this.identity.issue(principal) };
  }
}
