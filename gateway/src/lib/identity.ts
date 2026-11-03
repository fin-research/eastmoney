export interface SiteAuthorization {
  department?: string;
  name: string;
  roles: import('./server/auth0-directory').Auth0Role[];
  permissions: string[];
  mode: import('./permissions').AuthorizationMode;
  picture: string;
}

/** One verified site identity and one application authorization result. */
export interface SiteIdentity {
  readonly id: string;
  readonly email: string;
  readonly auth0Id: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  authorization?: SiteAuthorization;
}
