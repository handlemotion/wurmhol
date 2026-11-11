// Better Auth for Wurmhol, adapted from Omni's `packages/auth`: passkeys, Google and GitHub OAuth,
// organizations, several accounts per browser, and Stripe billing per org. It runs on D1 through
// Drizzle's SQLite adapter (ADR 0001).
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { stripe, type StripeOptions } from "@better-auth/stripe";
import { type Db, createPersonalOrg, findMember, schema } from "@wurmhol/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDpopJktFromPayload, getJwks, verifyJwsAccessToken } from "better-auth/oauth2";
import { APIError } from "better-auth/api";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { jwt } from "better-auth/plugins/jwt";
import { magicLink } from "better-auth/plugins/magic-link";
import { multiSession } from "better-auth/plugins/multi-session";
import { organization } from "better-auth/plugins/organization";
import Stripe from "stripe";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { fetchClientMetadata } from "./client-metadata.ts";

export { APIError };

const commaList = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

// Blank lines in a .dev.vars file arrive as "", which means unset.
const optionalText = z
  .string()
  .optional()
  .transform((value) => value || undefined);

/**
 * Billing (ADR 0027): two plans per org, Friends (yearly) and Business (a monthly base price plus
 * metered requests), each with a trial. All optional: with no `STRIPE_SECRET_KEY` there is no
 * Stripe plugin and pipes never need a plan (self-hosting). Amounts live in Stripe as prices; only
 * their ids are config.
 */
const billingFields = {
  STRIPE_SECRET_KEY: optionalText,
  STRIPE_WEBHOOK_SECRET: optionalText,
  /** Friends' yearly price. */
  STRIPE_PRICE_FRIENDS: optionalText,
  /** Business's monthly base price. */
  STRIPE_PRICE_BUSINESS: optionalText,
  /** Business's metered price on the `METER_EVENT_NAME` meter: requests past those included. */
  STRIPE_PRICE_BUSINESS_REQUESTS: optionalText,
};

/** Price ids, all required with `STRIPE_SECRET_KEY`. */
const REQUIRED_PRICES = [
  "STRIPE_PRICE_FRIENDS",
  "STRIPE_PRICE_BUSINESS",
  "STRIPE_PRICE_BUSINESS_REQUESTS",
] as const;

/** Auth variables, documented in `apps/worker/.dev.vars.example`. */
export const authEnvSchema = z
  .object({
    BETTER_AUTH_SECRET: z.string().min(32),
    /** The app's public origin (`https://wurmhol.com`): sign-in, the API and `/connect`. */
    BETTER_AUTH_URL: z.url(),
    AUTH_TRUSTED_ORIGINS: commaList,
    AUTH_PASSKEY_RP_ID: optionalText,
    APP_NAME: optionalText,
    /** Google OAuth client. Both set turns on "Sign in with Google"; neither leaves it off. */
    GOOGLE_CLIENT_ID: optionalText,
    GOOGLE_CLIENT_SECRET: optionalText,
    /** GitHub OAuth app. Both set turns on "Sign in with GitHub"; neither leaves it off. */
    GITHUB_CLIENT_ID: optionalText,
    GITHUB_CLIENT_SECRET: optionalText,
    ...billingFields,
  })
  .refine((env) => !env.GOOGLE_CLIENT_ID === !env.GOOGLE_CLIENT_SECRET, {
    path: ["GOOGLE_CLIENT_SECRET"],
    message: "set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET together, or neither",
  })
  .refine((env) => !env.GITHUB_CLIENT_ID === !env.GITHUB_CLIENT_SECRET, {
    path: ["GITHUB_CLIENT_SECRET"],
    message: "set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET together, or neither",
  })
  .superRefine((env, ctx) => {
    // Half a billing setup is a mistake, not "billing off": name what is missing.
    if (!env.STRIPE_SECRET_KEY) {
      const stray = ["STRIPE_WEBHOOK_SECRET", ...REQUIRED_PRICES] as const;
      for (const name of stray.filter((n) => env[n] !== undefined)) {
        ctx.addIssue({ code: "custom", path: [name], message: "needs STRIPE_SECRET_KEY" });
      }
      return;
    }
    if (env.STRIPE_WEBHOOK_SECRET === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_WEBHOOK_SECRET"],
        message: "is required with STRIPE_SECRET_KEY",
      });
    }
    for (const name of REQUIRED_PRICES.filter((n) => env[n] === undefined)) {
      ctx.addIssue({ code: "custom", path: [name], message: "is required with STRIPE_SECRET_KEY" });
    }
  })
  .transform((env) => ({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    passkeyRpId: env.AUTH_PASSKEY_RP_ID,
    appName: env.APP_NAME ?? "Wurmhol",
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined,
    github:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
        : undefined,
    billing:
      env.STRIPE_SECRET_KEY &&
      env.STRIPE_WEBHOOK_SECRET &&
      env.STRIPE_PRICE_FRIENDS &&
      env.STRIPE_PRICE_BUSINESS &&
      env.STRIPE_PRICE_BUSINESS_REQUESTS
        ? {
            secretKey: env.STRIPE_SECRET_KEY,
            webhookSecret: env.STRIPE_WEBHOOK_SECRET,
            prices: {
              friends: env.STRIPE_PRICE_FRIENDS,
              business: env.STRIPE_PRICE_BUSINESS,
              businessRequests: env.STRIPE_PRICE_BUSINESS_REQUESTS,
            },
          }
        : undefined,
  }));

