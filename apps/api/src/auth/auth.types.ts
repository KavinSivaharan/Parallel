export type OrganizationRole = "owner" | "member" | "viewer";

export interface AuthPrincipal {
  userId: string;
  email: string;
  displayName: string;
}

export interface IdentityVerifier {
  verify(token: string): Promise<AuthPrincipal>;
}

