import { Injectable, UnauthorizedException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthPrincipal, IdentityVerifier } from "./auth.types.js";

interface TokenPayload extends AuthPrincipal {
  expiresAt: number;
}

@Injectable()
export class DevelopmentIdentityService implements IdentityVerifier {
  private readonly secret =
    process.env.DEV_AUTH_SECRET ?? "parallel-local-development-secret-change-me";

  issue(principal: AuthPrincipal): { token: string; expiresAt: string } {
    if (process.env.NODE_ENV === "production") {
      throw new UnauthorizedException("Development sign-in is disabled in production");
    }
    const payload: TokenPayload = {
      ...principal,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return {
      token: `${encoded}.${this.sign(encoded)}`,
      expiresAt: new Date(payload.expiresAt).toISOString(),
    };
  }

  async verify(token: string): Promise<AuthPrincipal> {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) throw new UnauthorizedException("Malformed access token");
    const expected = Buffer.from(this.sign(encoded));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException("Invalid access token");
    }
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TokenPayload;
    if (payload.expiresAt <= Date.now()) throw new UnauthorizedException("Access token expired");
    return {
      userId: payload.userId,
      email: payload.email,
      displayName: payload.displayName,
    };
  }

  private sign(encoded: string): string {
    return createHmac("sha256", this.secret).update(encoded).digest("base64url");
  }
}

