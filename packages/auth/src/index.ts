// Better Auth for Wurmhol, adapted from Omni's `packages/auth`: passkeys, Google and GitHub OAuth,
// organizations, several accounts per browser, and Stripe billing per org. It runs on D1 through
// Drizzle's SQLite adapter (ADR 0001).
import { passkey } from "@better-auth/passkey";
import { stripe, type StripeOptions } from "@better-auth/stripe";
import { type Db, createPersonalOrg, findMember, schema } from "@wurmhol/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { magicLink } from "better-auth/plugins/magic-link";
import { multiSession } from "better-auth/plugins/multi-session";
import { organization } from "better-auth/plugins/organization";
import Stripe from "stripe";
import { uuidv7 } from "uuidv7";
import { z } from "zod";

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
 * Billing (ADR 0004): one plan per org, bought before the first pipe; no trial. Yearly is the
 * plan (card fees eat a small monthly charge); a monthly price is optional. All optional: with no
 * `STRIPE_SECRET_KEY` there is no Stripe plugin and pipes never need a plan (self-hosting).
 * Amounts live in Stripe as prices; only their ids are config.
 */
const billingFields = {
  STRIPE_SECRET_KEY: optionalText,
  STRIPE_WEBHOOK_SECRET: optionalText,
  /** Yearly price of the plan: the default, and the only one offered unless a monthly is set. */
  STRIPE_PRICE_YEARLY: optionalText,
  /** Optional monthly price. Empty offers yearly only. */
  STRIPE_PRICE_MONTHLY: optionalText,
};

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
      const stray = [
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PRICE_MONTHLY",
        "STRIPE_PRICE_YEARLY",
      ] as const;
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
    if (env.STRIPE_PRICE_YEARLY === undefined && env.STRIPE_PRICE_MONTHLY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_PRICE_YEARLY"],
        message: "set a price with STRIPE_SECRET_KEY",
      });
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
      (env.STRIPE_PRICE_YEARLY || env.STRIPE_PRICE_MONTHLY)
        ? {
            secretKey: env.STRIPE_SECRET_KEY,
            webhookSecret: env.STRIPE_WEBHOOK_SECRET,
            monthlyPriceId: env.STRIPE_PRICE_MONTHLY,
            yearlyPriceId: env.STRIPE_PRICE_YEARLY,
          }
        : undefined,
  }));

export type AuthConfig = z.output<typeof authEnvSchema>;

/** Present only when billing is on (`STRIPE_SECRET_KEY` and friends set). */
export type BillingConfig = NonNullable<AuthConfig["billing"]>;

/** The one plan's key, as the Stripe plugin stores it in `subscriptions.plan`. */
export const PLAN_NAME = "wurmhol";

/** Org roles (spec section 3): owners manage members, tokens and billing; members share. */
export const ROLES = ["owner", "member"] as const;
export type Role = (typeof ROLES)[number];

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
        {
          name: PLAN_NAME,
          // The plugin's base price is the monthly one when there is one; yearly-only plans use
          // the yearly price as the base (Checkout then never passes `annual`).
          priceId: billing.monthlyPriceId ?? billing.yearlyPriceId!,
          annualDiscountPriceId: billing.monthlyPriceId ? billing.yearlyPriceId : undefined,
        },
      ],
      // Org subscriptions only (the Worker refuses others), managed by owners.
      authorizeReference: ({ user, referenceId }) => isOwner(env.db, user.id, referenceId),
      getCheckoutSessionParams: () => ({
        params: { allow_promotion_codes: true, payment_method_collection: "if_required" },
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
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