export type AuthConfig = z.output<typeof authEnvSchema>;

/** Present only when billing is on (`STRIPE_SECRET_KEY` and friends set). */
export type BillingConfig = NonNullable<AuthConfig["billing"]>;

/** The plans (ADR 0027), by the key the Stripe plugin stores in `subscriptions.plan`. */
export const PLAN_NAMES = ["friends", "business"] as const;
export type PlanName = (typeof PLAN_NAMES)[number];

/** Days a new org's first subscription is free. Checkout still takes a card up front. */
export const TRIAL_DAYS = 14;

/** What an org's limits are: `members` null is any number. */
export interface OrgLimits {
  members: number | null;
  active: number;
  monthlyBytes: number;
  monthlyRequests: number;
  /** Custom domains (ADR 0033). */
  customDomains: number;
}

/**
 * Each plan's limits (ADR 0027). Prices live in Stripe; these are what the plan includes.
 * Business's `monthlyRequests` is a placeholder: its owner's spend cap sets the real one.
 */
export const PLAN_LIMITS: Record<PlanName, OrgLimits> = {
  friends: {
    members: 10,
    active: 25,
    monthlyBytes: 100 * 1000 ** 3,
    monthlyRequests: 2_000_000,
    customDomains: 0,
  },
  business: {
    members: null,
    active: 500,
    monthlyBytes: 10 * 1000 ** 4,
    monthlyRequests: 0,
    customDomains: 20,
  },
};

/** Business's spend cap before its owner sets one, in cents a month, base price included. */
export const DEFAULT_SPEND_CAP_CENTS = 10_000;

/** The Stripe meter's event name that Business requests are reported under. */
export const METER_EVENT_NAME = "wurmhol_requests";

export function isPlanName(value: string): value is PlanName {
  return (PLAN_NAMES as readonly string[]).includes(value);
}

/**
 * Session cookies are `__Host-` cookies (spec section 4): Secure, Path=/, no Domain, so no
 * other host (a share included) can set or read them. Better Auth only knows `__Secure-`, so the
 * prefix is part of the name and `Secure` is set by hand.
 */
export const SESSION_COOKIE_PREFIX = "__Host-wurmhol";

/** A Stripe client that works on Workers (fetch, Web Crypto) and in Node. */
export function createStripeClient(secretKey: string) {
  return new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient() });
}

/**
 * The one client of the device flow (`wurmhol login`, ADR 0008). The Worker fills it in on the
 * CLI's behalf; the plugin refuses any other.
 */
export const DEVICE_CLIENT_ID = "wurmhol-cli";

/** Whether `userId` owns `orgId`: owners manage billing. */
async function isOwner(db: Db, userId: string, orgId: string) {
  return (await findMember(db, userId, orgId))?.role === "owner";
}

function billingPlugin(env: AuthEnv, billing: BillingConfig) {
  return stripe({
    stripeClient: createStripeClient(billing.secretKey),
    stripeWebhookSecret: billing.webhookSecret,
    // Customers are orgs, created on first checkout; people never get one.
    createCustomerOnSignUp: false,
    organization: { enabled: true },
    subscription: {
      enabled: true,
      plans: [
        { name: "friends", priceId: billing.prices.friends, freeTrial: { days: TRIAL_DAYS } },
        {
          // The base price, and the metered one beside it on the same subscription.
          name: "business",
          priceId: billing.prices.business,
          lineItems: [{ price: billing.prices.businessRequests }],
          freeTrial: { days: TRIAL_DAYS },
        },
      ] satisfies ({ name: PlanName } & Record<string, unknown>)[],
      // Org subscriptions only (the Worker refuses others), managed by owners.
      authorizeReference: ({ user, referenceId }) => isOwner(env.db, user.id, referenceId),
      getCheckoutSessionParams: () => ({
        // A card up front, trial or not (ADR 0027): Stripe charges it when the trial ends.
        params: { allow_promotion_codes: true, payment_method_collection: "always" },
      }),
    },
    // The option's type intersects the three tables' field maps and rejects renames; this shape
    // is what the plugin reads (and what `auth:generate` turned into our schema).
    schema: {
      subscription: { modelName: "subscriptions", fields: { referenceId: "orgId" } },
      organization: { modelName: "organizations" },
      user: { modelName: "users" },
    } as unknown as StripeOptions["schema"],
  });
}

