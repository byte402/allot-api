// Netlify entry for the Allot sample x402 API. The API itself is ../../worker.js, unchanged.
// Settled transactions are kept in Netlify Blobs with strong consistency, so a transaction is refused
// everywhere once it has bought an answer.
import { getStore } from "@netlify/blobs";
import { handle } from "../../worker.js";
import { COMMIT } from "./commit.mjs";

export default async (req, context) => {
  const store = getStore({ name: "allot-used-tx", consistency: "strong" });
  const used = { has: async (tx) => (await store.get(tx)) !== null, add: (tx) => store.set(tx, String(Date.now())), check: () => store.get("health-probe") };
  const env = {
    PAY_TO: Netlify.env.get("PAY_TO"),
    CHALLENGE_SECRET: Netlify.env.get("CHALLENGE_SECRET"),
    GIT_COMMIT: Netlify.env.get("GIT_COMMIT") || COMMIT,
    DEPLOYMENT: context?.deploy?.id ? { id: context.deploy.id } : null,
  };
  return handle(req, env, used);
};

export const config = { path: "/*" };
