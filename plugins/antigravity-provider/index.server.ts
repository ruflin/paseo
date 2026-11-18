import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAntigravityProvider } from "./server/provider.js";
import { AntigravityUsage } from "./server/internal/usage.js";

export default function contribute(
  server: Pick<PluginServerContext, "registerProvider" | "registerUsageSource">,
) {
  const usage = new AntigravityUsage();
  server.registerUsageSource(usage.registration());
  server.registerProvider(createAntigravityProvider(usage));
  return () => {};
}
