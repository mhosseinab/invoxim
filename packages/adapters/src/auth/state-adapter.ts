import type { BetterAuthPlugin, DBAdapter } from "better-auth";
import { z } from "zod";

const encoder = new TextEncoder();
const storedState = z.object({
  identifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  value: z.string().max(8192),
});
const envelopeSchema = z.strictObject({
  v: z.literal(1),
  iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
  ciphertext: z
    .string()
    .min(24)
    .max(5500)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unbase64 = (text: string) =>
  Uint8Array.from(atob(text), (value) => value.charCodeAt(0));
/** Only the login library's verification value is transformed; all other models pass through. */
export function protectedLoginState(
  secret: string,
  origin: string,
  onCreatedUser: (id: string) => void,
): BetterAuthPlugin {
  return {
    id: "protected-login-state",
    init(context) {
      const adapter = context.adapter;
      const key = (async () => {
        const material = await crypto.subtle.importKey(
          "raw",
          encoder.encode(secret),
          "HKDF",
          false,
          ["deriveKey"],
        );
        return crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: encoder.encode("invoxim/google-login/state-key/v1"),
            info: encoder.encode(origin),
          },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      })();
      const aad = (identifier: string) =>
        encoder.encode(
          JSON.stringify([1, "google-login-state", origin, identifier]),
        );
      async function encrypt(identifier: string, value: unknown) {
        const checked = storedState.parse({ identifier, value });
        const bytes = encoder.encode(checked.value);
        if (bytes.byteLength > 4096) throw new Error("Invalid login state");
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: aad(identifier),
            tagLength: 128,
          },
          await key,
          bytes,
        );
        return JSON.stringify({
          v: 1,
          iv: base64(iv),
          ciphertext: base64(new Uint8Array(ciphertext)),
        });
      }
      async function hydrate<T>(row: T, model: string): Promise<T> {
        if (model !== "verification" || row === null) return row;
        const checked = storedState.parse(row);
        const envelope = envelopeSchema.parse(JSON.parse(checked.value));
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: unbase64(envelope.iv),
            additionalData: aad(checked.identifier),
            tagLength: 128,
          },
          await key,
          unbase64(envelope.ciphertext),
        );
        if (plaintext.byteLength > 4096) throw new Error("Invalid login state");
        const value = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(plaintext);
        // The SDK generic row type is preserved: only its validated string value field changes.
        return { ...row, value } as T;
      }
      async function updateValue(
        model: string,
        where: Parameters<DBAdapter["update"]>[0]["where"],
        update: Record<string, unknown>,
      ) {
        if (model !== "verification") return update;
        if ("identifier" in update)
          throw new Error("Login state identity is immutable");
        if (!("value" in update)) return update;
        const row = await adapter.findOne({ model, where });
        if (!row) throw new Error("Login state unavailable");
        const checked = storedState.parse(row);
        return {
          ...update,
          value: await encrypt(checked.identifier, update.value),
        };
      }
      const wrapped: DBAdapter = {
        ...adapter,
        async create<T extends Record<string, unknown>, R = T>(options: {
          model: string;
          data: Omit<T, "id">;
          select?: string[] | undefined;
          forceAllowId?: boolean | undefined;
        }): Promise<R> {
          let data = options.data;
          if (options.model === "verification") {
            const checked = storedState.parse(data);
            data = {
              ...data,
              value: await encrypt(checked.identifier, checked.value),
            };
          }
          const row = await adapter.create<T, R>({ ...options, data });
          if (options.model === "user") {
            const user = z
              .object({ id: z.string().min(1).max(256) })
              .parse(row);
            onCreatedUser(user.id);
          }
          return hydrate(row, options.model);
        },
        async findOne(options) {
          return hydrate(await adapter.findOne(options), options.model);
        },
        async findMany<T>(
          options: Parameters<DBAdapter["findMany"]>[0],
        ): Promise<T[]> {
          return Promise.all(
            (await adapter.findMany<T>(options)).map((row) =>
              hydrate(row, options.model),
            ),
          );
        },
        async update(options) {
          return hydrate(
            await adapter.update({
              ...options,
              update: await updateValue(
                options.model,
                options.where,
                options.update,
              ),
            }),
            options.model,
          );
        },
        async updateMany(options) {
          if (
            options.model === "verification" &&
            ("value" in options.update || "identifier" in options.update)
          )
            throw new Error("Login state bulk replacement is unsupported");
          return adapter.updateMany(options);
        },
        async consumeOne(options) {
          return hydrate(await adapter.consumeOne(options), options.model);
        },
        // Drizzle's D1 adapter explicitly has transaction:false. Keep its existing
        // as-is callback behavior while preventing a transaction context bypass.
        async transaction(callback) {
          return callback(wrapped);
        },
      };
      return { context: { adapter: wrapped } };
    },
  };
}