/**
 * The hosted MCP server's scopes (ADR 0014). `pipes:read` lists the person's orgs and pipes;
 * `pipes:write` also terminates them. Every member may terminate any pipe of their org, so the
 * split exists only so that a person can grant a client read-only access.
 */
export const MCP_SCOPES = ["pipes:read", "pipes:write"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Where the OAuth flow sends a person who is not signed in, and where they consent. */
export const MCP_LOGIN_PAGE = "/oauth/login";
export const MCP_CONSENT_PAGE = "/oauth/consent";

/**
 * The hosted MCP server (ADR 0014): Better Auth as the OAuth 2.1 authorization server for one
 * protected resource, `resource` (`https://api.wurmhol.com/mcp`). Clients register by Client ID
 * Metadata Document; Dynamic Client Registration stays off.
 */
export interface McpAuthOptions {
  /** The MCP server's URL, the audience of every access token. */
  resource: string;
}

/**
 * One instance per isolate, not per request: its cache of client metadata documents and its fetch
 * budgets then outlive a request. The plugin supports sharing one instance across auth instances.
 */
const clientDiscovery = cimd({
  fetchClientMetadataResource: fetchClientMetadata,
  metadataProfile: "mcp-2026-07-28",
});

function mcpPlugins(env: AuthEnv, options: McpAuthOptions) {
  return [
    // Signs access tokens. Its private key lives in D1, encrypted with BETTER_AUTH_SECRET. The
    // issuer is the app's origin, so the authorization server metadata sits at the root
    // `/.well-known/oauth-authorization-server`, where every MCP client looks first.
    jwt({
      jwt: { issuer: new URL(env.baseURL).origin },
      // No JWT on every get-session response: the console never uses one.
      disableSettingJwtHeader: true,
    }),
    mcp({
      resource: options.resource,
      loginPage: MCP_LOGIN_PAGE,
      consentPage: MCP_CONSENT_PAGE,
      scopes: [...MCP_SCOPES, "offline_access"],
      clientRegistrationDefaultScopes: [...MCP_SCOPES, "offline_access"],
      clientRegistrationAllowedScopes: [...MCP_SCOPES, "offline_access"],
      // Authorization code (with PKCE) and refresh only: no machine clients.
      grantTypes: ["authorization_code", "refresh_token"],
      // Better Auth's rate limiter is off (above); the Worker limits /api/auth per IP.
      rateLimit: {
        token: false,
        authorize: false,
        introspect: false,
        revoke: false,
        register: false,
        rotateClientKeys: false,
        userinfo: false,
      },
      schema: {
        oauthClient: { modelName: "oauthClients" },
        oauthResource: { modelName: "oauthResources" },
        oauthClientResource: { modelName: "oauthClientResources" },
        oauthRefreshToken: { modelName: "oauthRefreshTokens" },
        oauthAccessToken: { modelName: "oauthAccessTokens" },
        oauthConsent: { modelName: "oauthConsents" },
        oauthClientAssertion: { modelName: "oauthClientAssertions" },
      },
    }),
    clientDiscovery,
  ];
}

export type MagicLinkSender = (message: { email: string; url: string }) => Promise<void>;

export interface AuthEnv extends Partial<
  Pick<AuthConfig, "trustedOrigins" | "passkeyRpId" | "appName" | "google" | "github" | "billing">
> {
  db: Db;
  /** BETTER_AUTH_SECRET */
  secret: string;
  /** BETTER_AUTH_URL, the app's public origin. */
  baseURL: string;
  /**
   * Magic links stay off until a mail sender exists (spec open question 4). The Worker passes a
   * sender only in development and test, where the link is logged instead of mailed.
   */
  sendMagicLink?: MagicLinkSender;
  /** The hosted MCP server's authorization (ADR 0014); absent when it is off. */
  mcp?: McpAuthOptions;
}

/**
 * Better Auth instance for one request scope. The Worker calls this with its bindings, and
 * `auth.config.ts` calls it so the CLI generates `@wurmhol/db`'s auth schema from the same
 * options. Model names are plural to match our tables.
 */
export function createAuth(env: AuthEnv) {
  const appName = env.appName ?? "Wurmhol";
  const socialProviders = {
    // `select_account` lets one browser add a second Google account (multi-session).
    ...(env.google ? { google: { ...env.google, prompt: "select_account" as const } } : {}),
    ...(env.github ? { github: env.github } : {}),
  };
  return betterAuth({
    appName,
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: env.trustedOrigins ?? [],
    database: drizzleAdapter(env.db, { provider: "sqlite", schema }),
    socialProviders,
    user: { modelName: "users" },
    session: { modelName: "sessions" },
    account: {
      modelName: "accounts",
      // The provider's access, refresh and id tokens, encrypted with BETTER_AUTH_SECRET. Wurmhol
      // never calls the provider after sign-in; Better Auth has no switch to not store them.
      encryptOAuthTokens: true,
      // One person, one user: an OAuth sign-in joins the user who has that address only when the
      // provider says it verified it and our user has verified it too.
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    },
    verification: { modelName: "verifications" },
    advanced: {
      database: { generateId: () => uuidv7() },
      // No IP addresses at rest (ADR 0008): `sessions.ip_address` stays empty. Better Auth's own
      // rate limiter, which would key on it, is off; the Worker's keys on cf-connecting-ip.
      ipAddress: { disableIpTracking: true },
      useSecureCookies: false,
      cookiePrefix: SESSION_COOKIE_PREFIX,
      defaultCookieAttributes: { secure: true, path: "/", sameSite: "lax", httpOnly: true },
    },
    // Off: its default store is per isolate and keys on spoofable headers. The Worker
    // rate-limits every auth route itself.
    rateLimit: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // Only a proven address becomes an identity: OAuth providers must say they verified it.
          before: async (user) => {
            if (!user.emailVerified) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_NOT_VERIFIED",
                message: "sign-up needs a verified email",
              });
            }
          },
          // Self-serve sign-up creates a personal org (spec section 3).
          after: async (user) => {
            await createPersonalOrg(env.db, { userId: user.id, name: user.name || user.email });
          },
        },
      },
      session: {
        create: {
          // A new session starts in the user's oldest org, the same default the API uses.
          before: async (session) => {
            const member = await findMember(env.db, session.userId);
            return { data: { ...session, activeOrganizationId: member?.orgId ?? null } };
          },
        },
      },
    },
    plugins: [
      ...(env.sendMagicLink ? [magicLink({ sendMagicLink: env.sendMagicLink })] : []),
      passkey({
        rpName: appName,
        ...(env.passkeyRpId ? { rpID: env.passkeyRpId } : {}),
        schema: { passkey: { modelName: "passkeys" } },
      }),
      organization({
        // Anyone signed in may start another org; members join by invite link (the Worker's
        // `/api/invites`), not by email invitation.
        allowUserToCreateOrganization: true,
        schema: {
          organization: { modelName: "organizations" },
          member: { modelName: "members" },
          invitation: { modelName: "invitations" },
        },
      }),
      // Several accounts signed in on one device; switch with `multiSession.setActive`.
      multiSession(),
      // `wurmhol login` (ADR 0008): user codes, polling, `slow_down`, approve and deny, single
      // redemption. The Worker answers `/device/*` itself and never hands out the session the
      // plugin's token endpoint makes; its own routes under /api/auth stay closed (app.ts).
      deviceAuthorization({
        verificationUri: "/device",
        validateClient: (clientId) => clientId === DEVICE_CLIENT_ID,
        schema: { deviceCode: { modelName: "deviceCodes" } },
      }),
      ...(env.billing ? [billingPlugin(env, env.billing)] : []),
      ...(env.mcp ? mcpPlugins(env, env.mcp) : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Who an MCP access token speaks for: a person, through the client they consented to. */
export interface McpGrant {
  userId: string;
  clientId: string;
  scopes: Set<string>;
}

/** One cache of the signing keys per isolate, refetched on a `kid` it does not know. */
const jwksCache = {};

/**
 * Verifies an access token for the hosted MCP server (ADR 0014): its signature against our own
 * signing keys, read in process rather than over HTTP from our own `/jwks`; its issuer, audience
 * (`resource`) and expiry; and that it names a person and a client. Null when it fails any check.
 * Sender-constrained (DPoP) tokens are refused: Wurmhol never issues them to MCP clients.
 */
export async function verifyMcpAccessToken(
  auth: Auth,
  token: string,
  resource: string,
): Promise<McpGrant | null> {
  try {
    const payload = await verifyJwsAccessToken(token, {
      jwksFetch: async () => (await auth.api.getJwks()) as Awaited<ReturnType<typeof getJwks>>,
      jwksCacheKey: jwksCache,
      verifyOptions: {
        issuer: new URL(auth.options.baseURL as string).origin,
        audience: resource,
        requiredClaims: ["sub", "azp", "exp"],
      },
    });
    if (getDpopJktFromPayload(payload)) return null;
    const scope = typeof payload.scope === "string" ? payload.scope : "";
    return {
      userId: String(payload.sub),
      clientId: String(payload.azp),
      scopes: new Set(scope.split(" ").filter(Boolean)),
    };
  } catch {
    return null;
  }
}
